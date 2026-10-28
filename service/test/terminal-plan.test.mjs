import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { prepareTerminalImport } from '../src/terminal-import.mjs';
import { prepareDiskTerminalImport } from '../src/terminal-plan.mjs';
import { terminalRecordsRoot } from '../src/pending-financial.mjs';
import { Store } from '../src/store.mjs';
import { AccountAvailability } from '../src/account-availability.mjs';
import { accountKey, readAccountLeaf } from '../../contract/account-tree.js';
import { temp, agent } from './helpers.mjs';

test('disk terminal planner reproduces canonical roots, pages and account proofs without retaining the notary', async t => {
  const directory = await temp('terminal-disk-'), a = agent(701).address, b = agent(702).address;
  const records = new Map([['a/' + a, 1], ['a/' + b, 2], ['an/1', a], ['an/2', b], ['v/1/p0', '5'], ['v/2/p1', '11'],
    ['e/1/p0', [[2, '3']]], ['rq/n/1/' + 'a'.repeat(64), 1], ['pay/' + 'b'.repeat(64), { total: '9', used: '2' }],
    ['l/' + 'c'.repeat(64), { o: 1, to: 2, assets: [['p1', '7']], hash: 'd'.repeat(64), refund: 99 }],
    ['foreign/\u{10000}', { preserved: true }], ['foreign/\ue000', { preserved: true }]]);
  const expected = prepareTerminalImport({ records, height: 10, pageBytes: 1600 });
  const actual = prepareDiskTerminalImport({ file: join(directory, 'plan.sqlite'), records, height: 10, settings: { pageBytes: 1600, cacheKiB: 128 } }); t.after(() => actual.close());
  assert.equal(actual.financialRoot, expected.financialRoot); assert.equal(actual.importRoot, expected.importRoot);
  assert.equal(actual.importRows, expected.importRows); assert.deepEqual([...actual.pages], expected.pages);
  const writes = rows => [...rows].sort((a, b) => (a.space + '/' + a.id).localeCompare(b.space + '/' + b.id));
  assert.deepEqual(writes(actual.publicWrites), writes(expected.publicWrites)); assert.deepEqual(writes(actual.accountRecords), writes(expected.accountRecords));
  const store = await Store.open(join(directory, 'gateway')); t.after(() => store.close());
  await store.transactIterable(actual.availability);
  const available = new AccountAvailability(store), head = actual.records.get('ar/' + a), key = accountKey('balance', 'p0');
  assert.deepEqual(readAccountLeaf(head.root, available.prove(head.root, [key]), key), { available: '8', held: '0' });
  assert.equal(terminalRecordsRoot(actual.records), terminalRecordsRoot(new Map(actual.records)));
});

test('disk terminal plan refuses missing identities, oversized rows and existing output without dropping original evidence', async () => {
  const directory = await temp('terminal-disk-refusal-');
  for (const [name, records, settings, reason] of [
    ['owner', new Map([['v/1/p0', '2']]), {}, /account_import_owner/],
    ['external', new Map([['m/' + '1'.repeat(64), {}]]), {}, /external_financial_adapter/],
    ['custody', new Map([['fi/custody/' + '1'.repeat(64), {}]]), {}, /external_financial_adapter/],
    ['activated', new Map([['v2/ready', '1'.repeat(64)]]), {}, /already_activated/],
    ['bytes', new Map([['retained', 'x'.repeat(1000)]]), { rowBytes: 100 }, /row_budget/]])
    assert.throws(() => prepareDiskTerminalImport({ file: join(directory, name + '.sqlite'), records, height: 10, settings }), reason);
  const file = join(directory, 'plan.sqlite'), plan = prepareDiskTerminalImport({ file, records: new Map(), height: 10 }); plan.close();
  assert.throws(() => prepareDiskTerminalImport({ file, records: new Map(), height: 10 }), { code: 'EEXIST' });
});

test('streamed gateway transaction keeps its original identity, commits atomically and survives restart', async t => {
  const directory = await temp('terminal-stream-'); let store = await Store.open(directory, { journalFrameBytes: 2048, journalFragmentBytes: 256, journalGroupBytes: 8192 });
  t.after(() => store.close()); const value = { preserved: 'before' };
  function* writes() { for (let i = 0; i < 100; i++) yield { space: 'retained', id: String(i), value }; }
  const pending = store.transactIterable(writes()); value.preserved = 'after';
  assert.equal(store.count('retained'), 0); await pending;
  assert.equal(store.count('retained'), 100); assert.deepEqual(store.get('retained', '50'), { preserved: 'before' });
  assert.throws(() => store.transactIterable((function* () { yield { space: 'never', id: 'one', value: true }; throw Error('input_incomplete'); })()), /input_incomplete/);
  assert.equal(store.count('never'), 0); await store.close(); store = await Store.open(directory);
  assert.equal(store.count('retained'), 100); assert.equal(store.get('retained', '50').preserved, 'before');
});
