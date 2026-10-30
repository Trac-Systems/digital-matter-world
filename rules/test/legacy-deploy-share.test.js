import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/index.js';
import { financialSplit } from '../src/financial-fees.js';
import { manifestFromDeployments, manifestSource, scanDeployments } from '../scripts/legacy-deploy-manifest.mjs';
import { readFile } from 'node:fs/promises';
const authority = 'f'.repeat(64) + 'i0', active = r.LEGACY_DEPLOY_SHARE_HEIGHT;
const document = { values: { ...r.SETTINGS_PROFILE, legacyDeployShareBps: 1000, legacyDeployPayoutMinAtoms: '1000000000000000000' } };
const group = n => Object.entries(r.LEGACY_DEPLOY_MANIFEST.elements).find(([, rows]) => rows.length === n);
function plan(n, total = '11142309577929313189', linked = true, height = active, kind = 'find') {
  const [elementId] = group(n), deployment = { elementId, privilege: authority };
  const split = financialSplit(total, { kind, linked, discovered: true }, document);
  return { original: split, ...r.legacyDeployFee(total, split, { kind, deployment, document, height }) };
}
test('before activation preserves exact splits and payment bytes with configured settings', () => {
  for (const linked of [false, true]) for (const kind of ['find', 'compound', 'link']) {
    const result = plan(156, '11142309577929313189', linked, String(BigInt(active) - 1n), kind);
    assert.deepEqual(result.split, result.original); assert.equal(result.legacyDeploy, undefined);
    const destinations = { finder: 'finder', firstMaker: 'maker', discoverer: 'discoverer', landowner: 'holder', treasury: 'treasury' };
    assert.equal(JSON.stringify(r.mintFeeItems(result.split, destinations)), JSON.stringify(r.mintFeeItems(result.original, destinations)));
  }
  assert.equal(r.legacyDeployShareActive(String(BigInt(active) - 1n)), false);
  assert.equal(r.legacyDeployShareActive(active), true);
  assert.equal(r.legacyDeployShareActive(String(BigInt(active) + 1n)), true);
});
test('one, two and 156 deployments split equally, keep division dust in burn, and preserve other shares and gross fees', () => {
  for (const n of [1, 2, 156]) for (const linked of [false, true]) for (const total of ['1', '999', '11142309577929313189']) {
    const result = plan(n, total, linked), each = BigInt(total) * 1000n / 10000n / BigInt(n), allocated = each * BigInt(n);
    assert.equal(BigInt(result.split.burn), BigInt(result.original.burn) - allocated);
    for (const role of ['finder', 'landowner', 'discoverer', 'treasury', 'firstMaker']) assert.equal(result.split[role], result.original[role]);
    assert.equal(Object.values(result.split).reduce((s, v) => s + BigInt(v), 0n), BigInt(total));
    for (const rail of ['tap', 'ethereum']) {
      const fees = r.mintFeeItems(result.split, { finder: 'f', landowner: 'l', discoverer: 'd', treasury: 't' }, null, null, rail);
      assert.equal(fees.reduce((s, f) => s + BigInt(f.amount), 0n), BigInt(total));
      assert.equal(fees.some(f => f.role === 'legacyDeploy'), false);
      assert.equal(BigInt(fees.find(f => f.role === 'treasury')?.amount ?? '0'), BigInt(result.original.treasury) + allocated);
    }
    if (allocated) {
      const holders = group(n)[1].map(row => ({ id: row.id, address: '1BitcoinEaterAddressDontSendf59kuE' }));
      const owed = r.legacyDeployCommissions('mint-id', result.legacyDeploy, holders);
      assert.equal(owed.length, n); assert.ok(owed.every(c => c.amount === String(each)));
      assert.equal(owed.reduce((s, c) => s + BigInt(c.amount), 0n), allocated);
      assert.throws(() => r.legacyDeployCommissions('mint-id', result.legacyDeploy, holders.slice(1)), /liability/);
      assert.throws(() => r.legacyDeployCommissions('mint-id', result.legacyDeploy, holders.map(h => ({ ...h, id: authority }))), /holder/);
    }
  }
});
test('unknown element, other network, missing settings, compounds and links keep the original burn', () => {
  const split = r.splitFee('1000');
  for (const extra of [{ deployment: { elementId: authority, privilege: authority } }, { bitcoinNetwork: 'regtest' },
    { document: { values: r.SETTINGS_PROFILE } }, { document: { values: { ...document.values, ...r.LEGACY_DEPLOY_SETTINGS } } }, { kind: 'compound' }, { kind: 'link' }])
    assert.deepEqual(r.legacyDeployFee('1000', split, { kind: 'find', deployment: { elementId: group(156)[0], privilege: authority }, document, height: active, ...extra }), { split });
});
test('membership excludes exactly the configured authority and keeps all other deployments', () => {
  for (const [element, rows] of Object.entries(r.LEGACY_DEPLOY_MANIFEST.elements)) {
    for (const excluded of new Set(rows.map(row => row.privilege).filter(Boolean)))
      assert.deepEqual(r.legacyDeployments(element, excluded), rows.filter(row => row.privilege !== excluded).map(row => row.id));
  }
  assert.throws(() => r.legacyDeployments(group(1)[0], undefined), /authority/);
});
test('new settings are optional, complete, and cannot exceed burn or enable a zero threshold', () => {
  assert.equal(r.validateSettings(r.SETTINGS_PROFILE), r.SETTINGS_PROFILE);
  r.validateSettings(document.values);
  r.validateSettings({ ...r.SETTINGS_PROFILE, ...r.LEGACY_DEPLOY_SETTINGS });
  for (const extra of [{ legacyDeployShareBps: 2001 }, { legacyDeployShareBps: -1 }, { legacyDeployShareBps: '1000' },
    { legacyDeployPayoutMinAtoms: '0' }, { legacyDeployPayoutMinAtoms: 1 }])
    assert.throws(() => r.validateSettings({ ...document.values, ...extra }));
  assert.throws(() => r.validateSettings({ ...r.SETTINGS_PROFILE, legacyDeployShareBps: 1000 }), /settings_keys/);
});
test('offline generator freezes strictly pre-cutoff membership, validates identities, and emits the committed source', async () => {
  const rows = Object.entries(r.LEGACY_DEPLOY_MANIFEST.elements).flatMap(([elem, deploys]) => deploys.map(d =>
    ({ dmt: true, elem, ins: d.id, prv: d.privilege, blck: 973674 })));
  const generated = manifestFromDeployments(rows);
  assert.deepEqual(generated, r.LEGACY_DEPLOY_MANIFEST);
  assert.equal(manifestSource(generated), await readFile(new URL('../src/legacy-deploy-manifest.js', import.meta.url), 'utf8'));
  assert.deepEqual(manifestFromDeployments([{ ...rows[0], blck: 973675 }]).elements, {});
  assert.throws(() => manifestFromDeployments([rows[0], rows[0]]), /identity/);
  assert.throws(() => manifestFromDeployments([{ ...rows[0], elem: null }]), /identity/);
  const calls = [];
  const scanned = await scanDeployments('https://indexer.example', { pace: async () => calls.push('pace'), fetcher: async (url, options) => {
    calls.push([url.pathname + url.search, options]); return { ok: true, json: async () => ({ result: calls.length === 1 ? rows.slice(0, 500) : rows.slice(500) }) };
  } });
  assert.equal(scanned.length, rows.length); assert.equal(calls[1], 'pace');
  assert.ok(calls.filter(Array.isArray).every(([, options]) => options.method === 'GET' && options.redirect === 'error'));
});
