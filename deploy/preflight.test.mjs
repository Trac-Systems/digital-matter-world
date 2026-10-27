import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TARGET, validateTarget, privateBytes, privateDirectory, endpoint, request, loadLaunchTarget } from './target.mjs';
import { preflight, renderReport } from './preflight.mjs';
import { fundingRequirements } from './costs.mjs';
import { sharedTarget } from './test-target.mjs';
import { argumentsFor } from './safety.mjs';
const exec = promisify(execFile);
const mainnetPath = fileURLToPath(new URL('./targets/mainnet.example.json', import.meta.url));
const mainnet = JSON.parse(await readFile(mainnetPath, 'utf8'));
const shape = v => Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v;

test('both targets have exactly the same required schema and no inline endpoint slots', () => {
  validateTarget(sharedTarget); validateTarget(mainnet); assert.deepEqual(shape(sharedTarget), shape(mainnet));
  const bad = structuredClone(sharedTarget); bad.ethereum.rpc.url = 'SECRET_CANARY';
  assert.throws(() => validateTarget(bad), /unknown slots/);
  delete bad.ethereum.rpc.url; delete bad.committee.members[0].shareFile;
  assert.throws(() => validateTarget(bad), /missing or unknown/);
  assert.equal(argumentsFor(['--target', 'example', '--regtest', '--dry-run']).target, 'example');
  assert.equal(argumentsFor(['--regtest', '--dry-run']).target, DEFAULT_TARGET);
  assert.throws(() => argumentsFor(['--target', 'one', '--config', 'two', '--regtest', '--dry-run']));
});

test('the public regtest template contains policy defaults but no operator paths or deployment state', () => {
  const defaults = new Set(['mode', 'network', 'bitcoin.chain', 'ethereum.chainId', 'ethereum.referenceToken',
    'ethereum.signing', 'ethereum.estimateGasPriceGwei', ...Object.keys(sharedTarget.funding).map(k => 'funding.' + k),
    'local.smoke.baseFeeAtoms', 'policy.baseFeeAtoms', 'policy.ethereumFromBlock', 'policy.ethereumMaxGasPriceWei']);
  const walk = (value, path = '') => {
    if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, path ? path + '.' + key : key);
    else if (typeof value === 'string' && !defaults.has(path)) assert.equal(value, '', path);
  };
  walk(sharedTarget);
});

test('mainnet is a failing offline slot audit, including when values are filled', async () => {
  let calls = 0;
  for (const target of [mainnet, { ...structuredClone(sharedTarget), mode: 'mainnet' }]) {
    const report = await preflight(target, { fetchEndpoint: async () => { calls++; throw Error('must not contact'); } });
    assert.equal(report.ok, false); assert.match(renderReport(report), /Production read checks pending/);
  }
  assert.equal(calls, 0);
  await assert.rejects(loadLaunchTarget(mainnetPath), /Mainnet execution is disabled/);
  await assert.rejects(exec(process.execPath, [fileURLToPath(new URL('./preflight.mjs', import.meta.url)), '--target', mainnetPath]), error => {
    assert.equal(error.code, 1); assert.match(error.stdout, /Fill the operator role addresses/); return true;
  });
});

test('private files require 0600, no symlinks, and endpoints reject remote URLs without revealing them', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dmw-preflight-'))), path = join(dir, 'endpoint');
  try {
    await writeFile(path, 'http://127.0.0.1:12345', { mode: 0o600 });
    assert.equal((await endpoint({ urlFile: path, authFile: '', tokenFile: '' })).url, 'http://127.0.0.1:12345');
    await chmod(path, 0o644); await assert.rejects(privateBytes(path), /0600/); await chmod(path, 0o600);
    await symlink(path, join(dir, 'link')); await assert.rejects(privateBytes(join(dir, 'link')), /without symlinks/);
    assert.equal(await privateDirectory(dir), dir);
    await symlink(dir, join(dir, 'directory-link')); await assert.rejects(privateDirectory(join(dir, 'directory-link')), /without symlinks/);
    for (const url of ['https://SECRET_CANARY.invalid/token', 'http://127.0.0.1:12345/path', 'http://user:SECRET_CANARY@127.0.0.1', 'http://localhost:12345']) {
      await writeFile(path, url); await assert.rejects(endpoint({ urlFile: path }), error => { assert(!error.message.includes('SECRET_CANARY')); return true; });
    }
    await writeFile(path, ''); await assert.rejects(privateBytes(path), /nonempty/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('HTTP redirects and raw private response errors cannot escape the reader', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://SECRET_CANARY.invalid/' }); res.end(); }
    else { res.writeHead(500); res.end('SECRET_CANARY'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ep = { url: `http://127.0.0.1:${server.address().port}`, headers: {} };
    for (const path of ['/redirect', '/error']) await assert.rejects(request(ep, { path }), error => {
      assert(!error.message.includes('SECRET_CANARY')); return true;
    });
    assert.equal(requests, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('gaps are non-green and exception text never enters the report', async () => {
  const clearFiles = value => {
    if (Array.isArray(value)) return value.map(clearFiles);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /File$/.test(k) ? '' : clearFiles(v)]));
    return value;
  };
  const target = clearFiles(sharedTarget); target.ethereum.chainId = '1';
  const report = await preflight(target, { fetchEndpoint: async () => { throw Error('SECRET_CANARY'); } });
  assert.equal(report.ok, false); assert(report.checks.some(c => c.name === 'Local chain, fee and quorum policy' && !c.ok));
  assert(report.checks.some(c => c.name === 'Gateway signing key' && !c.ok)); assert(!renderReport(report).includes('SECRET_CANARY'));
});

test('funding reprices every measured launch operation and keeps sender budgets separate', () => {
  const labels = ['privilege-authority', 'privilege-authority-activation'];
  const costs = { bitcoin: labels.map(label => ({ label, vbytes: 100, postageSats: '1000', cancellationReserve: { parent: '200', child: '300' } })),
    ethereum: ['escrow-deploy', 'smoke-approve', 'smoke-deposit', 'smoke-release'].map((label, i) => ({ label, gas: (i + 1) * 100 })), trac: { registrationAtomic: '30' } };
  const target = structuredClone(sharedTarget); target.bitcoin.estimateFeeRate = 2; target.ethereum.estimateGasPriceGwei = '3'; target.funding.bitcoinReserveSats = '10';
  const result = fundingRequirements(costs, target);
  assert.equal(result.bitcoinSats, 3010n); assert.equal(result.ethereumAdminWei, 300000000000n);
  assert.equal(Object.hasOwn(result,'ethereumRelayerWei'),false); assert.equal(Object.hasOwn(result,'ethereumPayerWei'),false); assert.equal(result.tnkWriterAtoms, 30n);
  costs.bitcoin.pop(); assert.throws(() => fundingRequirements(costs, target));
});
