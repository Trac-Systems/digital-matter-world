import { preflightBatch } from './preflight.mjs';
// Service operators inject their own snapshot-capable Trac, TAP and escrow read
// clients. No evidence from an HTTP signing request is used as a trusted read.
export function createLocalReads({ trac, indexer, records, ethereum }) {
  return {
    bindings: records.bindings,
    preflight: async (batch, at) => preflightBatch(batch, at, { read: (key, snapshot) => trac.dmwRead(key, snapshot), deployment: await records.contractDeployment() }),
    receiptCertificate: (tip, hash) => records.receiptCertificate(tip, hash),
    receiptObservation: (tip, hash) => records.receiptObservation(tip, hash),
    tip: () => records.tip(),
    mintCertificate: id => records.mintCertificate(id),
    authority: () => trac.dmwAuthority(),
    counted: async () => (await trac.dmwHead()).counted,
    batchLast: () => trac.dmwBatchLast(),
    batchRoot: n => trac.dmwBatchRoot(n),
    pending: (id, at) => trac.dmwMint(id, at),
    balance: (owner, asset, at) => trac.dmwBalance(owner, asset, at),
    nonceUsed: (owner, nonce, at) => records.nonceUsed(owner, nonce, at),
    agentAddress: id => trac.dmwAgentAddress(id),
    pendingAcceptance: (id, at) => records.pendingAcceptance(id, at),
    assetContext: (asset, block, at, snapshot) => records.assetContext(asset, block, at, snapshot),
    mintFeeTerms: id => records.mintFeeTerms(id),
    mintRequest: id => records.mintRequest(id),
    mintPayment: id => records.mintPayment(id),
    paymentUsed: key => trac.dmwRead('pay/' + key),
    mintPayoutSnapshot: id => records.mintPayoutSnapshot?.(id),
    blockHold: (asset, block, at) => records.blockHold(asset, block, at),
    batchContext: sequence => records.batchContext(sequence),
    batchStamp: () => records.batchStamp(),
    link: (block, at) => records.link(block, at),
    linkTerms: (id, request, at) => records.linkTerms(id, request, at),
    linkPayment: (id, at) => records.linkPayment(id, at),
    bitmap: (block, at) => indexer.bitmap(block, at),
    isMinted: (deployment, tick, block, at) => indexer.isMinted(deployment, tick, block, at),
    payer: id => records.payer(id),
    escrowDeposit: (payer, id) => ethereum.deposit(payer, id),
    escrowRotation: (successor, deadline) => ethereum.rotation(successor, deadline),
    committeeRotation: () => records.committeeRotation(),
    mint: (id, at) => indexer.mint(id, at),
    mintAuthorization: id => records.mintAuthorization(id),
  };
}
// A fresh local run starts safely even when no gateway/indexer adapter has been
// configured. Every policy read then refuses, while keygen and health work.
export async function createReads() {
  return new Proxy({}, { get: (_, name) => name === 'close' || name === 'then' ? undefined : async () => { throw Error('read_adapter_unconfigured'); } });
}
