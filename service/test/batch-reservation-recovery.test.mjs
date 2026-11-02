import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '../../committee/node_modules/@noble/curves/secp256k1.js';
import { createSigner } from '../../committee/signer/service.mjs';
import { fixture, batchFixture } from '../../committee/test/fixture.mjs';
import { publicClaimBatch } from '../../committee/test/public-claim-batch-fixture.mjs';
import { Committee } from '../src/committee.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { Store } from '../src/store.mjs';
import { hash } from '../src/util.mjs';
import { rules } from '../src/rules.mjs';

// Real signer policy + durable journals, with the same local sidecar fixture
// used by committee/test/batch-attempt-retry.test.mjs. No external services.
async function setup(t, { v2 = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dmw-batch-reservations-'));
  let store = await Store.open(join(directory, 'gateway'));
  const b = v2 ? publicClaimBatch({ supplied: null }) : batchFixture(), network = b.proposal.network, contexts = new Map();
  let published = b.context;
  if (!v2) {
    b.context.last.n = 5262;
    b.proposal.batch = rules.buildBatch({ network, epoch: 0, sequence: 5263, lastTo: b.context.last.to,
      executionHeight: b.context.counted, files: b.proposal.files.map(file => rules.decodeBinary(Buffer.from(file, 'hex'))) }).batch;
  }
  const members = Array.from({ length: 5 }, (_, i) => ({ id: 'op' + (i + 1) }));
  const signers = [], servers = [], states = [], configs = [], calls = [];
  let counted = v2 ? '1202' : 96, offline = new Set(), busy = new Set(), fenceOffline = new Set(), beforeFence;
  const gatewayReads = { batchLast: async () => b.context.last, committeeEpoch: async () => b.proposal.batch.epoch, counted: async () => counted, batchRoot: async () => null };
  t.after(async () => {
    for (const signer of signers) await signer.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await store.close(); await rm(directory, { recursive: true });
  });
  for (let i = 0; i < 5; i++) {
    const f = fixture(), state = { failPrepare: true, session: null }; states.push(state);
    if (v2) Object.assign(f.reads, b.reads, { authority: async () => ({ network, committee: f.publicKey, epoch: '0' }) });
    f.reads.counted = gatewayReads.counted; f.reads.batchContext = async () => published;
    f.reads.batchLast = gatewayReads.batchLast; f.reads.batchRoot = gatewayReads.batchRoot;
    f.reads.tip = async () => ({ tip: v2 ? rules.addUint(counted, '5') : Math.max(100, counted + 5) });
    f.reads.preflight = async (batch, at) => ({ ok: true, ...at, digest: Buffer.from(rules.batchDigest(network, batch)).toString('hex') });
    const server = createServer(async (req, res) => {
      let bytes = ''; for await (const chunk of req) bytes += chunk; const body = JSON.parse(bytes || '{}');
      if (req.url === '/prepare') {
        if (state.failPrepare) { res.writeHead(409).end('{"error":"session_missing"}'); return; }
        state.session = { id: body.id, status: 'prepared', digest: body.digest };
      }
      if (req.url === '/abort') state.session = null;
      if (req.url === '/go') {
        const signature = secp256k1.sign(state.session.digest, new Uint8Array(32).fill(2), { prehash: false, lowS: true });
        state.session = { ...state.session, status: 'complete', signature: { compact: signature.toCompactHex(), r: String(signature.r), s: String(signature.s), v: signature.recovery } };
      }
      if (req.url === '/result') { res.writeHead(409).end('{"error":"session_missing"}'); return; }
      res.end(JSON.stringify({ public: f.publicKey, epoch: 1, session: state.session }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
    const config = { directory: join(directory, members[i].id), network, id: members[i].id, epoch: 1, members,
      sidecar: 'http://127.0.0.1:' + server.address().port,
      ...(v2 ? { resources: rules.resourceRevision({ operator: members[i].id, values: rules.RESOURCE_PROFILE }) } : {}) };
    configs.push(config); signers.push(await createSigner(config, { journalKey: 'local-test', sidecarToken: 'local-test' }, f.reads));
  }
  const makeCommittee = () => {
    const c = new Committee({ store, network, signers: members.map(peer => ({ id: peer.id, peer })), batchRetryMs: 1, historyPage: 1 });
    c.request = async (member, path, body) => {
      calls.push({ signer: member.id, path, body });
      if (offline.has(member.id)) throw Error('committee_http_timeout');
      if (fenceOffline.has(member.id) && path === '/retire-batch-attempt') throw Error('committee_http_timeout');
      if (busy.has(member.id) && path === '/prepare') throw Object.assign(Error('committee_signer_busy'), { unreserved: true });
      if (path === '/retire-batch-attempt') await beforeFence?.(member, body);
      try { return await signers[members.findIndex(m => m.id === member.id)].handle(path, body); }
      catch (error) { throw Object.assign(Error('committee_' + error.message), { unreserved: !!error.unreserved }); }
    };
    return c;
  };
  let committee = makeCommittee();
  const pipeline = new Pipeline({ store, committee, reads: gatewayReads, replay: { close: async () => {} }, archiveWritePage: 1 });
  const key = `batch/${b.proposal.batch.epoch}/${b.proposal.batch.n}`;
  const draft = (name, deadline, execution = v2 ? '1201' : 95) => {
    if (!v2) return { version: 3, execution, proposal: { ...b.proposal, batch: { ...b.proposal.batch, deadline } }, fixtureName: name };
    const context = { ...b.context, counted: execution }, output = rules.processBlockV2({ ...context.inputs[0], ...context, network, executionHeight: execution });
    const built = rules.buildBatchV2({ network, epoch: '0', sequence: '3', lastTo: context.last.to, previousRoot: context.previousRoot,
      files: [output.file], executionHeight: execution, executionHash: context.hashAt(execution), deadline, settings: context.settings,
      activation: context.activation, catalogRoot: output.state.catalogRoot, accountRoot: output.state.accountRoot });
    const proposal = { network, kind: 'batch', batch: built.batch, files: built.fileBytes.map(rules.bytesToHex) };
    const draft = { version: 3, execution, proposal, settings: context.settings, fixtureName: name };
    contexts.set(digest(draft), context); return draft;
  };
  const digest = draft => Buffer.from(rules.batchDigest(network, draft.proposal.batch)).toString('hex');
  const attempt = draft => ({ id: hash(draft.fixtureName), proposal: draft.proposal, digest: digest(draft),
    stage: 'blocked', reason: 'prepare_incomplete', started: 0, peers: members.slice(0, 3).map(m => m.id) });
  const reserve = async (draft, holders, { archive = true } = {}) => {
    published = contexts.get(digest(draft)) ?? b.context;
    const session = attempt(draft);
    for (const i of holders) {
      const peers = [members[i], ...members.filter(m => m.id !== members[i].id).slice(0, 2)];
      await assert.rejects(signers[i].handle('/prepare', { proposal: draft.proposal, ceremony: { id: session.id, epoch: 1, peers } }), /session_missing/);
    }
    await pipeline.saveDraft(draft); await store.put('ceremonies', key, session);
    if (archive) await pipeline.archiveDraft(draft, { reason: 'execution_snapshot_changed' });
    return session;
  };
  const current = async draft => {
    published = contexts.get(digest(draft)) ?? b.context;
    const session = { ...attempt(draft), retryPrepare: true, unreserved: members.slice(0, 3).map(m => m.id) };
    delete session.digest;
    await pipeline.saveDraft(draft); await store.put('ceremonies', key, session);
    return session;
  };
  const due = async () => {
    const session = store.get('ceremonies', key);
    if (session) await store.put('ceremonies', key, { ...session, started: 0, lastReset: 0,
      ...(session.recovery ? { recovery: { ...session.recovery, checkedAt: 0 } } : {}) });
  };
  const finish = async draft => {
    published = contexts.get(digest(draft)) ?? b.context;
    states.forEach(s => { s.failPrepare = false; });
    assert.equal(await committee.signature(key, draft.proposal), null);
    const result = await committee.signature(key, draft.proposal);
    assert.ok(result?.signature);
    assert.equal(secp256k1.verify(result.signature.compact, digest(draft), fixture().publicKey, { prehash: false, lowS: true }), true);
    return result;
  };
  return { get store() { return store; }, pipeline, signers, members, key, draft, digest, reserve, current, due, calls, finish, configs,
    get committee() { return committee; }, setCounted: value => { counted = value; },
    setOffline: ids => { offline = new Set(ids); }, setBusy: ids => { busy = new Set(ids); },
    setFenceOffline: ids => { fenceOffline = new Set(ids); },
    beforeFence: fn => { beforeFence = fn; },
    allowSigning: () => states.forEach(s => { s.failPrepare = false; }),
    restartGateway: async () => { committee.close(); await store.close(); store = await Store.open(join(directory, 'gateway'));
      committee = makeCommittee(); pipeline.store = store; pipeline.committee = committee; } };
}

test('5263: legacy first-three retries are refused; gateway restores the two-holder version and signs with op1/op2/op4', async t => {
  const f = await setup(t), earlier = f.draft('earlier', 100, 94), held = f.draft('held', 101), newest = f.draft('newest', 102, 96);
  await f.reserve(earlier, [2]); await f.reserve(held, [0, 1]);
  // Before this fix, archiving kept the ceremony only in the evidence file.
  for (const row of f.store.list('batchCeremonyAttempts')) await f.store.put('batchCeremonyAttempts', row.id);
  const latest = await f.current(newest);
  // This is the old selection and prepare path: all first three peers refuse
  // the replacement even though each refusal proves this NEW ID unreserved.
  for (let retry = 0; retry < 2; retry++) for (const member of f.members.slice(0, 3))
    await assert.rejects(f.committee.request(member, '/prepare', { proposal: newest.proposal,
      ceremony: { id: latest.id, epoch: 1, peers: f.members.slice(0, 3) } }), e => e.message === 'committee_batch_retirement_unproven' && e.unreserved);
  const reconciled = await f.pipeline.reconcileDraft(await f.pipeline.loadDraft());
  assert.deepEqual(reconciled.draft, held);
  assert.deepEqual(f.store.get('ceremonies', f.key).peers, ['op1', 'op2', 'op4']);
  assert.equal(f.store.get('ceremonies', f.key).digest, f.digest(held));
  await f.restartGateway();
  await f.finish(reconciled.draft);
  assert.equal(f.store.get('ceremonies', f.key).stage, 'complete');
  assert.deepEqual(await f.pipeline.loadDraft(), held);
  const records = (await readFile(join(f.configs[2].directory, 'signed.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(r => r.type === 'reserve').length, 1, 'conflicting op3 never receives a new reservation');
});

test('a held current draft survives a newer execution snapshot without replacement', async t => {
  const f = await setup(t), held = f.draft('held-current', 101);
  await f.reserve(held, [0, 1], { archive: false });
  assert.deepEqual((await f.pipeline.reconcileDraft(held)).draft, held);
  assert.equal(f.store.count('supersededDrafts'), 0);
  await f.finish(held);
});

test('an unreachable holder is unknown, and the reachable holder plus two empty signers recover', async t => {
  const f = await setup(t), held = f.draft('unreachable-held', 101), other = f.draft('unreachable-other', 100), newest = f.draft('unreachable-new', 102, 96);
  await f.reserve(other, [2]); await f.reserve(held, [0, 1]); await f.current(newest);
  f.setOffline(['op1']);
  assert.deepEqual((await f.pipeline.reconcileDraft(newest)).draft, held);
  assert.deepEqual(f.store.get('ceremonies', f.key).peers, ['op2', 'op4', 'op5']);
  await f.finish(held);
});

test('a busy empty signer is replaced by the other empty signer without changing the digest', async t => {
  const f = await setup(t), held = f.draft('busy-held', 101), other = f.draft('busy-other', 100), newest = f.draft('busy-new', 102, 96);
  await f.reserve(other, [2]); await f.reserve(held, [0, 1]); await f.current(newest);
  await f.pipeline.reconcileDraft(newest); f.setBusy(['op4']); f.allowSigning();
  // Holders can reserve even while the third member is busy.
  assert.equal(await f.committee.signature(f.key, held.proposal), null);
  await f.due();
  await f.pipeline.reconcileDraft(await f.pipeline.loadDraft());
  assert.deepEqual(f.store.get('ceremonies', f.key).peers, ['op1', 'op2', 'op5']);
  await f.finish(held);
});

test('all holders unreachable: retain the draft, expose the wait, and send no prepare retries', async t => {
  const f = await setup(t), held = f.draft('gone-held', 101), newest = f.draft('gone-new', 102, 96);
  await f.reserve(held, [0, 1, 2]); await f.current(newest); f.setOffline(['op1', 'op2', 'op3']);
  f.pipeline.build = () => assert.fail('a blocked slot must not rebuild');
  await f.pipeline.tick();
  const before = f.calls.filter(c => c.path === '/prepare').length;
  await f.pipeline.tick(); await f.due(); await f.pipeline.tick();
  const session = f.store.get('ceremonies', f.key);
  assert.equal(session.reason, 'batch_reservation_wait'); assert.equal(session.recovery.waiting, true);
  assert.equal(session.recovery.waitUntil, 101);
  assert.deepEqual(session.recovery.reservations.filter(r => r.unknown).map(r => r.signer), ['op1', 'op2', 'op3']);
  assert.equal(f.calls.filter(c => c.path === '/prepare').length, before);
  assert.deepEqual(await f.pipeline.loadDraft(), newest);
  f.setOffline([]); await f.due();
  assert.deepEqual((await f.pipeline.reconcileDraft(newest)).draft, held);
  await f.finish(held);
});

test('split reservations wait through the exact deadline, then the expired slots join a surviving version', async t => {
  const f = await setup(t), a = f.draft('split-a', 99), b = f.draft('split-b', 100), c = f.draft('split-c', 101);
  await f.reserve(a, [0, 1]); await f.reserve(b, [2, 3]); await f.reserve(c, [4], { archive: false });
  assert.equal((await f.pipeline.reconcileDraft(c)).waiting, true);
  assert.equal(f.store.get('ceremonies', f.key).recovery.waitUntil, 99);
  f.setCounted(99);
  assert.equal((await f.pipeline.reconcileDraft(c)).waiting, true, 'retirement requires counted > deadline');
  f.setCounted(100);
  const recovered = await f.pipeline.reconcileDraft(c);
  assert.deepEqual(recovered.draft, b);
  assert.deepEqual(f.store.get('ceremonies', f.key).peers, ['op3', 'op4', 'op1']);
  await f.finish(b);
  const records = (await readFile(join(f.configs[0].directory, 'signed.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.find(r => r.type === 'retired-batch').proof.counted, 100);
});

test('restart after archiving but before rebuilding restores a reserved version from disk', async t => {
  const f = await setup(t), held = f.draft('no-current-held', 101);
  await f.reserve(held, [0, 1]); await f.restartGateway();
  assert.equal(f.store.get('meta', 'draft'), null);
  assert.deepEqual((await f.pipeline.reconcileDraft(null)).draft, held);
  await f.finish(held);
});

test('a peer that times out while fencing is replaced on the next inventory pass', async t => {
  const f = await setup(t), held = f.draft('fence-held', 101), other = f.draft('fence-other', 100), newest = f.draft('fence-new', 102, 96);
  await f.reserve(other, [2]); await f.reserve(held, [0, 1]); await f.current(newest); f.setFenceOffline(['op4']);
  assert.equal((await f.pipeline.reconcileDraft(newest)).waiting, true);
  assert.equal(f.store.get('ceremonies', f.key).reason, 'batch_recovery_fencing');
  assert.deepEqual(f.store.get('ceremonies', f.key).recovery.fenceFailures, ['op4']);
  await f.due();
  assert.deepEqual((await f.pipeline.reconcileDraft(newest)).draft, held);
  assert.deepEqual(f.store.get('ceremonies', f.key).peers, ['op1', 'op2', 'op5']);
  await f.finish(held);
});

test('once every old deadline passes the gateway rebuilds and signers independently prove retirement', async t => {
  const f = await setup(t), old = f.draft('expired-held', 101), fresh = f.draft('after-expiry', 109, 103);
  await f.reserve(old, [0, 1, 2], { archive: false }); f.setCounted(102);
  assert.equal((await f.pipeline.reconcileDraft(old)).draft, null);
  f.setCounted(103); await f.pipeline.saveDraft(fresh); f.allowSigning();
  let result = await f.committee.signature(f.key, fresh.proposal, { counted: fresh.execution });
  result ??= await f.committee.signature(f.key, fresh.proposal, { counted: fresh.execution });
  assert.ok(result?.signature);
  for (const config of f.configs.slice(0, 3)) {
    const records = (await readFile(join(config.directory, 'signed.log'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.find(r => r.type === 'retired-batch').proof.counted, 103);
  }
});

test('v2 decimal batches restore the reserved execution anchor and exact file bytes', async t => {
  const f = await setup(t, { v2: true }), earlier = f.draft('v2-earlier', '1206', '1200'), held = f.draft('v2-held', '1207', '1201'), newest = f.draft('v2-newest', '1208', '1202');
  await f.reserve(earlier, [2]); await f.reserve(held, [0, 1]); await f.current(newest);
  const recovered = await f.pipeline.reconcileDraft(newest);
  assert.equal(recovered.draft.proposal.batch.execution.height, '1201');
  assert.deepEqual(recovered.draft.proposal.files, held.proposal.files);
  assert.deepEqual(f.store.get('ceremonies', f.key).peers, ['op1', 'op2', 'op4']);
  await f.finish(recovered.draft);
});

test('a late preparation discovered by fencing prevents replacement and is recovered on the next pass', async t => {
  const f = await setup(t), old = f.draft('late-old', 101), newest = f.draft('late-new', 102, 96);
  const attempt = await f.reserve(old, []); await f.current(newest); f.setCounted(97);
  f.beforeFence(async (member, body) => {
    if (member.id !== 'op1' || body.id !== attempt.id) return;
    f.beforeFence(null);
    await assert.rejects(f.signers[0].handle('/prepare', { proposal: old.proposal,
      ceremony: { id: attempt.id, epoch: 1, peers: f.members.slice(0, 3) } }), /session_missing/);
  });
  assert.equal((await f.pipeline.reconcileDraft(newest)).waiting, true);
  assert.deepEqual(await f.pipeline.loadDraft(), newest, 'the earlier empty inventory cannot authorize replacement');
  assert.equal(f.store.count('supersededDrafts'), 1);
  await f.due();
  assert.deepEqual((await f.pipeline.reconcileDraft(newest)).draft, old);
  assert.equal(f.store.get('ceremonies', f.key).peers[0], 'op1');
  await f.finish(old);
});

test('when both holders of the preferred version disappear the remaining reserved version signs', async t => {
  const f = await setup(t), a = f.draft('lost-a', 101), b = f.draft('lost-b', 100), newest = f.draft('lost-new', 102, 96);
  await f.reserve(b, [2]); await f.reserve(a, [0, 1]); await f.current(newest); f.setOffline(['op1', 'op2']);
  assert.deepEqual((await f.pipeline.reconcileDraft(newest)).draft, b);
  assert.deepEqual(f.store.get('ceremonies', f.key).peers, ['op3', 'op4', 'op5']);
  await f.finish(b);
});

test('an expired signed draft restores a still-live reserved version before rebuilding', async t => {
  const f = await setup(t), old = f.draft('signed-expired', 99), held = f.draft('signed-survivor', 102);
  await f.reserve(held, [3]); await f.reserve(old, [0, 1, 2], { archive: false });
  old.signature = secp256k1.sign(f.digest(old), new Uint8Array(32).fill(2), { prehash: false, lowS: true }).toCompactHex();
  await f.pipeline.saveDraft(old);
  await f.store.put('outbox', f.key, { value: old.proposal.batch });
  f.setCounted(100);
  assert.deepEqual((await f.pipeline.reconcileDraft(old)).draft, held);
  assert.equal(f.store.get('outbox', f.key), null);
  assert.deepEqual(f.store.get('ceremonies', f.key).peers, ['op4', 'op1', 'op2']);
  await f.finish(held);
});

test('a persisted wait with no attempted session clears once every old reservation expires', async t => {
  const f = await setup(t), old = f.draft('marker-old', 101), fresh = f.draft('marker-fresh', 109, 103);
  await f.reserve(old, [0, 1, 2]); await f.pipeline.saveDraft(fresh); f.setCounted(103);
  await f.store.put('ceremonies', f.key, { id: hash('wait-marker'), proposal: fresh.proposal, peers: [], stage: 'blocked',
    reason: 'batch_reservation_wait', recovery: { waiting: true, counted: 102, checkedAt: 0 } });
  await f.restartGateway();
  assert.deepEqual((await f.pipeline.reconcileDraft(fresh)).draft, fresh);
  assert.equal(f.store.get('ceremonies', f.key), null);
  f.allowSigning();
  let signed = await f.committee.signature(f.key, fresh.proposal, { counted: fresh.execution });
  signed ??= await f.committee.signature(f.key, fresh.proposal, { counted: fresh.execution });
  assert.ok(signed?.signature);
});
