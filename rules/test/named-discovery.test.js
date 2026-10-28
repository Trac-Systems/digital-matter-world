import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, hashObject, SETTINGS_PROFILE, settingsRevision, emptyNamedDiscovery, commitNamedDiscovery, namedCommitment,
  revealNamedDiscovery, submitOccurrences, witnessRoot, definitionKey, namedSet, namedGet, namedRoot,
  challengeNamedCount, migrateLegacyCommit, legacyRules, closeNamedAttribution, correctNamedOccurrence } from '../src/index.js';

const settings = settingsRevision({ network: 'fixture', effectiveBatch: '43', effectiveBitcoinWindow: '0', values: { ...SETTINGS_PROFILE } });
const agent = hash('fixture agent'), salt = hash('fixture salt');
const proposal = { name: 'dmwexample', pat: '1', fld: 4, dt: 'n' };
const anchor = { height: '10000', hash: hash('10000') };
const matches = ['1', '10', '11'].map(height => ({ height, hash: hash(height), count: height === '11' ? '2' : '1' }));
function view(tip = '10000') {
  let reads = 0;
  return { get reads() { return reads; }, get length() { throw Error('history_scan'); }, get(height) {
    reads++; assert.ok(BigInt(height) <= BigInt(tip)); return { height, hash: hash(height), nonce: 111, bits: 1 };
  } };
}
function prepare(state = emptyNamedDiscovery(), overrides = {}) {
  const args = { agent, proposal, salt, anchor, matches, settings, ...overrides };
  const commitment = namedCommitment(args);
  state = commitNamedDiscovery(state, { agent: args.agent, commitment, tip: overrides.commitTip ?? '10000', receiptPosition: overrides.commitPosition ?? '1', settings });
  return { state, args: { ...args, commitmentId: commitment, witnessRoot: witnessRoot(args.matches), tip: '10002', counted: '10002', receiptPosition: '2', history: view('10002'), ...overrides } };
}
test('three named blocks install immediately; later additions change known counts without awarding finds', () => {
  const p = prepare(), out = revealNamedDiscovery(p.state, p.args);
  assert.equal(out.record.knownMatchCount, '3'); assert.equal(out.record.knownOccurrenceTotal, '4'); assert.equal(out.record.tier, 5);
  assert.equal(out.record.attributionProvisional, true); assert.equal(p.args.history.reads, 4);
  assert.equal(out.state.finds, undefined); assert.equal(namedGet(p.state.records, `pattern/${out.record.key}`), undefined);
  const more = submitOccurrences(out.state, { patternKey: out.record.key, agent, anchor, matches: [matches[0], { height: '12', hash: hash('12'), count: '1' }], settings, history: view(), counted: '10000' });
  assert.deepEqual(more.results, ['already_known', 'added']); assert.equal(more.record.knownMatchCount, '4');
  assert.equal(out.record.knownMatchCount, '3'); assert.notEqual(more.record.evidenceRoot, out.record.evidenceRoot);
  const challenge = { patternKey: out.record.key, revision: out.record.catalogRevision, height: '11', history: view() };
  assert.equal(challengeNamedCount(more.state, challenge).outcome, 'correct');
  assert.equal(challengeNamedCount(more.state, { ...challenge, history: { get: height => ({ height, hash: hash('fork') }) } }).outcome, 'reorg');
  assert.throws(() => challengeNamedCount(more.state, { ...challenge, height: '12' }), /occurrence_not_asserted/);
});
test('bad witnesses, branch, empty match, opening and name conflicts fail atomically', () => {
  for (const bad of [[matches[0], matches[0], matches[2]], [...matches.slice(0, 2), { ...matches[2], count: '1' }],
    [...matches.slice(0, 2), { ...matches[2], hash: hash('fork') }], [...matches.slice(0, 2), { height: '20', hash: hash('20'), count: '1' }]]) {
    const p = prepare(undefined, { matches: bad }), before = namedRoot(p.state.records);
    assert.throws(() => revealNamedDiscovery(p.state, p.args), /occurrence/); assert.equal(namedRoot(p.state.records), before);
  }
  const p = prepare();
  assert.throws(() => revealNamedDiscovery(p.state, { ...p.args, salt: hash('wrong') }), /discovery_opening/);
  assert.throws(() => revealNamedDiscovery(p.state, { ...p.args, anchor: { ...anchor, hash: hash('fork') } }), /discovery_opening/);
  assert.throws(() => prepare(undefined, { proposal: { ...proposal, pat: '1?' } }), /pattern_nullable/);
});
test('same-pattern earlier commitment corrects attribution, keeps asset/name/deadline, and cannot reopen twice', () => {
  const early = prepare(undefined, { agent: hash('early'), proposal: { ...proposal, name: 'dmwearly' }, commitTip: '9999', commitPosition: '1' });
  const late = prepare(early.state, { agent: hash('late'), commitPosition: '2', receiptPosition: '3' });
  const installed = revealNamedDiscovery(late.state, late.args); // Unrelated and earlier opaque commitments do not stall.
  const corrected = revealNamedDiscovery(installed.state, { ...early.args, receiptPosition: '4' });
  assert.equal(corrected.record.discoverer, early.args.agent); assert.equal(corrected.record.number, installed.record.number);
  assert.equal(corrected.record.name, proposal.name); assert.equal(corrected.record.attributionCloses, installed.record.attributionCloses);
  assert.equal(corrected.record.knownMatchCount, '3');
  assert.throws(() => revealNamedDiscovery(corrected.state, { ...early.args, receiptPosition: '5' }), /discovery_reveal_window/);
});
test('definition normalization preserves alternative ordering and does not use historical equivalence', () => {
  const key = pat => definitionKey({ ...proposal, pat }, settings);
  assert.equal(key('[1-3]'), key('[321]')); assert.notEqual(key('1|11'), key('11|1'));
  assert.notEqual(key('1'), key('[1]')); // No unsupported semantic equivalence claim.
  const p = prepare(undefined, { proposal: { ...proposal, pat: '[0-9]', fld: 10 }, matches: matches.map(m => ({ ...m, count: '3' })) });
  assert.equal(revealNamedDiscovery(p.state, p.args).record.knownMatchCount, '3'); // Historically constant allowed.
});
test('500 commitments and reveals have no 64-queue or 256-catalog ceiling', () => {
  let state = emptyNamedDiscovery(); const pending = [];
  for (let i = 0; i < 500; i++) {
    // Different explicit definitions sharing three local examples are allowed.
    const p = { name: 'dmwitem' + i, pat: '1|' + i.toString(16), fld: 10, dt: 'n' };
    const prepared = prepare(state, { agent: hash('agent' + i), proposal: p, matches: matches.map(m => ({ ...m, count: '3' })), commitPosition: String(i + 1), receiptPosition: String(501 + i) });
    state = prepared.state; pending.push(prepared.args);
  }
  for (const args of pending) { const out = revealNamedDiscovery(state, args); state = out.state; assert.equal(args.history.reads, 4); }
  assert.equal(state.nextPattern, '500');
});
test('fixed named work at 0/500/50000 catalog entries and 20k/1m history heights, including cold restore', () => {
  let records = null, built = 0;
  for (const size of [0, 500, 50000]) {
    for (; built < size; built++) records = namedSet(records, 'unrelated/' + built, { number: String(built) });
    for (const height of ['19999', '999999']) {
      const p = prepare({ ...emptyNamedDiscovery(), records }, { anchor: { height, hash: hash(height) }, counted: height, history: view(height) });
      const restored = structuredClone(p.state), out = revealNamedDiscovery(restored, p.args);
      assert.equal(p.args.history.reads, 4); assert.equal(out.record.knownMatchCount, '3');
      const correctionView = view(height);
      assert.equal(challengeNamedCount(out.state, { patternKey: out.record.key, revision: out.record.catalogRevision, height: '10', history: correctionView }).outcome, 'correct');
      assert.equal(correctionView.reads, 1);
    }
  }
});
test('legacy commitment is preserved and requires named signed-attachment inputs at the execution boundary', () => {
  const commitment = legacyRules.discoveryCommitment(proposal, salt, agent);
  const state = migrateLegacyCommit(emptyNamedDiscovery(), { agent, commitment, tip: 10000 }, { network: 'fixture', settingsHash: hashObject(settings), receiptPosition: '1' });
  const out = revealNamedDiscovery(state, { agent, commitmentId: commitment, proposal, salt, anchor, matches, witnessRoot: witnessRoot(matches), tip: '10002', counted: '10002', receiptPosition: '2', settings, history: view('10002') });
  assert.equal(out.record.discoverer, agent); assert.equal(out.record.attribution.format, 1); assert.equal(out.record.attribution.commitment, commitment);
});
test('known tiers change at configured thresholds while prior revisions and attribution deadlines stay fixed', () => {
  const initial = prepare(undefined, { proposal: { ...proposal, pat: '1', fld: 10 }, matches: matches.map(m => ({ ...m, count: '3' })) });
  let out = revealNamedDiscovery(initial.state, initial.args);
  const original = out.record;
  const additions = Array.from({ length: 97 }, (_, i) => ({ height: String(100 + i), hash: hash(String(100 + i)), count: '3' }));
  out = submitOccurrences(out.state, { patternKey: original.key, agent, anchor, matches: additions, settings, history: view(), counted: '10000' });
  assert.equal(out.record.knownMatchCount, '100'); assert.equal(out.record.tier, 5);
  out = submitOccurrences(out.state, { patternKey: original.key, agent, anchor, matches: [{ height: '200', hash: hash('200'), count: '3' }], settings, history: view(), counted: '10000' });
  assert.equal(out.record.knownMatchCount, '101'); assert.equal(out.record.tier, 4);
  assert.equal(namedGet(out.state.records, `revision/${original.key}/${original.catalogRevision}`).knownMatchCount, '3');
  assert.throws(() => closeNamedAttribution(out.state, { patternKey: original.key, tip: '10144', settings }), /attribution_still_open/);
  const closed = closeNamedAttribution(out.state, { patternKey: original.key, tip: '10145', settings });
  assert.equal(closed.closed, true); assert.equal(closed.record.discoverer, agent);
  assert.equal(closeNamedAttribution(closed.state, { patternKey: original.key, tip: '10146', settings }).closed, false);
});
test('named discovery crosses safe-number heights and pattern counters without number coercion', () => {
  const heights = ['9007199254740993', '9007199254740994', '9007199254740995'], height = heights.at(-1);
  const p = prepare({ ...emptyNamedDiscovery(), nextPattern: '9007199254740992' }, {
    anchor: { height, hash: hash(height) }, matches: heights.map(height => ({ height, hash: hash(height), count: '1' })),
    counted: height, history: view(height)
  });
  const out = revealNamedDiscovery(p.state, p.args);
  assert.equal(out.record.number, '9007199254740992'); assert.equal(out.state.nextPattern, '9007199254740993');
  assert.equal(out.record.knownOccurrenceTotal, '3');
});
test('named reorg correction touches one header, preserves the old revision and permits a canonical replacement once', () => {
  const p = prepare(), initial = revealNamedDiscovery(p.state, p.args); let reads = 0;
  const canonical = { get: height => { reads++; return { height, hash: height === '11' ? hash('replacement') : hash(height), nonce: 111, bits: 1 }; } };
  const fixed = correctNamedOccurrence(initial.state, { patternKey: initial.record.key, revision: initial.record.catalogRevision, height: '11', history: canonical, settings, provenance: { batch: '44' } });
  assert.equal(reads, 1); assert.equal(fixed.incident.reason, 'reorg'); assert.equal(fixed.record.knownMatchCount, '2'); assert.equal(fixed.record.knownOccurrenceTotal, '2');
  assert.equal(namedGet(fixed.state.records, `revision/${initial.record.key}/${initial.record.catalogRevision}`).knownMatchCount, '3');
  assert.throws(() => correctNamedOccurrence(fixed.state, { patternKey: fixed.record.key, revision: initial.record.catalogRevision, height: '11', history: canonical, settings, provenance: null }), /catalog_revision_stale/);
  const replaced = submitOccurrences(fixed.state, { patternKey: fixed.record.key, agent, anchor, matches: [{ height: '11', hash: hash('replacement'), count: '2' }], settings, history: canonical, counted: '10000' });
  assert.equal(replaced.record.knownMatchCount, '3'); assert.deepEqual(replaced.results, ['added']);
  assert.deepEqual(submitOccurrences(replaced.state, { patternKey: fixed.record.key, agent, anchor, matches: [{ height: '11', hash: hash('replacement'), count: '2' }], settings, history: canonical, counted: '10000' }).results, ['already_known']);
});
