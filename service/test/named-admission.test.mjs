import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { edPublic } from '../src/util.mjs';
import * as r from '../../rules/src/index.js';
import { NamedAdmission } from '../src/named-admission.mjs';
import { NamedStorage } from '../src/named-storage.mjs';
import { Intake } from '../src/intake.mjs';

const secret = r.hashBytes('disposable gateway'), wallet = r.hashBytes('disposable agent'), agent = edPublic(wallet);
const gateway = edPublic(secret), key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), wallet]), format: 'der', type: 'pkcs8' });
const settings = r.settingsRevision({ network: 'fixture', effectiveBatch: '43', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
const history = new r.SettingsHistory(); history.append(settings, r.hashObject(settings));
const resources = r.resourceRevision({ operator: 'fixture', values: { ...r.RESOURCE_PROFILE } });
class Store {
  rows = new Map(); reads = 0; fail = false;
  get(s, id) { this.reads++; return this.rows.get(s + '\0' + id); }
  async transact(ops) { if (this.fail) throw Error('test_disk_failure'); for (const o of ops) this.rows.set(o.space + '\0' + o.id, JSON.parse(JSON.stringify(o.value))); }
  list(s) { return [...this.rows].filter(([k]) => k.startsWith(s + '\0')).sort(([a], [b]) => a < b ? -1 : 1).map(([k, value]) => ({ id: k.slice(s.length + 1), value })); }
}
function packet(type, payload, tip, document = settings, account = { agent, key }) {
  const move = { v: 2, ruleset: 'dmw-v2', settingsRevision: document.revision, settingsHash: r.hashObject(document), network: 'fixture', a: account.agent, t: type,
    b: tip, h: r.hash(tip), p: payload, w: '0', sig: '0'.repeat(128) };
  move.sig = sign(null, r.moveDigestV2(move), account.key).toString('hex'); return move;
}
function setup() {
  const store = new Store(); let reads = 0;
  const headerView = { get length() { throw Error('history_scan'); }, get: height => { reads++; return { height, hash: r.hash(height), nonce: 111, bits: 1 }; } };
  const context = { ready: true, ruleset: 'dmw-v2', settings, settingsHistory: history, batch: '43', tip: '100', counted: '100',
    state: r.emptyNamedDiscovery(), acceptedRoot: r.namedStateRoot(r.emptyNamedDiscovery()), lastSequence: '0' };
  const make = () => new NamedAdmission({ store, secret, context: () => context, history: headerView, hashAt: r.hash, resources });
  const accept = async () => {
    const entries = store.list('namedIntake/' + context.batch).map(row => row.value), draft = store.get('namedDrafts', context.batch);
    const replay = r.replayNamedEntries(context.state, { entries, settings, settingsHistory: history, batch: context.batch, gateway, history: headerView, hashAt: r.hash, counted: context.counted, lastSequence: context.lastSequence });
    assert.ok(replay.outcomes.every(o => o.reason === 'accepted'));
    const persistence = new NamedStorage({ get: id => store.get('namedNodes', id), cacheSize: 16 });
    const cold = persistence.load(draft.snapshot); assert.equal(r.namedStateRoot(cold), replay.root);
    context.state = cold; context.snapshot = draft.snapshot; context.acceptedRoot = replay.root; context.batch = r.nextUint(context.batch); context.lastSequence = replay.lastSequence;
    await store.transact([{ space: 'meta', id: 'namedReservedBatch', value: null }]); return replay;
  };
  return { store, context, make, accept, get reads() { return reads; } };
}
const anchor = { height: '100', hash: r.hash('100') }, matches = ['1', '10', '11'].map(height => ({ height, hash: r.hash(height), count: '3' }));
test('field-value gateway admission uses the counted execution height and only submitted evidence', async () => {
  const f = setup(), active = r.FIELD_VALUE_AMOUNT_HEIGHT;
  f.context.tip = f.context.counted = String(BigInt(active) - 2n);
  const proposal = { name: 'dmwvalue', pat: '1', fld: 10, dt: 'n', amountMode: 'field-value' }, salt = r.hash('value');
  const values = matches.map(m => ({ ...m, count: '111' }));
  const commitment = r.namedCommitment({ proposal, salt, agent, anchor, matches: values, settings });
  await f.make().accept(r.stableJSON(packet('discovery-commit-v2', { commitment }, f.context.tip)));
  await f.accept();
  f.context.tip = active; f.context.counted = String(BigInt(active) - 1n);
  const text = r.stableJSON(packet('discovery-reveal-v2', { proposal, salt, commitmentId: commitment,
    anchor, matches: values, witnessRoot: r.witnessRoot(values) }, active));
  const before = JSON.stringify([...f.store.rows]), reads = f.reads;
  await assert.rejects(f.make().accept(text), /proposal_payload/);
  assert.equal(JSON.stringify([...f.store.rows]), before);
  assert.equal(f.reads, reads);
  f.context.counted = active;
  await f.make().accept(text);
  assert.equal(f.reads - reads, 4);
  await f.accept();
  const record = r.namedGet(f.context.state.records, 'pattern/' + r.definitionKey(proposal, settings));
  assert.equal(record.amountMode, 'field-value');
  assert.equal(record.knownMatchCount, '3'); assert.equal(record.knownOccurrenceTotal, '333');
  f.context.segmented = true;
  await f.store.transact([{ space: 'meta', id: 'ruleState', value: { catalogRoot: f.context.acceptedRoot } }]);
  const admission = new NamedAdmission({ store: f.store, secret, context: () => f.context,
    history: { get() { throw Error('admission_must_not_replay_claims'); } }, hashAt: r.hash, resources });
  await admission.accept(r.stableJSON(packet('claim-v2', { window: active, plots: [{ block: '1', patterns: [record.number] }] }, active)));
  assert.ok(f.store.get('namedDrafts', f.context.batch).work.bytes <= settings.values.auditTotalBytes);
});
test('the first admission of a new batch never enumerates another loader\'s retained occurrence trees', async () => {
  for (const retained of [100, 10000]) {
    const f = setup(), state = r.emptyNamedDiscovery();
    for (let i = 0; i < retained; i++) {
      const key = r.hash('historical/' + i), leaf = r.namedSet(null, String(i), { count: '1' });
      state.records = r.namedSet(state.records, 'historical/' + key, { evidenceRoot: r.namedRoot(leaf) });
      state.evidence = r.recordSet(state.evidence, key, leaf);
      state.evidenceByRoot = r.recordSet(state.evidenceByRoot, r.namedRoot(leaf), leaf);
    }
    const writer = new NamedStorage({ get: id => f.store.get('namedNodes', id), cacheSize: 16 }), saved = writer.save(state);
    await f.store.transact(saved.writes);
    const separate = new NamedStorage({ get: id => f.store.get('namedNodes', id), cacheSize: 16 });
    f.context.state = separate.load(saved.snapshot); f.context.snapshot = saved.snapshot; f.context.acceptedRoot = r.namedStateRoot(state);
    const reads = f.store.reads, before = f.store.rows.size;
    await f.make().accept(r.stableJSON(packet('discovery-commit-v2', { commitment: r.hash('new/' + retained) }, '100')));
    assert.ok(f.store.reads - reads < 100, `admission read ${f.store.reads - reads} rows with ${retained} retained occurrences`);
    assert.ok(f.store.rows.size - before < 100, 'only new radix paths and receipt metadata may be written');
    const draft = f.store.get('namedDrafts', '43');
    assert.deepEqual(draft.snapshot.evidence, saved.snapshot.evidence);
    assert.deepEqual(draft.snapshot.evidenceByRoot, saved.snapshot.evidenceByRoot);
    f.context.snapshot = { ...saved.snapshot, nextPattern: '1' };
    f.store.rows.delete('namedDrafts\0' + '43');
    await assert.rejects(f.make().accept(r.stableJSON(packet('discovery-commit-v2', { commitment: r.hash('wrong snapshot') }, '100'))), /admission_state_root/);
  }
});
test('500 distinct agents commit and reveal in their reserved batches with cold indexed replay', async () => {
  const fixture = setup(), openings = []; let intake = fixture.make();
  for (let i = 0; i < 500; i++) {
    const proposal = { name: 'dmwitem' + i, pat: '1|' + i.toString(16), fld: 10, dt: 'n' }, salt = r.hash('salt' + i);
    const seed = r.hashBytes('disposable load identity ' + i), account = { agent: edPublic(seed), key: createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' }) };
    const commitment = r.namedCommitment({ proposal, salt, agent: account.agent, anchor, matches, settings });
    await intake.accept(r.stableJSON(packet('discovery-commit-v2', { commitment }, '100', settings, account)));
    openings.push({ account, payload: { proposal, salt, commitmentId: commitment, anchor, matches, witnessRoot: r.witnessRoot(matches) } });
  }
  await fixture.accept(); fixture.context.tip = fixture.context.counted = '102'; intake = fixture.make();
  let used = 0;
  for (const { payload, account } of openings) {
    if (used === settings.values.revealBudget) { await fixture.accept(); intake = fixture.make(); used = 0; }
    const move = packet('discovery-reveal-v2', payload, '102', settings, account), before = fixture.reads;
    const receipt = await intake.accept(r.stableJSON(move)); assert.equal(fixture.reads - before, 4);
    assert.equal(receipt.batch, fixture.context.batch); assert.ok(r.verifyReceiptV2(receipt, move, { network: 'fixture', gateway, hashAt: r.hash }));
    assert.deepEqual(await fixture.make().accept(r.stableJSON(move)), receipt); used++;
  }
  await fixture.accept(); assert.equal(fixture.context.state.nextPattern, '500');
});
test('invalid witnesses, exhausted reservations and disk errors cannot produce an acknowledged receipt', async () => {
  const f = setup(), proposal = { name: 'dmwtest', pat: '1', fld: 10, dt: 'n' }, salt = r.hash('salt');
  const commitment = r.namedCommitment({ proposal, salt, agent, anchor, matches, settings });
  const commit = r.stableJSON(packet('discovery-commit-v2', { commitment }, '100'));
  const admission = f.make();
  f.store.fail = true; await assert.rejects(admission.accept(commit), /test_disk_failure/); f.store.fail = false;
  assert.equal(f.store.rows.size, 0); await admission.accept(commit); await f.accept(); f.context.tip = f.context.counted = '102';
  const body = { proposal, salt, commitmentId: commitment, anchor, matches: matches.map(m => ({ ...m, count: '1' })), witnessRoot: r.witnessRoot(matches) };
  const before = f.store.rows.size;
  await assert.rejects(f.make().accept(r.stableJSON(packet('discovery-reveal-v2', body, '102'))), /discovery_opening/);
  assert.equal(f.store.rows.size, before);
  const intake = new Intake({ store: f.store, network: 'fixture', secret, hashAt: r.hash, rulesContext: () => ({ ruleset: 'dmw-v2' }), namedAdmission: f.make() });
  await assert.rejects(intake.accept('{"v":1}'), error => error.message === 'upgrade_required' && error.status === 409);
});
test('capacity refuses before receipt creation and decimal receipt sequence survives restart beyond 2^53', async () => {
  const f = setup(); await f.store.transact([{ space: 'meta', id: 'namedReceiptSequence', value: '9007199254740992' }]);
  const limited = r.resourceRevision({ operator: 'fixture', values: { ...r.RESOURCE_PROFILE, intakeEntries: 1 } });
  const make = () => new NamedAdmission({ store: f.store, secret, context: () => f.context, history: { get: h => ({ height: h, hash: r.hash(h) }) }, hashAt: r.hash, resources: limited });
  const body = packet('discovery-commit-v2', { commitment: r.hash('one') }, '100');
  const receipt = await make().accept(r.stableJSON(body)); assert.equal(receipt.sequence, '9007199254740993');
  await assert.rejects(make().accept(r.stableJSON(packet('discovery-commit-v2', { commitment: r.hash('two') }, '100'))), /next_batch_work_capacity/);
  assert.equal(f.store.get('meta', 'namedReceiptSequence'), receipt.sequence);
  assert.deepEqual(await make().accept(r.stableJSON(body)), receipt);
});
test('cold storage verifies logical commitments even if a corrupt node has a recomputed storage address', async () => {
  const f = setup(); await f.make().accept(r.stableJSON(packet('discovery-commit-v2', { commitment: r.hash('one') }, '100')));
  const snapshot = f.store.get('namedDrafts', '43').snapshot;
  const original = f.store.get('namedNodes', snapshot.records), forged = { ...original, prefix: original.prefix + '0' };
  const id = r.hashObject(['dmw-stored-index-v2', forged]); await f.store.transact([{ space: 'namedNodes', id, value: forged }]);
  const reader = new NamedStorage({ get: id => f.store.get('namedNodes', id), cacheSize: 2 });
  assert.throws(() => reader.load({ ...snapshot, records: id }), /named_storage_commitment/);
});
test('a commitment uses its original definition/lease revision after settings change', async () => {
  const f = setup(), proposal = { name: 'dmwtest', pat: '1', fld: 10, dt: 'n' }, salt = r.hash('salt');
  const commitment = r.namedCommitment({ proposal, salt, agent, anchor, matches, settings });
  await f.make().accept(r.stableJSON(packet('discovery-commit-v2', { commitment }, '100'))); await f.accept();
  const later = r.settingsRevision({ network: 'fixture', effectiveBatch: '44', effectiveBitcoinWindow: '102', previous: settings,
    values: { ...settings.values, commitLifetime: 10, minMatchingBlocks: 4, tierThresholds: ['2', '10', '100', '1000'] } });
  const revisions = new r.SettingsHistory(); revisions.append(settings, r.hashObject(settings)); revisions.append(later, r.hashObject(later));
  Object.assign(f.context, { tip: '102', counted: '102', settings: later, settingsHistory: revisions });
  const move = packet('discovery-reveal-v2', { proposal, salt, commitmentId: commitment, anchor, matches, witnessRoot: r.witnessRoot(matches) }, '102', later);
  await f.make().accept(r.stableJSON(move));
  const draft = f.store.get('namedDrafts', '44'), state = new NamedStorage({ get: id => f.store.get('namedNodes', id), cacheSize: 16 }).load(draft.snapshot);
  const record = r.namedGet(state.records, 'pattern/' + r.definitionKey(proposal, settings));
  assert.equal(record.attributionCloses, '244'); assert.equal(record.tier, 4); assert.equal(record.knownMatchCount, '3');
});

test('claim admission reserves expanded records once and refuses before receipt without replaying the segment', async () => {
  const f = setup(), proposal = { name: 'dmwbudget', pat: '1', fld: 10, dt: 'n' }, salt = r.hash('budget');
  const commitment = r.namedCommitment({ proposal, salt, agent, anchor, matches, settings });
  await f.make().accept(r.stableJSON(packet('discovery-commit-v2', { commitment }, '100'))); await f.accept();
  f.context.tip = f.context.counted = '102';
  await f.make().accept(r.stableJSON(packet('discovery-reveal-v2', { proposal, salt, commitmentId: commitment, anchor, matches, witnessRoot: r.witnessRoot(matches) }, '102')));
  await f.accept();
  const later = r.settingsRevision({ network: 'fixture', effectiveBatch: f.context.batch, effectiveBitcoinWindow: '102', previous: settings,
    values: { ...settings.values, auditChunkBytes: 1024, auditTotalBytes: 6000 } });
  const revisions = new r.SettingsHistory(); revisions.append(settings, r.hashObject(settings)); revisions.append(later, r.hashObject(later));
  Object.assign(f.context, { settings: later, settingsHistory: revisions, segmented: true });
  await f.store.transact([{ space: 'meta', id: 'ruleState', value: { catalogRoot: f.context.acceptedRoot } }]);
  const local = r.resourceRevision({ operator: 'fixture', values: { ...resources.values, intakeReserveBytes: 1 } });
  const make = () => new NamedAdmission({ store: f.store, secret, context: () => f.context,
    history: { get() { throw Error('admission_must_not_replay_claims'); } }, hashAt: r.hash, resources: local });
  let first, receipt, rejected = false;
  for (let i = 1; i <= 4; i++) {
    const text = r.stableJSON(packet('claim-v2', { window: '102', plots: [{ block: String(i), patterns: ['0'] }] }, '102', later));
    const before = f.store.get('meta', 'namedReceiptSequence');
    try { const value = await make().accept(text); first ??= text; receipt ??= value; }
    catch (error) {
      assert.equal(error.message, 'next_batch_byte_capacity'); assert.equal(error.status, 429);
      assert.equal(f.store.get('meta', 'namedReceiptSequence'), before); rejected = true; break;
    }
  }
  assert.ok(first && rejected);
  assert.deepEqual(await make().accept(first), receipt, 'exact retry survives a full reservation');
  assert.ok(f.store.get('namedDrafts', f.context.batch).work.bytes <= later.values.auditTotalBytes);
});

test('closure backlog refuses before receipt or writes and exact acknowledged retries survive a full backlog', async () => {
  const f = setup();
  const text = r.stableJSON(packet('claim-v2', { window: '100', plots: [{ block: '1', patterns: ['0'] }] }, '100'));
  for (const backlog of [
    [{ window: '98', closurePairs: String(settings.values.closureBacklogPairs) }],
    [{ window: '98', closureBytes: String(settings.values.closureBacklogBytes) }],
    Array.from({ length: settings.values.closureBacklogWindows }, (_, i) => ({ window: String(i) }))
  ]) {
    await f.store.transact([{ space: 'meta', id: 'ruleState', value: { rounds: backlog } }]);
    const before = JSON.stringify([...f.store.rows]);
    await assert.rejects(f.make().accept(text), error => error.message === 'closure_backlog_capacity' && error.status === 429 && error.retryAfterMs > 0);
    assert.equal(JSON.stringify([...f.store.rows]), before);
  }
  await f.store.transact([
    { space: 'meta', id: 'ruleState', value: { rounds: Array.from({ length: settings.values.closureBacklogWindows - 1 }, (_, i) => ({ window: String(i) })) } },
    { space: 'namedDrafts', id: f.context.batch, value: { acceptedRoot: f.context.acceptedRoot, settingsHash: r.hashObject(settings),
      work: { entries: 1, pairs: 1, reveals: 0, challenges: 0, bytes: 1000, closurePairs: 1, closureBytes: 100, closureWindows: ['99'] } } }
  ]);
  const pending = JSON.stringify([...f.store.rows]);
  await assert.rejects(f.make().accept(text), /closure_backlog_capacity/);
  assert.equal(JSON.stringify([...f.store.rows]), pending, 'distinct windows reserved by the draft also consume backlog capacity');
  const receipt = r.signReceiptV2(JSON.parse(text), { tip: '100', hash: r.hash('100'), sequence: '1', batch: '43' }, secret);
  await f.store.transact([{ space: 'namedDedupe', id: r.moveIdV2(JSON.parse(text)), value: { receipt } }]);
  assert.deepEqual(await f.make().accept(text), receipt);
});

test('backlog admission keeps quorum acknowledgments and recovers the exact pending receipt across a fence', async () => {
  const f = setup(), votes = [{ signer: 'fixture-quorum', signature: 'fixture-ack' }];
  let calls = 0, unavailable = true, original;
  const committee = { async acknowledgeReceipt(receipt) {
    calls++; original ??= receipt; assert.deepEqual(receipt, original);
    if (unavailable) throw Object.assign(Error('receipt_quorum_unavailable'), { status: 503 });
    return votes;
  } };
  const make = () => new NamedAdmission({ store: f.store, secret, context: () => f.context,
    history: { get: h => ({ height: h, hash: r.hash(h) }) }, hashAt: r.hash, resources, committee });
  const text = r.stableJSON(packet('claim-v2', { window: '100', plots: [{ block: '1', patterns: ['0'] }] }, '100'));
  const full = { rounds: [{ window: '98', closurePairs: String(settings.values.closureBacklogPairs) }] };
  await f.store.transact([{ space: 'meta', id: 'ruleState', value: full }]);
  const before = JSON.stringify([...f.store.rows]);
  await assert.rejects(make().accept(text), e => e.message === 'closure_backlog_capacity' && e.retryAfterMs > 0);
  assert.equal(calls, 0); assert.equal(JSON.stringify([...f.store.rows]), before);
  await f.store.transact([{ space: 'meta', id: 'ruleState', value: { rounds: [] } }]);
  await assert.rejects(make().accept(text), e => e.message === 'receipt_quorum_unavailable' && e.retryAfterMs > 0);
  const id = r.moveIdV2(JSON.parse(text)), sequence = f.store.get('meta', 'namedReceiptSequence');
  assert.equal(f.store.get('namedDedupe', id).witnessPending, true);
  await f.store.transact([{ space: 'meta', id: 'ruleState', value: full },
    { space: 'namedFences', id: r.hashObject(settings), value: { fenced: true } }]);
  f.context.ready = false; unavailable = false;
  assert.deepEqual(await make().accept(text), original);
  assert.deepEqual(f.store.get('namedDedupe', id), { receipt: original, votes });
  assert.equal(f.store.get('meta', 'namedReceiptSequence'), sequence);
  assert.deepEqual(await make().accept(text), original); assert.equal(calls, 2);
});
