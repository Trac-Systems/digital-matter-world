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
    journal = await new Journal(resolve(config.directory, 'signed.log'), secrets.journalKey, config.network, config.id).load();
    const status = await rpc(config.sidecar, secrets.sidecarToken, '/status');
    check(status.public && !status.retired && status.epoch === (config.tssEpoch ?? config.epoch), 'sidecar_not_active');
    check(!config.publicKey || status.public === config.publicKey, 'target_committee_key');
    if (status.session && journal.records.some(r => r.type === 'retired-batch' && r.session === status.session.id)) {
      await rpc(config.sidecar, secrets.sidecarToken, '/abort');
    }
    reads.verifyPayoutSnapshot = (snapshot, payouts) => verifyPayoutSnapshot(snapshot, payouts, { bindings: reads.bindings, journal });
    replay = new BatchReplay({ timeoutMs: config.replayTimeoutMs }); await replay.ready;
    const policy = new Policy({ network: config.network, publicKey: status.public, reads, escrow: config.escrow, replayBatch: (...args) => replay.run(...args),
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
      if (path === '/batch-ready') {
        const counted = await reads.counted(), clock = await reads.tip();
        return { id: config.id, network: config.network, epoch: config.epoch, counted, tip: clock.tip };
      }
      if (path === '/preparation-state') {
        check(isHex(body.id), 'ceremony_id');
        const reserved = uncertainPreparations.has(body.id) || journal.records.some(r => r.type === 'reserve' && r.session === body.id);
        return { id: body.id, reserved, retired: journal.records.some(r => r.type === 'retired-preparation' && r.session === body.id) };
      }
      if (!['/health', '/status', '/relay', '/round', '/abort', '/finish'].includes(path)) await reads.refreshEvidence?.();
      if (path === '/attest-deployment') return operatorAttestation(config, secrets.identity, status.public, body.challenge);
      if (path === '/attest-roster') {
        check(canonicalJSON(rotationBody(config.network, config.members, body.members, status.public)) === canonicalJSON(body), 'rotation_binding');
        const prior = journal.records.findLast(r => r.type === 'roster-rotation' && r.body.before === body.before);
        check(!prior || canonicalJSON(prior.body) === canonicalJSON(body), 'rotation_conflict');
        if (prior) return prior.vote;
        const vote = attestRotation(body, config.id, secrets.identity);
        await journal.append('roster-rotation', { body, vote }); return vote;
      }
      if (path === '/bind-payout') return endorseBinding(body, { config, secrets, journal, bitcoinNetwork: reads.bindings.bitcoinNetwork });
      if (path === '/attest-root') {
        const { seal, receipts } = await reads.receiptObservation(body.tip, body.hash);
        const clock = await reads.tip();
        const highestTip = Math.max(clock.highestTip, journal.records.filter(r => r.type === 'tip').at(-1)?.highestTip ?? 0);
        check(Number.isSafeInteger(highestTip) && clock.tip <= highestTip, 'receipt_clock');
        await journal.append('tip', { highestTip });
        check(seal.tip === body.tip && seal.hash === body.hash && rules.verifyReceiptRoot(seal, receipts, { network: config.network, gateway: config.gateway, tip: body.tip, hash: body.hash }), 'receipt_observation');
        const old = journal.records.find(r => r.type === 'root-attestation' && r.tip === body.tip);
        if (old) { check(old.hash === body.hash && old.attestation.root === seal.root && old.attestation.count === seal.count, 'receipt_root_conflict'); return old.attestation; }
        const attestation = rules.attestReceiptRoot(seal, highestTip, config.id, Buffer.from(secrets.identity, 'hex'));
        await journal.append('root-attestation', { tip: body.tip, hash: body.hash, attestation });
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
      if (path === '/prepare') {
        // An expired or superseded active ceremony no longer owns its slot.
        // Preserve the reservation and proof before stopping the sidecar.
        if (active?.approval.batch || active?.approval.details?.batch) {
          const b = active.approval.batch ?? active.approval.details.batch;
          const authority = await reads.authority(), counted = await reads.counted();
          const accepted = await reads.batchRoot(b.n) === b.root;
          if (accepted || authority.epoch > b.epoch || counted > b.deadline) {
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
        approval = await policy.approve(body.proposal);
        if (approval.batch) for (const [slot, old] of journal.slots) {
          if (slot.startsWith('batch/') && old.details.n === approval.batch.n && old.details.epoch < approval.batch.epoch) await journal.retireBatch(slot, reads);
        }
        for (const slot of approval.slots.filter(s => s.startsWith('batch/'))) {
          const old = journal.slots.get(slot);
          if (old && old.digest !== approval.digest) await journal.retireBatch(slot, reads);
        }
        const saved = journal.slots.get(approval.slots[0]);
        if (saved && approval.slots[0].startsWith('mint/') && saved.digest === approval.digest) {
          const result = signedFor(saved);
          check(result, 'permit_recovery_required');
          return { id: saved.session, digest: saved.digest, recovered: true };
        }
        // A write/sync error is ambiguous even if the in-memory journal was
        // not updated. Only a successful journal reload can resolve it.
        uncertainPreparations.add(ceremony.id);
        await journal.reserve(approval.slots, approval.digest, ceremony.id, approval.details);
        uncertainPreparations.delete(ceremony.id);
        const peers = config.thresholdMembers ? ceremony.peers.map(p => { const member = config.thresholdMembers.find(m => m.signer === p.id); check(member, 'threshold_roster'); return member.peer; }) : ceremony.peers;
        const start = { id: ceremony.id, kind: 'sign', network: config.network, epoch: config.tssEpoch ?? config.epoch, digest: approval.digest, peers, newPeers: [], timeout: 180 };
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
        if (session.status === 'aborted') { await journal.append('aborted', { session: body.id, reason: session.error }); active = null; }
        return { status: session.status, error: session.error };
      }
      if (path === '/abort') { check(active?.id === body.id, 'ceremony_id'); await rpc(config.sidecar, secrets.sidecarToken, '/abort'); await journal.append('aborted', { session: body.id, reason: 'operator_abort' }); active = null; return { ok: true }; }
      throw Error('route');
    };
    const handle = (path, body) => {
      const result = queue.then(async () => {
        try {
          const result = await (reads.withAction ? reads.withAction(() => perform(path, body)) : perform(path, body));
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
    return { handle, async close() { closed = true; await queue; if (active) await rpc(config.sidecar, secrets.sidecarToken, '/abort').catch(() => {}); await replay.close(); await journal.close(); await lock.close(); await unlink(lockPath); } };
  } catch (error) { await replay?.close(); await journal?.close(); await lock.close(); await unlink(lockPath); throw error; }
}

export async function serveSigner(configPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
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
      for await (const chunk of req) { length += chunk.length; check(length <= 4 << 20, 'body_limit'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const result = await signer.handle(req.url, body); res.end(JSON.stringify(result));
    } catch (error) { res.statusCode = error.message === 'authentication' ? 403 : 409; res.end(JSON.stringify(signerError(error))); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 5000; server.maxConnections = 32;
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
