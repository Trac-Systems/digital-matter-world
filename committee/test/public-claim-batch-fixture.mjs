import * as r from '../../rules/src/index.js';
import { replayFixture, withSignedClaim, active, first, previous, hashAt } from '../../rules/test/claims-never-close-fixture.mjs';
import { Policy } from '../signer/policy.mjs';
import { financialPlan } from '../../rules/src/financial-execution.js';

export function publicClaimBatch({ supplied = r.hash('old-public-winner'), independent = supplied, remote = false } = {}) {
  const input = withSignedClaim(replayFixture().input);
  input.state.accountRoot = r.hash('prior-accounts'); input.financialPlanning = false; input.accountOperations = [];
  input.publicMintEvidence = remote ? [] : [{ asset: 'p2:7', block: '12', id: supplied }];
  const output = r.processBlockV2(input, { publicMintGet: () => supplied });
  const manifest = { version: 1, network: active.network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '1',
    previousBatchRoot: r.hash('initial-root'), bitcoinAnchor: { height: '0', hash: hashAt('0') }, settingsHash: r.hashObject(first),
    catalogRoot: input.state.catalogRoot, accountsRoot: input.state.accountRoot, receiptSegmentStart: '0',
    schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const manifestHash = r.hashObject(manifest), activation = { sequence: '1', previousRoot: manifest.previousBatchRoot, height: '0', hash: hashAt('0'),
    ruleset: 'dmw-v2', settingsRevision: '0', settingsHash: manifest.settingsHash, manifest, manifestHash };
  const previousRoot = r.hash('prior-batch'), last = { n: '2', to: '1199' };
  const built = r.buildBatchV2({ network: active.network, epoch: '0', sequence: '3', lastTo: last.to, previousRoot,
    files: [output.file], executionHeight: '1200', executionHash: hashAt('1200'), settings: input.settings, activation,
    catalogRoot: output.state.catalogRoot, accountRoot: output.state.accountRoot });
  const proposal = { kind: 'batch', network: active.network, batch: built.batch, files: built.fileBytes.map(r.bytesToHex) };
  const { state, settings, history, hashAt: historyHash, ...wireInput } = input;
  const context = { state, settings, gateway: input.gateway, patterns: {}, inputs: [wireInput], counted: '1200', last, previousRoot, activation,
    history: { ...history, length: 1201 }, hashAt: historyHash };
  const publicKey = '02' + r.hash('public-claim-committee');
  const reads = {
    authority: async () => ({ network: active.network, committee: publicKey, epoch: '0' }), counted: async () => '1200', batchContext: async () => context,
    rulesContext: async () => ({ ready: true, ruleset: 'dmw-v2', manifest, manifestHash, settings: active, settingsHash: r.hashObject(active),
      scheduledSettings: null, last, catalogRoot: state.catalogRoot, accountsRoot: state.accountRoot, claimsRoot: state.claimRoot }),
    settingsByHash: async hash => [first, previous, active].find(d => r.hashObject(d) === hash),
    receiptCertificate: async () => ({ seal: input.receiptRoot, attestations: input.rootAttestations }),
    financialRecord: async key => key === 'dc/plot/p2:7/12' ? independent : key === 'fp/' + independent ? { publicMint: true, owner: null } : null,
    preflight: async () => ({ ok: true, counted: '1200', last, digest: r.bytesToHex(built.signingDigest) })
  };
  return { policy: new Policy({ network: active.network, publicKey, reads }), proposal, output, reads, context };
}

export async function publicScanBatch({ agentFirst = false, forgedEvidence = false } = {}) {
  const f = publicClaimBatch({ supplied: null }), wire = f.context.inputs[0], nodes = new Map(wire.claimEvidence.nodes);
  if (agentFirst) {
    const storage = new r.ClaimStorage({ get: id => nodes.get(id), cacheSize: 64 }), loaded = storage.load(f.context.state);
    loaded.claimReservations = r.recordSet(loaded.claimReservations, r.findIdV2('12', '7'), { window: '1198', winner: r.hash('earlier-agent') });
    const saved = storage.save(loaded); Object.assign(f.context.state, saved.state);
    for (const row of saved.writes) nodes.set(row.id, row.value); wire.claimEvidence = { nodes: [...nodes] };
  }
  const args = { ...wire, ...f.context, state: f.context.state }, free = r.processBlockV2(args), view = r.publicClaimProjection(free, args);
  const asset = 'p2:7', block = '12', id = r.hash('new-public-payment'), generation = r.hash('scan-generation'), deployment = r.hash('scan-deployment') + 'i0';
  const records = new Map([['fd/asset/' + asset, generation], ['fd/' + generation, { asset, deployment, minted: '0', reserved: '0', maximum: '20' }]]);
  const source = { publicMint: true, owner: null, requestId: id, asset, amount: '2', request: { asset, block, amount: '2' }, payer: 'wallet', receiver: 'wallet',
    deployment: { id: deployment }, generation, fees: [{ key: r.hash('fee'), amount: '10' }], capacity: { deployment, asset, block, amount: '2', remaining: '20', limit: '0' } };
  const payment = { id, asset, block, tapAddress: 'wallet', reference: r.hash('scan-inscription') + 'i0', height: '1200', transactionIndex: '0', inscriptionIndex: '0',
    complete: true, fees: [{ amount: '10' }], paymentHash: r.hash('paid'), permitHash: r.hash('permit'), source };
  const plot = r.publicPlotId(asset, block), evidence = { requestId: plot, asset, block, previous: r.hashObject(null), start: '1200',
    from: { height: '1200', transactionIndex: '0', inscriptionIndex: '0' }, next: { height: '1201', transactionIndex: '0', inscriptionIndex: '0' },
    blockHash: hashAt('1200'), payments: [payment] };
  const claim = r.publicScanClaim({ ...view, pattern: view.patterns.get('7'), asset, block });
  const financial = { transition: { type: 'public-scan', id: plot, asset, block, previous: evidence.previous }, evidence: { ...evidence, claim } };
  financial.operations = await financialPlan(financial, { read: async key => records.get(key), height: '1200', document: active });
  if (forgedEvidence) financial.evidence = { ...financial.evidence, claim: { ...claim, claimed: !claim.claimed } };
  wire.financialOperations = [financial]; f.output = r.processBlockV2({ ...args, financialOperations: [financial] });
  const built = r.buildBatchV2({ network: active.network, epoch: '0', sequence: '3', lastTo: f.context.last.to, previousRoot: f.context.previousRoot,
    files: [f.output.file], executionHeight: '1200', executionHash: hashAt('1200'), settings: f.context.settings, activation: f.context.activation,
    catalogRoot: f.output.state.catalogRoot, accountRoot: f.output.state.accountRoot });
  f.proposal = { kind: 'batch', network: active.network, batch: built.batch, files: built.fileBytes.map(r.bytesToHex) };
  f.reads.financialRecord = async key => records.get(key) ?? null;
  f.reads.financialEvidence = async () => evidence;
  f.reads.batchStamp = async () => ({ counted: '1200', last: f.context.last, tip: '1200', tipHash: hashAt('1200'), revision: '1' });
  f.reads.preflight = async () => ({ ok: true, counted: '1200', last: f.context.last, digest: r.bytesToHex(built.signingDigest) });
  return f;
}
