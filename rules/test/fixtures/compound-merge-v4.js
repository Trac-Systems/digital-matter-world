import * as r from '../../src/index.js';
export function mergeFixture() {
  const network = 'compound-merge-test', owner = r.hash('original maker'), other = r.hash('later maker');
  const settings = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
  const inputs = [['p2:0', '1'], ['p2:1', '1']]; let state = r.emptyNamedDiscovery();
  for (let i = 0; i < 2; i++) {
    const record = { number: String(i), key: r.hash('pattern/' + i), fld: 10, catalogRevision: '1', knownMatchCount: '100',
      anchor: { height: '973000', hash: r.hash('anchor') }, settingsHash: r.hashObject(settings), ...(i === 0 ? { legacy: { asset: 'p0' } } : {}) };
    state.records = r.namedSet(state.records, 'number/' + i, record.key); state.records = r.namedSet(state.records, 'pattern/' + record.key, record);
  }
  const records = [];
  for (const height of ['973796', '973803']) {
    const made = r.previewCraftV2(state, { recipe: 'fusion', inputs, snapshot: { height, hash: r.hash(height) }, settings });
    state = made.state; records.push(made.record);
    state.records = r.namedSet(state.records, 'compound/maker/' + made.record.id, { owner: records.length === 1 ? owner : other, created: height, provenance: { batch: height } });
  }
  const id = r.compoundIdentityV4('fusion', inputs).id;
  const manifest = { network, ready: true, rows: records.map((c, i) => ({ oldId: c.id, newId: id, holder: owner, amount: i ? '10' : '1' })) };
  return { network, owner, other, settings, state, records, id, manifest };
}
