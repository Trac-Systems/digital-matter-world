import { ed25519 } from '@noble/curves/ed25519';
import * as r from '../src/index.js';
import { attest, receiptSigners } from './witness-fixture.mjs';

export const first = r.settingsRevision({ network: 'permanent-claims', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
export const previous = r.settingsRevision({ network: first.network, previous: first, effectiveBatch: '2', effectiveBitcoinWindow: '100',
  values: { ...first.values, ...r.PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '100' } });
export const active = r.settingsRevision({ network: first.network, previous, effectiveBatch: '3', effectiveBitcoinWindow: '1200',
  values: { ...previous.values, claimsNeverCloseHeight: '1200' } });
export const hashAt = height => r.hash(String(height)), history = { get: height => ({ height: Number(height), hash: hashAt(height) }) };
export const pattern = { number: '7', key: r.hash('pattern'), name: 'dmwpermanent', pat: '[0-9]', fld: 4, dt: 'n', knownMatchCount: '0', knownOccurrenceTotal: '0', evidenceRoot: r.EMPTY_NAMED_ROOT,
  catalogRevision: '0', settingsHash: r.hashObject(first), definitionSettingsHash: r.hashObject(first), anchor: { height: '0', hash: hashAt('0') }, tier: 5 }, patterns = { '7': pattern };
export const agent = r.hash('agent'), payment = n => ({ id: r.hash('payment' + n), reference: r.hash('payment' + n) + 'i0', complete: true,
  height: '1200', transactionIndex: String(n), inscriptionIndex: '0' });
export function fixture(document = active, block = '12', window = '1200') {
  const settings = r.batchSettings({ document });
  const event = { ...r.claimRound(window, hashAt(window), window, { root: r.hash('catalog'), nextNumber: '8', revision: '1' }),
    policy: { settingsHash: r.hashObject(document), finderWindow: document.values.finderWindow, claimWindowBlocks: 2, claimsPerWindow: 100 } };
  return { state: { rounds: [event] }, event, patterns, pattern, asset: 'p2:7', block, history, settings, height: window, agent,
    plots: [{ block, patterns: ['7'] }] };
}
export function replayFixture(document = active, { block = '12', priorClaim = false } = {}) {
  const nodes = new Map(), namedNodes = new Map(), storage = new r.ClaimStorage({ get: id => nodes.get(id), cacheSize: 64 });
  const snapshot = r.initialClaimSnapshot({ bitcoinAnchor: { height: '1200' } }, '1199');
  const state = storage.load({ ...snapshot.hot, claimSnapshot: snapshot, claimRoot: r.claimStateRoot(snapshot) });
  if (priorClaim) {
    const f = fixture(previous, block, '1198'); r.enterClaims(f);
    for (const name of r.CLAIM_MAPS) for (const [key, value] of Object.entries(r.recordChanges(f.state[name]))) state[name] = r.recordSet(state[name], key, value);
    state.rounds = [f.event];
  }
  const saved = storage.save(state); for (const row of saved.writes) nodes.set(row.id, row.value);
  const named = r.emptyNamedDiscovery(); named.nextPattern = '8';
  named.records = r.namedSet(r.namedSet(named.records, 'number/7', pattern.key), 'pattern/' + pattern.key, pattern);
  const namedSaved = new r.NamedStorage({ get: () => null, cacheSize: 64 }).save(named);
  for (const row of namedSaved.writes) namedNodes.set(row.id, row.value);
  const secret = r.hashBytes('permanent-gateway'), gateway = r.bytesToHex(ed25519.getPublicKey(secret));
  const settings = r.batchSettings({ document, receiptSigners });
  const seal = r.sealReceiptSegment([], { network: document.network, tip: '1200', hash: hashAt('1200'), segment: '0', previous: null,
    ruleset: document.ruleset, settingsRevision: document.revision, settingsHash: r.hashObject(document) }, secret);
  const input = { state: { ...saved.state, namedSnapshot: namedSaved.snapshot, catalogRoot: r.namedStateRoot(named) }, settings,
    network: document.network, gateway, batchSequence: '3', height: '1200', executionHeight: '1200', blockHash: hashAt('1200'), tip: '1200', tipHash: hashAt('1200'),
    history, hashAt, entries: [], receiptRoot: seal, rootAttestations: attest(seal), claimEvidence: { nodes: [...nodes] }, namedEvidence: { nodes: [...namedNodes] },
    publicMintEvidence: [{ asset: 'p2:7', block, id: null }], financialPlanning: true };
  return { input, block };
}

export function withSignedClaim(input, { document = input.settings.document, block = '12', sequence = '1', segment = '0', previousSegment = null } = {}) {
  const secret = r.hashBytes('permanent-claim-sender'), gatewaySecret = r.hashBytes('permanent-gateway');
  const move = { v: 2, ruleset: 'dmw-v2', settingsHash: r.hashObject(document), settingsRevision: document.revision, network: document.network,
    a: r.bytesToHex(ed25519.getPublicKey(secret)), t: 'claim-v2', b: input.tip, h: input.tipHash,
    p: { window: input.tip, plots: [{ block, patterns: ['7'] }] }, w: '0' };
  move.sig = r.bytesToHex(ed25519.sign(r.moveDigestV2(move), secret));
  const receipt = r.signReceiptV2(move, { tip: input.tip, hash: input.tipHash, sequence, batch: input.batchSequence }, gatewaySecret);
  const seal = r.sealReceiptSegment([receipt], { network: document.network, tip: input.tip, hash: input.tipHash, segment, previous: previousSegment,
    ruleset: document.ruleset, settingsRevision: document.revision, settingsHash: r.hashObject(document) }, gatewaySecret);
  return { ...input, entries: [{ move, receipt }], receiptRoot: seal, rootAttestations: attest(seal), settingsDocuments: [first, previous] };
}

