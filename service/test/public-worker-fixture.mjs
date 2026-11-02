import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { History } from '../src/history.mjs';
import { HeaderFiles } from '../src/header-files.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { BulkMints } from '../src/bulk-mints.mjs';
import { FinancialActions } from '../src/financial-actions.mjs';
import { PublicReadPool } from '../src/public-read-pool.mjs';
import { createWeb } from '../src/web.mjs';
import { rankingHighlights } from '../src/public-rankings.mjs';
import { serve } from '../src/http.mjs';
import { agent, fixtureHistory, temp, secret } from './helpers.mjs';
import { bindingFixture } from './bindings-fixture.mjs';
import { hash, heightKey } from '../src/util.mjs';
import { rules } from '../src/rules.mjs';

export async function publicWorkerFixture({ settings = {}, rows = 8, startServers = true } = {}) {
  const root = await temp('public-workers-'), store = await Store.open(root), files = new Files(join(root, 'static'));
  const servers = []; let pool;
  const close = async () => { await Promise.all(servers.map(s => s.close())); await pool?.close(); await store.close(); await rm(root, { recursive: true, force: true }); };
  try {
    await store.put('meta', 'ruleState', { batchVersion: 2, counted: '100' });
    const source = fixtureHistory(5), owner = agent(3).address;
    const operations = [
      { space: 'meta', id: 'head', value: { tip: '100', hash: source.hashAt(5) } },
      { space: 'meta', id: 'headerHeight', value: '5' },
      { space: 'publicDeployments', id: 'p2:0', value: { id: 'deployment', suspended: false } },
      { space: 'publicBalances', id: owner + '/p2:0', value: { owner, asset: 'p2:0', amount: '10' } },
      { space: 'catalogPatterns', id: 'p2:0', value: { number: '0', asset: 'p2:0', name: 'dmwpattern', discoverer: owner, knownMatchCount: '1', anchor: { height: '100' }, catalogRevision: '1' } },
      { space: 'batches', id: heightKey('1'), value: { batch: { n: '1', from: '0', to: '100', root: hash('batch') } } },
      { space: 'receiptRenewalProofs', id: hash('renewal') + '/1', value: { root: hash('proof'), rows: [] } },
    ];
    for (let i = 0; i < source.length; i++) operations.push({ space: 'headers', id: heightKey(String(i)), value: { raw: source.raw(i), hash: source.hashAt(i), fields: source.get(i) } });
    for (let i = 0; i < rows; i++) {
      operations.push({ space: 'finds', id: rules.findIdV2(String(i), '0'), value: { block: String(i), asset: 'p2:0', pattern: '0', count: '1', finder: owner, findHeight: '10', finderUntil: '200' } },
        { space: 'publicEvents', id: heightKey(String(i)), value: { id: hash('event' + i), sequence: String(i), type: 'claim', at: i, data: { agent: owner }, provenance: { height: String(i) } } });
    }
    await store.transact(operations);
    const bindings = bindingFixture(store), record = await bindings.bind(agent(3), 'tap');
    const headers = new HeaderFiles({ history: new History(store), files, network: 'regtest', secret });
    // A signed fixture root lets read-only manifest serving exercise the exact
    // production path without invoking the publisher from an HTTP request.
    await store.put('meta', 'headerChunks', { version: 2, network: 'regtest', height: 5, tip: source.hashAt(5), root: { hash: hash('tree') } });
    const artifact = await files.json('patterns/p0/' + hash('artifact') + '-' + hash('file') + '.json', { rows: [1, 2, 3] }, { immutable: true });
    const chunk = await files.immutable('headers/chunks/' + hash('chunk') + '.bin', Buffer.alloc(300000, 17));
    const tree = await files.json('headers/tree/' + hash('tree') + '.json', { children: [] }, { immutable: true });
    const archive = await files.immutable('headers/regtest-5-' + source.hashAt(5) + '.bin', Buffer.alloc(480, 21));
    const artifacts = [
      await files.json('blocks/example.json', { height: '1', owner }, { immutable: true }),
      await files.immutable('blocks/example.bin', Buffer.from('fixture block bytes')),
      await files.json('receipts/example.json', { observation: '1' }, { immutable: true }),
      await files.json('records/example-' + hash('record-file') + '.json', { records: [] }, { immutable: true }),
      await files.immutable('headers/chunks/' + hash('compressed') + '.gz', Buffer.from('fixture gzip bytes')),
      await files.immutable('headers/regtest-5-' + source.hashAt(5) + '.bin.' + hash('archive-gzip') + '.gz', Buffer.from('fixture archive bytes')),
    ];
    await files.json('latest.json', { observation: '1', rows: [1, 2, 3] });
    const mints = { document: { values: {} } }, views = { store, mints, status: () => ({ ready: true }) };
    const publicAPI = createPublicAPI({ views, files });
    const bulkMints = { store, ...Object.fromEntries(['row', 'page', 'terms', 'members'].map(name => [name, BulkMints.prototype[name]])) };
    await store.put('bulkOrders', 'a'.repeat(64), { body: { terms: { receiver: owner, members: [{ owner, block: '1', amount: '1' }, { owner, block: '2', amount: '1' }] }, feeManifest: { payer: owner } } });
    await store.put('financialQueue', 'a'.repeat(64), { type: 'lifecycle' });
    const options = { intake: { store }, files, headers, publicAPI, bulkMints, financialActions: new FinancialActions({ store }), bindings: bindings.bindings,
      web: createWeb({ records: () => rankingHighlights(store), bulkMints, target: { network: 'test' } }),
      operator: { status: () => ({ live: true }) }, readBudget: { enabled: false }, maxConnections: 512, maxInFlight: 512 };
    const poolOptions = { directory: root, filesDirectory: files.directory, version2: true, publicAPI, mints, bulkReads: true, financialActions: true,
      bindingsOptions: { network: bindings.bindings.network, bitcoinNetwork: 'regtest', members: bindings.members },
      headerOptions: { network: 'regtest' }, checkout: true, operator: true, settings: { threads: 2, ...settings } };
    pool = await PublicReadPool.open(poolOptions);
    const result = { root, store, files, publicAPI, options, poolOptions, pool, owner, record, artifact, chunk, tree, archive, artifacts, close };
    if (startServers) {
      result.direct = await serve(options); servers.push(result.direct);
      result.threaded = await serve({ ...options, readPool: pool }); servers.push(result.threaded);
    }
    return result;
  } catch (error) { await close(); throw error; }
}
