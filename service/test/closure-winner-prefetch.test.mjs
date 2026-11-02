import test from 'node:test';
import assert from 'node:assert/strict';
import { prefetchingWinnerBatch, readPublicWinnerBatch } from '../src/public-claim-readers.mjs';
import { capacityPlotKey } from '../../rules/src/per-ticker-supply-activation.js';
import { rules } from '../src/rules.mjs';

const win = 'ab'.repeat(32);
const fixture = () => {
  const records = new Map([[capacityPlotKey('p2:7', '120'), win], ['fp/' + win, { publicMint: true, owner: null }]]);
  const pages = [];
  const reads = {
    financialRecord: async key => records.get(key) ?? null,
    financialRecords: async keys => { pages.push(keys.length); return keys.map(key => records.get(key) ?? null); },
  };
  const blocks = ['100', '110', '120', '130', '140'];
  const claimed = blocks.map(height => ({ id: rules.uintKeyV2(height), value: { height } }));
  const claims = { list: (space, { after, limit }) => space === 'claimed2/p2:7' ? claimed.filter(r => r.id > after).slice(0, limit) : [] };
  return { reads, claims, pages };
};

test('a closure walking one pattern reads its next claimed blocks in one page and answers like single reads', async () => {
  const { reads, claims, pages } = fixture(), at = { counted: '974288', last: { n: '1' } };
  const batch = prefetchingWinnerBatch({ store: {}, reads, at, claims });
  const answers = [];
  for (const block of ['100', '110', '120', '130', '140']) answers.push(...await batch([['p2:7', block]]));
  const plain = await readPublicWinnerBatch({ store: {}, reads, at }, ['100', '110', '120', '130', '140'].map(b => ['p2:7', b]));
  assert.deepEqual(answers, plain);
  assert.deepEqual(answers.map(r => r.value), [null, null, win, null, null]);
  assert.equal(pages.length - 2, 2, 'the walk needed one plot page and one funding page');
});

test('failed rows are returned for demanded pairs but never kept', async () => {
  const { claims } = fixture();
  let fail = true, reads = 0;
  const source = { financialRecord: async () => null, financialRecords: async keys => { reads++; if (fail) throw Error('down'); return keys.map(() => null); } };
  // financialRecords failures fall back to single reads inside readPublicWinners; make those fail too.
  source.financialRecord = async () => { if (fail) throw Error('trac_down'); return null; };
  const batch = prefetchingWinnerBatch({ store: {}, reads: source, at: {}, claims });
  const [first] = await batch([['p2:7', '100']]);
  assert.ok(first.error);
  fail = false;
  const [second] = await batch([['p2:7', '100']]);
  assert.deepEqual(second, { value: null });
});
