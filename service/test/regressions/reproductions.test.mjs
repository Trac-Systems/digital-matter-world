import { BUILD as configuredBuildRoot } from '../../../local/common.mjs';
import { feeFixture } from '../helpers.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';
import { Files } from '../../src/files.mjs';
import { Pipeline } from '../../src/pipeline.mjs';
import { Intake } from '../../src/intake.mjs';
import { Mints, payerDigest } from '../../src/mints.mjs';
import { MintOperations } from '../../src/operations.mjs';
import { Committee, post } from '../../src/committee.mjs';
import { rules, initialState } from '../../src/rules.mjs';
import { hash, heightKey } from '../../src/util.mjs';
import { network, secret, fixtureHistory, agent, signEd, patterns, makeMove, attestRoot, receiptSigners } from '../helpers.mjs';

const root = `${configuredBuildRoot}/service/regressions/reproduction-data`;
async function store() { await mkdir(root, { recursive: true }); return Store.open(await mkdtemp(join(root, 'case-'))); }
function pipeline(s, extra = {}) {
  const history = fixtureHistory(200), intake = new Intake({ store: s, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
  return new Pipeline({ store: s, files: new Files(join(s.directory, 'static')), history, intake,
    reads: { batchLast: async () => ({ n: 0, to: 0 }), committeeEpoch: async () => 0, batchHeaders: async () => [], balance: async () => '10', nonceUsed: async () => false },
    committee: { attestRoot }, patterns, settings: { puzzleBits: 0, receiptSigners }, ...extra });
}
const observe = (p, tip) => p.intake.observe({ tip, hash: p.history.hashAt(tip), counted: tip - 5, confirmed: tip - 5 });

test('missed receipt quorum publishes missed evidence and permits recovery', async () => {
  const s = await store(); let witnesses = 0;
  const p = pipeline(s, { committee: { ready: async () => true, attestRoot: async () => { witnesses++; throw Error('receipt_quorum_unavailable'); } } });
  try {
    await observe(p, 6); await p.intake.accept(rules.stableJSON(makeMove(p.history, 6)));
    for (let tip = 7; tip <= 10; tip++) await observe(p, tip);
    const draft = await p.build(); assert.ok(draft); assert.equal(witnesses, 1);
    assert.equal(draft.items[0].input.entries.length, 0); assert.equal(draft.items[0].originalEntries.length, 1);
    assert.equal(s.count('missedReceipts'), 1); assert.equal(s.get('receiptObservations', `6/${p.history.hashAt(6)}`).seal.count, 1);
  } finally { await p.close(); await s.close(); }
});

for (const revisit of [false, true]) test(`512 stalled ${revisit ? 'branch revisits' : 'frozen observations'} recover with explicit retained outcomes`, async () => {
  const s = await store(), p = pipeline(s);
  try {
    await p.intake.observe({ tip: 6, hash: p.history.hashAt(6), counted: 0, confirmed: 0 });
    for (let i = 0; i < 512; i++) { if (revisit) await p.intake.observe({ tip: i % 2 ? 5 : 6, hash: p.history.hashAt(i % 2 ? 5 : 6), counted: 0, confirmed: 0, force: true }); else await p.intake.seal(); }
    await p.intake.observe({ tip: 7, hash: p.history.hashAt(7), counted: 1, confirmed: 1 }); await p.intake.seal();
    const draft = await p.build(); assert.ok(draft); assert.ok(draft.items.length <= 512); assert.equal(draft.proposal.batch.to, 1);
    assert.ok(s.count('observationRecovery') > 0);
  } finally { await p.close(); await s.close(); }
});

test('a craft that expired during recovery is rejected without aborting the draft', async () => {
  const s = await store(), table = [...patterns, { ...patterns[0], number: 1, name: 'dmwother' }], p = pipeline(s, { patterns: table });
  try {
    const who = agent(), output = rules.compound('fusion', table.map(x => ({ asset: rules.patternAsset(x), amount: '1', properties: rules.patternProperties(x) })), 2);
    const request = { owner: who.address, in: [['p0', '1'], ['p1', '1']], out: [[output.id, '1']], nonce: hash('expired-craft'), until: 2 };
    await observe(p, 6);
    const move = rules.solveMove({ v: 1, network, a: who.address, t: 'craft', b: 6, h: p.history.hashAt(6), p: { recipe: 'fusion', request, sig: rules.signRequest('xc', network, request, who.secret) } }, who.secret, 0);
    await p.intake.accept(rules.stableJSON(move));
    for (let tip = 7; tip <= 10; tip++) await observe(p, tip);
    const draft = await p.build(); assert.ok(draft); assert.equal(draft.items[0].output.file.moves[0].reason, 'request_expired'); assert.equal(draft.proposal.batch.ops.some(o => o.op === 'xc'), false);
  } finally { await p.close(); await s.close(); }
});

function mintFixture(s) {
  const who = agent(), receiver = 'bcrt-local-receiver'; let counted = 100;
  const context = { deployment: { id: hash('deployment') + 'i0', kind: 'compound', tick: 'dmwc0', active: true,
    privilegePublicKey: '02' + '11'.repeat(32), decimals: 0, remaining: '100', limit: '0' }, tier: 1, treasury: 'treasury', firstMakerAddress: 'maker' };
  const reads = { ...feeFixture({ store: s }), counted: async () => counted, assetContext: async () => context, balance: async () => '2', nonceUsed: async () => false,
    pending: async () => null, pendingAcceptance: async () => null, mintExit: async () => null, cancellation: async () => null };
  const operations = new MintOperations({ store: s, network, reads });
  const mints = new Mints({ store: s, network, reads, operations, committee: { enroll: async () => hash('release') },
    payments: {mint:async row=>({requestId:row.id,payer:row.payer,kind:row.kind,fees:row.quote.fees,receipts:[]})} });
  function body(i) {
    const request = { owner: who.address, asset: 'c0', amount: '2', receive: hash(receiver), nonce: hash('nonce-' + i), until: 200, expires: 532 };
    const b = { request, signature: rules.signRequest('rq', network, request, who.secret), receiver, payer: 'local-payer', kind: 'tap' };
    b.authorization = signEd(payerDigest(network, b), who.secret); return b;
  }
  return { who, reads, mints, operations, body, setCounted: n => counted = n };
}

test('two individually valid mint admissions reserve balances and isolate stale admissions', async () => {
  const s = await store(), f = mintFixture(s);
  const p = pipeline(s, { operations: f.operations, reads: { ...f.reads, batchLast: async () => ({ n: 0, to: 0 }), committeeEpoch: async () => 0, batchHeaders: async () => [] } });
  try {
    await f.mints.request(f.body(1)); await assert.rejects(f.mints.request(f.body(2)), /mint_balance/);
    // Model a balance change after admission with another already-durable request.
    const b = f.body(2), id = rules.pendingId(network, b.request);
    await s.transact([{ space: 'mints', id, value: { ...s.list('mints')[0].value, id, request: b.request, signature: b.signature, op: { op: 'rq', request: b.request, sig: b.signature } } }, { space: 'activeMints', id, value: true }]);
    await f.mints.tick();
    assert.equal(s.count('mintInputs'), 2);
    await observe(p, 105); await p.intake.seal();
    const draft = await p.build(); assert.ok(draft); assert.equal(draft.proposal.batch.ops.filter(o => o.op === 'rq').length, 1); assert.equal(s.count('mintRejected'), 1);
  } finally { await p.close(); await s.close(); }
});

test('an unpaid never-prepared mint releases routine capacity after authoritative expiry', async () => {
  const s = await store(), f = mintFixture(s);
  try {
    const result = await f.mints.request(f.body(1)), row = s.get('mints', result.id);
    await f.mints.save({ ...row, created: 100, expiry: 532, state: 'awaiting_payment' });
    f.reads.pendingAcceptance = async () => ({ id: result.id, created: 100, expiry: 532 });
    f.setCounted(317); await f.mints.tick(); assert.equal(f.mints.public(result.id).state, 'awaiting_payment');
    f.setCounted(600); await f.mints.tick(); await f.mints.tick();
    assert.equal(f.mints.public(result.id).state, 'expired'); assert.equal(s.count('activeMints'), 0);
    assert.deepEqual(await f.operations.inputs({ counted: 600, last: {}, files: [], view: {}, limit: 8 }), []);
    assert.equal(s.count('mintInputs'), 0);
  } finally { await s.close(); }
});

test('expired unaccepted rq inputs retire and free the bounded queue', async () => {
  const s = await store(), f = mintFixture(s);
  try {
    for (let i = 0; i < 256; i++) {
      const b = f.body(i), id = rules.pendingId(network, b.request);
      await s.put('mints', id, { id, request: b.request, signature: b.signature, receiver: b.receiver, state: 'expired' });
      await f.operations.ensure('rq/' + id, { op: 'rq', request: b.request, sig: b.signature });
    }
    assert.deepEqual(await f.operations.inputs({ counted: 600, files: [], last: {}, view: {}, limit: 8 }), []);
    assert.equal(s.count('mintInputs'), 128); assert.equal(s.count('mintRejected'), 128);
    // Maintenance retires one configured page per turn, then resumes at the
    // next key so a full queue cannot monopolize the batch builder.
    assert.deepEqual(await f.operations.inputs({ counted: 600, files: [], last: {}, view: {}, limit: 8 }), []);
    const b = f.body(256), id = rules.pendingId(network, b.request);
    await s.put('mints', id, { id, request: b.request });
    assert.equal(s.count('mintInputs'), 0); assert.equal(s.count('mintRejected'), 256);
    await f.operations.ensure('rq/' + id, { op: 'rq', request: b.request }); assert.equal(s.count('mintInputs'), 1);
  } finally { await s.close(); }
});

test('health selection contacts available replacement members', async () => {
  const s = await store(), calls = [];
  const signers = Array.from({ length: 5 }, (_, i) => ({ id: 's' + i, url: 'http://127.0.0.1:' + (59000 + i), token: 'test-only', peer: { id: 's' + i } }));
  const fetchMock = mock.method(globalThis, 'fetch', async url => {
    const i = new URL(url).port - 59000; calls.push([i, new URL(url).pathname]);
    if (i === 0) throw Error('offline');
    return new Response(JSON.stringify({ id: 's' + i, network, epoch: 1 }), { status: 200 });
  });
  try {
    const c = new Committee({ store: s, network, signers }), id = hash('request');
    await s.put('release', id, { package: {}, enrolled: signers.map(s => s.id) }); await s.put('ceremonies', 'mint/' + id, { stage: 'complete', peers: ['s0', 's1', 's2'], result: { certificate: {} } });
    assert.equal(await c.ready(), true);
    assert.equal(calls.filter(([, p]) => p === '/health').length, 5); assert.ok(calls.some(([i]) => i === 4));
  } finally { fetchMock.mock.restore(); await s.close(); }
});





test('cumulative receipt state exceeds the journal frame and is paged without poisoning the store', async () => {
  const s = await store(); let seals = {};
  try {
    for (let i = 0; i < 20000; i++) seals = rules.recordSet(seals, `${i}/${hash('block-' + i)}`, hash('receipt-' + i));
    const state = { ...initialState(6, hash('start'), 1), receiptSeals: seals };
    const bytes = Buffer.byteLength(JSON.stringify(state)); assert.ok(bytes > 4_000_000);
    await s.put('meta', 'ruleState', state);
    assert.equal(rules.recordGet(s.get('meta', 'ruleState').receiptSeals, `19999/${hash('block-19999')}`), hash('receipt-19999'));
    await s.put('meta', 'workerStatus', {});
    const { archiveState, hotState, hydrateState } = await import('../../src/replay-state.mjs');
    await archiveState(s, state);
    await s.put('meta', 'ruleState', hotState(state)); assert.ok(JSON.stringify(s.get('meta', 'ruleState')).length < 4000);
    const loaded = hydrateState(s, s.get('meta', 'ruleState'), [{ tip: 19999, hash: hash('block-19999') }]);
    assert.equal(rules.recordGet(loaded.receiptSeals, `19999/${hash('block-19999')}`), hash('receipt-19999'));
    console.log(JSON.stringify({ evidence: 'receipt-pagination', receiptTips: 20000, bytes }));
  } finally { await s.close(); }
});

test('accepted mint cleanup is inside the atomic draft commit', async () => {
  const s = await store(), f = mintFixture(s); let acceptedCalls = 0, last = { n: 0, to: 0 };
  f.operations.accepted = async () => { acceptedCalls++; throw Error('crash-boundary'); };
  const p = pipeline(s, { operations: f.operations,
    reads: { ...f.reads, batchLast: async () => last, committeeEpoch: async () => 0, batchHeaders: async () => [] },
    committee: { attestRoot, signature: async () => ({ signature: { compact: 'ab'.repeat(64) } }) },
    outbox: { enqueue: async key => s.put('sent', key, { accepted: true }), tick: async () => {} } });
  try {
    await f.mints.request(f.body(1)); await f.mints.tick();
    await observe(p, 105); await p.intake.seal();
    await p.tick();
    assert.equal(s.get('meta', 'draft'), null); assert.equal(s.count('observations'), 0); assert.equal(s.count('mintInputs'), 0);
    last = { n: 1, to: 100 }; f.setCounted(101);
    p.reads.nonceUsed = async () => true; f.reads.nonceUsed = async () => true;
    await observe(p, 106); await p.intake.seal();
    await p.tick(); assert.equal(acceptedCalls, 0); assert.equal(s.count('mintInputs'), 0);
  } finally { await p.close(); await s.close(); }
});

test('committee response bound cancels the response stream at the byte limit', async () => {
  let consumed = 0, cancelled = false;
  const f = mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ pull(controller) { consumed++; controller.enqueue(new Uint8Array(1000000)); }, cancel() { cancelled = true; } })));
  try { await assert.rejects(post({ url: 'http://127.0.0.1:59000', token: 'test-only' }, '/status', {}), /committee_response_limit/); assert.ok(consumed <= 6); assert.equal(cancelled, true); }
  finally { f.mock.restore(); }
});
