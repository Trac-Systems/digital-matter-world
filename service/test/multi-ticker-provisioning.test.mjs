import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { provisioningFixture } from './provisioning-fixture.mjs';
import { readRegistry, migrateRegistry } from '../src/registry.mjs';
import { createFeePolicy } from '../src/fees.mjs';
import { TickerProvisioning } from '../src/ticker-provisioning.mjs';
import { rules } from '../src/rules.mjs';
const address = '1BitcoinEaterAddressDontSendf59kuE';
async function setup(t) {
  const f = await provisioningFixture(t), held = new Map();
  f.reads.inscription = async () => ({ address }); f.reads.bindings.resolve = () => ({ request: { address } });
  await f.store.put('patternsByAsset', 'p2:2', { ...f.pattern, number: '2', legacy: { asset: 'p2', record: f.pattern } });
  f.reads.officialName = async name => name === f.pattern.name;
  const checks = { validateChosenTicker: tick => tick.toLowerCase(), tickerConflicts: async (tick, { officialName }) => { if (await officialName(tick)) throw Error('ticker_conflict'); },
    tickerAvailable: async (reads, tick) => !(await reads.tap('getDeployment/' + tick)),
    reserveTicker: async (_, tick, id) => { if (held.has(tick) && held.get(tick) !== id) throw Error('ticker_reserved'); held.set(tick, id); },
    releaseTicker: async (_, tick, id) => { if (held.get(tick) === id) held.delete(tick); } };
  const payments = { request: async ({ id, tick }) => { await checks.reserveTicker(f.store, tick, id); return { id, state: 'paid' }; }, complete: async () => {}, refuse: async () => {} };
  f.reads.batchStamp = async () => ({ counted: String(await f.reads.counted()) });
  f.reads.tickerDeploymentFee = async () => ({ final: true });
  const tickers = new TickerProvisioning(f.operator, { checks: async () => checks, payments });
  const activate = async () => {
    f.mine(Number(rules.MULTI_TICKER_HEIGHT));
    f.context.settings = rules.settingsRevision({ network: f.network, effectiveBatch: '0', effectiveBitcoinWindow: '0', values: rules.SETTINGS_PROFILE });
    const legacy = await f.reads.registry(); legacy.feePolicy = createFeePolicy('100');
    await writeFile(f.registryPath, JSON.stringify(legacy)); await migrateRegistry(f.registryPath);
    f.reads.registry = () => readRegistry(f.registryPath);
  };
  return { ...f, tickers, activate, held };
}
test('additional provisioning refuses before activation and before an official deployment', async t => {
  const f = await setup(t);
  await assert.rejects(f.tickers.request('p2:2', { ticker: 'chosen', receiver: address }), /multi_ticker_inactive/);
  await f.activate();
  await assert.rejects(f.tickers.request('p2:2', { ticker: 'chosen', receiver: address }), /official_deployment_required/);
});
test('chosen ticker reuses the exact element and privilege and leaves official bytes unchanged', async t => {
  const f = await setup(t), official = await f.complete(); await f.activate();
  const before = JSON.stringify((await f.reads.registry()).assets.p2);
  const job = await f.tickers.request('p2:2', { ticker: 'Chosen', receiver: address });
  assert.equal(job.state, 'awaiting_player_deploy'); assert.equal(job.content.elem, official.entry.elementId);
  assert.equal(job.content.prv, official.entry.privilege); assert.equal(job.content.tick, 'chosen');
  const inscription = f.index(job.content); f.mine();
  const result = await f.tickers.submit('p2:2', { requestId: job.id, inscription });
  assert.equal(result.state, 'registered'); assert.equal(result.ordinal, '2');
  assert.equal(JSON.stringify((await f.reads.registry()).assets.p2), before);
  assert.equal((await f.tickers.list('p2:2')).rows.length, 2);
  assert.equal(f.held.size, 0);
});
test('availability is checked before reserving or paying and only one pending request holds the chosen name', async t => {
  const f = await setup(t); await f.complete(); await f.activate();
  await assert.rejects(f.tickers.request('p2:2', { ticker: f.pattern.name, receiver: address }), /ticker_conflict/);
  f.deployments.set('dmt-taken', { ins: 'a'.repeat(64) + 'i0' });
  await assert.rejects(f.tickers.request('p2:2', { ticker: 'taken', receiver: address }), /ticker_occupied/);
  assert.equal(f.held.size, 0);
  const results = await Promise.allSettled([f.tickers.request('p2:2', { ticker: 'race', receiver: address }),
    f.tickers.request('p2:2', { ticker: 'race', receiver: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const job = results.find(r => r.status === 'fulfilled').value;
  f.deployments.set('dmt-race', { ins: 'a'.repeat(64) + 'i0' });
  const inscription = f.index(job.content);
  const refused = await f.tickers.submit('p2:2', { requestId: job.id, inscription });
  assert.equal(refused.state, 'refused'); assert.equal(f.held.size, 0);
});
