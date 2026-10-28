import { AuditedReplay } from './replay-cache.mjs';
import { writeOperatorResponse } from '../../deploy/rehearsal/operator-pages.mjs';
import { rotationBody, attestRotation } from '../rosters.mjs';
import { createServer } from 'node:http';
import { mkdir, readFile, open, unlink, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Policy } from './policy.mjs';
import { Journal } from './journal.mjs';
import { canonicalJSON, check, isHex, safeEqual, seal, sha256 } from './crypto.mjs';
import { signerError } from './errors.mjs';
import { attestMintResult, verifyMintCertificate, verifyMintResult } from './certificate.mjs';
import { rpc } from '../tss.mjs';
import { rules } from './adapter.mjs';
import { endorseBinding, verifyPayoutSnapshot } from './bindings.mjs';
import { BatchReplay } from './replay-worker.mjs';
import { operatorAttestation } from '../provision.mjs';
import { operatorExportBytes, deriveOperatorImport } from '../../deploy/rehearsal/reconcile.mjs';
import { terminalRecordsRoot } from '../../service/src/pending-financial.mjs';
import { checkPublic } from '../../deploy/rehearsal/export.mjs';
import { pendingInventory } from '../../service/src/pending-inventory.mjs';
import { createPrivateKey, sign } from 'node:crypto';
import { ReceiptFences } from './receipt-fences.mjs';
import { closureTimeouts } from '../../rules/src/closure-timeouts.js';

export async function createSigner(config, secrets, reads) {
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  const lockPath = resolve(config.directory, 'signer.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const before = await lstat(lockPath), pid = Number(await readFile(lockPath, 'utf8'));
    check(before.isFile() && Number.isSafeInteger(pid) && pid > 1, 'signer_lock');
    try { process.kill(pid, 0); throw Error('signer_lock_live'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    check((await lstat(lockPath)).ino === before.ino, 'signer_lock_changed');
    await unlink(lockPath); lock = await open(lockPath, 'wx', 0o600);
  }
  await lock.write(String(process.pid)); await lock.sync();
  let journal, replay;
  try {
    journal = await new Journal(resolve(config.directory, 'signed.log'), secrets.journalKey, config.network, config.id, { decimalIndex: !!config.v2 }).load();
    const status = await rpc(config.sidecar, secrets.sidecarToken, '/status');
    check(status.public && !status.retired && rules.compareOrdinal(status.epoch, config.tssEpoch ?? config.epoch) === 0, 'sidecar_not_active');
    check(!config.publicKey || status.public === config.publicKey, 'target_committee_key');
    if (status.session && journal.records.some(r => r.type === 'retired-batch' && r.session === status.session.id)) {
      await rpc(config.sidecar, secrets.sidecarToken, '/abort');
    }
    reads.verifyPayoutSnapshot = (snapshot, payouts) => verifyPayoutSnapshot(snapshot, payouts, { bindings: reads.bindings, journal });
    const resources = (config.v2?.resources ?? config.resources)?.values;
    replay = new BatchReplay({ timeoutMs: resources?.replayTimeoutMs ?? config.replayTimeoutMs,
      nodeCacheEntries: resources?.namedNodeCache ?? config.replayNodeCacheEntries, resources }); await replay.ready;
    const receiptFences = new ReceiptFences({ journal, reads, members: config.v2?.receiptSigners ?? config.members, network: config.network, gateway: config.gateway,
      signer: config.id, secret: secrets.identity === undefined ? undefined : Buffer.from(secrets.identity, 'hex') });
    const auditedReplay = new AuditedReplay((...args) => replay.run(...args));
    const policy = new Policy({ network: config.network, publicKey: status.public, reads, receiptFences, escrow: config.escrow, replayBatch: (...args) => auditedReplay.run(...args),
      authorizedMint: async id => {
        const prior = journal.slots.get(`mint/request/${id}`);
        if (prior && journal.records.some(r => r.type === 'signed' && r.session === prior.session && r.digest === prior.digest)) return rules.mintAuthorization(prior.details);
        return reads.mintAuthorization(id);
      } });
    const signedFor = prior => prior && journal.records.find(r => r.type === 'signed' && r.session === prior.session && r.digest === prior.digest);
    const certificateDetails = async (id, certificate) => {
      const prior = journal.slots.get(`mint/request/${id}`);
      if (signedFor(prior)) return prior.details;
      const saved = journal.records.findLast(r => r.type === 'certificate' && r.request === id);
      certificate ??= saved?.certificate ?? await reads.mintCertificate(id);
      const details = verifyMintCertificate(certificate, { network: config.network, rosterHistory: config.rosterHistory, members: config.members, publicKey: status.public, id });
      if (!saved) await journal.append('certificate', { request: id, certificate });
      return details;
    };
    let active = null, queue = Promise.resolve(), closed = false;
    const uncertainPreparations = new Set();
    const perform = async (path, body) => {
      check(!closed, 'signer_closed');
      if (path === '/health') return { id: config.id, network: config.network, publicKey: status.public, epoch: config.epoch };
      check(!receiptFences.failed, 'receipt_journal_uncertain');
      if (path === '/batch-ready') {
        const counted = await reads.counted(), clock = await reads.tip();
        const active = await reads.rulesContext?.();
        let capabilities;
        if (body.settingsHash) {
          const document = active?.settingsHash === body.settingsHash ? active.settings : await reads.settingsByHash?.(body.settingsHash);
          check(document && rules.hashObject(document) === body.settingsHash, 'settings_unknown');
          capabilities = rules.runtimeCapabilities(document, config.v2?.resources ?? config.resources);
        }
        return { id: config.id, network: config.network, epoch: config.epoch, counted, tip: clock.tip,
          ...(active?.ready ? { manifestHash: active.manifestHash } : {}), ...(capabilities ? { capabilities } : {}) };
      }
      if (path === '/preparation-state') {
        check(isHex(body.id), 'ceremony_id');
        const reserved = uncertainPreparations.has(body.id) || journal.records.some(r => r.type === 'reserve' && r.session === body.id);
        return { id: body.id, reserved, retired: journal.records.some(r => r.type === 'retired-preparation' && r.session === body.id) };
      }
      if (!['/health', '/status', '/relay', '/round', '/abort', '/finish'].includes(path)) await reads.refreshEvidence?.();
      if (path === '/attest-deployment') return operatorAttestation(config, secrets.identity, status.public, body.challenge);
      if (path === '/migration-export') {
        check(Object.keys(body).sort().join(',') === 'document,legacySettings' && reads.migrationEvidence, 'pending_export_request');
        rules.validateSettingsDocument(body.document);
        check(body.document.network === config.network, 'pending_export_network');
        const evidence = await reads.migrationEvidence();
        const reservations = [...new Set(journal.slots.values())].map(row => ({
          slots: row.slots.filter(slot => journal.slots.get(slot) === row), digest: row.digest, details: row.details
        })).filter(row => row.slots.length);
        const exported = { version: 2, signer: config.id, network: config.network, gateway: config.gateway,
          document: body.document, legacySettings: body.legacySettings, ...evidence, reservations,
          inventory: pendingInventory(evidence.gatewayRows, new Map(evidence.notary.records)) };
        checkPublic(exported);
        const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(secrets.identity, 'hex')]), format: 'der', type: 'pkcs8' });
        const signed = value => ({ ...value, signature: sign(null, operatorExportBytes(value), key).toString('hex') });
        check(reads.migrationHistory, 'pending_export_history');
        if (Object.values(exported.inventory.unsupported).every(n => n === 0)) {
          const expected = { network: config.network, gateway: config.gateway, anchor: evidence.anchor, headersHash: evidence.headersHash,
            settingsHash: rules.hashObject(body.document), legacySettings: body.legacySettings,
            gatewayRoot: exported.inventory.sourceRoot, notaryRoot: terminalRecordsRoot(new Map(evidence.notary.records)), artifactsRoot: rules.hashObject(evidence.artifacts) };
          const derived = deriveOperatorImport({ exported: signed(exported), member: config.members.find(m => m.id === config.id), expected,
            history: await reads.migrationHistory(evidence.anchor) });
          exported.derivation = derived.roots;
          derived.imported.close?.();
        }
        return signed(exported);
      }
      if (path === '/attest-roster') {
        check(canonicalJSON(rotationBody(config.network, config.members, body.members, status.public)) === canonicalJSON(body), 'rotation_binding');
        const prior = journal.records.findLast(r => r.type === 'roster-rotation' && r.body.before === body.before);
        check(!prior || canonicalJSON(prior.body) === canonicalJSON(body), 'rotation_conflict');
        if (prior) return prior.vote;
        const vote = attestRotation(body, config.id, secrets.identity);
        await journal.append('roster-rotation', { body, vote }); return vote;
      }
      if (path === '/bind-payout') return endorseBinding(body, { config, secrets, journal, bitcoinNetwork: reads.bindings.bitcoinNetwork });
      if (path === '/ack-receipt') return receiptFences.admit(body.receipt, body.checkpoint);
      if (path === '/fence-receipts') {
        check(!uncertainPreparations.size, 'receipt_cutoff_preparation_uncertain');
        return receiptFences.cutoff(body.cutoff, body.evidence);
      }
      if (path === '/attest-root') {
        const { seal, receipts } = await reads.receiptObservation(body.tip, body.hash, body.segment);
        const clock = await reads.tip();
        const ordinal = rules.ordinalCodec(!!seal.settingsHash), highestTip = ordinal.max(clock.highestTip, journal.records.findLast(r => r.type === 'tip')?.highestTip ?? 0);
        check(ordinal.valid(highestTip) && ordinal.compare(clock.tip, highestTip) <= 0, 'receipt_clock');
        await journal.append('tip', { highestTip });
        check(seal.tip === body.tip && seal.hash === body.hash && rules.verifyReceiptRoot(seal, receipts, { network: config.network, gateway: config.gateway, tip: body.tip, hash: body.hash }), 'receipt_observation');
        check(seal.v !== 2 || seal.segment === body.segment, 'receipt_segment');
        receiptFences.checkSegment(seal, receipts);
        const old = journal.records.find(r => r.type === 'root-attestation' && r.tip === body.tip && r.segment === body.segment);
        if (old) { check(old.hash === body.hash && (seal.v === 2 ? old.attestation.segmentHash === rules.receiptSegmentHash(seal) : old.attestation.root === seal.root && old.attestation.count === seal.count), 'receipt_root_conflict'); return old.attestation; }
        const attestation = rules.attestReceiptRoot(seal, highestTip, config.id, Buffer.from(secrets.identity, 'hex'));
        await journal.append('root-attestation', { tip: body.tip, hash: body.hash, ...(seal.v === 2 ? { segment: seal.segment } : {}), attestation });
        return attestation;
      }
      if (path === '/recover-result') {
        check(body.network === config.network && isHex(body.id), 'release_domain');
        const prior = journal.slots.get(`mint/request/${body.id}`);
        check(prior, 'permit_not_observed');
        verifyMintResult(prior.details, body.signature, { network: config.network, publicKey: status.public, id: body.id });
        const old = signedFor(prior);
        check(!old || canonicalJSON(old.signature) === canonicalJSON(body.signature), 'permit_result_conflict');
        const result = { permit: prior.details.permit, details: prior.details, attestation: attestMintResult(config.network, prior.details, body.signature, config.id, secrets.identity) };
        if (!old) await journal.append('signed', { session: prior.session, digest: prior.digest, signature: body.signature, result });
        if (active?.id === prior.session) { await rpc(config.sidecar, secrets.sidecarToken, '/abort'); active = null; }
        return { status: 'complete', signature: body.signature, result };
      }
      if (path === '/retire-unprepared') {
        check(body.network === config.network && isHex(body.id), 'ceremony_id');
        // Serialize with prepare and durably fence late requests. An absent
        // status alone cannot prove a timed-out preparation will never reserve.
        check(!uncertainPreparations.has(body.id) && !journal.records.some(r => r.type === 'reserve' && r.session === body.id), 'ceremony_reserved');
        if (!journal.records.some(r => r.type === 'retired-preparation' && r.session === body.id))
          await journal.append('retired-preparation', { session: body.id });
        return { id: body.id, status: 'retired-unprepared' };
      }
      if (path === '/audit-batch') {
        check(body?.kind === 'batch', 'audit_batch_only');
        return auditedReplay.audit(() => policy.approve(body));
      }
      if (path === '/prepare') {
        // An expired or superseded active ceremony no longer owns its slot.
        // Preserve the reservation and proof before stopping the sidecar.
        if (active?.approval.batch || active?.approval.details?.batch) {
          const b = active.approval.batch ?? active.approval.details.batch;
          const authority = await reads.authority(), counted = await reads.counted();
          const accepted = await reads.batchRoot(b.n) === b.root;
          if (accepted || rules.compareOrdinal(authority.epoch, b.epoch) > 0 || rules.compareOrdinal(counted, b.deadline) > 0) {
            if (!accepted && journal.slots.has(`batch/${b.epoch}/${b.n}`)) await journal.retireBatch(`batch/${b.epoch}/${b.n}`, reads);
            await rpc(config.sidecar, secrets.sidecarToken, '/abort'); active = null;
          }
        }
        check(!active, 'signer_busy');
        const ceremony = body.ceremony;
        check(ceremony?.epoch === config.epoch && isHex(ceremony.id) && Array.isArray(ceremony.peers) && ceremony.peers.length === 3 && ceremony.peers.some(p => p.id === config.id) && new Set(ceremony.peers.map(p => p.id)).size === 3, 'ceremony_members');
        check(ceremony.peers.every(p => config.members.some(m => canonicalJSON(p) === canonicalJSON(m))), 'ceremony_roster');
        check(!journal.records.some(r => r.type === 'retired-preparation' && r.session === ceremony.id), 'ceremony_retired');
        check(!uncertainPreparations.has(ceremony.id) && !journal.records.some(r => r.type === 'reserve' && r.session === ceremony.id), 'ceremony_reused');
        let approval;
        try { approval = await policy.approve(body.proposal); }
        finally { auditedReplay.clear(); }
        let signingTimeoutMs = resources?.signerSessionMs ?? 180000;
        if (approval.batch?.settingsHash && resources?.closureWorkPerSecond) {
          const accepted = await reads.rulesContext();
          const document = accepted.settingsHash === approval.batch.settingsHash ? accepted.settings : await reads.settingsByHash?.(approval.batch.settingsHash);
          check(document && rules.hashObject(document) === approval.batch.settingsHash, 'settings_unknown');
          signingTimeoutMs = closureTimeouts(document, resources)?.sessionMs ?? signingTimeoutMs;
        }
        if (approval.batch) for (const [slot, old] of journal.slots) {
          if (slot.startsWith('batch/') && old.details.n === approval.batch.n && rules.compareOrdinal(old.details.epoch, approval.batch.epoch) < 0) await journal.retireBatch(slot, reads);
        }
        for (const slot of approval.slots.filter(s => s.startsWith('batch/'))) {
          const old = journal.slots.get(slot);
          if (old && old.digest !== approval.digest) await journal.retireBatch(slot, reads);
        }
        const saved = journal.slots.get(approval.slots[0]);
        let retryMint = false;
        if (saved && approval.slots[0].startsWith('mint/') && saved.digest === approval.digest) {
          const result = signedFor(saved);
          if (result) return { id: saved.session, digest: saved.digest, recovered: true };
          check(config.assetRecoveryVersion === 2 && ceremony.retry === 'same-mint-v2', 'permit_recovery_required');
          // The independently reapproved digest is unchanged. Preserve every
          // original obligation field while the sidecar uses a fresh session.
          retryMint = true; approval.details = saved.details;
        }
        // A write/sync error is ambiguous even if the in-memory journal was
        // not updated. Only a successful journal reload can resolve it.
        uncertainPreparations.add(ceremony.id);
        if (retryMint) await journal.retryMint(approval.slots, approval.digest, ceremony.id);
        else await journal.reserve(approval.slots, approval.digest, ceremony.id, approval.details);
        uncertainPreparations.delete(ceremony.id);
        const peers = config.thresholdMembers ? ceremony.peers.map(p => { const member = config.thresholdMembers.find(m => m.signer === p.id); check(member, 'threshold_roster'); return member.peer; }) : ceremony.peers;
        const start = { id: ceremony.id, kind: 'sign', network: config.network, epoch: config.tssEpoch ?? config.epoch, digest: approval.digest, peers, newPeers: [], timeout: Math.ceil(signingTimeoutMs / 1000) };
        await rpc(config.sidecar, secrets.sidecarToken, '/prepare', start);
        active = { id: ceremony.id, approval, completed: false };
        return { id: active.id, digest: approval.digest };
      }
      if (path === '/go') { check(active?.id === body.id, 'ceremony_id'); await rpc(config.sidecar, secrets.sidecarToken, '/go'); return { ok: true }; }
      if (path === '/status') {
        check(isHex(body.id), 'ceremony_id');
        const prior = journal.records.find(r => r.type === 'signed' && r.session === body.id);
        if (prior) return { status: 'complete', signature: prior.signature, result: prior.result };
        if (!active) {
          const reservation = journal.records.findLast(r => r.type === 'reserve' && r.session === body.id);
          check(reservation, 'ceremony_id');
          const running = (await rpc(config.sidecar, secrets.sidecarToken, '/status')).session;
          if (running?.id === body.id && ['prepared', 'running'].includes(running.status)) {
            active = { id: body.id, approval: { digest: reservation.digest, details: reservation.details, ...(reservation.details.permit ? { permit: reservation.details.permit } : {}), ...(reservation.details.typedData ? { typedData: reservation.details.typedData } : {}) } };
            return { status: running.status };
          }
          if (running?.id === body.id && running.status === 'aborted') {
            if (!journal.records.some(r => r.type === 'aborted' && r.session === body.id))
              await journal.append('aborted', { session: body.id, reason: running.error ?? 'sidecar_abort' });
            return { status: 'aborted' };
          }
          if (running?.id !== body.id && journal.records.some(r => r.type === 'aborted' && r.session === body.id)) return { status: 'aborted' };
          const recovered = await rpc(config.sidecar, secrets.sidecarToken, '/result', { id: body.id });
          check(recovered?.start?.digest === reservation.digest && recovered.start.network === config.network, 'recovery_result');
          const details = reservation.details;
          if (details.permit) verifyMintResult(details, recovered.signature, { network: config.network, publicKey: status.public, id: details.id });
          const result = { ...(details.typedData ? { typedData: details.typedData } : {}), ...(details.permit ? { permit: details.permit, details, attestation: attestMintResult(config.network, details, recovered.signature, config.id, secrets.identity) } : {}) };
          await journal.append('signed', { session: body.id, digest: reservation.digest, signature: recovered.signature, result });
          return { status: 'complete', signature: recovered.signature, result };
        }
        check(active?.id === body.id, 'ceremony_id');
        const { session } = await rpc(config.sidecar, secrets.sidecarToken, '/status'); check(session?.id === body.id, 'sidecar_session');
        if (session.status === 'complete') {
          const result = { ...(active.approval.permit ? { permit: active.approval.permit, details: active.approval.details, attestation: attestMintResult(config.network, active.approval.details, session.signature, config.id, secrets.identity) } : {}), ...(active.approval.typedData ? { typedData: active.approval.typedData } : {}) };
          await journal.append('signed', { session: body.id, digest: active.approval.digest, signature: session.signature, result });
          active = null; return { status: 'complete', signature: session.signature, result };
        }
        if (session.status === 'aborted') { await journal.append('aborted', { session: body.id, reason: session.error ?? 'sidecar_abort' }); active = null; }
        return { status: session.status, error: session.error };
      }
      if (path === '/abort') { check(active?.id === body.id, 'ceremony_id'); await rpc(config.sidecar, secrets.sidecarToken, '/abort'); await journal.append('aborted', { session: body.id, reason: 'operator_abort' }); active = null; return { ok: true }; }
      throw Error('route');
    };
    const handle = (path, body) => {
      const result = queue.then(async () => {
        try {
          const result = await perform(path, body);
          if (path === '/status') {
            const reservation = journal.records.findLast(r => r.type === 'reserve' && r.session === body.id);
            return { ...result, id: body.id, ...(reservation ? { digest: reservation.digest } : {}) };
          }
          return result;
        }
        catch (error) {
          // Still inside the serialized request: a failed sidecar call AFTER
          // reserve must never receive a no-reservation proof.
          delete error.unreserved;
          if (path === '/prepare' && isHex(body?.ceremony?.id) && body.proposal
            && !uncertainPreparations.has(body.ceremony.id) && !journal.records.some(r => r.type === 'reserve' && r.session === body.ceremony.id)
            && !journal.records.some(r => r.type === 'retired-preparation' && r.session === body.ceremony.id))
            error.unreserved = { id: body.ceremony.id, proposalHash: sha256(JSON.stringify(body.proposal)) };
          throw error;
        }
      });
      queue = result.catch(() => {}); return result;
    };
    return { handle, replayStats: () => ({ hits: auditedReplay.hits ?? 0 }), async close() { closed = true; await queue; if (active) await rpc(config.sidecar, secrets.sidecarToken, '/abort').catch(() => {}); await replay.close(); await journal.close(); await lock.close(); await unlink(lockPath); } };
  } catch (error) { await replay?.close(); await journal?.close(); await lock.close(); await unlink(lockPath); throw error; }
}

export async function serveSigner(configPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const resources = config.v2?.resources ?? config.resources;
  if (resources) rules.validateResourceDocument(resources);
  const local = resources?.version >= 3 ? resources.values : null;
  check(/^127\.0\.0\.1:[0-9]+$/.test(config.listen), 'signer_loopback');
  const st = await lstat(config.secrets); check(st.isFile() && (st.mode & 0o777) === 0o600, 'credentials_mode');
  const secrets = JSON.parse(await readFile(config.secrets, 'utf8'));
  const adapter = await import(pathToFileURL(config.readModule).href);
  const reads = await adapter.createReads({ ...config.readOptions, gateway: config.gateway, identity: Buffer.from(secrets.identity, 'hex') });
  const signer = await createSigner(config, secrets, reads);
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
      check(req.method === 'POST' && safeEqual(req.headers.authorization, `Bearer ${secrets.apiToken}`), 'authentication');
      let length = 0; const chunks = [];
      for await (const chunk of req) { length += chunk.length; check(length <= (local?.signerRequestBytes ?? 4 << 20), 'body_limit'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const result = await signer.handle(req.url, body);
      if (req.url === '/migration-export') await writeOperatorResponse(res, result); else res.end(JSON.stringify(result));
    } catch (error) { if (res.headersSent) { res.destroy(); return; } res.statusCode = error.message === 'authentication' ? 403 : 409; res.end(JSON.stringify(signerError(error))); }
  });
  server.requestTimeout = local?.requestTimeoutMs ?? 30000; server.headersTimeout = Math.min(local?.httpHeaderTimeoutMs ?? 5000, server.requestTimeout);
  server.maxConnections = local?.httpConnections ?? 32;
  if (local) { server.timeout = local.httpSocketTimeoutMs; server.keepAliveTimeout = local.httpKeepAliveMs; }
  const [host, port] = config.listen.split(':');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(port), host, resolve); });
  let closing;
  const shutdown = () => close().catch(() => {}).finally(() => process.exit());
  const close = () => closing ??= (async () => {
    process.removeListener('SIGTERM', shutdown); process.removeListener('SIGINT', shutdown);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    try { await signer.close(); } finally { await reads.close?.(); }
  })();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { server, signer, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  serveSigner(resolve(process.argv[2])).catch(error => { console.error('signer startup failed:', error.message); process.exitCode = 1; });
}
