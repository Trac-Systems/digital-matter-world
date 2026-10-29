import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { newStore } from './helpers.mjs';
import { PublicMintAdmission, publicMintClientIP } from '../src/public-mint-admission.mjs';
import { assetResources } from '../src/asset-resources.mjs';
import { runtimeResources } from '../src/r3-settings.mjs';
import { rules } from '../src/rules.mjs';
import { hash } from '../src/util.mjs';
import { publicScanKey } from '../../contract/public-mint.js';

async function fixture(t, resources = {}) {
  const store = await newStore(); let now = 1000;
  t.after(async () => { await store.close(); await rm(store.directory, { recursive: true, force: true }); });
  await store.put('meta', 'ruleState', { counted: '10' });
  const parent = { store, resources: assetResources({ publicMintsPerPayer: 2, publicMintsPerIP: 3, publicMintStartsPerMinute: 2, workPage: 1, ...resources }) };
  const admission = new PublicMintAdmission(parent, { now: () => now });
  const add = (id, payer = 'wallet', ip = 'ip', extra = {}) => admission.admit({ id, payer, publicMint: true, request: { asset: 'p2:0', block: id }, expiry: '10', ...extra }, hash(ip),
    row => store.transact([{ space: 'mints', id, value: row }, { space: 'publicMintRequests', id, value: true }]));
  return { store, admission, parent, add, now: value => now = value };
}

test('public admission enforces wallet and connection limits with distinct refusals', async t => {
  const f = await fixture(t);
  await f.add('1'); await f.add('2');
  await assert.rejects(f.add('3'), { message: 'public_mint_payer_capacity', status: 429 });
  await f.add('3', 'another-wallet');
  await assert.rejects(f.add('4', 'third-wallet'), { message: 'public_mint_ip_capacity', status: 429 });
  await f.add('4', 'third-wallet', 'other-ip');
  assert.equal(f.store.count('publicMintRequests'), 4);
});

test('expired, finished, winning and refundable requests release every admission limit immediately', async t => {
  for (const finish of ['expired', 'permit', 'winner', 'refund']) {
    const f = await fixture(t, { activeMints: 2 });
    await f.add('1'); await f.add('2');
    if (finish === 'expired') await f.store.put('meta', 'ruleState', { counted: '11' });
    else if (finish === 'permit') for (const id of ['1', '2']) await f.store.put('mints', id, { ...f.store.get('mints', id), permit: {} });
    else if (finish === 'winner') for (const block of ['1', '2']) await f.store.put('accountRecords', publicScanKey(rules.publicPlotId('p2:0', block)), { winner: { id: 'other' } });
    else for (const id of ['1', '2']) await f.store.put('publicMintRefundsByRequest/' + id, 'refund', { id });
    await f.add('3', 'wallet', 'ip', { expiry: '20' });
    assert.equal(f.store.count('publicMintRequests'), 3, 'no cleanup tick was needed to admit the next request');
  }
});

test('parallel starts cannot overfill admission; duplicate IDs do not consume a second slot', async t => {
  const f = await fixture(t, { activeMints: 1 });
  const results = await Promise.allSettled([f.add('1'), f.add('2')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.message, 'mint_capacity');
  assert.equal((await f.add('1')).created, false);
  assert.equal(f.store.count('publicMintRequests'), 1);
});

test('starts per minute persist across restarts, release at the boundary, and bound IP tracking', async t => {
  const f = await fixture(t, { mintInputCapacity: 2 });
  await f.admission.start('ip'); await f.admission.start('ip');
  await assert.rejects(f.admission.start('ip'), { message: 'public_mint_start_rate', status: 429 });
  const resumed = new PublicMintAdmission(f.parent, { now: () => 60999 });
  await assert.rejects(resumed.start('ip'), /public_mint_start_rate/);
  await f.admission.start('other-ip');
  await assert.rejects(f.admission.start('third-ip'), /public_mint_start_rate/);
  f.now(61000); await f.admission.start('third-ip'); await f.admission.start('ip');
  assert.equal(f.store.count('publicMintStartRates'), 2);
});

test('only the loopback proxy final forwarded hop selects the normalized client IP', () => {
  const ip = (peer, forwarded) => publicMintClientIP({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': forwarded } });
  assert.equal(ip('127.0.0.1', '198.51.100.9, 203.0.113.8'), '203.0.113.8');
  assert.equal(ip('203.0.113.2', '198.51.100.9'), '203.0.113.2');
  assert.equal(ip('127.0.0.1', 'spoofed'), '127.0.0.1');
  assert.equal(ip('127.0.0.1', '::ffff:203.0.113.8'), '203.0.113.8');
  assert.equal(ip('127.0.0.1', '2001:0db8:0:0:0:0:0:1'), '2001:db8::1');
});

test('public admission settings are operator controlled with preserved v4 resource documents', () => {
  const values = { ...rules.RESOURCE_PROFILE, assetPublicMintsPerPayer: 3, assetPublicMintsPerIP: 9, assetPublicMintStartsPerMinute: 4 };
  const next = rules.resourceRevision({ operator: 'test', values });
  const mapped = runtimeResources(next).assets;
  assert.equal(mapped.publicMintsPerPayer, 3); assert.equal(mapped.publicMintsPerIP, 9); assert.equal(mapped.publicMintStartsPerMinute, 4);
  const { assetPublicMintsPerPayer, assetPublicMintsPerIP, assetPublicMintStartsPerMinute, ...oldValues } = rules.RESOURCE_PROFILE;
  const previous = { version: 4, operator: 'test', revision: '0', previousHash: null, values: oldValues };
  const pin = rules.hashObject(previous);
  assert.equal(rules.validateResourceDocument(previous), previous);
  assert.equal(assetResources(runtimeResources(previous).assets).publicMintsPerPayer, 8);
  assert.equal(rules.resourceRevision({ operator: 'test', previous, values }).previousHash, pin);
  for (const name of ['assetPublicMintsPerPayer', 'assetPublicMintsPerIP', 'assetPublicMintStartsPerMinute']) {
    assert.throws(() => rules.resourceRevision({ operator: 'test', values: { ...values, [name]: 0 } }), /resource_value/);
  }
});
