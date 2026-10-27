import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, validateTarget } from './target.mjs';
import { launchConfirmed, initialProductionRegistry } from './production-launch.mjs';
import { currentFee } from '../service/src/fees.mjs';
import { fundingRuntimeConfig } from '../service/prod/runtime.mjs';
import { temporary } from '../service/prod/test/helpers.mjs';
import { prepareOperatorInputs } from './operator-inputs.mjs';
const exec = promisify(execFile);
const worksheet = fileURLToPath(new URL('./inputs/mainnet-inputs.template.json', import.meta.url));

test('production CLI actually audits the worksheet offline, exits nonzero and redacts invalid arguments', async t => {
  const target = await loadTarget(worksheet); validateTarget(target);
  assert.equal(target.mode, 'mainnet');
  const cli = fileURLToPath(new URL('./production-preflight.mjs', import.meta.url));
  await assert.rejects(exec(process.execPath, [cli, '--target', worksheet]), error => {
    assert.equal(error.code, 1);
    assert.deepEqual(error.stdout.split('\n').filter(s => s.startsWith('GAP ')).map(s => s.split(':')[0]),
      ['GAP Server IP and SSH access', 'GAP DNS pointing', 'GAP Bitcoin/TAP connection files', 'GAP Ethereum RPC connection files', 'GAP Funded role key files']);
    assert.match(error.stdout, /admission remains closed/);
    assert.doesNotMatch(error.stdout, /wrong type|missing or unknown slots/);
    return true;
  });
  await assert.rejects(exec(process.execPath, [cli, '--private-do-not-print-me']), error => {
    assert.equal(error.code, 1); assert.doesNotMatch(error.stderr, /private-do-not-print-me/); return true;
  });
  const root = await temporary(t), file = join(root, 'invalid.json');
  const input = JSON.parse(await readFile(worksheet)); input.target.unexpected = 'never-printed';
  await writeFile(file, JSON.stringify(input));
  await assert.rejects(loadTarget(file), /missing or unknown slots/);
});

test('mempool, missing, conflicted and partially confirmed launch transactions keep admission closed', async () => {
  for (const confirmations of [undefined, 0, -1, '1']) {
    assert.equal(await launchConfirmed(async () => ({ confirmations }), ['tx'], 1), false);
  }
  assert.equal(await launchConfirmed(async () => { throw Object.assign(Error('not found'), { rpcCode: -5 }); }, ['tx'], 1), false);
  assert.equal(await launchConfirmed(async () => ({ confirmations: 1 }), ['tx'], 1), true);
  await assert.rejects(launchConfirmed(async () => { throw Error('transport'); }, ['tx'], 1), /transport/);
});

test('fresh production registry configures Bitmap-link quotes with the selected treasury and one fee policy', async () => {
  const target = await loadTarget(worksheet);
  target.bitcoin.treasuryAddress = 'owner-selected-treasury';
  const registry = initialProductionRegistry(target);
  assert.equal(currentFee(registry).baseFee, '22600000000000000000');
  assert.equal(Object.hasOwn(registry, 'charter'), false);
  assert.equal(registry.link.treasury, target.bitcoin.treasuryAddress);
  assert.deepEqual(Object.keys(registry.operator), ['provisioning']);
  assert.equal(registry.operator.provisioning.confirmations, 1);
  assert.equal(registry.operator.provisioning.tapTreasury, target.bitcoin.treasuryAddress);
});

test('MSB funding preparation needs no deployed subnet and cannot borrow a live writer or host store', () => {
  const config = { mode: 'prod', directory: '/private/writer', hostDirectory: '/private/host', fundingDirectory: '/private/funding',
    msbBootstrap: 'ab'.repeat(32), msbChannel: 'owner-supplied-channel', dhtBootstrap: ['discovery.example.org:49737'],
    validators: ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)] };
  assert.equal(fundingRuntimeConfig(config), config);
  for (const fundingDirectory of [config.directory, config.hostDirectory, '']) {
    assert.throws(() => fundingRuntimeConfig({ ...config, fundingDirectory }), /trac_funding_directory/);
  }
  assert.throws(() => fundingRuntimeConfig({ ...config, validators: [config.validators[0], config.validators[0], config.validators[1]] }), /trac_validators/);
});

test('operator configuration materializes only local public references and refuses an identity change', async t => {
  const root = await temporary(t), filename = join(root, 'inputs.json'), directory = join(root, 'operator1');
  const w = JSON.parse(await readFile(worksheet));
  w.target.network = 'launch-fixture-mainnet'; w.target.trac.msbBootstrap = 'ab'.repeat(32);
  for (const [i, m] of w.target.committee.members.entries()) {
    m.identity = String(i + 1).padStart(64, '0'); m.encryption = String(i + 6).padStart(64, '0');
    w.files.operatorTrac[i].msbBootstrap = w.target.trac.msbBootstrap;
  }
  await writeFile(filename, JSON.stringify(w), { mode: 0o600 });
  const output = await prepareOperatorInputs(filename, 'operator1', directory);
  const target = await loadTarget(output.targetFile), reader = JSON.parse(await readFile(target.runtime.signerReads[0]));
  assert.equal(reader.network, w.target.network);
  assert.equal(target.gateway.registryFile, join(directory, 'registry.json'));
  assert.equal(target.committee.members[0].signer.tokenFile, join(directory, 'endpoints/signer.token'));
  assert.equal(target.committee.members[1].signer.tokenFile, '');
  assert.equal((await readFile(target.committee.members[2].sidecar.urlFile, 'utf8')).trim(), 'http://127.0.0.1:58702');
  assert.equal((await readFile(reader.evidence.urlFile, 'utf8')).trim(), 'http://127.0.0.1:58910');
  assert.equal(reader.tap.endpoints.length, 1);
  await prepareOperatorInputs(filename, 'operator1', directory);
  w.target.committee.members[0].identity = 'ff'.repeat(32);
  await writeFile(filename, JSON.stringify(w), { mode: 0o600 });
  await assert.rejects(prepareOperatorInputs(filename, 'operator1', directory), /identity_changed/);
});
