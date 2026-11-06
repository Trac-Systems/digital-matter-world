import test from 'node:test';
import assert from 'node:assert/strict';
import { installFinancialReadScope } from '../src/financial-read-scope.mjs';
import { rules } from '../src/rules.mjs';

function fixture() {
  let at = { counted: '100', tip: '101', tipHash: 'a'.repeat(64), last: { n: '1', root: 'b'.repeat(64) }, revision: 1 };
  let stamps = 0, calls = 0, value = { id: 'verified' }, fail = false;
  const reads = { batchStamp: async () => { stamps++; return structuredClone(at); },
    withTapReadSnapshot: async (_at, task) => task(),
    tap: async () => { calls++; if (fail) throw Error('unavailable'); return structuredClone(value); } };
  installFinancialReadScope(reads);
  return { reads, get at() { return at; }, stamps: () => stamps, calls: () => calls,
    change: fields => { at = { ...at, ...fields }; }, value: v => { value = v; }, fail: v => { fail = v; } };
}

test('nested financial reads share fences and successful values only at their exact snapshot', async () => {
  const f = fixture(), read = () => f.reads.withFinancialSnapshot(f.at, async () => {
    await f.reads.withFinancialSnapshot(f.at, () => f.reads.tap('deployment'));
    const value = await f.reads.tap('deployment'); value.id = 'caller mutation';
    assert.deepEqual(await f.reads.tap('deployment'), { id: 'verified' });
  });
  await read(); assert.equal(f.stamps(), 2); assert.equal(f.calls(), 1);
  await read(); assert.equal(f.stamps(), 4); assert.equal(f.calls(), 1);
  await f.reads.withFinancialSnapshot({ ...f.at, counted: 100, tip: 101 }, () => null);
  for (const fields of [{ revision: 2 }, { counted: '101' }, { last: { n: '2', root: 'c'.repeat(64) } }, { tipHash: 'd'.repeat(64) }]) {
    const before = f.calls(); f.change(fields); await read(); assert.equal(f.calls(), before + 1);
  }
});

test('a changing fence discards cached facts and cannot conceal a same-height reorg', async () => {
  const f = fixture();
  await assert.rejects(f.reads.withFinancialSnapshot(f.at, async () => {
    await f.reads.tap('deployment'); f.change({ tipHash: 'd'.repeat(64) });
  }), /financial_snapshot_changed/);
  f.change({ tipHash: 'a'.repeat(64) }); f.value({ id: 'new' });
  assert.deepEqual(await f.reads.withFinancialSnapshot(f.at, () => f.reads.tap('deployment')), { id: 'new' });
  assert.equal(f.calls(), 2);
  await assert.rejects(f.reads.withFinancialSnapshot({ ...f.at, tipHash: 'e'.repeat(64) }, () => null), /financial_snapshot_changed/);
});

test('missing results and source failures are retried, with distinct optional arguments', async () => {
  const f = fixture(); f.value(null);
  await f.reads.withFinancialSnapshot(f.at, async () => {
    assert.equal(await f.reads.tap('missing'), null); f.value({ id: 'arrived' });
    assert.deepEqual(await f.reads.tap('missing'), { id: 'arrived' });
    f.fail(true); await assert.rejects(f.reads.tap('failing'), /unavailable/); f.fail(false);
    await f.reads.tap('failing');
    await f.reads.tap(undefined); await f.reads.tap(null);
  });
  assert.equal(f.calls(), 6);
});

test('detached tasks cannot retain an expired snapshot scope', async () => {
  const f = fixture(); let release, detached;
  const gate = new Promise(resolve => { release = resolve; });
  await f.reads.withFinancialSnapshot(f.at, async () => {
    await f.reads.tap('deployment'); detached = gate.then(() => f.reads.tap('deployment'));
  });
  release(); await detached; assert.equal(f.calls(), 2);
});

test('fee validation and financial settings share only hash-verified history in the current snapshot', async () => {
  const document = { network: 'test', value: 'pinned' }, hash = rules.hashObject(document);
  let calls = 0, value = document;
  const source = async () => { calls++; return value; };
  const reads = { batchStamp: async () => ({ counted: '1', tip: '2', tipHash: 'h', last: { n: '0' } }),
    settingsByHash: source, feeQuotes: { settingsHistory: { get: source } } };
  installFinancialReadScope(reads);
  await reads.withFinancialSnapshot(undefined, async () => {
    assert.deepEqual(await reads.settingsByHash(hash), document);
    assert.deepEqual(await reads.feeQuotes.settingsHistory.get(hash), document);
    assert.equal(calls, 1);
    value = { network: 'wrong' };
    await assert.rejects(reads.settingsByHash('other'), /financial_settings_history/);
    await assert.rejects(reads.feeQuotes.settingsHistory.get('other'), /fee_settings_history/);
    assert.equal(calls, 3, 'invalid history is never retained');
  });
});

test('a caught nested evidence failure discards content as well as snapshot reads', async () => {
  let value = 'invalid', calls = 0;
  const reads = { batchStamp: async () => ({ counted: '1', tip: '2', tipHash: 'h', last: { n: '0' } }),
    content: async () => { calls++; return value; } };
  installFinancialReadScope(reads);
  await reads.withFinancialSnapshot(undefined, async () => {
    await assert.rejects(reads.withFinancialSnapshot(undefined, async () => { await reads.content('id'); throw Error('invalid_evidence'); }), /invalid_evidence/);
    value = 'verified'; assert.equal(await reads.content('id'), 'verified'); assert.equal(calls, 2);
  });
});
