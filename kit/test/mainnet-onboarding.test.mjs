import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { MAINNET_FILE, validateMainnet, validatePlayerConfig, networkProfile } from '../lib/network.mjs';
import { setup } from '../lib/setup.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { createWallet, publicKey, wipeWallet } from '../lib/keyring.mjs';
import { runtimeWallets } from '../lib/player-runtime.mjs';
import { create as createAdapter } from '../lib/mainnet-adapter.mjs';
import { launchPins } from '../bin/pin-mainnet.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { MAINNET_CHECKPOINT } from '../../contract/launch.js';
import { temp, witnesses, fakeTrac, patterns, cleanup } from './helpers.mjs';
import { FakeService } from './fake-service.mjs';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { loadHistory } from '../lib/headers.mjs';
import { checkMove } from '../../rules/src/index.js';
const cli = fileURLToPath(new URL('../bin/dmw.mjs', import.meta.url));
const run = promisify(execFile);
const shippedPins = JSON.parse(await readFile(MAINNET_FILE));
const awaitingLaunch = JSON.stringify(shippedPins).includes('TO-BE-FILLED-AT-LAUNCH');

async function pins() {
  const p = JSON.parse(await readFile(MAINNET_FILE));
  p.gatewayKey = '11'.repeat(32); p.receiptSigners = witnesses().members;
  p.trac.bootstrap = '33'.repeat(32); p.trac.adminPublicKey = '44'.repeat(32);
  p.trac.committeePublicKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  Object.assign(p.runtime.deployment, { admin: p.trac.adminPublicKey, committee: p.trac.committeePublicKey });
  p.runtime.deployment.beacon.checkpoint = structuredClone(MAINNET_CHECKPOINT);
  return p;
}
test('mainnet refuses launch placeholders, arbitrary pins, hosts, HTTP, discovery and weak PoW', async t => {
  if (awaitingLaunch) await assert.rejects(networkProfile(), /TO-BE-FILLED-AT-LAUNCH/);
  else assert.deepEqual(await networkProfile(), shippedPins);
  await assert.rejects(networkProfile({ network: 'mainnet', networkFile: '/tmp/otherParty.json' }), /regtest only/);
  const p = await pins(), directory = await temp(t), config = { ...p, directory, owner: {} };
  assert.throws(() => validateMainnet({ ...p, gatewayKey: 'TO-BE-FILLED-AT-LAUNCH' }), /TO-BE-FILLED-AT-LAUNCH/);
  await validatePlayerConfig(config, { pins: p });
  const mutations = [
    c => { c.gatewayKey = '55'.repeat(32); }, c => { c.receiptSigners[0].identity = '66'.repeat(32); },
    c => { c.gateway = 'https://dmtworld.much.fun.otherParty.example'; }, c => { c.gateway = 'http://dmtworld.much.fun'; },
    c => { c.gateway = 'https://dmtworld.much.fun:444'; }, c => { c.headerSource = 'https://mempool.space'; },
    c => { c.paymentOrigin = 'https://otherParty.example'; }, c => { c.trac.bootstrap = '00'.repeat(32); },
    c => { c.trac.networkId = '1'; }, c => { c.trac.msbBootstrap = '22'.repeat(32); },
    c => { c.runtime.dhtBootstrap = ['127.0.0.1:10001']; }, c => { c.runtime.msbChannel = 'wrong'; },
    c => { c.runtime.deployment.beacon.params.retarget = false; }, c => { c.puzzleBits = 0; },
    c => { c.powLimitBits = 0x207fffff; }, c => { c.receiptSigners[1] = c.receiptSigners[0]; },
    c => { c.adapter = '/tmp/evil.mjs'; }, c => { c.localOnly = true; },
    c => { c.trac.secret = 'not-allowed'; }, c => { c.gatewayKey = 'TO-BE-FILLED-AT-LAUNCH'; },
  ];
  for (const mutate of mutations) { const c = structuredClone(config); mutate(c); await assert.rejects(validatePlayerConfig(c, { pins: p })); }
});
test('launch pin command projects public outputs, binds deployment and refuses extra fields', async () => {
  const p = await pins(), { runtime, ...target } = structuredClone(p);
  target.receiptSigners = target.receiptSigners.map(m => ({ ...m, address: encodeTracAddress(m.identity) }));
  assert.deepEqual(launchPins(target, runtime.deployment), p);
  assert.throws(() => launchPins({ ...target, privateFile: '/tmp/secret' }, runtime.deployment));
  assert.throws(() => launchPins(target, { ...runtime.deployment, admin: '55'.repeat(32) }));
  assert.throws(() => launchPins(target, { ...runtime.deployment, secret: 'not-public' }));
});
test('production service keeps redirect refusal, route restrictions and bounded streamed bodies', async () => {
  let options;
  const service = new ServiceClient({ mode: 'mainnet', origin: 'https://dmtworld.much.fun', fetchImpl: async (_url, o) => {
    options = o; return new Response('x'.repeat(40));
  } });
  await assert.rejects(service.request('/health', { limit: 20 }), /too large/);
  assert.equal(options.redirect, 'error'); assert.ok(options.signal);
  await assert.rejects(service.request('//otherParty.example/health'), /Invalid service path/);
  for (const origin of ['http://dmtworld.much.fun', 'https://evil.example', 'https://dmtworld.much.fun:444', 'https://user@dmtworld.much.fun', 'https://dmtworld.much.fun/path']) {
    assert.throws(() => new ServiceClient({ mode: 'mainnet', origin }));
  }
  assert.throws(() => new ServiceClient({ origin: 'https://dmtworld.much.fun' }));
});
test('setup refuses unfilled mainnet before prompting, creating a signer or opening a connection', async t => {
  if (!awaitingLaunch) return t.skip('Launch pins are filled; placeholder validation is covered above');
  const dir = join(await temp(t), 'not-created'); let prompted = false;
  await assert.rejects(setup({ directory: dir, password: () => { prompted = true; } }), /TO-BE-FILLED/);
  assert.equal(prompted, false); await assert.rejects(access(dir));
  const { stdout } = await run(process.execPath, [cli, 'preflight', '--network', 'mainnet']).catch(e => e);
  assert.match(stdout, /TO-BE-FILLED/);
});
test('one setup path creates/imports/reuses signer and config, with optional validated owner addresses', async t => {
  const root = await temp(t), directory = join(root, 'signer'), file = join(root, 'network.json');
  const profile = { localOnly: true, mode: 'regtest', network: 'dmw-kit-test', gateway: 'http://127.0.0.1:5570',
    gatewayKey: '11'.repeat(32), receiptSigners: witnesses().members, puzzleBits: 0, powLimitBits: 0x207fffff,
    adapter: fileURLToPath(new URL('./fixtures/mcp-adapter.mjs', import.meta.url)) };
  await writeFile(file, JSON.stringify(profile));
  const password = 'disposable onboarding password';
  const result = await setup({ network: 'regtest', networkFile: file, directory, password });
  assert.match(result.address, /^trac1/); assert.equal(result.signer, 'created');
  assert.equal((await stat(join(directory, 'keystore.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(result.config)).mode & 0o777, 0o600);
  const config = JSON.parse(await readFile(result.config)); assert.equal(config.directory, directory); assert.deepEqual(config.owner, { receiver: {}, payer: {} });
  const again = await setup({ network: 'regtest', networkFile: file, directory, password });
  assert.equal(again.address, result.address); assert.equal(again.signer, 'reused');
  assert.equal(JSON.stringify(result).includes(password), false);
  const { stdout } = await run(process.execPath, [cli, 'read', 'status', '--config', result.config], { env: { ...process.env, DMW_SIGNER_PASSWORD: password } });
  assert.equal(JSON.parse(stdout).dryRun, true);
  const wallet = await createWallet();
  try {
    const imported = await setup({ network: 'regtest', networkFile: file, directory: join(root, 'import'), password, mnemonic: wallet.mnemonic });
    assert.equal(imported.address, wallet.address); assert.equal(imported.signer, 'imported');
  } finally { wipeWallet(wallet); }
  await assert.rejects(setup({ network: 'regtest', networkFile: file, directory: join(root, 'bad-owner'), password, ask: async () => 'not-an-address' }), /Invalid Bitcoin/);
  await assert.rejects(setup({ network: 'regtest', networkFile: file, directory, password, mnemonic: 'ignored' }), /already exists/);
});
test('native wallet bridge stays in memory, preserves identity and signs the same bytes', async () => {
  const wallet = await createWallet();
  try {
    const { raw, peer } = runtimeWallets(wallet); await peer.initKeyPair('/must-not-be-created/keypair.json');
    assert.equal(raw.address, wallet.address); assert.equal(peer.publicKey, publicKey(wallet));
    assert.equal(peer.sign(Buffer.from('onboarding test')), Buffer.from(wallet.sign(Buffer.from('onboarding test'))).toString('hex'));
    assert.equal(peer.verify(peer.sign(Buffer.from('onboarding test')), 'onboarding test'), true);
    assert.equal(peer.verify(peer.sign(Buffer.from('onboarding test')), 'different message'), false);
    assert.equal(raw.secretKey, wallet.secretKey); assert.equal(peer.exportToFile, undefined);
  } finally { wipeWallet(wallet); }
});
test('mainnet adapter initializes public reads without creating an MSB account or opening P2P', async t => {
  const p = await pins(), wallet = await createWallet(); let opened = 0;
  try {
    const adapter = await createAdapter({ wallet, network: p.network, config: { ...p, directory: await temp(t) }, pins: p,
      service: new ServiceClient({ mode: 'mainnet', origin: p.gateway }), openRuntime: async () => { opened++; throw Error('no network in this test'); } });
    assert.equal(opened, 0); await adapter.close(); assert.equal(opened, 0);
  } finally { wipeWallet(wallet); }
});
test('mainnet free header, claim, discovery/reveal and craft never touch an MSB account or TNK send', async t => {
  const directory = await temp(t), p = await pins(), wallet = await createWallet(); cleanup(t, () => wipeWallet(wallet));
  const raw = Buffer.from((await readFile(new URL('./fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex'), histories = {};
  for (const tip of [61, 62, 63]) {
    const file = join(directory, `history-${tip}.bin`); await writeFile(file, raw.subarray(0, (tip + 1) * 80)); histories[tip] = await loadHistory(file);
  }
  const history = histories[63], genesis = history.get(0), fake = new FakeService({ network: p.network, history });
  p.runtime.deployment.beacon.checkpoint = { height: 0, hash: genesis.hash, bits: genesis.bits, time: genesis.time, chainwork: '4295032833', times: [genesis.time] };
  p.gatewayKey = fake.gateway; p.receiptSigners = fake.witness.members;
  const local = fakeTrac({ get: h => history.get(h), hashAt: h => history.get(h)?.hash }, { network: p.network, tip: 61 });
  let paidCalls = 0, closed = 0;
  const noPaid = () => { paidCalls++; throw Error('Free moves must never touch the MSB account'); };
  const service = new ServiceClient({ mode: 'mainnet', origin: p.gateway, network: p.network, gateway: p.gatewayKey, receiptSigners: p.receiptSigners,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      if (path === '/health') return Response.json({ ok: true, tip: fake.tip });
      if (path.startsWith('/api/block-height/')) return new Response(history.get(Number(path.split('/').at(-1))).hash);
      if (path === '/moves') assert.equal(checkMove(JSON.parse(options.body), { network: p.network, tip: fake.tip, hashAt: h => history.get(h).hash, puzzleBits: 12 }), null);
      return fake.fetch(url, options);
    } });
  const runtime = {
    peer: { wallet: runtimeWallets(wallet).peer, config: { dmw: p.runtime.deployment },
      base: { key: Buffer.from(p.trac.bootstrap, 'hex'), update: async () => {}, writable: false }, protocol: { instance: { api: local.trac.api } } },
    bus: { config: { networkId: 918, bootstrap: Buffer.from(p.trac.msbBootstrap, 'hex') }, state: { getFee: noPaid, getNodeEntry: noPaid },
      network: { validatorConnectionManager: { connectedValidators: () => [], pickRandomValidator: noPaid, pickRandomConnectedValidator: noPaid },
        validatorMessageOrchestrator: { send: noPaid } } }, close: async () => { closed++; }
  };
  const adapter = await createAdapter({ wallet, network: p.network, config: { ...p, directory }, pins: p, service, dryRun: false, openRuntime: async () => runtime });
  cleanup(t, () => adapter.close());
  const journal = await Journal.open(join(directory, 'journal'), p.network, { intervalMs: 0 }); cleanup(t, () => journal.close());
  const agent = new Agent({ wallet, network: p.network, service, trac: adapter.trac, journal, dryRun: false, puzzleBits: 12, powLimitBits: 0x1d00ffff });
  assert.equal((await agent.headers({ height: 61, raw: Buffer.from(history.raw(61)).toString('hex') })).state, 'received');
  assert.equal((await agent.claim({ event: { window: 61, hash: history.get(61).hash }, plots: [{ block: 61, patterns: [0] }], patterns, history })).state, 'received');
  const proposal = { name: 'dmwnewdigits', pat: '[12]', fld: 4, dt: 'n' };
  await agent.propose({ actionId: 'discovery', proposal, history: histories[61], patterns: [] });
  const { publication } = fake.observe(); local.state.tip = fake.tip = 63;
  assert.equal((await agent.reveal({ actionId: 'discovery', publication, history: histories[63], patterns: [] })).phase, 'reveal');
  assert.equal((await agent.craft({ actionId: 'craft', inputs: [['p0', '1'], ['p1', '1']], patterns })).state, 'received');
  await assert.rejects(adapter.trac.submit({}), /three connected validators/);
  assert.equal(paidCalls, 0); assert.equal(closed, 0);
  assert.equal(fake.entries.size, 5);
});
