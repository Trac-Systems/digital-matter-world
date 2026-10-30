import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as r from '../src/index.js';
import { amountReplay } from './field-value-replay-fixture.mjs';

const height = r.FIELD_VALUE_AMOUNT_HEIGHT, before = String(BigInt(height) - 1n);
const settings = r.settingsRevision({ network: 'amount-test', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE } });
const agent = r.hash('amount-agent'), salt = r.hash('amount-salt');
const proposal = { name: 'dmwfield', pat: '[0-9]', fld: 10, dt: 'n', amountMode: 'field-value' };
// Frozen mainnet headers: genesis, block 1, and block 973506. Expected values
// follow pinned ord-tap dmt_mint.rs: None pat => nonce/bits as i128, or blk.
const samples = [
  [0, '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c', '2083236893', '486604799'],
  [1, '010000006fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000982051fd1e4ba744bbbe680e1fee14677ba1a3c3540bf7b1cdb606e857233e0e61bc6649ffff001d01e36299', '2573394689', '486604799'],
  [973506, '00a0972603aa7e745dc8b417772d5e91cef7bddb5c88c2c187bc00000000000000000000fe1d37e6413a227a023bed1240e8b2c130049a9ac2f66e8c8bbbb1d2dedcf3c06788e16a930002176d60dfe1', '3789512813', '386007187']
];
function discovery() {
  const headers = new Map(samples.map(([h, raw]) => [String(h), r.parseHeader(r.hexToBytes(raw), h)]));
  const anchor = { height: '973506', hash: headers.get('973506').hash };
  const matches = samples.map(([h, , count]) => ({ height: String(h), hash: headers.get(String(h)).hash, count }));
  let reads = 0;
  const history = { get length() { throw Error('history_scan'); }, get: h => { reads++; return headers.get(String(h)); } };
  const commitment = r.namedCommitment({ proposal, salt, agent, anchor, matches, settings });
  const state = r.commitNamedDiscovery(r.emptyNamedDiscovery(), { agent, commitment, tip: String(BigInt(height) - 2n), receiptPosition: '1', settings });
  const args = { proposal, salt, agent, anchor, matches, settings, history, commitmentId: commitment,
    witnessRoot: r.witnessRoot(matches), tip: height, counted: height, executionHeight: height, receiptPosition: '2' };
  return { state, args, get reads() { return reads; } };
}

test('full numeric header values equal the pinned TAP computation; regex selects once and zero pays nothing', () => {
  for (const [h, raw, nonce, bits] of samples) {
    const row = r.parseHeader(r.hexToBytes(raw), h);
    for (const [fld, dt, expected] of [[4, 'n', String(h)], [10, 'n', nonce], [11, 'n', bits], [11, 'h', bits]]) {
      const p = { ...proposal, fld, dt, pat: dt === 'h' ? '[0-9a-f]' : '[0-9]' };
      assert.equal(r.patternAmount(p, row), expected);
      assert.equal(r.patternAmount({ ...p, amountMode: 'count' }, row), String(r.patternCount(p, row)));
      assert.equal(r.patternAmount({ ...p, pat: '^a$' }, row), '0');
    }
  }
  assert.equal(r.patternAmount(proposal, { nonce: 0 }), '0');
  assert.equal(r.patternAmount({ ...proposal, fld: 4 }, { height: '9007199254740993' }), '9007199254740993');
  assert.equal(r.tapElementText('dmwfield', proposal), 'dmwfield.10.element');
  assert.equal(r.tapElementPattern(proposal), null);
});

test('mode participates in identity; count default is unchanged; execution height gates new proposal fields', () => {
  const { amountMode, ...count } = proposal;
  assert.equal(r.definitionKey(count, settings), r.definitionKey({ ...count, amountMode: 'count' }, settings));
  assert.notEqual(r.definitionKey(proposal, settings), r.definitionKey(count, settings));
  assert.throws(() => r.canonicalDefinition({ ...proposal, amountMode: 'other' }, settings), /pattern_amount_mode/);
  const f = discovery(), { commitmentId, proposal: p, salt: s, anchor, matches, witnessRoot } = f.args;
  const payload = { commitmentId, proposal: p, salt: s, anchor, matches, witnessRoot };
  assert.throws(() => r.validateNamedPayload('discovery-reveal-v2', payload, settings, before), /proposal_payload/);
  assert.doesNotThrow(() => r.validateNamedPayload('discovery-reveal-v2', payload, settings, height));
  assert.throws(() => r.revealNamedDiscovery(f.state, { ...f.args, executionHeight: before }), /pattern_name/);
  const out = r.revealNamedDiscovery(f.state, f.args);
  assert.equal(out.record.amountMode, 'field-value');
  assert.equal(out.record.knownMatchCount, '3');
  assert.equal(out.record.knownOccurrenceTotal, '8446144395');
  assert.equal(out.record.tier, 5); assert.equal(f.reads, 3);
  assert.equal(r.challengeNamedCount(out.state, { patternKey: out.record.key, revision: out.record.catalogRevision,
    height: '1', history: f.args.history }).outcome, 'correct');
  assert.throws(() => r.submitOccurrences(out.state, { ...f.args, patternKey: out.record.key,
    matches: [{ ...matches[1], count: '10' }] }), /occurrence_count/);
});

test('claims spend one pair and settle full units as exact account credits', () => {
  const f = discovery(), out = r.revealNamedDiscovery(f.state, f.args), p = out.record;
  const state = {}, event = r.claimRound(height, r.hash(height), height, '1');
  const args = { state, event, agent, plots: [{ block: '1', patterns: [p.number] }], patterns: new Map([[p.number, p]]), history: f.args.history, settings: { document: settings }, height };
  assert.throws(() => r.enterClaims({ ...args, state: {}, event: structuredClone(event), height: before }), /pattern_amount_inactive/);
  const oldTip = r.enterClaims({ ...args, state: {}, event: structuredClone(event), height: before, executionHeight: height });
  assert.equal(oldTip.slots[0].count, '2573394689');
  const entered = r.enterClaims(args);
  assert.equal(entered.exceeded, false); assert.equal(entered.slots[0].count, '2573394689');
  assert.equal(r.recordGet(state.claimAgents, `${height}/${agent}`).pairs.length, 1);
  r.freezeClaimWindow({ state, event, decidingHash: r.hash('draw'), counted: String(BigInt(height) + 2n), settings: { document: settings } });
  const budget = new r.CreditBudget({ document: settings });
  while (r.takeSettlementPage({ state, event, height, budget })) {}
  assert.equal(r.recordGet(state.balances, agent)['p2:0'], '2573394689');
  assert.equal(r.recordGet(state.finds, 'f2:1:0').count, '2573394689');
  assert.deepEqual(budget.operations()[0].assets, [['p2:0', '2573394689']]);
});

test('value occurrence corrections remove exact units and require fresh submitted replacement evidence', () => {
  const f = discovery(), initial = r.revealNamedDiscovery(f.state, f.args);
  const replacement = { ...f.args.history.get('1'), nonce: 4294967295, hash: r.hash('replacement') };
  let reads = 0;
  const history = { get length() { throw Error('history_scan'); }, get: h => { reads++; return h === '1' ? replacement : f.args.history.get(h); } };
  const fixed = r.correctNamedOccurrence(initial.state, { patternKey: initial.record.key, revision: initial.record.catalogRevision,
    height: '1', history, settings });
  assert.equal(reads, 1);
  assert.equal(fixed.record.knownMatchCount, '2');
  assert.equal(fixed.record.knownOccurrenceTotal, '5872749706');
  assert.equal(r.namedGet(fixed.state.records, `revision/${initial.record.key}/${initial.record.catalogRevision}`).knownOccurrenceTotal, '8446144395');
  const args = { ...f.args, patternKey: initial.record.key, history, matches: [{ height: '1', hash: replacement.hash, count: '4294967295' }] };
  const replaced = r.submitOccurrences(fixed.state, args);
  assert.deepEqual(replaced.results, ['added']);
  assert.equal(replaced.record.knownMatchCount, '3');
  assert.equal(replaced.record.knownOccurrenceTotal, '10167717001');
  assert.equal(replaced.record.tier, 5);
  assert.deepEqual(r.submitOccurrences(replaced.state, args).results, ['already_known']);
});

test('huge compound scales remain exact and operator ratio/work settings still bound coprime inputs', () => {
  const snapshot = { height, hash: r.hash(height) }, scale = '900719925474099312345';
  const options = { recipe: 'fusion', inputs: [['p2:0', scale], ['p2:1', String(BigInt(scale) * 2n)]], snapshot, executionHeight: height, settings,
    lookup: asset => ({ number: asset.slice(3), key: r.hash(asset), fld: 10, amountMode: 'field-value', catalogRevision: '1', knownMatchCount: '3', anchor: snapshot, settingsHash: r.hashObject(settings) }) };
  const result = r.compoundV2(r.emptyExactCompounds(), options);
  assert.equal(result.amount, scale);
  assert.deepEqual(result.record.inputs.map(p => p.amount), ['1', '2']);
  assert.throws(() => r.compoundV2(r.emptyExactCompounds(), { ...options, inputs: [['p2:0', scale], ['p2:1', '1']] }), /compound_ratio/);
});

test('signed discovery batches retain base audit bytes before activation and count bytes on both sides', () => {
  // Recorded from the frozen 9f8babb release using amountReplay, Node 24.22.1.
  const count = { auditHash: '81c493366ff81e919bde6784827d2a14408366da1de95e3533d6552edd4f4ec5',
    catalogRoot: '22a4a32e9357d086ed245788b991d655aa75c0497924650a513c3122f0d6a427',
    claimRoot: '00771fc4057e847047b808eb01b281824d59e600145dda59f660894d21219f7f', outcome: 'accepted', amount: '6' };
  const refused = { auditHash: '777081fa060e22a054b75a4af7f890116d8bbf265ed1d85ece43cdbdee7cbebd',
    catalogRoot: '1769b70cd43617762def83e3892cba672abeff1a58948f2d3ff9b7e01b3eae8b',
    claimRoot: '6c33eb94a41c81f347fd78d6cba5f64310e7ef9ebe862749f71ead90fe855592', outcome: 'proposal_payload', amount: null };
  for (const executionHeight of ['10002', before, height]) assert.deepEqual(amountReplay(r, { executionHeight }), count);
  for (const executionHeight of ['10002', before]) assert.deepEqual(amountReplay(r, { executionHeight, value: true }), refused);
  const active = amountReplay(r, { executionHeight: height, value: true });
  assert.equal(active.outcome, 'accepted'); assert.equal(active.amount, '11368538439');
  assert.notEqual(active.catalogRoot, refused.catalogRoot);
});

test('changing only the reviewed constant activates at batch execution height 973900', () => {
  // A process-local loader models the release edit without changing checkout
  // files or adding a runtime activation override to consensus code.
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { amountReplay } from ${JSON.stringify(new URL('./field-value-replay-fixture.mjs', import.meta.url).href)};
    let replacements = 0;
    registerHooks({ load(url, context, next) {
      const loaded = next(url, context);
      if (url !== ${JSON.stringify(new URL('../src/pattern-amount.js', import.meta.url).href)}) return loaded;
      const source = String(loaded.source);
      const declaration = /(export const FIELD_VALUE_AMOUNT_HEIGHT = )'[^']+';/;
      assert.match(source, declaration);
      const edited = source.replace(declaration, "$1'973900';"); replacements++;
      return { ...loaded, source: edited };
    } });
    const r = await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)});
    assert.equal(replacements, 1);
    assert.equal(r.FIELD_VALUE_AMOUNT_HEIGHT, '973900');
    console.log(JSON.stringify(['973899', '973900', '973901'].map(executionHeight => ({
      active: r.fieldValueAmountActive(executionHeight),
      count: amountReplay(r, { executionHeight }),
      value: amountReplay(r, { executionHeight, value: true })
    }))));
  `], { encoding: 'utf8' });
  const [prior, at, after] = JSON.parse(output);
  const oldCount = amountReplay(r, { executionHeight: '10002' });
  const oldRefusal = amountReplay(r, { executionHeight: '10002', value: true });
  assert.equal(prior.active, false);
  assert.deepEqual(prior.value, oldRefusal, 'old audit bytes and state roots before activation');
  for (const result of [prior, at, after]) assert.deepEqual(result.count, oldCount);
  for (const result of [at, after]) {
    assert.equal(result.active, true);
    assert.equal(result.value.outcome, 'accepted');
    assert.equal(result.value.amount, '11368538439');
  }
});
