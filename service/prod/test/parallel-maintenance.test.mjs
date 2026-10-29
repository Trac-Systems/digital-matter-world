import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { join } from 'node:path';
import { lookupMaintenance } from '../lookup-maintenance.mjs';
import { TapLookupIndex } from '../tap-index.mjs';
import { temporary } from './helpers.mjs';

test('stalled TAP maintenance cannot stop repeated bitmap and Ethereum passes', async t => {
  let release, tap = 0, bitmaps = 0, ethereum = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const maintenance = lookupMaintenance({ interval: 60000, lookups: { tick: async () => { tap++; await blocked; } },
    inventory: { tick: async () => { bitmaps++; } }, ethereum: { rpc: async () => ({ number: '0x1' }), events: { advance: async () => { ethereum++; } } } });
  t.after(async () => { release(); await maintenance.close(); });
  const first = maintenance.run(); await turn();
  const second = maintenance.run(); await turn();
  assert.equal(tap, 1); assert.equal(bitmaps, 2); assert.equal(ethereum, 2);
  release(); await Promise.all([first, second]);
});

test('lookup streams advance independently while the same stream retains one ordered cursor', async t => {
  let release, entered; const blocked = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const root = await temporary(t); let stalledCalls = 0;
  const index = new TapLookupIndex({ filename: join(root, 'lookup.sqlite'), settings: { pagesPerTick: 2 }, indexer: {
    stamp: async () => ({ height: 10, hash: 'hash' }), bitcoin: { blockHash: async () => 'hash' },
    tap: async path => {
      if (path === 'getPrivilegeAuthListLength') { stalledCalls++; entered(); await blocked; return 0; }
      if (path === 'getDmtElementsListLength') return 1;
      if (path.startsWith('getDmtElementsList?')) return [{ ins: 'element', tick: 'rock', pat: '123', fld: 4 }];
      throw Error('unexpected_route');
    }
  } });
  t.after(async () => { release(); await index.work.drain(); index.close(); });
  const privilege = index.watch('privilege'), element = index.watch('element');
  const slow = index.advance(privilege); await started;
  const duplicate = index.advance(privilege);
  assert.equal(await index.advance(element), true);
  assert.equal(index.stream(element).offset, 1); assert.equal(stalledCalls, 1);
  release(); await Promise.all([slow, duplicate]); assert.equal(stalledCalls, 1);
});
