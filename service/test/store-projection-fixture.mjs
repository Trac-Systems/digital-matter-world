import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { rules } from '../src/rules.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { serve } from '../src/http.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';

export async function projectionFixture() {
  const directory = await mkdtemp(join(process.env.DMW_BUILD_ROOT ?? tmpdir(), 'projection-equivalence-'));
  let store = await Store.open(directory), http;
  const owner = 'a'.repeat(64), other = 'b'.repeat(64), snapshots = [], responses = {};
  const op = (space, id, value) => ({ space, id, value });
  const pattern = { number: '1', name: 'é漢😀', knownMatchCount: '2', discoverer: owner, tier: 1 };
  const find = { asset: 'p2:1', block: '1', finder: owner, finderUntil: '20', findHeight: '2', count: '2' };
  const snapshot = () => {
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'public%' OR name LIKE 'projection%' OR name IN ('records','evidence_values','evidence_nodes','evidence_root')) ORDER BY name").all();
    snapshots.push(Object.fromEntries(tables.map(({ name }) => [name, rules.hash(JSON.stringify(store.db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort()))])));
  };
  try {
    await store.put('meta', 'ruleState', { batchVersion: 2, counted: '10' });
    await store.transact([
      op('meta', 'head', { tip: '10', hash: 'c'.repeat(64) }), op('catalogPatterns', 'p2:1', pattern), op('catalogPatterns', 'p2:2', { ...pattern, number: '2', name: 'second' }),
      op('catalogTypes', 'c2:1', { id: 'c2:1', properties: { mass: '12' }, firstMaker: owner }),
      op('catalogAgents', owner, { address: owner, findCount: '2', discoveryCount: '1' }),
      op('discoveriesByAgent/' + owner, 'p2:1', pattern), op('finds', 'find', find),
      op('findsByAgent/' + owner, 'find', find), op('links', rules.uintKeyV2('1'), { block: '1', owner, linkHeight: '2' }),
      op('minted', 'p2:1/1', 'inscription'), op('publicBalances', owner + '/p2:1', { owner, asset: 'p2:1', amount: '20' }),
      op('submittedBitmaps', rules.uintKeyV2('1'), { block: '1', agent: owner, address: 'verified' }),
      op('publicEvents', 'event', { sequence: '1', at: 20, type: 'find', data: { owner, finder: other } }),
      op('publicResults/payments', 'payment', { id: 'payment', block: '1', owner, action: 'paid', total: '2' }),
      op('publicSupply', 'p2:1', { asset: 'p2:1', issued: '20', burned: '0', outstanding: '20' }),
      op('mints', 'mint', { request: { asset: 'p2:1', block: '1', amount: '2', owner }, kind: 'tap', state: 'pending' }),
      op('linkRequests', 'link', { request: { height: '1' }, paymentId: 'link-payment', paymentEvidence: { amount: '2' } }),
      op('payoutTotals', 'payout', { beneficiary: owner, accrued: '10', paid: '2' }),
      op('commissionOwed', 'owed', { amount: '8', to: owner }), op('payoutPaid', 'paid', { amount: '2', to: owner }),
      op('window/2/winners', 'draw', { row: { block: '1', agent: owner }, batch: '2', audit: 'audit', root: 'root' }),
      op('windowEligibility', '2', { window: '2', agent: owner }),
      op('ceremonies', 'mint/one', { result: {} }), op('patternsByAsset', 'p2:1', pattern),
    ]);
    snapshot();
    await store.transact([
      op('catalogPatterns', 'p2:1', pattern), op('catalogPatterns', 'p2:1', pattern),
      op('catalogPatterns', 'p2:1', { ...pattern, name: 'new name' }),
      op('publicEvents', 'event', { sequence: '1', at: 20, type: 'find', data: { owner: other } }),
      op('submittedBitmaps', rules.uintKeyV2('1'), { block: '1', agent: other, address: 'other' }),
      op('publicResults/payments', 'transient', { id: 'transient', owner, total: '1' }), op('publicResults/payments', 'transient'),
      op('feedEvents', 'pending', { finds: [find], discoveries: [], types: [] }),
    ]);
    snapshot();
    const pendingAPI = createPublicAPI({ views: { store } });
    try { await pendingAPI.read('/world'); } catch (e) { responses.pending = [e.status, e.message]; }
    await store.transact([op('feedEvents', 'pending'), op('links', rules.uintKeyV2('1')), op('minted', 'p2:1/1'), op('rankExpiry', 'ever/find', { kind: 'ever', id: 'find' })]);
    snapshot();
    // Exercise the bounded flush paths as well as repeated equivalent rows.
    await store.transact(Array.from({ length: 300 }, (_, i) => op('publicResults/credits', String(i), { id: String(i), owner, amount: String(i) })));
    snapshot();
    const api = createPublicAPI({ views: { store }, settings: { publicPageBytes: 1100, patternDetailRows: 4 } });
    http = await serve({ files: { serve: async () => false }, publicAPI: api });
    for (const path of ['/patterns?sort=name', '/patterns?sort=number&order=desc', '/compounds', '/agents', '/finds', '/feed', '/world?found=true', '/results/payments', '/results/credits?limit=4', '/results/supply', '/payouts/beneficiaries', '/windows/2/winners', '/window-eligibility', '/agents/' + encodeTracAddress(owner) + '/discoveries']) {
      const response = await fetch(http.url + path); responses[path] = [response.status, await response.text()];
    }
    await http.close(); http = null;
    await store.close(); store = await Store.open(directory); snapshot();
    // Rebuild from the fsynced journal, whose frames are replayed independently
    // of the original grouped SQLite transaction boundaries.
    await store.close();
    for (const name of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) await rm(join(directory, name), { force: true });
    store = await Store.open(directory); snapshot();
    return { snapshots, responses, evidenceRoot: store.evidenceIndex.root() };
  } finally { await http?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
}
