import { ed25519 } from '@noble/curves/ed25519';

// Accepts either the frozen release rules or current rules. The only evidence
// reads are the anchor and three named headers; no historical scan is available.
export function amountReplay(r, { executionHeight, value = false }) {
  const height = '10002', network = 'amount-replay';
  const document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
  const secret = r.hashBytes('amount-replay-agent'), agent = r.bytesToHex(ed25519.getPublicKey(secret));
  const gatewaySecret = r.hashBytes('amount-replay-gateway'), gateway = r.bytesToHex(ed25519.getPublicKey(gatewaySecret));
  const hashAt = h => r.hash(String(h)), history = { get length() { throw Error('history_scan'); }, get: h => ({ height: h, hash: hashAt(h), nonce: 3789512813, bits: 386007187 }) };
  const proposal = { name: 'dmwreplay', pat: '1', fld: 10, dt: 'n', ...(value ? { amountMode: 'field-value' } : {}) };
  const salt = r.hash('amount-replay-salt'), anchor = { height: '10000', hash: hashAt('10000') };
  const matches = ['1', '10', '11'].map(h => ({ height: h, hash: hashAt(h), count: value ? '3789512813' : '2' }));
  // Construct the new commitment without requiring the retained release to
  // understand the mode. The old replay must reject the new packet unchanged.
  const canonical = { pat: proposal.pat, fld: proposal.fld, dt: proposal.dt, ...(value ? { amountMode: 'field-value' } : {}) };
  const commitment = r.hashObject(['dmw-discovery-v2', network, document.ruleset, document.revision, r.hashObject(document), agent,
    canonical, proposal.name, salt, anchor, r.witnessRoot(matches)]);
  const named = r.commitNamedDiscovery(r.emptyNamedDiscovery(), { agent, commitment, tip: '10000', receiptPosition: '1', settings: document });
  const saved = new r.NamedStorage({ get: () => null, cacheSize: 64 }).save(named), nodes = new Map(saved.writes.map(row => [row.id, row.value]));
  const claims = r.initialClaimSnapshot({ bitcoinAnchor: { height } }, '10001');
  const state = { ...claims.hot, claimSnapshot: claims, claimRoot: r.claimStateRoot(claims), namedSnapshot: saved.snapshot, catalogRoot: r.namedStateRoot(named) };
  const witnesses = [1, 2, 3, 4, 5].map(n => { const secret = r.hashBytes('amount-replay-witness-' + n); return { id: String(n), secret, identity: r.bytesToHex(ed25519.getPublicKey(secret)) }; });
  const move = { v: 2, ruleset: 'dmw-v2', network, settingsHash: r.hashObject(document), settingsRevision: document.revision, a: agent,
    t: 'discovery-reveal-v2', b: height, h: hashAt(height), w: '0', p: { proposal, salt, anchor, matches, commitmentId: commitment, witnessRoot: r.witnessRoot(matches) } };
  move.sig = r.bytesToHex(ed25519.sign(r.moveDigestV2(move), secret));
  const receipt = r.signReceiptV2(move, { tip: height, hash: hashAt(height), sequence: '2', batch: '1' }, gatewaySecret);
  const seal = r.sealReceiptSegment([receipt], { network, tip: height, hash: hashAt(height), segment: '0', previous: null,
    ruleset: document.ruleset, settingsRevision: document.revision, settingsHash: r.hashObject(document) }, gatewaySecret);
  const output = r.processBlockV2({ state, settings: r.batchSettings({ document, receiptSigners: witnesses.map(({ secret, ...w }) => w) }),
    network, gateway, batchSequence: '1', entries: [{ move, receipt }], receiptRoot: seal,
    rootAttestations: witnesses.slice(0, 3).map(w => r.attestReceiptRoot(seal, height, w.id, w.secret)),
    height, tip: height, executionHeight, blockHash: hashAt(height), tipHash: hashAt(height), history, hashAt,
    claimEvidence: { nodes: [] }, namedEvidence: { nodes: [] } }, { namedNodeGet: id => nodes.get(id) });
  return { auditHash: r.hash(output.auditBytes), catalogRoot: output.state.catalogRoot, claimRoot: output.state.claimRoot,
    outcome: output.file.moves[0]?.reason, amount: output.file.discoveries[0]?.record.knownOccurrenceTotal ?? null };
}
