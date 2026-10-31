import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { provisioningFixture } from './provisioning-fixture.mjs';
import { readRegistry, migrateRegistry } from '../src/registry.mjs';
import { createFeePolicy } from '../src/fees.mjs';
import { TickerProvisioning } from '../src/ticker-provisioning.mjs';
import { indexedTicker } from '../src/ticker-availability.mjs';
import { Files } from '../src/files.mjs';
import { serve } from '../src/http.mjs';
import { rules } from '../src/rules.mjs';
import { temp } from './helpers.mjs';
const address = '1BitcoinEaterAddressDontSendf59kuE';

// A registered official ticker and one chosen ticker for pattern p2:2 (ledger asset p2).
async function setup(t) {
  const f = await provisioningFixture(t), held = new Map();
  f.reads.inscription = async () => ({ address }); f.reads.bindings.resolve = () => ({ request: { address } });
  await f.store.put('patternsByAsset', 'p2:2', { ...f.pattern, number: '2', legacy: { asset: 'p2', record: f.pattern } });
  f.reads.officialName = async name => name === f.pattern.name;
  const checks = { indexedTicker, validateChosenTicker: tick => tick.toLowerCase(), tickerConflicts: async (tick, { officialName }) => { if (await officialName(tick)) throw Error('ticker_conflict'); },
    tickerAvailable: async (reads, tick) => !(await reads.tap('getDeployment/' + tick)),
    reserveTicker: async (_, tick, id) => { held.set(tick, id); }, releaseTicker: async (_, tick, id) => { if (held.get(tick) === id) held.delete(tick); } };
  const payments = { request: async ({ id, tick }) => { await checks.reserveTicker(f.store, tick, id); return { id, state: 'paid' }; }, complete: async () => {}, refuse: async () => {} };
  f.reads.batchStamp = async () => ({ counted: String(await f.reads.counted()) });
  f.reads.tickerDeploymentFee = async () => ({ final: true });
  const tickers = new TickerProvisioning(f.operator, { checks: async () => checks, payments });
  const official = await f.complete();
  f.mine(Number(rules.MULTI_TICKER_HEIGHT));
  f.context.settings = rules.settingsRevision({ network: f.network, effectiveBatch: '0', effectiveBitcoinWindow: '0', values: rules.SETTINGS_PROFILE });
  const legacy = await f.reads.registry(); legacy.feePolicy = createFeePolicy('100');
  await writeFile(f.registryPath, JSON.stringify(legacy)); await migrateRegistry(f.registryPath);
  // Searching never pages through the registry.
  f.reads.registry = async () => Object.assign(await readRegistry(f.registryPath), { page() { throw Error('registry_scan'); } });
  const job = await tickers.request('p2:2', { ticker: 'Moon', receiver: address });
  const inscription = f.index(job.content); f.mine();
  assert.equal((await tickers.submit('p2:2', { requestId: job.id, inscription })).state, 'registered');
  return { ...f, tickers, official };
}

test('a ticker finds its pattern by point reads, case-insensitive, bare or indexed', async t => {
  const f = await setup(t);
  for (const typed of ['moon', 'MOON', 'dmt-moon', 'Dmt-Moon']) {
    const hit = await f.tickers.find(typed);
    assert.deepEqual({ ...hit }, { ticker: 'dmt-moon', tick: 'moon', asset: 'p2:2', official: false, ordinal: '2' }, typed);
  }
  const tick = f.official.entry.tick, hit = await f.tickers.find(tick.toUpperCase());
  assert.equal(hit.asset, 'p2:2'); assert.equal(hit.official, true); assert.equal(hit.tick, tick); assert.equal(hit.ordinal, '1');
  assert.deepEqual(await f.tickers.find('nobody'), { ticker: 'nobody', asset: null });
  // Prefixes are not matched: only an exact ticker counts.
  assert.equal((await f.tickers.find('moo')).asset, null);
  await assert.rejects(f.tickers.find('-moon'), /ticker_invalid/);
  await assert.rejects(f.tickers.find(''), /ticker_invalid/);
  await assert.rejects(f.tickers.find('a'.repeat(33)), /ticker_invalid/);
});

test('GET /tickers/<tick> answers next to the ticker routes and refuses query keys', async () => {
  const asked = [];
  const tickers = { find: async tick => { asked.push(tick); return { ticker: tick.toLowerCase(), asset: tick === 'Moon' ? 'p2:2' : null }; } };
  const http = await serve({ files: new Files(await temp()), intake: {}, operator: { provisioner: { tickers } } });
  try {
    const read = async path => { const r = await fetch(http.url + path, { headers: { accept: 'application/json' } }); return [r.status, await r.json()]; };
    assert.deepEqual(await read('/tickers/Moon'), [200, { ticker: 'moon', asset: 'p2:2' }]);
    assert.deepEqual(await read('/api/tickers/moon'), [200, { ticker: 'moon', asset: null }]);
    assert.deepEqual(await read('/tickers/%E2%9C%A8'), [200, { ticker: '✨', asset: null }]);
    assert.deepEqual(await read('/tickers/moon?prefix=1'), [400, { error: 'ticker_query' }]);
    assert.deepEqual(await read('/tickers/%E0%A4%A'), [400, { error: 'ticker_invalid' }]);
    assert.deepEqual(asked, ['Moon', 'moon', '✨']);
  } finally { await http.close(); }
});

test('the ticker route is absent without the ticker store', async () => {
  const http = await serve({ files: new Files(await temp()), intake: {}, operator: { provisioner: {} } });
  try { assert.equal((await fetch(http.url + '/tickers/moon')).status, 404); } finally { await http.close(); }
});
