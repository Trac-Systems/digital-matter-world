import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { rules as r, initialState } from '../src/rules.mjs';
import { NamedStorage } from '../src/named-storage.mjs';
import { edPublic } from '../src/util.mjs';
import { phase, lifecycleSignal } from '../src/lifecycle.mjs';

// The production orchestrator and v2 admission are real. Only independent
// source/committee I/O is replaced, with deterministic loopback delays.
export async function restartFixture({ adapterMs = 300, notaryMs = 400, committeeMs = 700, publicMs = 1000, pollMs = 5000 } = {}) {
  const root = await mkdtemp(fileURLToPath(new URL('../../.fr1-restart-', import.meta.url)));
  const secret = Buffer.alloc(32, 9), network = 'dmw-regtest', events = [];
  const controller = new AbortController();
  let pendingResolve, committeeResolve;
  const polling = new Promise(resolve => { pendingResolve = resolve; });
  const committeePolling = new Promise(resolve => { committeeResolve = resolve; });
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/poll') { pendingResolve(); await delay(pollMs, undefined, { signal: controller.signal }); }
      else { committeeResolve(); await delay(committeeMs, undefined, { signal: controller.signal }); }
    } catch { return; }
    const id = req.headers.authorization?.slice('Bearer '.length);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id, network, epoch: 1, tip: '0', counted: '0', manifestHash: config.v2.manifestHash,
      capabilities: r.runtimeCapabilities(document, resources) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const committee = Array.from({ length: 5 }, (_, i) => ({ id: `member-${i}`, url: origin, token: `member-${i}`,
    peer: { id: `member-${i}`, identity: edPublic(Buffer.alloc(32, i + 1)), encryption: edPublic(Buffer.alloc(32, i + 11)), url: origin } }));
  const document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
  const resources = r.resourceRevision({ operator: 'restart-fixture', values: { ...r.RESOURCE_PROFILE } });
  const named = r.emptyNamedDiscovery(), manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '1',
    previousBatchRoot: '00'.repeat(32), bitcoinAnchor: { height: '0', hash: '11'.repeat(32) }, settingsHash: r.hashObject(document),
    catalogRoot: r.namedStateRoot(named), accountsRoot: '22'.repeat(32), receiptSegmentStart: '0',
    schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const config = { mode: 'regtest', network, data: join(root, 'gateway'), gatewayKey: join(root, 'gateway.hex'),
    adapter: fileURLToPath(import.meta.url), committee, pollMs: 60000, listen: { host: '127.0.0.1', port: 0 },
    local: { escrow: { chainId: '31337', token: '0x' + '11'.repeat(20), address: '0x' + '22'.repeat(20) } }, endpoints: { ethereum: 'http://127.0.0.1:1' },
    v2: { manifest, manifestHash: r.hashObject(manifest), document, resources },
    onPhase: row => events.push(row), restartFixture: { adapterMs, notaryMs, publicMs, origin, events } };
  await writeFile(config.gatewayKey, secret.toString('hex'), { mode: 0o600 });
  const store = await Store.open(config.data);
  try {
    const saved = new NamedStorage({ get: id => store.get('namedNodes', id), cacheSize: 64 }).save(named);
    const claimSnapshot = r.initialClaimSnapshot(manifest, 0);
    await store.transact([...saved.writes, { space: 'meta', id: 'v2Activation', value: config.v2.manifestHash },
      { space: 'meta', id: 'ruleState', value: { ...initialState(0, manifest.bitcoinAnchor.hash, 0), ...claimSnapshot.hot,
        batchVersion: 2, namedSnapshot: saved.snapshot, catalogRoot: manifest.catalogRoot, claimSnapshot, claimRoot: r.claimStateRoot(claimSnapshot) } }]);
  } finally { await store.close(); }
  return { config, events, polling, committeePolling, origin, async close() {
    controller.abort();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  } };
}

export async function createAdapters({ config, store }) {
  const f = config.restartFixture, signal = lifecycleSignal();
  await phase('fixture.trac_open', () => delay(f.adapterMs, undefined, { signal }));
  const reads = {
    rulesContext: async () => { await delay(f.notaryMs, undefined, { signal }); return { ready: true, manifest: config.v2.manifest,
      manifestHash: config.v2.manifestHash, settings: config.v2.document, settingsHash: r.hashObject(config.v2.document),
      last: { n: '0' }, catalogRoot: config.v2.manifest.catalogRoot, claimsRoot: store.get('meta', 'ruleState').claimRoot }; },
    registry: async () => ({ assets: {} }),
    head: async () => { await delay(f.publicMs, undefined, { signal }); throw Error('fixture_public_pending'); }
  };
  return { reads, transport: {}, observations: async () => {
    const { post } = await import('../src/committee.mjs');
    await post({ url: f.origin, token: 'fixture' }, '/poll', {}, 30000); return [];
  }, close: async () => {} };
}
