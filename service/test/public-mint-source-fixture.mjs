import assert from 'node:assert/strict';
import * as r from '../../rules/src/index.js';
import { secp256k1 } from '../../kit/node_modules/@noble/curves/secp256k1.js';
import { p2tr } from '../../kit/node_modules/@scure/btc-signer/index.js';
import { buildInscription, signCommit, fundingAddress } from '../../kit/lib/inscription-core.mjs';
import { beneficiaryFeePlan } from '../../rules/src/beneficiary-credits.js';
import { publicScanKey, publicRefundKey } from '../../contract/public-mint.js';
import { plotKey } from '../../contract/financial-capacity.js';
import { applyPaymentPage } from '../../contract/payment-pages.js';
import { financialPlan } from '../../rules/src/financial-execution.js';
import { verifyFinancialExecution } from '../../committee/signer/financial-execution.mjs';
import { accountSettings } from '../../rules/src/account-settings.js';
import { permit } from '../../committee/signer/adapter.mjs';
import { reserveFinancialCapacity } from '../../contract/financial-capacity.js';
import { buildFinancialExecution } from '../src/financial-execution.mjs';
const { installPublicMintSources, publicPaymentData } = await import('../src/public-mint-sources.mjs');
const { FeeQuotes, createFeePolicy } = await import('../src/fees.mjs');
const { identifyFinancialFees } = await import('../src/financial-fee-identity.mjs');

export function publicMintSourceFixture({ deployerShareBps, baseFee = '100', feeSettings, legacyPolicy = false, legacyAsset = false, publicPaymentV2Height, bitmapMintOpenHeight, moveBytes, chainAnchored = false, bitcoinNetwork = 'regtest', legacyElement, lateConfirmBlocks } = {}) {
  const network = 'test', key = new Uint8Array(32).fill(44), publicKey = Buffer.from(secp256k1.getPublicKey(key)).toString('hex');
  const address = fundingAddress(publicKey, bitcoinNetwork), asset = legacyAsset ? 'p0' : 'p2:0', block = '100';
  const registry = { feePolicy: createFeePolicy(baseFee, 0, feeSettings) };
  const document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '100', values: {
    ...r.SETTINGS_PROFILE, ...r.PUBLIC_MINT_SETTINGS, ...(deployerShareBps === undefined ? {} : { deployerShareBps }), ...(legacyElement ? { legacyDeployShareBps: 1000, legacyDeployPayoutMinAtoms: '1000000000000000000' } : {}), publicMintActivationHeight: '100', feePolicyRevision: registry.feePolicy.current,
    linkMultiplier: feeSettings?.link ?? r.FEE_DEFAULTS.link, finderWindow: 2, publicMintLegacyFinderWindow: 2, ...(!legacyPolicy ? { claimsNeverCloseHeight: '100' } : {}),
    ...(bitmapMintOpenHeight ? { bitmapMintOpenHeight } : {}), ...(publicPaymentV2Height ? { publicPaymentV2Height } : {}), ...(moveBytes ? { moveBytes } : {}), ...(lateConfirmBlocks ? { lateConfirmBlocks } : {}) } });
  const feeQuotes = new FeeQuotes({ network, secret: Buffer.alloc(32, 9), registry: async () => registry, now: () => 1000 }); feeQuotes.document = document;
  const context = { pattern: { number: '0', pat: '[0-9]', fld: 4, dt: 'n', releaseHeight: '100', releaseFinderWindow: 2 },
    publicClaims: { reservation: null, headerAward: false, unsettled: true }, find: null, tier: 1, treasury: address,
    beneficiaries: {}, payouts: {}, deployment: { active: true, kind: 'dmt', ...(legacyElement ? { elementId: legacyElement, privilege: r.hash('authority') + 'i0' } : {}), id: r.hash('deployment') + 'i0', tick: 'dmwfixture', remaining: '1000000', limit: '0' } };
  const records = new Map([['fd/asset/' + asset, 'generation'], ['fd/generation', { asset, deployment: context.deployment.id, minted: '0', reserved: '0', maximum: '1000000' }]]), blocks = new Map(), contents = new Map(), transfers = new Map(), included = new Map(), calls = [];
  let height = '103', confirmations = 1, activeDocument = document;
  const reads = { feeQuotes, rulesContext: async () => ({ settings: activeDocument }), counted: async () => height,
    assetContext: async () => context, isMinted: async () => false, publicMintHeader: async b => ({ height: Number(b) }),
    financialSettings: async hash => { assert.equal(hash, r.hashObject(document)); return document; },
    financialRecord: async id => records.get(id), publicBitcoinHash: async h => r.hash('block/' + h),
    publicBitcoinBlock: async h => { calls.push(h); const txs = blocks.get(h) ?? []; return { height: h, hash: r.hash('block/' + h), tx: txs.map(t => t.id), transactions: txs.map(t => t.hex) }; },
    content: async id => contents.get(id), paymentTransfers: async id => (transfers.get(id) ?? []).map((value, index) => ({ index, value })),
    included: async id => confirmations ? { height: included.get(id) ?? height, confirmations } : null,
    financialFeePlan: ({ split, destinations, beneficiaries, id, payer, rail }) => {
      const plan = beneficiaryFeePlan({ split, destinations, beneficiaries, requestId: id, payer, rail, bitcoinNetwork: bitcoinNetwork });
      return { fees: identifyFinancialFees(plan.fees, { network, rail, bitcoinNetwork: bitcoinNetwork }), custody: plan.credits };
    } };
  installPublicMintSources(reads, { network, bitcoinNetwork: bitcoinNetwork });
  const input = { asset, block, tapAddress: address }, scan = () => reads.publicMintScan({ asset, block, id: r.publicPlotId(asset, block) }, { counted: height });
  const pay = (quote, payer = address) => {
    const payload = { p: 'tap', op: 'token-auth', redeem: { items: r.walletFeeItems(quote.fees, bitcoinNetwork) } };
    const plan = buildInscription({ text: JSON.stringify(payload), receiver: address, publicKey, network: bitcoinNetwork, feeRate: 1, maxFeeSats: '1000000', secret: key.slice(),
      utxos: [{ txid: r.hash('cardinal'), vout: 0, value: '10000000', script: Buffer.from(p2tr(secp256k1.getPublicKey(key).slice(1)).script).toString('hex'), confirmed: true, cardinal: true }] });
    const signed = signCommit(plan, key), id = plan.inscriptionId;
    blocks.set(height, [{ id: id.slice(0, 64), hex: signed.revealHex }]); contents.set(id, payload); included.set(id, height);
    transfers.set(id, quote.fees.map(f => ({ ins: id, fail: false, int: true, addr: payer, taddr: f.to, tick: f.ticker, amt: f.amount, dta: f.dta })));
    records.set(publicScanKey(r.publicPlotId(asset, block)), { next: { height, transactionIndex: '0', inscriptionIndex: '0' }, scannedHeight: String(BigInt(height) - 1n), blockHash: r.hash('block/' + (BigInt(height) - 1n)), winner: null });
    return id;
  };
  const accept = async transition => {
    const signerReads = { ...reads, financialEvidence: reads.publicMintPayment, ...(chainAnchored ? {
      financialChainAnchor: async () => ({ bitcoin: { height, hash: r.hash('block/' + height) }, ethereum: null }) } : {}) };
    const built = await buildFinancialExecution({ store: { get: (space, id) => space === 'accountRecords' ? records.get(id) ?? null : null },
      transitions: [transition], reads: signerReads, document: activeDocument, height, at: { counted: height } });
    const { operations, inputs } = built, evidence = inputs[0].evidence;
    // This verifier has only chain/accepted-record reads; no gateway checkout lookup.
    await verifyFinancialExecution({ files: [{ ops: operations, financialOperations: inputs }],
      reads: signerReads, document: activeDocument, network, height, at: { counted: height } });
    for (const op of operations) await applyPaymentPage({ get: reads.financialRecord, put: (k, v) => records.set(k, v) }, op,
      { network, height, settings: accountSettings(activeDocument) });
    return { evidence, operations };
  };
  const register = quote => accept({ type: 'public-payment', id: quote.registration.commitment, action: 'register', registration: quote.registration });
  const reveal = (quote, reference) => accept({ type: 'public-payment', id: quote.registration.commitment, action: 'reveal', intent: quote.intent, reference });
  const settle = async (selectedBlock = block, { claimed = !!context.find } = {}) => {
    const scanEvidence = await reads.publicMintScan({ asset, block: selectedBlock, id: r.publicPlotId(asset, selectedBlock) }, { counted: height }), id = scanEvidence.requestId;
    const transition = { type: 'public-scan', id, asset, block: selectedBlock, previous: scanEvidence.previous };
    const evidence = { ...scanEvidence, ...(!legacyPolicy ? { claim: { pattern: '0', claimed,
      publicWinner: records.get(publicScanKey(id))?.winner?.id ?? null } } : {}) };
    const operations = await financialPlan({ transition, evidence }, { read: reads.financialRecord, height, document: activeDocument });
    await verifyFinancialExecution({ files: [{ ops: operations, financialOperations: [{ transition, evidence, operations }] }],
      reads: { ...reads, financialEvidence: reads.publicMintScan }, document: activeDocument, network, height, at: { counted: height } });
    for (const op of operations) await applyPaymentPage({ get: reads.financialRecord, put: (k, v) => records.set(k, v) }, op,
      { network, height, settings: accountSettings(activeDocument) });
    return scanEvidence;
  };
  return { reads, document, context, records, calls, input, scan, pay, accept, register, reveal, settle, transfers, blocks, contents, included,
    activate: () => { activeDocument = r.settingsRevision({ network, previous: document, effectiveBatch: '2', effectiveBitcoinWindow: '103', values: { ...document.values, claimsNeverCloseHeight: '103' } }); },
    activatePayment: boundary => { activeDocument = r.settingsRevision({ network, previous: document, effectiveBatch: '2', effectiveBitcoinWindow: boundary,
      values: { ...document.values, publicPaymentV2Height: boundary } }); },
    setPolicy: next => activeDocument = next, setHeight: h => height = h, setConfirmations: n => confirmations = n };
}
