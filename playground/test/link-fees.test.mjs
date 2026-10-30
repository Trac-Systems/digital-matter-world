import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../engine.mjs';
import { rules } from '../../service/src/rules.mjs';

test('local link payment preserves old bytes before activation and uses pinned settings afterwards', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'playground-link-fees-'));
  t.after(() => rm(directory, { recursive: true }));
  const document = rules.settingsRevision({ network: 'dmw-regtest', effectiveBatch: '0', effectiveBitcoinWindow: '0', values: { ...rules.SETTINGS_PROFILE, linkBurnBps: 1234 } });
  let counted = String(BigInt(rules.MULTI_TICKER_HEIGHT) - 1n), reads = 0;
  const row = { terms: { baseFee: '101', feeSettings: { ...rules.FEE_DEFAULTS, link: 3 }, settingsHash: rules.hashObject(document) } };
  const engine = { directory, state: { payerKey: '11'.repeat(32), releaseKey: '22'.repeat(32) }, store: { get: () => row },
    reads: { counted: async () => counted, financialSettings: async hash => { reads++; assert.equal(hash, row.terms.settingsHash); return document; } },
    trac: async () => { throw Error('stop_before_payment'); } };
  const payment = () => Engine.prototype.pay.call(engine, { id: rules.hash('local-link'), type: 'link' });
  await assert.rejects(payment(), /stop_before_payment/);
  assert.equal(reads, 0); assert.deepEqual(row.split, rules.splitFee(rules.feeFor('link', '101', 1), { kind: 'link' }));
  counted = rules.MULTI_TICKER_HEIGHT;
  await assert.rejects(payment(), /stop_before_payment/);
  assert.equal(reads, 1); assert.equal(row.split.burn, '37'); assert.equal(row.split.treasury, '266');
});
