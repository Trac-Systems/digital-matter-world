import { rules } from '../src/rules.mjs';
import { hash, heightKey } from '../src/util.mjs';
import { evidenceKey, verifyRange } from '../src/authenticated-index.mjs';

export function largeWriterBatch() {
  return Array.from({ length: 50000 }, (_, i) => {
    const id = String(i), n = String(Math.floor(i / 5)), owner = 'a'.repeat(64);
    switch (i % 5) {
      case 0: return { space: 'types', id, value: { id, properties: { mass: n }, name: 'type ' + n } };
      case 1: return { space: 'catalogAgents', id, value: { address: id, findCount: n, discoveryCount: '0' } };
      case 2: return { space: 'claimed2/p2:0', id: rules.uintKeyV2(n), value: { height: n, pattern: '0', count: '1', found: true, minted: false } };
      case 3: return { space: 'publicEvents', id, value: { sequence: id, type: 'find', at: i, data: { owner } } };
      default: return { space: 'accountNodes', id, value: { hash: id, values: [i, n] } };
    }
  });
}

export function randomWriterBatches() {
  let state = 0x1a2b3c4d;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const batches = [[{ space: 'meta', id: 'ruleState', value: { batchVersion: 2 } },
    { space: 'officialCatalogNameIndex', id: 'ready', value: { version: 1 } },
    ...['a', 'b'].map(owner => ({ space: 'payoutBindings', id: owner, value: { request: { address: owner.repeat(64) } } }))]];
  for (let batch = 0; batch < 12; batch++) {
    const operations = [];
    for (let i = 0; i < 300; i++) {
      const n = String(random() % 48), asset = 'p2:' + n, owner = (random() % 2 ? 'a' : 'b').repeat(64), amount = String(random() % 1000);
      const pattern = { number: n, name: 'dmwstone' + n, knownMatchCount: amount, discoverer: owner };
      let op;
      switch (random() % 17) {
        case 0: op = { space: 'accountNodes', id: n, value: { n, text: 'é漢😀', bytes: 'x'.repeat(batch % 3 ? 4 : 1100) } }; break;
        case 1: op = { space: 'types', id: 'c' + n, value: { name: 'compound' + n, properties: { mass: amount } } }; break;
        case 2: op = { space: 'patternsByAsset', id: asset, value: pattern }; break;
        case 3: op = { space: 'catalogPatterns', id: asset, value: pattern }; break;
        case 4: op = { space: 'catalogAgents', id: owner, value: { address: owner, findCount: amount, discoveryCount: n } }; break;
        case 5: op = { space: 'finds', id: n, value: { asset, block: n, finder: owner, finderUntil: '100', findHeight: '2', count: amount } }; break;
        case 6: op = { space: 'claimed2/' + asset, id: rules.uintKeyV2(n), value: { height: n, pattern: n, count: amount, found: !!(random() % 2), minted: false } }; break;
        case 7: op = { space: 'publicEvents', id: n, value: { sequence: n, type: 'find', at: batch, data: { owner } } }; break;
        case 8: op = { space: 'publicSupply', id: asset, value: { asset, issued: amount, burned: '0', outstanding: amount } }; break;
        case 9: op = { space: 'minted', id: asset + '/' + n, value: 'inscription' + batch }; break;
        case 10: op = { space: 'payoutTotals', id: hash(owner), value: { beneficiary: owner, accrued: amount, paid: '3' } }; break;
        case 11: op = { space: 'mints', id: n, value: { request: { asset, block: n, owner }, kind: 'tap', state: 'pending' } }; break;
        case 12: op = { space: 'linkRequests', id: n, value: { request: { height: n }, paymentId: 'payment' + n } }; break;
        case 13: {
          const block = String(batch * 300 + i);
          op = { space: 'links', id: heightKey(block), value: { block, owner, linkHeight: '2' } }; break;
        }
        case 14: op = { space: 'publicBalances', id: owner + '/' + asset, value: { owner, asset, amount } }; break;
        case 15: op = { space: 'findProvenance', id: n, value: String(batch) }; break;
        default: op = { space: 'payoutCurrent', id: asset + '/tap', value: random() % 2 ? 'a' : 'b' };
      }
      if (random() % 4 === 0) delete op.value;
      operations.push(op);
      if (i % 50 === 0 && op.space !== 'links') operations.push(structuredClone(op));
    }
    if (batch === 4 || batch === 5) operations.unshift({ space: 'meta', id: 'ruleState', value: { batchVersion: batch === 4 ? 1 : 2 } });
    batches.push(operations);
  }
  return batches;
}

export function writerSnapshot(store) {
  const tables = Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => {
    const rows = store.db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort();
    return [name, { rows: rows.length, digest: hash(JSON.stringify(rows)) }];
  }));
  const root = store.evidenceIndex.root();
  const proofs = [['types', 'c0', 'c99'], ['patternsByAsset', 'p2:0', 'p2:99'], ['finds', '', '~'], ['types', 'missing', 'missing']].map(([space, from, to]) => {
    const lower = evidenceKey(space, from), upper = evidenceKey(space, to), proof = store.evidenceIndex.proof(lower, upper, 8192);
    const leaves = verifyRange(root, lower, upper, proof, 8192);
    return { space, from, to, leaves: leaves.length, digest: hash(JSON.stringify(proof)) };
  });
  return { sequence: store.sequence, decimalSequence: store.decimalSequence, publicProjectionActive: store.publicProjectionActive,
    evidenceReady: store.evidenceReady, tables, root, proofs };
}

export async function writerEquivalence(StoreClass, directory) {
  const options = { checkpointBytes: 100000000, journalFrameBytes: 4096, journalFragmentBytes: 512, journalGroupBytes: 16384 };
  const seed = await (StoreClass.openForMaintenance ? StoreClass.openForMaintenance(directory, options) : StoreClass.open(directory, options));
  // Use the same disposable taken-index epoch in the two independent databases.
  const epoch = '0'.repeat(64);
  seed.db.prepare('UPDATE takenControl SET epoch=?,hash=? WHERE id=1').run(epoch, hash('taken/v1/' + epoch));
  // The original application installs this disposable invalidation index when
  // constructing its bitmap reader. Seed it before comparing standalone stores.
  seed.db.exec('CREATE TABLE IF NOT EXISTS bitmap_link_changes(id TEXT PRIMARY KEY)');
  for (const [name, op, ref] of [['Insert', 'INSERT', 'new'], ['Update', 'UPDATE', 'new'], ['Delete', 'DELETE', 'old']]) seed.db.exec(`
    CREATE TRIGGER IF NOT EXISTS bitmap_link_${name} AFTER ${op} ON records WHEN ${ref}.space='links'
    BEGIN INSERT OR IGNORE INTO bitmap_link_changes VALUES(${ref}.id); END;`);
  await seed.close();
  let store = await StoreClass.open(directory, options);
  const snapshots = [];
  try {
    for (const [i, operations] of randomWriterBatches().entries()) {
      if (i % 2) await store.transactIterable(operations);
      else await store.transact(operations);
      snapshots.push(writerSnapshot(store));
      if (i === 6) { await store.close(); store = await StoreClass.open(directory, options); snapshots.push(writerSnapshot(store)); }
    }
    await store.close(); store = await StoreClass.open(directory, options); snapshots.push(writerSnapshot(store));
    return snapshots;
  } finally { await store.close(); }
}
