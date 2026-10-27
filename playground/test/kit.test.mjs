import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { preparePlayer, playerConfig, testWalletOwner } from '../kit-player.mjs';
import { candidates, candidate } from '../kit-adapter.mjs';
import { BUILD } from '../common.mjs';

test('playground callers get distinct keys and may explicitly resume their own named player', async t => {
  await mkdir(join(BUILD, 'playground-tests'), { recursive: true });
  const directory = await mkdtemp(join(BUILD, 'playground-tests/kit-')); t.after(() => rm(directory, { recursive: true }));
  const root = join(directory, 'agents'), env = {};
  const first = await preparePlayer(['status'], { root, env }), second = await preparePlayer(['status'], { root, env });
  const address = async p => JSON.parse(await readFile(join(p.directory, 'keystore.json'))).address;
  assert.notEqual(await address(first), await address(second)); assert.notEqual(first.password, second.password);
  const resumed = await preparePlayer(['read', 'address', '--player', first.name], { root, env });
  assert.equal(resumed.directory, first.directory); assert.equal(resumed.password, first.password); assert.equal(await address(resumed), await address(first));
  assert.deepEqual(resumed.args, ['read', 'address']);
  await assert.rejects(preparePlayer(['--player', '../owner'], { root, env }), /Player name/);
  await assert.rejects(preparePlayer(['--player', 'name', '--directory', directory], { root, env }), /either/);
});

test('mint candidates page all rights, including public finds, and targeted lookup retains time', async () => {
  const owner = '1'.repeat(64), calls = [];
  const rows = Array.from({ length: 201 }, (_, block) => ({ asset: 'p0', block, amount: '1', allowed: true, found: true, time: 100 + block,
    find: { asset: 'p0', block, count: 1, finder: owner, findHeight: 1 } }));
  const service = { mintRights: async (key, options) => {
    assert.equal(key, owner); calls.push(options);
    return { mintRights: options.cursor ? rows.slice(200) : rows.slice(0, 200), next: options.cursor ? null : 'page-two' };
  } };
  assert.deepEqual(await candidates(service, owner, 'p0'), rows); assert.equal(calls.length, 2); assert.equal(calls[1].allowed, undefined); assert.equal(calls[1].sort, 'block');
  const reads = { assetContext: async () => ({ find: rows[200].find, link: null }), registry: async () => ({ assets: { p0: { id: 'deployment', tick: 'token' } } }),
    isMinted: async () => false, blockHold: async () => null };
  const selected = await candidate(reads, 'p0', 200, 'tap', { get: () => ({ time: 300 }) });
  assert.equal(selected.time, 300); assert.equal(selected.find.finder, owner); assert.equal(selected.find.block, 200);
});


test('each kit player receives owner wallet defaults and retains an owner override', async t => {
  const root = await mkdtemp(join(BUILD, 'playground-tests/owner-')); t.after(() => rm(root, { recursive: true }));
  const state = { addresses: { receiver: 'local-bitcoin-receiver', payer: 'local-tap-payer' }, ethPayer: '0x' + 'ab'.repeat(20) };
  const expected = testWalletOwner(state), player = await preparePlayer(['read', 'address', '--player', 'owner-test'], { root, env: {} });
  const path = await playerConfig({ localOnly: true }, player, { readState: async () => state });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).owner, expected);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).bitcoinNetwork, 'regtest');
  await playerConfig({ localOnly: true, owner: { receiver: { bitcoin: 'changed' }, payer: {} } }, player, { readState: () => { throw Error('do not overwrite owner configuration'); } });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).owner, expected);
});
