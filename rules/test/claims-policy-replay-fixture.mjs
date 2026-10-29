import { ed25519 } from '@noble/curves/ed25519';

// This fixture runs against both the retained and current rules modules.
export async function claimsPolicyReplay(r, applyPublicScan) {
  const first = r.settingsRevision({ network: 'claims-policy-replay', effectiveBatch: '1', effectiveBitcoinWindow: '0',
    values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
  const document = r.settingsRevision({ network: first.network, previous: first, effectiveBatch: '2', effectiveBitcoinWindow: '100',
    values: { ...first.values, ...r.PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '100' } });
  const hashAt = height => r.hash(String(height)), history = { get: height => ({ height: Number(height), hash: hashAt(height) }) };
  const secret = r.hashBytes('claims-policy-agent'), agent = r.bytesToHex(ed25519.getPublicKey(secret)), gatewaySecret = r.hashBytes('claims-policy-gateway');
  const proposal = { name: 'dmwforever', pat: '[0-9]', fld: 4, dt: 'n' }, salt = r.hash('claims-policy-salt');
  const anchor = { height: '90', hash: hashAt('90') }, matches = ['1', '10', '11'].map(height => ({ height, hash: hashAt(height), count: String(height.length) }));
  const commitment = r.namedCommitment({ proposal, salt, agent, anchor, matches, settings: first });
  const named = r.revealNamedDiscovery(r.commitNamedDiscovery(r.emptyNamedDiscovery(), { agent, commitment, tip: '90', receiptPosition: '1', settings: first }),
    { agent, commitmentId: commitment, proposal, salt, anchor, matches, witnessRoot: r.witnessRoot(matches), tip: '92', counted: '92',
      receiptPosition: '2', history, settings: first }).state;
  const namedSaved = new r.NamedStorage({ get: () => null, cacheSize: 64 }).save(named), namedNodes = new Map(namedSaved.writes.map(row => [row.id, row.value])), claimNodes = new Map();
  const snapshot = r.initialClaimSnapshot({ bitcoinAnchor: { height: '1107' } }, '1106');
  let state = { ...snapshot.hot, claimSnapshot: snapshot, claimRoot: r.claimStateRoot(snapshot), namedSnapshot: namedSaved.snapshot, catalogRoot: r.namedStateRoot(named) };
  const witnesses = [1, 2, 3, 4, 5].map(n => { const secret = r.hashBytes('claims-policy-witness-' + n); return { id: String(n), secret, identity: r.bytesToHex(ed25519.getPublicKey(secret)) }; });
  const settings = r.batchSettings({ document, receiptSigners: witnesses.map(({ secret, ...identity }) => identity) });
  const files = [], outcomes = [], roots = [];
  for (let i = 0; i < 4; i++) {
    const height = String(1107 + i), entries = [];
    if (i < 2) {
      const move = { v: 2, ruleset: 'dmw-v2', settingsHash: r.hashObject(document), settingsRevision: document.revision, network: document.network,
        a: agent, t: 'claim-v2', b: height, h: hashAt(height), p: { window: height, plots: [{ block: String(12 + i), patterns: ['0'] }] }, w: '0' };
      move.sig = r.bytesToHex(ed25519.sign(r.moveDigestV2(move), secret));
      entries.push({ move, receipt: r.signReceiptV2(move, { tip: height, hash: hashAt(height), sequence: String(i + 1), batch: '2' }, gatewaySecret) });
    }
    const seal = r.sealReceiptSegment(entries.map(e => e.receipt), { network: document.network, tip: height, hash: hashAt(height), segment: '0', previous: null,
      ruleset: document.ruleset, settingsRevision: document.revision, settingsHash: r.hashObject(document) }, gatewaySecret);
    const output = r.processBlockV2({ state, settings, network: document.network, gateway: r.bytesToHex(ed25519.getPublicKey(gatewaySecret)), batchSequence: '2',
      entries, receiptRoot: seal, rootAttestations: witnesses.slice(0, 3).map(w => r.attestReceiptRoot(seal, height, w.id, w.secret)),
      height, executionHeight: height, blockHash: hashAt(height), tip: height, tipHash: hashAt(height), history, hashAt,
      claimEvidence: { nodes: [] }, namedEvidence: { nodes: [] }, settingsDocuments: [first] },
    { claimNodeGet: id => claimNodes.get(id), namedNodeGet: id => namedNodes.get(id) });
    for (const row of output.claimWrites) claimNodes.set(row.id, row.value);
    for (const row of output.namedWrites) namedNodes.set(row.id, row.value);
    state = output.state; files.push(r.hash(output.auditBytes)); outcomes.push(...output.file.moves.map(m => m.reason)); roots.push(state.claimRoot);
  }
  const asset = 'p2:0', block = '14', id = r.hash('claims-policy-payment'), generation = r.hash('claims-policy-generation'), deployment = r.hash('claims-policy-deployment') + 'i0';
  const records = new Map([['fd/asset/' + asset, generation], ['fd/' + generation, { asset, deployment, minted: '0', reserved: '0', maximum: '20' }]]);
  const source = { publicMint: true, requestId: id, asset, amount: '2', request: { asset, block, amount: '2' }, payer: 'wallet', receiver: 'wallet',
    deployment: { id: deployment }, generation, fees: [{ key: r.hash('fee'), amount: '10' }], capacity: { deployment, asset, block, amount: '2', remaining: '20', limit: '0' } };
  const payment = { id, asset, block, tapAddress: 'wallet', reference: r.hash('claims-policy-inscription') + 'i0', height: '1108', transactionIndex: '0', inscriptionIndex: '0',
    complete: true, fees: [{ amount: '10' }], paymentHash: r.hash('paid'), permitHash: r.hash('permit'), source };
  const operation = { id: r.publicPlotId(asset, block), asset, block, previous: r.hashObject(null), start: '1108',
    from: { height: '1108', transactionIndex: '0', inscriptionIndex: '0' }, next: { height: '1109', transactionIndex: '0', inscriptionIndex: '0' },
    blockHash: hashAt('1108'), payments: [payment] };
  await applyPublicScan({ get: async key => records.get(key), put: (key, value) => records.set(key, value) }, operation,
    { height: '1110', settings: { publicMintActivationHeight: '100', publicMintPageSize: 50, paymentPage: 32 } });
  return { document: r.hashObject(document), files, outcomes, roots, publicRecords: r.hashObject([...records]),
    rightBefore: r.publicBlockRight({ pattern: {}, block: '12', height: '1107', settings: document }),
    rightAfter: r.publicBlockRight({ pattern: {}, block: '12', height: '1108', settings: document }) };
}
