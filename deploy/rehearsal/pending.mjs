import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { product, save } from '../../service/load/common.mjs';

// LT1 extension: an actual v1 receipt, a pinned import, and ordinary witnessed
// v2 batches through the real notary. Uses only the disposable synthetic
// baseline's committee key. Never substitutes test authority in a host export.
export async function pendingDiscoveryProbe({ snapshot, directory, history, tip, network, secret, document, oldSaved }) {
  assert.equal(snapshot.descriptor.synthetic, true, 'pending_host_rehearsal_adapter_required');
  const [r, { Store }, { Intake }, { preparePendingWork }, { prepareTerminalImport }, { installGatewayActivation, createV2Runtime },
    { harness, committeeSecret }, { Pipeline }, { Files }, { Outbox }, { rebuildBatch }, { edPublic }, { ed25519 }, { secp256k1 }] = await Promise.all([
    product('rules/src/index.js'), product('service/src/store.mjs'), product('service/src/intake.mjs'), product('service/src/pending-work.mjs'),
    product('service/src/terminal-import.mjs'), product('service/src/v2-runtime.mjs'), product('contract/tests/helpers/harness.mjs'),
    product('service/src/pipeline.mjs'), product('service/src/files.mjs'), product('service/src/transport.mjs'), product('committee/signer/adapter.mjs'),
    product('service/src/util.mjs'), product('rules/node_modules/@noble/curves/ed25519.js'), product('contract/node_modules/@noble/curves/secp256k1.js')]);
  const data = join(directory, 'pending-job-copy'); await cp(join(snapshot.source, 'gateway'), data, { recursive: true, errorOnExist: true });
  const store = await Store.open(data); let pipeline; const journals = [], receiptFences = [];
  const [{ Journal }, { ReceiptFences }] = await Promise.all([product('committee/signer/journal.mjs'), product('committee/signer/receipt-fences.mjs')]);
  try {
    assert.equal(oldSaved.options.committee, secp256k1.getPublicKey(committeeSecret, true).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''), 'pending_disposable_committee');
    const player = r.hashBytes('pm1-retained-discovery-player'), owner = r.bytesToHex(ed25519.getPublicKey(player));
    const pattern = { number: 0, name: 'dmwpriorpattern', pat: '[0-9]', fld: 4, dt: 'n', rarity: 10, total: 10, tier: 5,
      discoverer: owner, historyHeight: tip - 1, historyHash: history.hashAt(tip - 1) };
    const round = { window: tip, windowHash: history.hashAt(tip), claimableHeight: tip,
      slots: [1, 2].flatMap(h => r.legacyRules.slotsFor(history.get(h), [pattern])),
      claims: [1, 2].map(block => ({ agent: owner, window: tip, block, patterns: [0] })), headerSenders: [], seedHash: null, closed: false };
    assert(round.slots.length > 0, 'pending_claim_fixture');
    await store.put('meta', 'patterns', [pattern]);
    await store.put('meta', 'ruleState', { ...store.get('meta', 'ruleState'), rounds: [round], lastTip: tip, highestTip: tip });
    const proposal = { name: 'dmwretained', pat: '[123]', fld: 4, dt: 'n' }, salt = r.hash('pm1-retained-discovery-salt');
    const commitment = r.legacyRules.discoveryCommitment(proposal, salt, owner), old = new Intake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
    await old.observe({ tip, hash: history.hashAt(tip), counted: tip, confirmed: tip });
    const move = r.solveMove({ v: 1, network, a: owner, t: 'discovery-commit', b: tip, h: history.hashAt(tip), p: { commitment } }, player, 0);
    const receipt = await old.accept(r.stableJSON(move)), preserved = store.get('dedupe', r.moveId(move));
    const readers = { gateway: edPublic(secret), history, hashAt: history.hashAt, legacySettings: { puzzleBits: 0 } };
    const anchor = { height: String(tip), hash: history.hashAt(tip) }, last = snapshot.descriptor.accepted;
    const plans = Array.from({ length: 5 }, () => preparePendingWork({ store, network, document, anchor, lastTo: last.to, ...readers }));
    assert.equal(new Set(plans.map(p => p.root)).size, 1);
    const pendingWork = plans[0], imported = prepareTerminalImport({ records: new Map(oldSaved.records), network, height: tip, pendingWork });
    const manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: String(Number(last.n) + 1),
      previousBatchRoot: new Map(oldSaved.records).get('bt/' + last.n), bitcoinAnchor: anchor, settingsHash: r.hashObject(document),
      catalogRoot: r.namedStateRoot(pendingWork.named), accountsRoot: imported.financialRoot, receiptSegmentStart: '0',
      schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
    const manifestHash = r.hashObject(manifest), contract = harness({ ...oldSaved.options, v2: { manifest, manifestHash, document, importRoot: imported.importRoot, importRows: imported.importRows } });
    for (const page of imported.pages) assert.equal(await contract.run('ad_import', page), null);
    await installGatewayActivation({ store, document, imported, manifest, manifestHash, named: pendingWork.named, ...readers });
    const start = tip, members = Array.from({ length: 5 }, (_, i) => {
      const key = r.hashBytes('pm1-disposable-witness/' + i); return { id: 'pm1-' + i, key, peer: { id: 'pm1-' + i, identity: r.bytesToHex(ed25519.getPublicKey(key)) } };
    });
    const rulesContext = async () => ({ ready: true, manifest, manifestHash, settings: document, settingsHash: r.hashObject(document), last: await contract.state().batchLast(),
      catalogRoot: contract.db.get('v2/catalog'), accountsRoot: contract.db.get('v2/accounts'), claimsRoot: contract.db.get('v2/claims') });
    let approvals = 0;
    const committee = { acknowledgeReceipt: (receipt, checkpoint) => Promise.all(receiptFences.map(f => f.admit(receipt, checkpoint))), healthy: async () => members, attestRoot: async root => members.slice(0, 3).map(m => r.attestReceiptRoot(root, root.tip, m.id, m.key)),
      signature: async (_, proposal) => {
        const d = await pipeline.loadDraft(), context = { authority: { epoch: 0 }, counted: tip, last: await contract.state().batchLast(),
          state: d.startState, patterns: d.startPatterns, gateway: edPublic(secret), history, hashAt: history.hashAt, settings: d.settings, limits: d.limits,
          inputs: d.items.map(i => i.input), activation: d.activation, previousRoot: d.previousRoot };
        const results = members.map((_, i) => { const result = rebuildBatch(network, proposal, { ...context, state: structuredClone(context.state) }); receiptFences[i].checkBatch(proposal.batch, result.files); return result; });
        assert.equal(new Set(results.map(a => a.digest)).size, 1); approvals += 5;
        return { signature: { compact: secp256k1.sign(results[0].digest, committeeSecret, { prehash: false, lowS: true }).toCompactHex() } };
      } };
    const reads = { rulesContext, counted: async () => tip, batchLast: () => contract.state().batchLast(), batchRoot: async n => contract.db.get('bt/' + n) ?? null,
      committeeEpoch: async () => 0, settings: () => contract.state().settings() };
    for (const member of members) {
      const journal = await new Journal(join(data, member.id + '.log'), 'disposable-pending-probe', network, member.id).load(); journals.push(journal);
      receiptFences.push(new ReceiptFences({ journal, reads: { ...reads, tip: async () => ({ tip }), authority: async () => ({ epoch: 0 }) }, network, gateway: edPublic(secret), signer: member.id, secret: member.key, members: members.map(m => m.peer) }));
    }
    const resources = r.resourceRevision({ operator: 'PM1 rehearsal', values: { ...r.RESOURCE_PROFILE } });
    const runtime = await createV2Runtime({ config: { network, committee: members, v2: { manifest, manifestHash, document, resources } }, store, secret, history, reads, committee });
    const transport = { prepareMessage: async (op, value) => ({ op, value }), sendMessage: async m => assert.equal(await contract.run(m.op, m.value), null),
      status: async job => ({ state: contract.db.get('bt/' + job.value.n) === job.value.root ? 'accepted' : 'pending' }) };
    const replayHistory = { length: history.length, get: h => history.get(h), field: (...args) => history.field(...args), raw: h => history.raw(h), hashAt: history.hashAt };
    pipeline = new Pipeline({ store, files: new Files(join(data, 'static')), history: replayHistory, intake: runtime.intake, reads, committee,
      settings: runtime.settings, outbox: new Outbox({ store, transport, retryMs: 0 }) });
    const drain = async () => {
      for (let n = 0; n < 100; n++) { await pipeline.tick(); await runtime.refresh(); if (!store.hasRows('observations') && !store.get('meta', 'draft') && !store.get('meta', 'namedReservedBatch')) return; }
      throw Error('pending_rehearsal_no_progress');
    };
    for (; tip <= start + 2; tip++) {
      if (tip > start) assert.equal(await contract.run('hd', { headers: [Buffer.from(history.raw(tip)).toString('hex')] }), null);
      await runtime.intake.observe({ tip, hash: history.hashAt(tip), counted: tip, confirmed: tip });
      await runtime.intake.seal(); await drain();
    }
    tip = start + 2;
    const matches = [1, 2, 3].map(h => ({ height: String(h), hash: history.hashAt(h), count: '1' }));
    const reveal = { v: 2, ruleset: 'dmw-v2', settingsRevision: document.revision, settingsHash: r.hashObject(document), network, a: owner,
      t: 'discovery-reveal-v2', b: String(tip), h: history.hashAt(tip), p: { proposal, salt, commitmentId: commitment, anchor, matches, witnessRoot: r.witnessRoot(matches) }, w: '0', sig: '00'.repeat(64) };
    reveal.sig = r.bytesToHex(ed25519.sign(r.moveDigestV2(reveal), player));
    await runtime.intake.accept(r.stableJSON(reveal)); await drain();
    const record = store.get('patternsByAsset', 'p2:1'); assert.equal(record.name, proposal.name); assert.equal(record.discoverer, owner);
    const winners = r.legacyRules.settleClaims({ ...round, counted: start + 2, decidingHash: history.hashAt(start + 2) }).winners;
    for (const winner of winners) {
      const find = store.get('finds', r.findIdV2(String(winner.block), String(winner.pattern)));
      assert.equal(find.finder, winner.winner); assert.equal(find.asset, winner.asset); assert.equal(find.count, winner.count);
    }
    assert(!store.get('meta', 'ruleState').rounds.some(row => row.legacy), 'pending_claims_not_delivered');
    assert.deepEqual(store.get('dedupe', r.moveId(move)), preserved);
    assert.deepEqual(store.get('legacyReceiptResults', r.moveId(move)).receipt, receipt);
    const result = { preserved: true, migrated: true, completed: true, pendingRoot: pendingWork.root, signerDerivations: 5,
      replayApprovals: approvals, acceptedV2: Number((await contract.state().batchLast()).n) - Number(last.n),
      pattern: record.name, commitment, originalEligible: String(start + 2), originalExpires: String(start + 144), legacyClaimWinners: winners.length,
      coverage: 'legacy discovery receipt and open claim window through actual v2 acceptance; other pending kinds are separate gates' };
    await save(join(directory, 'retained-job.json'), result); return result;
  } finally { await pipeline?.close(); for (const journal of journals) await journal.close(); await store.close(); }
}
