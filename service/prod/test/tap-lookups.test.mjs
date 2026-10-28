import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TapLookupIndex } from '../tap-index.mjs';
import { temporary } from './helpers.mjs';

function source(lists) {
  const state = { height: 10, hash: 'aa', calls: [], generation: 0 };
  const indexer = { bitcoin: { blockHash: async () => state.hash }, stamp: async () => ({ height: state.height, hash: state.hash }), at: async (_at, fn) => {
    const hash = state.hash, result = await fn(); assert.equal(state.hash, hash); return result;
  }, tap: async path => {
    state.calls.push(path); const [name, query] = path.split('?');
    if (name.includes('Length')) return lists[name.replace('Length', '')]?.length ?? 0;
    const q = new URLSearchParams(query), offset = Number(q.get('offset')), max = Number(q.get('max'));
    assert.ok(max > 0 && max <= 500); return (lists[name] ?? []).slice(offset, offset + max);
  } };
  return { state, indexer };
}

test('5,002 authorities and >8MB of history do not change a named lookup cost', async t => {
  const root = await temporary(t), filename = join(root, 'tap.sqlite');
  const rows = Array.from({ length: 5002 }, (_, i) => ({ ins: String(i), padding: 'x'.repeat(2000) }));
  const lists = { getPrivilegeAuthList: rows, getDmtElementsList: [{ ins: 'element', tick: 'rock', pat: '123', fld: 4 }] };
  const { state, indexer } = source(lists); let index = new TapLookupIndex({ filename, indexer });
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) > 8000000);
  await assert.rejects(index.authority('5001'), /tap_lookup_index_catching_up/);
  for (let i = 0; i < 3; i++) { await index.advance(index.watch('privilege')); index.close(); index = new TapLookupIndex({ filename, indexer }); }
  t.after(() => index.close());
  state.calls = []; assert.equal((await index.authority('5001')).ins, '5001');
  assert.deepEqual(state.calls, ['getPrivilegeAuthList?offset=5001&max=1']);
  rows.push(...Array.from({ length: 1000 }, (_, i) => ({ ins: String(5002 + i), padding: 'x'.repeat(2000) })));
  state.calls = []; assert.equal((await index.authority('5001')).ins, '5001');
  assert.deepEqual(state.calls, ['getPrivilegeAuthList?offset=5001&max=1']);
  await index.advance(index.watch('element'));
  assert.equal((await index.elementDefinition('123', 4)).ins, 'element');
  assert.equal((await index.elementName('ROCK')).ins, 'element');
  assert.equal(await index.elementName('absent'), null);
});

test('permit recovery starts at zero, resumes beyond the recent tail, and rechecks its precise location', async t => {
  const root = await temporary(t), filename = join(root, 'tap.sqlite'), route = 'getAccountMintList/receiver/token';
  const rows = Array.from({ length: 6000 }, (_, i) => ({ ins: String(i), fail: false, dta: 'data/' + i, amt: '1' }));
  const { state, indexer } = source({ [route]: rows }); let index = new TapLookupIndex({ filename, indexer, settings: { pagesPerTick: 1 } });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(index.mint('receiver', 'token', 'data/2501', '1'), /tap_lookup_index_catching_up/);
    index.close(); index = new TapLookupIndex({ filename, indexer, settings: { pagesPerTick: 1 } });
  }
  assert.equal((await index.mint('receiver', 'token', 'data/2501', '1')).ins, '2501');
  await index.advance(index.watch('mint', ['receiver', 'token']), 20);
  state.calls = []; assert.equal((await index.mint('receiver', 'token', 'data/2501', '1')).ins, '2501');
  assert.equal(state.calls.filter(p => p.includes('?')).length, 1);
  rows[2501] = { ...rows[2501], ins: 'substitution', dta: 'other' };
  await assert.rejects(index.mint('receiver', 'token', 'data/2501', '1'), /tap_lookup_location_changed/);
  state.hash = 'bb';
  for (let i = 0; i < 30; i++) await index.advance(index.watch('mint', ['receiver', 'token']), 1);
  assert.equal(await index.mint('receiver', 'token', 'data/2501', '1'), null);
  index.close();
});
