import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { KIT_VERSION, KIT_UPGRADE_CODE, KIT_UPGRADE_MESSAGE, KIT_DOWNLOAD_URL } from '../../rules/src/kit-release.js';
import { serve } from '../../service/src/http.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { requireKitVersion, resumeLegacyFinancial } from '../lib/upgrade.mjs';
import { Journal } from '../lib/journal.mjs';
import { financialMintId } from '../../rules/src/financial-mint.js';
import { linkId } from '../../rules/src/index.js';
import { temp, testWallet } from './helpers.mjs';
import { publicKey } from '../lib/keyring.mjs';

test('HTTP upgrade notice fits the installed client and names the exact release and source', async t => {
  const http = await serve({ intake: { accept: async () => { throw Object.assign(Error('upgrade_required'), { status: 409 }); } }, files: { serve: async () => false } });
  t.after(() => http.close());
  const response = await fetch(http.url + '/moves', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 409); const body = await response.json();
  assert.equal(body.error, 'upgrade_required'); assert.equal(body.code, KIT_UPGRADE_CODE);
  assert.match(body.code, /^[a-z][a-z0-9_]{0,80}$/); assert.equal(body.message, KIT_UPGRADE_MESSAGE);
  assert.deepEqual(body.upgrade, { version: KIT_VERSION, url: KIT_DOWNLOAD_URL });
  const client = new ServiceClient({ origin: http.url });
  await assert.rejects(client.request('/moves', { value: {} }), error => {
    assert.equal(error.code, 'upgrade_required'); assert.equal(error.refusedBeforeAcceptance, true);
    assert.match(error.message, new RegExp(`kit ${KIT_VERSION.replaceAll('.', '\\.')}`)); assert.ok(error.message.includes(KIT_DOWNLOAD_URL)); return true;
  });
  assert.equal(JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version, KIT_VERSION);
});

test('accepted manifest minimum kit version refuses future versions without numerical rounding', () => {
  for (const minimum of ['0.1.0', '0.2.0', '0.2.1', '0.2.2', '0.2.3', '0.2.4', '0.2.5', '0.2.6']) requireKitVersion(minimum);
  for (const minimum of ['0.2.7', '1.0.0', '99999999999999999999.0.0']) assert.throws(() => requireKitVersion(minimum), /upgrade_required/);
  assert.throws(() => requireKitVersion('remote text'), /Invalid minimum kit version/);
});

for (const kind of ['mint', 'link']) test(`legacy ${kind} recovery resolves the original ID and never signs a replacement on a missing read`, async t => {
  const directory = await temp(t), journal = await Journal.open(directory, 'upgrade'); t.after(() => journal.close());
  const network = 'dmw-regtest', owner = publicKey(testWallet());
  const request = kind === 'mint' ? { owner, asset: 'p0', block: 3, amount: '1', receive: '12'.repeat(32), nonce: '13'.repeat(32), until: 20, expires: 432 }
    : { owner, height: 3, nonce: '13'.repeat(32), until: 20 };
  const intent = kind === 'mint' ? { asset: 'p0', block: 3, amount: '1' } : { height: 3, payer: 'original' };
  const body = { request, signature: 'saved-signature', feeQuote: { baseFee: '100' } }, id = (kind === 'mint' ? financialMintId : linkId)(network, request);
  journal.reserve(kind + '/same', intent, body); journal.mark(kind + '/same', 'unknown');
  const before = journal.get(kind + '/same'); let missing = true;
  const status = async queried => { assert.equal(queried, id); if (missing) throw Object.assign(Error('request_not_found'), { status: 404 }); return { id, state: 'paid' }; };
  const agent = { network, journal, service: { mintStatus: status, linkStatus: status, paymentLink: () => 'http://127.0.0.1/payment' } };
  await assert.rejects(resumeLegacyFinancial(agent, kind, 'same', intent), /request_not_found/);
  assert.deepEqual(journal.get(kind + '/same'), before);
  await assert.rejects(resumeLegacyFinancial(agent, kind, 'same', { ...intent, changed: true }), /Conflicting/);
  missing = false;
  assert.equal((await resumeLegacyFinancial(agent, kind, 'same', intent)).request.id, id);
  assert.deepEqual(journal.get(kind + '/same').body, body); assert.equal(journal.get(kind + '/same').state, 'submitted');
  assert.equal(journal.get(kind + '/same/reservation-v2'), null);
});

test('explicit config upgrade keeps player settings and an exact backup without unlocking the wallet', async t => {
  const { writeFile } = await import('node:fs/promises'), { join } = await import('node:path');
  const { upgradeConfig } = await import('../lib/upgrade.mjs');
  const pins = JSON.parse(await readFile(new URL('../networks/mainnet.json', import.meta.url)));
  const directory = await temp(t), configFile = join(directory, 'mainnet.json');
  const previous = { ...pins, directory, owner: { receiver: {}, payer: {} }, headers: join(directory, 'retained.bin'), strategy: join(directory, 'strategy.mjs') };
  const bytes = Buffer.from(JSON.stringify(previous, null, 4) + '\n'); await writeFile(configFile, bytes, { mode: 0o600 });
  const next = structuredClone(pins); next.trac.bootstrap = '35'.repeat(32);
  const changed = await upgradeConfig({ configFile, pins: next });
  assert.equal(changed.changed, true); assert.deepEqual(await readFile(changed.backup), bytes);
  const config = JSON.parse(await readFile(configFile));
  for (const key of ['directory', 'owner', 'headers', 'strategy']) assert.deepEqual(config[key], previous[key]);
  assert.equal(config.trac.bootstrap, next.trac.bootstrap);
  assert.equal((await upgradeConfig({ configFile, pins: next })).changed, false);
  await assert.rejects(upgradeConfig({ configFile, networkFile: join(directory, 'untrusted.json'), pins: next }), /reviewed repository pins/);
  const foreign = { ...next, network: 'different-network' };
  await assert.rejects(upgradeConfig({ configFile, pins: foreign }), /preserve the player network/);
});

test('reviewed v2 mainnet pins select a new peer store and forward independent activation reads', async t => {
  const r = await import('../../rules/src/index.js'), { validateMainnet } = await import('../lib/network.mjs');
  const { playerPeerStore, runtimeWallets } = await import('../lib/player-runtime.mjs');
  const { create: createAdapter } = await import('../lib/mainnet-adapter.mjs');
  const { createWallet, wipeWallet } = await import('../lib/keyring.mjs');
  const pins = JSON.parse(await readFile(new URL('../networks/mainnet.json', import.meta.url))), checkpoint = pins.runtime.deployment.beacon.checkpoint;
  const document = r.settingsRevision({ network: pins.network, effectiveBatch: '2', effectiveBitcoinWindow: String(checkpoint.height), values: { ...r.SETTINGS_PROFILE } });
  const manifest = { version: 1, network: pins.network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '2', previousBatchRoot: r.hash('previous'),
    bitcoinAnchor: { height: String(checkpoint.height), hash: checkpoint.hash }, settingsHash: r.hashObject(document), catalogRoot: r.namedStateRoot(r.emptyNamedDiscovery()),
    accountsRoot: r.hash('accounts'), receiptSegmentStart: '0', schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: KIT_VERSION, route: 'terminal-import' };
  const legacyPins = structuredClone(pins); delete legacyPins.runtime.deployment.v2;
  const oldStore = playerPeerStore(legacyPins); assert.equal(oldStore, 'peer');
  pins.runtime.deployment.v2 = { manifest, manifestHash: r.hashObject(manifest), document, importRoot: r.hash('import'), importRows: 1,
    receiptProtocol: 1, gateway: pins.gatewayKey, receiptSigners: structuredClone(pins.receiptSigners) };
  validateMainnet(pins); assert.equal(playerPeerStore(pins), 'peer-v2-' + pins.trac.bootstrap);
  const bad = structuredClone(pins); bad.runtime.deployment.v2.manifest.accountsRoot = r.hash('changed'); assert.throws(() => validateMainnet(bad));
  for (const mutate of [
    v => { v.gateway = r.hash('other-gateway'); },
    v => { v.receiptSigners[0].identity = r.hash('other-witness'); },
    v => { v.receiptSigners[0].secret = 'not-public'; },
  ]) { const changed = structuredClone(pins); mutate(changed.runtime.deployment.v2); assert.throws(() => validateMainnet(changed)); }
  const wallet = await createWallet(); t.after(() => wipeWallet(wallet)); let closed = 0;
  const context = { ready: true, ruleset: 'dmw-v2', manifest, manifestHash: r.hashObject(manifest), settings: document, settingsHash: r.hashObject(document) };
  const api = { dmwAuthority: async () => ({ network: pins.network }), dmwHead: async () => ({ tip: { height: String(checkpoint.height), hash: checkpoint.hash }, counted: String(checkpoint.height) }),
    dmwHashAt: async h => { assert.equal(h, String(checkpoint.height)); return checkpoint.hash; }, dmwRulesContext: async () => context,
    dmwSettingsByHash: async h => { assert.equal(h, r.hashObject(document)); return document; }, dmwAccountRoot: async () => null,
    dmwFinancialRecord: async key => ({ key }), dmwBatchRoot: async n => n };
  const runtime = { peer: { wallet: runtimeWallets(wallet).peer, config: { dmw: pins.runtime.deployment },
    base: { key: Buffer.from(pins.trac.bootstrap, 'hex'), update: async () => {} }, protocol: { instance: { api } } },
    bus: { config: { networkId: 918, bootstrap: Buffer.from(pins.trac.msbBootstrap, 'hex') }, network: { validatorConnectionManager: { connectedValidators: () => [], pickRandomValidator: () => null, pickRandomConnectedValidator: () => null }, validatorMessageOrchestrator: { send: () => assert.fail("No paid send") } } }, close: async () => { closed++; } };
  const service = new ServiceClient({ mode: 'mainnet', origin: pins.gateway, fetchImpl: async url => new URL(url).pathname === '/health'
    ? Response.json({ tip: String(checkpoint.height) }) : new Response(checkpoint.hash) });
  const adapter = await createAdapter({ wallet, network: pins.network, pins, config: { ...pins, directory: await temp(t) }, service, openRuntime: async () => runtime });
  t.after(() => adapter.close());
  assert.deepEqual(await adapter.trac.rulesContext(), context);
  assert.deepEqual(await adapter.trac.settingsByHash(r.hashObject(document)), document);
  assert.equal(await adapter.trac.accountRoot(publicKey(wallet)), null);
  assert.deepEqual(await adapter.trac.financialRecord('fc/' + '12'.repeat(32)), { key: 'fc/' + '12'.repeat(32) });
  assert.equal(await adapter.trac.batchRoot('9007199254740993'), '9007199254740993');
  assert.equal((await adapter.trac.head()).counted, checkpoint.height); assert.equal(closed, 0);
});
