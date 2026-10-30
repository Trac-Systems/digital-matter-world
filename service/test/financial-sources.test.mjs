import { serve } from '../src/http.mjs';
import { FinancialActions } from '../src/financial-actions.mjs';
import { FinancialCustody } from '../src/financial-custody.mjs';
import { installFinancialChain } from '../src/financial-chain.mjs';
import { custodyPaymentData } from '../src/financial-custody-sources.mjs';
import { bitcoinAddress } from '../../kit/test/helpers.mjs';
import { paymentCreditDigest } from '../../contract/payment-pages.js';
import { financialFeeKey, identifyFinancialFees } from '../src/financial-fee-identity.mjs';
import { WebCheckout } from '../src/web-checkout.mjs';
import { createWeb } from '../src/web.mjs';
import { FinancialLinks } from '../src/financial-links.mjs';
import { financialLinkDigest } from '../../rules/src/financial-link.js';
import { lifecycleDigest } from '../../contract/financial-lifecycle.js';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { ed25519 } from '../../contract/node_modules/@noble/curves/ed25519.js';
import { secp256k1 } from '../../contract/node_modules/@noble/curves/secp256k1.js';
import { rules as r } from '../src/rules.mjs';
import { Store } from '../src/store.mjs';
import { AccountExecution, AccountBatchOverlay } from '../src/account-batch.mjs';
import { FinancialExecution, buildFinancialExecution } from '../src/financial-execution.mjs';
import { FinancialMints } from '../src/financial-mints.mjs';
import { installFinancialSources } from '../src/financial-sources.mjs';
import { verifyFinancialExecution } from '../../committee/signer/financial-execution.mjs';
import { Policy } from '../../committee/signer/policy.mjs';
import { attachPermit } from '../../committee/signer/adapter.mjs';
import { verifyMintResult } from '../../committee/signer/certificate.mjs';
import { accountActionDigest } from '../../contract/root-accounts.js';
import { financialMintDigest, financialMintId } from '../../rules/src/financial-mint.js';
import { payerDigest } from '../src/mints.mjs';
import { FeeQuotes, createFeePolicy } from '../src/fees.mjs';
import { deploymentPayload } from '../src/deployments.mjs';
import { capacityKey } from '../../contract/financial-capacity.js';
import { escrowSplitForItems } from '../../committee/signer/escrow.mjs';
import { temp, network, secret, agent } from './helpers.mjs';

const flat = JSON.parse(await readFile(new URL('./fixtures/flat-fees.json', import.meta.url))).changes;
const flatSettings = { tierMultipliers: flat.tierMultipliers, compoundMinimum: flat.compoundMinimum, link: flat.link };

async function setup(t, values = {}, initialCounted = 100, options = {}) {
  let store = await Store.open(await temp('g3b-sources-')); t.after(() => store.close());
  const owner = agent(100), signerSecret = new Uint8Array(32).fill(2), publicKey = Buffer.from(secp256k1.getPublicKey(signerSecret)).toString('hex');
  const feePolicy = createFeePolicy(options.baseFee ?? '100', 0, options.feeSettings);
  let document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '100', values: { ...r.SETTINGS_PROFILE, feePolicyRevision: feePolicy.current, linkMultiplier: options.feeSettings?.link ?? r.FEE_DEFAULTS.link, ...values } });
  const d = { id: r.hash('deploy') + 'i0', tick: 'dmwcompound', kind: 'compound', active: true, privilegePublicKey: publicKey, decimals: 0, remaining: '100', limit: '0' };
  const context = { deployment: d, find: null, link: null, tier: 1, treasury: 'regtest-treasury', firstMakerAddress: options.custody ? null : 'regtest-maker',
    beneficiaries: { firstMaker: owner.address }, payouts: { firstMaker: null } };
  const privilege = r.hash('privilege') + 'i0', auth = { p: 'tap', op: 'privilege-auth', auth: { name: 'fixture' }, salt: r.hash('salt') };
  auth.hash = r.hash(JSON.stringify(auth.auth) + auth.salt);
  const authSig = secp256k1.sign(auth.hash, signerSecret, { lowS: true, prehash: false });
  auth.sig = { r: String(authSig.r), s: String(authSig.s), v: String(authSig.recovery) };
  const entry = { ...d, asset: 'c1', privilege, authorityKey: publicKey, options: { max: '100', dec: '0' } };
  const registry = { feePolicy, link: { treasury: 'regtest-treasury' }, assets: { c1: entry } }, accepted = new Map(), transfers = new Map();
  let counted = initialCounted, confirmations = 1, revision = 0, signCount = 0, minted = null, holder = { agent: owner.address, address: 'regtest-payer' }, paymentHeight = initialCounted;
  const escrow = { chainId: '31337', address: '0x' + 'a'.repeat(40), token: '0x' + 'b'.repeat(40) }, ethereum = {};
  const settings = new Map([[r.hashObject(document), document]]);
  const stamp = async () => ({ counted, last: { n: revision, to: counted }, revision, tip: counted, tipHash: r.hash('tip') });
  const base = { bitmap: async () => holder, link: async block => { const value = store.get('accountRecords', 'k/link/' + BigInt(block).toString(36)); return value ? JSON.parse(value) : null; }, mint: async () => structuredClone(minted), settingsByHash: async hash => settings.get(hash), counted: async () => counted, batchStamp: stamp, authority: async () => ({ network, committee: publicKey, epoch: 0 }), assetContext: async () => structuredClone(context),
    registry: async () => registry, included: async () => confirmations ? { confirmations, height: paymentHeight } : null,
    content: async id => id === privilege ? auth : id === d.id ? deploymentPayload(entry) : ({ p: 'tap', op: 'token-auth', redeem: { items: transfers.get(id).map(x => ({ dta: x.dta, address: x.taddr, tick: x.tick, amt: r.formatTapAmount(x.amt) })) } }),
    tap: async key => key.startsWith('getDeployment/') ? { ins: d.id, prv: privilege, tick: d.tick, dec: '0', max: '100', lim: '0' } : key.startsWith('getPrivilegeAuthCancelled/') ? false : '100',
    privilegeAuthority: async () => ({ ins: privilege }),
    escrowDeposit: async () => structuredClone(ethereum.snapshot), escrowSettled: async () => structuredClone(ethereum.event),
    paymentTransfers: async id => transfers.get(id).map((value, index) => ({ index, value })),
    discoverPaymentIds: () => assert.fail('history scan'), bitcoinTransaction: () => assert.fail('mempool funding'),
  };
  const makeReads = () => installFinancialSources({ ...base, feeQuotes: new FeeQuotes({ network, secret, registry: async () => registry, settings: () => document }) }, {
    network, document, bitcoinNetwork: 'regtest', recoveryVersion: 2, escrow, suspense: options.custody ? { tap: bitcoinAddress('regtest', 2) } : {},
    payout: id => store.get('financialCustodyPayments', id),
    request: id => store.get('financialLinks', id) ?? store.get('mints', id), reservation: async id => accepted.get(id), record: async key => store.get('accountRecords', key) });
  const reads = makeReads(), independent = makeReads();
  if (options.custody) for (const reader of [reads, independent]) installFinancialChain(reader, { bitcoinHash: async () => r.hash('tip') });
  const seed = new AccountExecution({ store, document, height: counted });
  await seed.accounts([{ type: 'credit', owner: owner.address, asset: 'c1', amount: '100' }]); await store.transact(seed.result().writes);
  const financial = new FinancialExecution({ store, reads, document });
  const policy = new Policy({ network, publicKey, reads: independent });
  const committee = { signature: async (_key, proposal) => {
    const approval = await policy.approve(proposal); signCount++;
    const s = secp256k1.sign(approval.digest, signerSecret, { lowS: true, prehash: false });
    const signature = { compact: s.toCompactHex(), r: String(s.r), s: String(s.s), v: s.recovery };
    verifyMintResult(approval.details, signature, { network, publicKey, id: approval.details.id });
    return { session: r.hash('session'), payload: attachPermit(approval.permit, signature) };
  } };
  const mints = new FinancialMints({ store, reads, financial, committee, network, document, bitcoinNetwork: 'regtest' });
  const links = new FinancialLinks({ store, reads, financial, network, document });
  const prepareLink = async (label = 'link', block = '42') => {
    const quote = await links.quote({ block, payer: 'regtest-payer' }), request = { v: 2, kind: 'link', owner: owner.address, block, payer: 'regtest-payer', nonce: r.hash(label),
      until: (BigInt(counted) + 432n).toString(), settingsHash: quote.settingsHash, quoteHash: r.hashObject(quote.feeQuote) };
    const body = { request, feeQuote: quote.feeQuote, signature: Buffer.from(ed25519.sign(financialLinkDigest(network, request), owner.secret)).toString('hex') };
    const pending = await links.request(body), action = pending.reservationAction;
    return { body, id: pending.id, action: { ...action, sig: Buffer.from(ed25519.sign(lifecycleDigest(network, action), owner.secret)).toString('hex') } };
  };
  const prepare = async (nonce = 'first', kind = 'tap', who = owner) => {
    if (kind === 'ethereum') { context.treasury = '0x' + 'c'.repeat(40); context.firstMakerAddress = '0x' + 'd'.repeat(40); }
    const quote = await mints.quote({ asset: 'c1', amount: '3', kind });
    const request = { v: 2, owner: who.address, asset: 'c1', amount: '3', receive: r.hash('regtest-receiver'), nonce: r.hash(nonce), until: r.ordinalCodec(typeof counted === 'string').add(counted, 20), expires: r.ordinalCodec(typeof counted === 'string').add(counted, 432), settingsHash: quote.feeQuote.settingsHash };
    const body = { request, signature: Buffer.from(ed25519.sign(financialMintDigest(network, request), who.secret)).toString('hex'), receiver: 'regtest-receiver', payer: kind === 'tap' ? 'regtest-payer' : '0x' + 'e'.repeat(40), kind, feeQuote: quote.feeQuote };
    body.authorization = Buffer.from(ed25519.sign(payerDigest(network, body), who.secret)).toString('hex');
    const pending = await mints.request(body), action = pending.reservationAction;
    return { body, id: financialMintId(network, request), action: { ...action, sig: Buffer.from(ed25519.sign(accountActionDigest(network, action), who.secret)).toString('hex') } };
  };
  const execute = async () => {
    const result = await financial.build({ height: counted, at: await stamp() });
    assert.equal(result.deferred.length, 0, JSON.stringify(result.deferred));
    await verifyFinancialExecution({ files: [{ ops: result.operations, financialOperations: result.inputs }], reads: independent, document, network, height: counted, at: await stamp() });
    for (const input of result.inputs) if (input.transition.type === 'reserve' || input.transition.action?.type === 'link-reserve') accepted.set(input.transition.id, input.evidence);
    const draft = { proposal: { batch: { n: ++revision } }, items: [{ output: { file: { financialOperations: result.inputs } } }] };
    await store.transact([...result.writes, ...financial.acceptedOperations(draft)]); return result;
  };
  const generation = await reads.financialDeployment('c1', await stamp());
  await financial.submit({ type: 'lifecycle', id: generation.id, action: generation.action }); await execute();
  return { get store() { return store; }, reads, independent, financial, mints, links, prepare, prepareLink, execute, context, transfers, accepted, document, owner, stamp, escrow, ethereum,
    holder: value => holder = value, paymentHeight: value => paymentHeight = value,
    minted: observation => minted = observation,
    settingsDocuments: settings, useSettings: next => { settings.set(r.hashObject(next), next); document = financial.document = mints.document = links.document = next; mints.pendingBlocks = next.values.pendingBlocks; },
    amend: next => { settings.set(r.hashObject(next), next); reads.feeQuotes.settings = independent.feeQuotes.settings = () => next; links.document = mints.document = financial.document = next; },
    confirmations: n => confirmations = n, counted: n => counted = n, signCount: () => signCount,
    reopen: async () => { const path = store.directory; await store.close(); store = await Store.open(path); financial.store = financial.linkReconciler.store = mints.store = links.store = store; } };
}

test('native custody is explicit, accrues once from consumed funding, and verifies the exact canonical payout', async t => {
  const f = await setup(t, {}, '100', { custody: true }), p = await f.prepare('custody');
  const row = f.store.get('mints', p.id);
  assert.equal(row.quote.custody.length, 1); assert.equal(row.quote.custody[0].owner, f.owner.address);
  await f.mints.request({ ...p.body, reserve: p.action }); await f.execute();
  const payment = r.hash('custody-funding') + 'i0';
  f.transfers.set(payment, row.quote.fees.map(fee => ({ ins: payment, fail: false, int: true, addr: row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
  await f.mints.payment({ id: p.id, paymentId: payment }); await f.execute();
  await f.mints.tick(); await f.execute();
  const custody = new FinancialCustody({ store: f.store, reads: f.reads, financial: f.financial, network });
  await f.reopen(); custody.store = f.store;
  await custody.tick(); await f.execute(); await custody.tick();
  const [action] = await f.reads.financialCustodyAccruals(p.id, await f.stamp());
  assert.equal((await custody.status(action.id)).state, 'claimable');
  assert.equal(f.store.count('financialCustodyPending'), 0);
  const claim = { type: 'custody-claim', id: action.id, revision: '0', destination: bitcoinAddress('regtest', 3), until: '600' };
  claim.sig = Buffer.from(ed25519.sign(lifecycleDigest(network, claim), f.owner.secret)).toString('hex');
  const actions = new FinancialActions({ store: f.store, reads: f.reads, financial: f.financial });
  await actions.submit(claim); await f.execute();
  const paying = await custody.status(action.id), reference = r.hash('custody-payout') + 'i0';
  assert.equal(paying.payout.items[0].dta, custodyPaymentData(paying.claim));
  await f.store.put('accountRecords', 'fq/bc/' + action.id, { recovery: r.hash('recovery') });
  assert.equal((await custody.status(action.id)).payout, null);
  assert.deepEqual((await custody.status(action.id)).blocked, ['financial_quarantined']);
  await f.store.put('accountRecords', 'fq/bc/' + action.id, null);
  f.transfers.set(reference, [{ ins: reference, fail: false, int: true, addr: paying.custodian, taddr: paying.destination, tick: 'tap', amt: paying.amount, dta: custodyPaymentData(paying.claim) }]);
  f.confirmations(0); await assert.rejects(custody.payment({ id: action.id, reference, index: 0 }), /financial_custody_unsettled/);
  assert.equal(f.store.count('financialCustodyPayments'), 0);
  f.confirmations(1); f.transfers.get(reference)[0].dta = 'unrelated';
  await assert.rejects(custody.payment({ id: action.id, reference, index: 0 }), /financial_custody_unsettled/);
  f.transfers.get(reference)[0].dta = custodyPaymentData(paying.claim);
  await assert.rejects(f.reads.financialEvidence({ type: 'lifecycle', id: action.id, action: { type: 'custody-reopen', id: action.id, claim: paying.claim } }, await f.stamp()), /financial_custody_revocation_unavailable/);
  await custody.payment({ id: action.id, reference, index: 0 }); await f.execute();
  assert.equal((await custody.status(action.id)).state, 'settled');
  await assert.rejects(custody.payment({ id: action.id, reference, index: 0 }), /financial_custody_claim/);
});

test('native credit exit, reuse and transfer retain exact accepted backing and signed revisions', async t => {
  const f = await setup(t, {}, '100'), p = await f.prepare('credit-source');
  await f.mints.request({ ...p.body, reserve: p.action }); await f.execute();
  const payment = r.hash('credit-payment') + 'i0', row = f.store.get('mints', p.id), fee = row.quote.fees[0];
  f.transfers.set(payment, [{ ins: payment, fail: false, int: true, addr: row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta }]);
  await f.mints.payment({ id: p.id, paymentId: payment }); await f.execute();
  f.counted('533'); await f.mints.refund({ id: p.id }); await f.execute();
  const credit = f.store.get('accountRecords', 'fc/' + p.id), target = await f.prepare('credit-target');
  await f.mints.request({ ...target.body, reserve: target.action }); await f.execute();
  assert.notEqual(f.store.get('mints', target.id).quote.fees[0].dta, fee.dta);
  assert.equal(f.store.get('accountRecords', 'fp/' + target.id).fees[0].key, credit.fees[0].key);
  const actions = new FinancialActions({ financial: f.financial, reads: f.reads, store: f.store });
  const sign = op => ({ ...op, sig: Buffer.from(ed25519.sign(paymentCreditDigest(network, op), f.owner.secret)).toString('hex') });
  const amount = (BigInt(fee.amount) / 2n).toString();
  const use = { type: 'credit-use', id: target.id, operation: sign({ op: 'fp', v: 2, type: 'use', id: target.id, credit: p.id,
    revision: '0', until: '600', items: [{ fee: credit.fees[0].key, amount }] }) };
  const queued = await actions.submit(use); await f.execute();
  assert.equal(actions.status(queued.id).state, 'accepted');
  assert.equal((await actions.submit(use)).state, 'accepted');
  assert.equal(f.store.get('accountRecords', 'fp/' + target.id).paid[0], amount);
  const transfer = { type: 'credit-transfer', id: p.id, operation: sign({ op: 'fp', v: 2, type: 'transfer', id: p.id, credit: p.id,
    revision: '1', until: '600', to: agent(101).address }) };
  await actions.submit(transfer); await f.execute();
  assert.equal(f.store.get('accountRecords', 'fc/' + p.id).owner, agent(101).address);
  assert.equal(f.store.get('accountRecords', 'fc/' + p.id).fees[0].amount, (BigInt(fee.amount) - BigInt(amount)).toString());
  await assert.rejects(f.independent.financialEvidence({ type: 'lifecycle', id: use.id, action: use }, await f.stamp()), /financial_credit_authorization/);
  await assert.rejects(actions.submit({ type: 'capacity-finish', id: p.id }), /financial_owner_action/);
});

test('new credit fee identities bind network, rail, token, role, destination and custody beneficiary; retained keys keep dta', () => {
  const fee = { role: 'treasury', to: 'receiver', ticker: 'tap', tt: 'a', dta: 'old-request', amount: '1' };
  const options = { network, rail: 'tap', bitcoinNetwork: 'regtest' };
  const key = financialFeeKey(identifyFinancialFees([fee], options)[0]);
  assert.equal(key, financialFeeKey(identifyFinancialFees([{ ...fee, dta: 'new-request' }], options)[0]));
  assert.notEqual(financialFeeKey(fee), financialFeeKey({ ...fee, dta: 'new-request' }));
  for (const patch of [{ network: 'other' }, { bitcoinNetwork: 'mainnet' }, { custody: [{ role: fee.role, owner: 'a'.repeat(64) }] },
    { rail: 'ethereum', escrow: { chainId: '1', token: '0x' + 'a'.repeat(40) } }]) assert.notEqual(key, financialFeeKey(identifyFinancialFees([fee], { ...options, ...patch })[0]));
  for (const patch of [{ role: 'burn' }, { to: 'other' }, { ticker: 'other' }]) assert.notEqual(key, financialFeeKey(identifyFinancialFees([{ ...fee, ...patch }], options)[0]));
});

test('native dependency overlays verify newly credited funds across observations without publishing speculative state', async t => {
  const f = await setup(t, {}, '100'), p = await f.prepare('overlay-credit');
  for (const reader of [f.reads, f.independent]) installFinancialChain(reader, { bitcoinHash: async () => r.hash('tip') });
  await f.mints.request({ ...p.body, reserve: p.action }); await f.execute();
  const payment = r.hash('overlay-payment') + 'i0', row = f.store.get('mints', p.id), fee = row.quote.fees[0];
  f.transfers.set(payment, [{ ins: payment, fail: false, int: true, addr: row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta }]);
  await f.mints.payment({ id: p.id, paymentId: payment }); await f.execute();
  f.counted('533');
  const target = await f.prepare('overlay-target'); await f.mints.request({ ...target.body, reserve: target.action }); await f.execute();
  const at = await f.stamp(), partial = { counted: at.counted, last: at.last }, overlay = new AccountBatchOverlay(f.store),
    args = { store: overlay, reads: f.reads, document: f.document, height: at.counted, at: partial };
  const refund = await buildFinancialExecution({ ...args, transitions: [{ type: 'refund', id: p.id, reason: 'credit' }] });
  overlay.apply(refund.writes);
  const sign = op => ({ ...op, sig: Buffer.from(ed25519.sign(paymentCreditDigest(network, op), f.owner.secret)).toString('hex') });
  const use = { type: 'lifecycle', id: target.id, action: { type: 'credit-use', id: target.id,
    operation: sign({ op: 'fp', v: 2, type: 'use', id: target.id, credit: p.id, revision: '0', until: '600', items: [{ fee: financialFeeKey(fee), amount: '1' }] }) } };
  const transfer = { type: 'lifecycle', id: p.id, action: { type: 'credit-transfer', id: p.id,
    operation: sign({ op: 'fp', v: 2, type: 'transfer', id: p.id, credit: p.id, revision: '1', until: '600', to: agent(101).address }) } };
  await assert.rejects(f.independent.financialEvidence(use, at), /financial_credit_authorization/);
  const spent = await buildFinancialExecution({ ...args, transitions: [use, transfer] });
  assert.equal(f.store.get('accountRecords', 'fc/' + p.id), null);
  const files = [refund, spent].map(result => ({ ops: result.operations, financialOperations: result.inputs }));
  await verifyFinancialExecution({ files, reads: f.independent, document: f.document, network, height: at.counted, at: partial });
  assert.equal(spent.writes.find(w => w.id === 'fc/' + p.id).value.owner, agent(101).address);
  assert.equal(spent.writes.find(w => w.id === 'fp/' + target.id).value.paid[0], '1');
  await assert.rejects(verifyFinancialExecution({ files: [files[1]], reads: f.independent, document: f.document, network, height: at.counted, at }), /financial_credit_authorization/);
});

test('mint and link payment status fences recovery and quarantined dependencies without changing requests', async t => {
  const f = await setup(t, {}, '100'), mint = await f.prepare('recovery-status');
  await f.mints.request({ ...mint.body, reserve: mint.action }); await f.execute();
  const link = await f.prepareLink('recovery-status-link'); await f.links.request({ ...link.body, reserve: link.action }); await f.execute();
  assert.equal(f.mints.public(mint.id).payable, true); assert.equal((await f.links.public(link.id)).payable, true);
  await f.store.put('meta', 'financialRecoveryActive', r.hash('recovery'));
  assert.equal(f.mints.public(mint.id).payable, false); assert.equal((await f.links.public(link.id)).payable, false);
  await f.store.put('meta', 'financialRecoveryActive', null);
  await f.store.put('accountRecords', 'fq/fp/' + mint.id, { recovery: r.hash('recovery') });
  await f.store.put('accountRecords', 'fq/fl/' + link.id, { recovery: r.hash('recovery') });
  assert.deepEqual(f.mints.public(mint.id).blocked, ['financial_quarantined']);
  assert.deepEqual((await f.links.public(link.id)).blocked, ['financial_quarantined']);
  assert.deepEqual(f.store.get('mints', mint.id).request, mint.body.request);
  await f.store.put('accountRecords', 'fq/fp/' + mint.id, null); await f.store.put('accountRecords', 'fq/fl/' + link.id, null);
  assert.equal(f.mints.public(mint.id).payable, true); assert.equal((await f.links.public(link.id)).payable, true);
});

test('independent readers reconstruct pinned mint terms and canonical named TAP pages, refusing mempool and source replacement', async t => {
  const f = await setup(t), p = await f.prepare();
  assert.equal((await f.mints.request({ ...p.body, reserve: p.action })).state, 'reserving');
  await f.execute(); await f.mints.tick();
  assert.equal(f.mints.public(p.id).payable, true);
  const payment = r.hash('payment') + 'i0', row = f.store.get('mints', p.id);
  f.transfers.set(payment, row.quote.fees.map(fee => ({ ins: payment, fail: false, int: true, addr: row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
  f.confirmations(0);
  await assert.rejects(f.mints.payment({ id: p.id, paymentId: payment }), /payment_unconfirmed/);
  assert.equal(f.store.count('financialQueue'), 0);
  f.confirmations(1); await f.mints.payment({ id: p.id, paymentId: payment });
  const result = await f.financial.build({ height: 100, at: await f.stamp() });
  const commitment = result.inputs[0].recordCommitments[0][1];
  result.inputs[0].recordCommitments[0][1] = r.hash('substituted-record');
  await assert.rejects(verifyFinancialExecution({ files: [{ ops: result.operations, financialOperations: result.inputs }], reads: f.independent, document: f.document, network, height: 100, at: await f.stamp() }), /financial_record_commitments/);
  result.inputs[0].recordCommitments[0][1] = commitment;
  const fee = f.transfers.get(payment)[0]; fee.taddr = 'redirected';
  await assert.rejects(verifyFinancialExecution({ files: [{ ops: result.operations, financialOperations: result.inputs }], reads: f.independent, document: f.document, network, height: 100, at: await f.stamp() }), /financial_receipt_binding/);
  fee.taddr = row.quote.fees[0].to; await f.execute();
  assert.deepEqual(f.store.get('accountRecords', 'fp/' + p.id).paid, row.quote.fees.map(f => f.amount));
  await f.reopen();
  assert.deepEqual(await f.reads.financialRecord('fp/' + p.id, await f.stamp()), f.store.get('accountRecords', 'fp/' + p.id));
});

for (const flatFees of [false, true]) test(`accepted funding consumes once and a restarted mint delivers the permanent permit once (flat=${flatFees})`, async t => {
  const f = await setup(t, {}, '100', flatFees ? { baseFee: flat.baseFee, feeSettings: flatSettings } : {}), p = await f.prepare();
  await f.mints.request({ ...p.body, reserve: p.action }); await f.execute();
  const payment = r.hash('paid') + 'i0', row = f.store.get('mints', p.id);
  f.transfers.set(payment, row.quote.fees.map(fee => ({ ins: payment, fail: false, int: true, addr: row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
  await f.mints.payment({ id: p.id, paymentId: payment }); await f.execute();
  await f.mints.tick(); assert.equal(f.store.list('financialQueue', { limit: 10 })[0].value.type, 'consume');
  await f.execute(); await f.reopen();
  f.confirmations(0); // Consumed authorization must survive source unavailability.
  await f.mints.tick();
  assert.equal(f.mints.public(p.id).state, 'permit_issued', f.store.get('mints', p.id).lastError);
  const permit = f.mints.public(p.id).permit;
  await f.reopen(); await f.mints.tick();
  assert.deepEqual(f.mints.public(p.id).permit, permit); assert.equal(f.signCount(), 1);
  assert.equal(f.store.count('financialPermitDelivery'), 1); assert.equal(f.store.count('financialQueue'), 0);
});

test('expired admissions retain signed drafts and release only unaccepted local reservations', async t => {
  const f = await setup(t), p = await f.prepare();
  await f.mints.request({ ...p.body, reserve: p.action });
  const queued = f.store.list('financialQueue', { limit: 10 })[0], capacity = f.store.get('financialAdmission', queued.id).capacity;
  await f.store.put('meta', 'draft', { proposal: { batch: { ops: [{ op: 'ar', actions: [p.action] }] } } });
  f.counted(121); await f.mints.tick();
  assert.equal(f.store.count('financialAdmissionOwner'), 1);
  await f.store.transact([{ space: 'meta', id: 'draft' }]); await f.mints.tick();
  assert.equal(f.mints.public(p.id).state, 'expired');
  assert.equal(f.store.count('financialAdmissionOwner'), 0); assert.equal(f.store.count('financialQueue'), 0);
  assert.equal(f.store.get('financialAdmissionCapacity', capacityKey(capacity.deployment)), '0');
  assert.equal(f.store.count('financialActiveMints'), 0);
});

test('admission reserves account revision and deployment capacity before acknowledging competing intents', async t => {
  const f = await setup(t), a = await f.prepare('a'), b = await f.prepare('b');
  await f.mints.request({ ...a.body, reserve: a.action });
  await assert.rejects(f.mints.request({ ...b.body, reserve: b.action }), /financial_account_reserved/);
  assert.equal(f.store.count('financialQueue'), 1);
  assert.equal((await f.mints.request({ ...a.body, reserve: a.action })).id, a.id);
  await f.execute(); assert.equal(f.store.count('financialAdmissionOwner'), 0);
  await assert.rejects(f.mints.request({ ...b.body, reserve: b.action }), /account_signature/);
});

test('slow admission verification does not hold durable submissions and cannot commit across their revision', async t => {
  const f = await setup(t), p = await f.prepare('overlap');
  const scope = f.reads.financialScope;
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  f.reads.financialScope = options => {
    const reads = scope(options), evidence = reads.financialEvidence;
    reads.financialEvidence = async (...args) => { started(); await blocked; return evidence(...args); };
    return reads;
  };
  const admission = f.mints.request({ ...p.body, reserve: p.action }); await entered;
  const transition = { type: 'lifecycle', id: r.hash('unrelated'), action: { type: 'fixture' } };
  const submission = await f.financial.submit(transition);
  assert.equal(submission.state, 'queued');
  release(); await assert.rejects(admission, /financial_snapshot_changed/);
  assert.equal(f.store.count('financialAdmissionOwner'), 0);
  assert.equal(f.store.count('financialAdmissionCapacity'), 0);
  f.reads.financialScope = scope;
  await f.mints.request({ ...p.body, reserve: p.action });
  assert.equal(f.store.count('financialAdmissionOwner'), 1);
  assert.equal(f.store.count('financialQueue'), 2);
});

for (const flatFees of [false, true]) test(`Ethereum exits require the exact configured escrow, payer, canonical refund and named transaction (flat=${flatFees})`, async t => {
  const f = await setup(t, {}, '100', flatFees ? { baseFee: flat.baseFee, feeSettings: flatSettings } : {}), p = await f.prepare('ethereum', 'ethereum');
  await f.mints.request({ ...p.body, reserve: p.action }); await f.execute();
  const row = f.store.get('mints', p.id), references = ['0x' + r.hash('refund')];
  f.ethereum.snapshot = { ...f.escrow, confirmations: 1, requestId: p.id, payer: row.payer,
    deposit: { payer: row.payer, status: 3, split: escrowSplitForItems(row.quote.fees), amount: row.quote.payableAmount } };
  f.ethereum.event = { kind: 'refund', confirmations: 1, requestId: p.id, payer: row.payer, transactionHash: references[0], blockNumber: '0x10', blockHash: '0x' + r.hash('block') };
  const transition = { type: 'refund', id: p.id, reason: 'ethereum_refund', references };
  await assert.rejects(f.reads.financialEvidence({ ...transition, references: [] }, await f.stamp()), /financial_payment_rail/);
  f.ethereum.snapshot.address = '0x' + 'f'.repeat(40);
  await assert.rejects(f.reads.financialEvidence(transition, await f.stamp()), /financial_escrow_domain/);
  f.ethereum.snapshot.address = f.escrow.address; f.ethereum.event.confirmations = 0;
  await assert.rejects(f.reads.financialEvidence(transition, await f.stamp()), /financial_refund_unproven/);
  f.ethereum.event.confirmations = 1; f.ethereum.event.kind = 'claim';
  await assert.rejects(f.reads.financialEvidence(transition, await f.stamp()), /financial_refund_unproven/);
  f.ethereum.event.kind = 'refund';
  await f.mints.refund({ id: p.id, reason: 'ethereum_refund', references }); await f.execute(); await f.mints.tick();
  assert.equal(f.store.get('accountRecords', 'fp/' + p.id).state, 'refunded');
  assert.equal(f.store.get('accountRecords', 'ao/' + p.id).state, 'refunded');
  assert.equal(f.store.get('accountRecords', 'fc/' + p.id), null);
  await assert.rejects(f.reads.financialEvidence(transition, await f.stamp()), /financial_exit_state/);
});

test('different owners cannot reserve the same deployment capacity, including after gateway restart', async t => {
  const f = await setup(t), other = agent(101), seed = new AccountExecution({ store: f.store, document: f.document, height: 100 });
  await seed.accounts([{ type: 'credit', owner: other.address, asset: 'c1', amount: '100' }]); await f.store.transact(seed.result().writes);
  f.context.deployment.remaining = '4';
  const a = await f.prepare('a'), b = await f.prepare('b', 'tap', other);
  await f.mints.request({ ...a.body, reserve: a.action }); await f.reopen();
  await assert.rejects(f.mints.request({ ...b.body, reserve: b.action }), /financial_capacity_reserved/);
  assert.equal(f.store.count('financialAdmission'), 1); assert.equal(f.store.count('financialQueue'), 1);
});

test('independent source reconstruction refuses a changing accepted snapshot', async t => {
  const f = await setup(t), p = await f.prepare(); let calls = 0;
  f.independent.batchStamp = async () => ({ ...await f.stamp(), revision: calls++ });
  await assert.rejects(f.independent.financialEvidence({ type: 'reserve', id: p.id, action: p.action, fees: [] }, await f.stamp()), /financial_snapshot_changed/);
});

test('activated quote lifetimes and fee shares come from the pinned operator settings', async t => {
  const f = await setup(t, { firstMakerShareBps: 1000, compoundBurnBps: 5000, quoteLifetimeMs: 60000, quoteLifetimeTips: 600 });
  const p = await f.prepare(), row = f.store.get('mints', p.id), q = row.quote.feeQuote;
  assert.equal(q.expiresAt - q.issuedAt, 60000); assert.equal(q.validUntil - q.validFrom, 600);
  assert.equal(row.quote.split.firstMaker, '100'); assert.equal(row.quote.split.burn, '500'); assert.equal(row.quote.split.treasury, '400');
  await f.mints.request({ ...p.body, reserve: p.action }); await f.execute();
});

test('a payment disappearing before acceptance cannot strand the reserved account past expiry', async t => {
  const f = await setup(t), p = await f.prepare();
  await f.mints.request({ ...p.body, reserve: p.action }); await f.execute();
  const payment = r.hash('orphan') + 'i0', row = f.store.get('mints', p.id);
  f.transfers.set(payment, row.quote.fees.map(fee => ({ ins: payment, fail: false, int: true, addr: row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
  await f.mints.payment({ id: p.id, paymentId: payment }); f.confirmations(0);
  const result = await f.financial.build({ height: 100, at: await f.stamp() });
  assert.equal(result.inputs.length, 0); assert.equal(result.deferred.length, 1);
  f.counted(533); await f.mints.tick();
  assert.equal(f.store.list('financialQueue', { limit: 10 })[0].value.type, 'refund');
  await f.mints.tick(); assert.equal(f.store.count('financialQueue'), 1);
  await f.execute(); await f.mints.tick();
  assert.equal(f.mints.public(p.id).state, 'expired'); assert.equal(f.store.get('accountRecords', 'ao/' + p.id).state, 'refunded');
});


test('an admitted mint retains original fee terms while new quotes use the effective amendment', async t => {
  const f = await setup(t), p = await f.prepare(), original = structuredClone(f.store.get('mints', p.id));
  const next = r.settingsRevision({ network, previous: f.document, effectiveBatch: '2', effectiveBitcoinWindow: '100',
    values: { ...f.document.values, firstMakerShareBps: 1000, compoundBurnBps: 5000 } });
  f.amend(next);
  const quote = await f.mints.quote({ asset: 'c1', amount: '3', kind: 'tap' });
  assert.equal(quote.settingsHash, r.hashObject(next)); assert.equal(quote.split.firstMaker, '100');
  assert.notDeepEqual(quote.split, original.quote.split);
  await f.mints.request({ ...p.body, reserve: p.action }); await f.execute();
  const admitted = f.accepted.get(p.id);
  assert.equal(admitted.settingsHash, r.hashObject(f.document)); assert.deepEqual(admitted.feeItems, original.quote.fees);
  const missing = { ...p.body.request, settingsHash: r.hash('missing') };
  await assert.rejects(f.reads.financialSettings(missing.settingsHash), /financial_settings_history/);
});

for (const height of ['9007199254740992', '9223372036854775808', '1' + '0'.repeat(79)]) {
  test(`native financial reservation, funding and consumption retain decimal clock ${height}`, async t => {
    const f = await setup(t, {}, height), p = await f.prepare();
    assert.equal(p.body.request.until, (BigInt(height) + 20n).toString());
    await f.mints.request({ ...p.body, reserve: p.action }); await f.execute();
    const payment = r.hash('large-clock/' + height) + 'i0', row = f.store.get('mints', p.id);
    f.transfers.set(payment, row.quote.fees.map(fee => ({ ins: payment, fail: false, int: true, addr: row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
    await f.mints.payment({ id: p.id, paymentId: payment }); await f.execute(); await f.mints.tick(); await f.execute();
    await f.reopen(); await f.mints.tick();
    assert.equal(f.mints.public(p.id).state, 'permit_issued', f.store.get('mints', p.id).lastError);
    assert.equal(f.accepted.get(p.id).expiry, (BigInt(height) + 432n).toString());
  });
}


test('a native canonical mint finishes both capacity ledgers only through accepted terminal replay', async t => {
  const f = await setup(t), p = await f.prepare();
  await f.mints.request({ ...p.body, reserve: p.action }); await f.execute();
  const payment = r.hash('terminal-pay') + 'i0', row = f.store.get('mints', p.id);
  f.transfers.set(payment, row.quote.fees.map(fee => ({ ins: payment, fail: false, int: true, addr: row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
  await f.mints.payment({ id: p.id, paymentId: payment }); await f.execute(); await f.mints.tick(); await f.execute(); await f.mints.tick();
  const permit = f.mints.public(p.id).permit, c = f.store.get('accountRecords', 'dc/' + p.id);
  assert.equal(c.state, 'issued'); assert.equal(f.store.get('accountRecords', capacityKey(row.context.deployment.id)), '3');
  f.counted('10000000000000000000000000000000000000000'); await f.mints.tick();
  assert.equal(f.store.get('accountRecords', 'dc/' + p.id).state, 'issued', 'elapsed time cannot revoke a permit');
  const observation = { accepted: true, fail: false, confirmations: 1, inscription: r.hash('canonical-mint') + 'i0',
    deployment: row.context.deployment.id, tick: row.context.deployment.tick, receiver: row.receiver, amount: row.request.amount,
    dta: permit.dta, permitHash: permit.prv.hash, committee: row.context.deployment.privilegePublicKey };
  f.minted(observation); await f.mints.payment({ id: p.id, inscription: observation.inscription }); await f.mints.tick();
  const result = await f.financial.build({ height: (await f.stamp()).counted, at: await f.stamp() });
  f.minted({ ...observation, amount: '4' });
  await assert.rejects(verifyFinancialExecution({ files: [{ ops: result.operations, financialOperations: result.inputs }], reads: f.independent,
    document: f.document, network, height: (await f.stamp()).counted, at: await f.stamp() }), /financial_capacity_mint/);
  assert.equal(f.store.get('accountRecords', capacityKey(observation.deployment)), '3');
  f.minted(observation); await f.execute(); await f.reopen(); await f.mints.tick();
  assert.equal(f.mints.public(p.id).state, 'minted');
  assert.equal(f.store.get('accountRecords', 'dc/' + p.id).state, 'minted');
  assert.equal(f.store.get('accountRecords', capacityKey(observation.deployment)), '0');
  const generation = f.store.get('accountRecords', 'fd/' + c.deployment);
  assert.equal(generation.reserved, '0'); assert.equal(generation.minted, '3');
  await f.mints.tick(); assert.equal(f.store.get('accountRecords', 'fd/' + c.deployment).minted, '3');
});


for (const flatFees of [false, true]) test(`native paid link reserves before payment and completes after deadline and holder transfer (flat=${flatFees})`, async t => {
  const f = await setup(t, {}, '100', flatFees ? { baseFee: flat.baseFee, feeSettings: flatSettings } : {}), p = await f.prepareLink(), competitor = await f.prepareLink('competitor');
  assert.equal((await f.links.public(p.id)).payable, false);
  await f.links.request({ ...p.body, reserve: p.action });
  await assert.rejects(f.links.request({ ...competitor.body, reserve: competitor.action }), /financial_link_reserved/);
  await f.execute(); assert.equal((await f.links.public(p.id)).payable, true);
  const row = f.store.get('financialLinks', p.id), payment = r.hash('link-payment') + 'i0';
  f.transfers.set(payment, row.quote.fees.map(fee => ({ ins: payment, fail: false, int: true, addr: row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
  f.confirmations(0); await assert.rejects(f.links.payment({ id: p.id, paymentId: payment }), /payment_unconfirmed/);
  f.confirmations(1); f.paymentHeight('533');
  await assert.rejects(f.links.payment({ id: p.id, paymentId: payment }), /financial_link_payment_late/);
  f.paymentHeight('101'); await f.links.payment({ id: p.id, paymentId: payment }); await f.execute();
  f.holder({ agent: agent(101).address, address: 'new-holder' }); f.counted('1000000000000000000000000000000000000');
  await f.reopen(); await f.execute();
  assert.equal((await f.links.public(p.id)).state, 'accepted');
  assert.equal(f.store.get('accountRecords', 'fl/' + p.id).state, 'complete');
  assert.deepEqual(JSON.parse(f.store.get('accountRecords', 'k/link/' + BigInt('42').toString(36))), { block: '42', linkHeight: '1000000000000000000000000000000000000' });
  await assert.rejects(f.links.quote({ block: '42', payer: 'regtest-payer' }), /link_exists/);
  assert.equal(f.store.get('accountRecords', 'fl/slot/42'), null); assert.equal(f.store.count('financialPendingLinks'), 1, 'unaccepted competitor remains until its own expiry');
  await f.links.tick(); assert.equal(f.store.count('financialPendingLinks'), 0);
});

for (const flatFees of [false, true]) test(`native expired link credits only canonical partial funding and retains original identity (flat=${flatFees})`, async t => {
  const f = await setup(t, {}, '100', flatFees ? { baseFee: flat.baseFee, feeSettings: flatSettings } : {}), p = await f.prepareLink();
  await f.links.request({ ...p.body, reserve: p.action }); await f.execute();
  const row = f.store.get('financialLinks', p.id), payment = r.hash('link-partial') + 'i0', fee = row.quote.fees[0];
  f.transfers.set(payment, [{ ins: payment, fail: false, int: true, addr: row.payer, taddr: fee.to, tick: fee.ticker, amt: '1', dta: fee.dta }]);
  await f.links.payment({ id: p.id, paymentId: payment }); await f.execute(); f.counted('533'); await f.execute();
  assert.equal((await f.links.public(p.id)).state, 'credited'); assert.equal(f.store.get('accountRecords', 'fc/' + p.id).fees.reduce((n, x) => n + BigInt(x.amount), 0n), 1n);
  assert.equal(f.store.get('accountRecords', 'k/link/16'), null); assert.equal(f.store.count('financialPendingLinks'), 0);
  assert.equal((await f.links.request({ ...p.body, reserve: p.action })).id, p.id);
});


test('activated link HTTP and checkout routes expose accepted direct-fee plans', async t => {
  const f = await setup(t, {}, '100'), p = await f.prepareLink();
  const checkout = new WebCheckout({ store: f.store, reads: f.reads, links: f.links,
    config: { mode: 'regtest', network, endpoints: { ethereum: 'http://127.0.0.1:1' }, local: { escrow: { chainId: '31337' } } } });
  checkout.enrollLink = () => assert.fail('activated request used legacy wallet enrollment');
  const server = await serve({ intake: { store: f.store, settings: { document: f.document } }, files: { serve: async () => false }, links: f.links, web: createWeb(checkout) });
  t.after(() => server.close());
  const post = async (path, body) => { const response = await fetch(server.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
  assert.equal((await post('/link/quote', { block: '42', payer: p.body.request.payer })).settingsHash, r.hashObject(f.document));
  assert.equal((await post('/link/request', { ...p.body, reserve: p.action })).state, 'reserving');
  let plan = await (await fetch(server.url + '/web-api/link/' + p.id)).json(); assert.equal(plan.payable, false); assert.deepEqual(plan.redeem.items, []);
  await f.execute();
  plan = await (await fetch(server.url + '/web-api/link/' + p.id)).json();
  assert.equal(plan.financialVersion, 2); assert.equal(plan.payable, true); assert.equal(plan.walletPreparation, false);
  assert.deepEqual(plan.redeem.actions, []); assert.equal(plan.redeem.items.length, f.store.get('financialLinks', p.id).quote.fees.length);
  assert.doesNotMatch(JSON.stringify(plan), /signature|feeAuthorization|reservationAction/);
  assert.equal((await (await fetch(server.url + '/link-status/' + p.id)).json()).state, 'awaiting_payment');
});

// The fixtures below start with an actual v1 request/quote, then replace only
// the derived financial view with the terminal import. The original records
// stay byte-for-byte present in the import pages.
async function importLegacyMint(t, { consumed = false, issued = false, rail = 'tap', credit = false, values = {} } = {}) {
  const { Mints } = await import('../src/mints.mjs');
  const { prepareFinancialMigration } = await import('../src/pending-financial.mjs');
  const { legacyGatewayRows, preparePendingWork } = await import('../src/pending-work.mjs');
  const { prepareTerminalImport } = await import('../src/terminal-import.mjs');
  const { initialState } = await import('../src/rules.mjs');
  const { permit } = await import('../../committee/signer/adapter.mjs');
  const f = await setup(t, values);
  await f.store.transact(f.store.list('accountRecords', { limit: 100 }).filter(row => row.id.startsWith('fd/')).map(({ id }) => ({ space: 'accountRecords', id })));
  if (rail === 'ethereum') { f.context.treasury = '0x' + 'c'.repeat(40); f.context.firstMakerAddress = '0x' + 'd'.repeat(40); }
  const fees = new FeeQuotes({ network, secret, registry: f.reads.registry });
  const old = new Mints({ network, store: f.store, reads: { ...f.reads, feeQuotes: fees, balance: async () => '100', pending: async () => null }, bitcoinNetwork: 'regtest', operations: { supportsMintBatches: true } });
  const request = { owner: f.owner.address, asset: 'c1', amount: '3', receive: r.hash('regtest-receiver'), nonce: r.hash('legacy-mint'), until: 120, expires: 532 };
  const q = await old.quote({ asset: 'c1', amount: '3', kind: rail });
  const body = { request, signature: r.signRequest('rq', network, request, f.owner.secret), receiver: 'regtest-receiver', payer: rail === 'tap' ? 'regtest-payer' : '0x' + 'e'.repeat(40), kind: rail, feeQuote: q.feeQuote };
  body.authorization = Buffer.from(ed25519.sign(payerDigest(network, body), f.owner.secret)).toString('hex');
  const p = await old.request(body), id = p.id, row = f.store.get('mints', id);
  const payment = r.hash('legacy-payment') + 'i0';
  const receipts = row.quote.fees.map((fee, i) => ({ ...fee, key: r.paymentItemKey('tap', payment + '/' + i), accepted: true, confirmations: 1, origin: id, reference: payment }));
  const allocations = r.paymentProgress(row.quote.fees, receipts).allocations;
  const plan = permit(network, request, row.context.deployment, row.receiver, id, r.paymentCommitment(allocations));
  const sig = secp256k1.sign(plan.digest, new Uint8Array(32).fill(2), { prehash: false, lowS: true });
  const payload = attachPermit(plan, { r: String(sig.r), s: String(sig.s), v: sig.recovery });
  const raw = { o: 1, asset: 'c1', amount: '3', receive: request.receive, e: 532, s: consumed ? 1 : 0, h: true,
    ...(consumed ? { permitHash: plan.digest, paymentHash: r.paymentCommitment(allocations), payments: allocations } : {}) };
  const records = new Map([['a/' + request.owner, 1], ['an/1', request.owner], ['v/1/c1', '97'], ['m/' + id, raw], ['rq/n/1/' + request.nonce, 1]]);
  if (!consumed) records.set('e/1/c1', [[Number.MAX_SAFE_INTEGER, '3']]);
  else for (const a of allocations) records.set('pay/' + a.key, { total: a.total, used: a.amount });
  await f.store.put('mints', id, { ...row, state: issued ? 'permit_issued' : consumed ? 'paid' : 'awaiting_payment', expiry: 532,
    ...(issued ? { permit: payload } : {}) });
  await f.store.put('meta', 'ruleState', initialState(101, r.hash('tip'), 100));
  const creditPayment = r.hash('legacy-surplus') + 'i0';
  if (credit) {
    await f.store.put('mintCredits', id, { owner: request.owner, payer: row.payer, rail, items: [{ reference: creditPayment }] });
    await f.store.put('creditClaims', id, id);
  }
  const snapshot = { version: 2, height: 100, escrow: f.escrow, requests: new Map([[id, { request, signature: row.signature, receiver: row.receiver,
    deployment: { ...row.context.deployment, asset: request.asset }, payment: { rail, payer: row.payer, ids: [], allocations }, ...(issued ? { permit: payload } : {}) }]]), links: new Map(), custody: new Map() };
  const rows = legacyGatewayRows(f.store), migration = prepareFinancialMigration({ rows, records, snapshot, network, document: f.document, height: 100, gateway: r.bytesToHex(ed25519.getPublicKey(secret)) });
  const pendingWork = preparePendingWork({ store: f.store, network, document: f.document, anchor: { height: '100', hash: r.hash('tip') }, lastTo: 100, financialMigration: migration });
  const imported = prepareTerminalImport({ records, height: 100, network, financialSnapshot: snapshot, pendingWork, gatewayRows: rows, document: f.document });
  const importedRecords = new Map(imported.pages.flatMap(p => p.records));
  for (const [key, value] of records) assert.deepEqual(importedRecords.get(key), value);
  await f.store.transact([...imported.availability, ...imported.accountRecords, ...migration.writes]);
  return { ...f, get store() { return f.store; }, id, row: f.store.get('mints', id), body, migration, imported, records, snapshot, rows, payload, plan, payment, creditPayment };
}

for (const issued of [false, true]) test(`legacy consumed permit keeps its original digest after import (issued=${issued})`, async t => {
  const f = await importLegacyMint(t, { consumed: true, issued });
  const p = await f.reads.financialPermit(f.id, await f.stamp(), { consumed: true });
  assert.equal(p.permit.digest, f.plan.digest);
  if (!issued) { await f.mints.tick(); assert.equal(f.store.get('mints', f.id).permit.prv.hash, f.plan.digest); }
  const row = f.store.get('mints', f.id), inscription = r.hash('legacy-completed') + 'i0';
  f.minted({ accepted: true, fail: false, confirmations: 1, inscription, deployment: row.context.deployment.id, tick: row.context.deployment.tick,
    receiver: row.receiver, amount: row.request.amount, dta: row.permit.dta, permitHash: row.permit.prv.hash, committee: row.context.deployment.privilegePublicKey });
  await f.mints.payment({ id: f.id, inscription }); await f.mints.tick(); await f.execute(); await f.mints.tick();
  assert.equal(f.store.get('mints', f.id).state, 'minted');
  assert.equal(f.store.get('accountRecords', capacityKey(row.context.deployment.id)), '0');
});

test('legacy unpaid reservation funds once through native readers and completes after activation', async t => {
  const f = await importLegacyMint(t);
  f.transfers.set(f.payment, f.row.quote.fees.map(fee => ({ ins: f.payment, fail: false, int: true, addr: f.row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
  await f.mints.payment({ id: f.id, paymentId: f.payment }); await f.execute();
  await f.mints.payment({ id: f.id, paymentId: f.payment }); assert.equal(f.financial.pending(), false);
  await f.mints.tick(); await f.execute(); await f.mints.tick();
  assert.equal(f.store.get('mints', f.id).state, 'permit_issued');
  assert.equal(f.store.get('accountRecords', 'ao/' + f.id).state, 'consumed');
});

test('legacy Ethereum refund proves the original escrow domain and releases held units', async t => {
  const f = await importLegacyMint(t, { rail: 'ethereum' }), row = f.row;
  const ref = '0x' + r.hash('legacy-eth-refund'), split = escrowSplitForItems(row.quote.fees);
  f.ethereum.snapshot = { chainId: f.escrow.chainId, address: f.escrow.address, token: f.escrow.token, payer: row.payer,
    requestId: f.id, confirmations: 1, deposit: { status: 3, payer: row.payer, split, amount: row.quote.fees.reduce((n, x) => n + BigInt(x.amount), 0n).toString() } };
  f.ethereum.event = { kind: 'refund', confirmations: 1, payer: row.payer, requestId: f.id, transactionHash: ref, blockHash: '0x' + r.hash('eth-block'), blockNumber: 50 };
  await f.mints.refund({ id: f.id, reason: 'ethereum_refund', references: [ref] }); await f.execute(); await f.mints.tick();
  assert.equal(f.store.get('accountRecords', 'fp/' + f.id).state, 'refunded');
  assert.equal(f.store.get('accountRecords', 'ao/' + f.id).state, 'refunded');
  assert.equal(f.store.get('accountRecords', 'fc/' + f.id), null);
});

test('a legacy Ethereum payment released before activation funds in bounded pages and delivers its permit', async t => {
  const f = await importLegacyMint(t, { rail: 'ethereum', values: { paymentPage: 1 } }), row = f.row, ref = '0x' + r.hash('legacy-eth-claim');
  f.ethereum.snapshot = { ...f.escrow, payer: row.payer, requestId: f.id, confirmations: 1,
    deposit: { status: 2, payer: row.payer, split: escrowSplitForItems(row.quote.fees), amount: row.quote.fees.reduce((n, x) => n + BigInt(x.amount), 0n).toString() } };
  f.ethereum.event = { kind: 'claim', confirmations: 1, payer: row.payer, requestId: f.id, transactionHash: ref, blockHash: '0x' + r.hash('eth-block'), blockNumber: 50 };
  await f.mints.payment({ id: f.id, paymentId: ref }); await f.execute();
  for (let i = 1; i < row.quote.fees.length; i++) { await f.mints.tick(); await f.execute(); }
  assert.deepEqual(f.store.get('mints', f.id).ethereumReferences, [ref]);
  await f.mints.payment({ id: f.id, paymentId: ref }); assert.equal(f.financial.pending(), false);
  await f.mints.tick(); await f.execute(); await f.mints.tick();
  assert.equal(f.store.get('mints', f.id).state, 'permit_issued');
  assert.equal(f.store.get('accountRecords', 'ao/' + f.id).state, 'consumed');
});

test('a client-held legacy quote enters v2 admission at its original price after a fee amendment', async t => {
  const { Mints } = await import('../src/mints.mjs');
  const { changeBaseFee } = await import('../src/fees.mjs');
  const f = await setup(t), registry = await f.reads.registry();
  const oldQuotes = new FeeQuotes({ network, secret, registry: async () => registry, now: () => 1000 });
  const old = new Mints({ network, store: f.store, reads: { ...f.reads, feeQuotes: oldQuotes }, bitcoinNetwork: 'regtest' });
  const quote = await old.quote({ asset: 'c1', amount: '3' });
  Object.assign(registry, changeBaseFee(registry, '900', 2000));
  const next = r.settingsRevision({ ...f.document, revision: '1', effectiveBatch: '2', previous: f.document,
    values: { ...f.document.values, feePolicyRevision: registry.feePolicy.current } });
  // Keep the acceptance inside the signed five-minute wall-clock window.
  f.reads.feeQuotes.now = () => 3000; f.independent.feeQuotes.now = () => 3000; f.amend(next);
  const request = { v: 2, owner: f.owner.address, asset: 'c1', amount: '3', receive: r.hash('regtest-receiver'), nonce: r.hash('client-held-v1'), until: 120, expires: 532, settingsHash: r.hashObject(next) };
  const body = { request, signature: Buffer.from(ed25519.sign(financialMintDigest(network, request), f.owner.secret)).toString('hex'),
    receiver: 'regtest-receiver', payer: 'regtest-payer', kind: 'tap', feeQuote: quote.feeQuote };
  body.authorization = Buffer.from(ed25519.sign(payerDigest(network, body), f.owner.secret)).toString('hex');
  const prepared = await f.mints.request(body), action = prepared.reservationAction;
  await f.mints.request({ ...body, reserve: { ...action, sig: Buffer.from(ed25519.sign(accountActionDigest(network, action), f.owner.secret)).toString('hex') } });
  await f.execute(); assert.equal(f.store.get('mints', prepared.id).quote.price, quote.price);
  assert.deepEqual(f.store.get('mints', prepared.id).requestedFeeQuote, quote.feeQuote);
});

async function importLegacyLink(t, paid = true) {
  const { Links } = await import('../src/links.mjs');
  const { prepareFinancialMigration } = await import('../src/pending-financial.mjs');
  const { legacyGatewayRows, preparePendingWork } = await import('../src/pending-work.mjs');
  const { prepareTerminalImport } = await import('../src/terminal-import.mjs');
  const { initialState } = await import('../src/rules.mjs');
  const f = await setup(t), feeQuotes = new FeeQuotes({ network, secret, registry: f.reads.registry });
  const terms = async (id, until, counted) => {
    const quote = await feeQuotes.issue('link/' + id, counted);
    return { treasury: 'regtest-treasury', baseFee: quote.baseFee, feeAuthorization: await feeQuotes.accept(quote, 'link/' + id, id, until, counted) };
  };
  const old = new Links({ network, store: f.store, reads: { ...f.reads, validateFeeTerms: async () => {} }, terms });
  const request = { owner: f.owner.address, height: 42, nonce: r.hash('legacy-link'), until: 532 }, sig = r.signLink(network, request, f.owner.secret);
  const p = await old.request({ request, sig, payer: 'regtest-payer', paymentHash: r.hash('legacy-payment-hash') }), id = p.id;
  const original = f.store.get('linkIntents', id), paymentId = r.hash('legacy-lock') + 'i0';
  if (paid) await f.store.put('linkRequests', id, { ...original, paymentId });
  await f.store.put('meta', 'ruleState', initialState(101, r.hash('tip'), 100));
  const records = new Map([['a/' + request.owner, 1], ['an/1', request.owner], ['v/1/c1', '100']]);
  const snapshot = { version: 2, height: 100, escrow: f.escrow, requests: new Map(), links: new Map([[id, f.store.get('linkRequests', id) ?? original]]), custody: new Map() };
  const rows = legacyGatewayRows(f.store), migration = prepareFinancialMigration({ rows, records, snapshot, network, document: f.document, height: 100, gateway: r.bytesToHex(ed25519.getPublicKey(secret)) });
  const pendingWork = preparePendingWork({ store: f.store, network, document: f.document, anchor: { height: '100', hash: r.hash('tip') }, lastTo: 100, financialMigration: migration });
  const imported = prepareTerminalImport({ records, height: 100, network, financialSnapshot: snapshot, pendingWork, gatewayRows: rows, document: f.document });
  await f.store.transact([...imported.availability, ...imported.accountRecords, ...migration.writes]);
  const split = p.split;
  const payment = { requestId: id, id: paymentId, kind: 'tap', payer: 'regtest-payer', confirmations: 1, consumed: true, verifiedHeight: 100, eventIndex: 0,
    total: p.price, tick: 'tap', lockKind: 'htlc', conditionType: 'hashlock', hash: original.terms.hash, refund: 'regtest-payer', claim: 'regtest-treasury', base: split.treasury,
    allocations: r.tapPaymentAllocations(split, {}, 'link'), refundAfter: 676,
    settlement: { accepted: true, refund: false, paymentId, txid: r.hash('legacy-release'), confirmations: 1 } };
  f.reads.linkPaymentFor = f.independent.linkPaymentFor = async row => { assert.equal(row.paymentId, paymentId); return structuredClone(payment); };
  return { ...f, id, original, paymentId, payment };
}

test('legacy paid TAP link completes with the original lock, signed request and fee terms', async t => {
  const f = await importLegacyLink(t);
  await f.links.tick(); await f.execute(); await f.links.tick(); await f.execute();
  assert.equal((await f.links.public(f.id)).state, 'accepted');
  assert.equal(f.store.get('accountRecords', 'fl/' + f.id).block, '42');
  assert.equal(f.store.get('linkStatus', f.id).state, 'accepted');
  assert.deepEqual(f.store.get('financialLinks', f.id).legacyLink.request, f.original.request);
});

test('legacy link awaiting payment survives activation and expires without taking a v2 link slot', async t => {
  const f = await importLegacyLink(t, false);
  assert.equal(f.store.get('accountRecords', 'fl/slot/42'), null);
  f.counted(533); await f.links.tick(); await f.execute();
  assert.equal((await f.links.public(f.id)).state, 'credited');
  assert(f.store.get('accountRecords', 'fc/' + f.id).fees.every(fee => fee.amount === '0'));
});

test('a paid legacy link whose Bitmap changed hands exits to backed credit instead of changing ownership terms', async t => {
  const f = await importLegacyLink(t);
  await f.links.tick(); await f.execute(); f.holder({ agent: agent(7000).address, address: 'regtest-other' });
  await f.links.tick(); await f.execute();
  assert.equal((await f.links.public(f.id)).state, 'credited');
  assert.equal(f.store.get('accountRecords', 'k/link/16'), null);
  assert(f.store.get('accountRecords', 'fc/' + f.id).fees.every(fee => BigInt(fee.amount) > 0n));
});

test('legacy credit hints become canonical backed transferable credit exactly once after restart', async t => {
  const f = await importLegacyMint(t, { consumed: true, issued: true, credit: true });
  assert.equal(f.store.get('creditClaims', f.id), null);
  assert.equal(f.store.get('legacyCreditClaims', f.id), f.id);
  f.transfers.set(f.creditPayment, f.row.quote.fees.map(fee => ({ ins: f.creditPayment, fail: false, int: true, addr: f.row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
  await f.reopen(); await f.mints.tick(); await f.execute(); await f.mints.tick(); await f.mints.tick();
  const [{ id: credit }] = f.store.list('legacyCreditResults/' + f.id, { limit: 10 });
  assert.equal(f.store.get('financialLegacyCredits', f.id), null);
  const value = f.store.get('accountRecords', 'fc/' + credit);
  assert.deepEqual(value.fees, f.store.get('accountRecords', 'fp/' + f.id).fees);
  const op = { op: 'fp', v: 2, type: 'transfer', id: credit, credit, revision: '0', to: agent(7200).address, until: 600 };
  op.sig = Buffer.from(ed25519.sign(paymentCreditDigest(network, op), f.owner.secret)).toString('hex');
  await f.financial.submit({ type: 'lifecycle', id: credit, action: { type: 'credit-transfer', id: credit, operation: op } }); await f.execute();
  assert.equal(f.store.get('accountRecords', 'fc/' + credit).owner, op.to);
  await f.mints.tick(); assert.equal(f.financial.pending(), false);
});

test('expired legacy paid hold accounts known payments before crediting and returning its units', async t => {
  const f = await importLegacyMint(t);
  f.transfers.set(f.payment, f.row.quote.fees.map(fee => ({ ins: f.payment, fail: false, int: true, addr: f.row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
  await f.store.put('mints', f.id, { ...f.row, paymentReferences: [f.payment] });
  f.counted(533); await f.mints.tick(); await f.execute(); await f.mints.tick(); await f.execute();
  assert.equal(f.store.get('accountRecords', 'ao/' + f.id).state, 'refunded');
  assert.deepEqual(f.store.get('accountRecords', 'fc/' + f.id).fees, f.store.get('accountRecords', 'fp/' + f.id).fees);
});

test('an unconfirmed original link payment does not prevent expiry; later settlement produces credit once', async t => {
  const f = await importLegacyLink(t);
  f.payment.settlement.accepted = false;
  f.counted(533); await f.links.tick(); await f.execute();
  assert.equal((await f.links.public(f.id)).state, 'credited');
  f.payment.settlement.accepted = true;
  await f.links.payment({ id: f.id, paymentId: f.paymentId }); await f.execute();
  await f.mints.tick(); await f.mints.tick();
  const [{ id: credit }] = f.store.list('legacyCreditResults/' + f.id, { limit: 10 });
  assert.deepEqual(f.store.get('accountRecords', 'fc/' + credit).fees, f.store.get('accountRecords', 'fp/' + f.id).fees);
  await f.links.payment({ id: f.id, paymentId: f.paymentId }); await f.mints.tick();
  assert.equal(f.financial.pending(), false);
});

test('financial migration refuses orphaned queues and altered original fee authorization', async t => {
  const f = await importLegacyMint(t), { prepareFinancialMigration } = await import('../src/pending-financial.mjs');
  const derive = rows => prepareFinancialMigration({ rows, records: f.records, snapshot: f.snapshot, network,
    document: f.document, height: 100, gateway: r.bytesToHex(ed25519.getPublicKey(secret)) });
  for (const space of ['activeMints', 'expiredMints', 'issuedMints', 'activeLinks', 'linkRecovery'])
    assert.throws(() => derive([...f.rows, [space, r.hash('orphan'), true]]), /pending_(financial|link)_queue_coverage/);
  for (const space of ['mintInputs', 'mintDeferred'])
    assert.throws(() => derive([...f.rows, [space, 'rq/' + r.hash('orphan'), { id: r.hash('orphan') }]]), /pending_financial_queue_coverage/);
  const changed = structuredClone(f.rows); changed.find(([space]) => space === 'mints')[2].quote.baseFee = '101';
  assert.throws(() => derive(changed), /pending_financial_price/);
  const changedFees = structuredClone(f.rows); changedFees.find(([space]) => space === 'mints')[2].quote.fees[0].amount = '999999';
  assert.throws(() => derive(changedFees), /pending_financial_fee_plan/);
});

test('an imported link keeps its pinned treasury even after the live registry changes', async t => {
  const f = await importLegacyLink(t), { validateQuotedTerms } = await import('../src/fees.mjs');
  (await f.reads.registry()).link.treasury = 'changed-registry-treasury';
  assert.deepEqual(await validateQuotedTerms(f.reads, 'link', f.original), f.original.terms);
  await assert.rejects(validateQuotedTerms(f.reads, 'link', { ...f.original, terms: { ...f.original.terms, treasury: 'changed-registry-treasury' } }), /link_import_terms/);
});

test('historical quotes and reservations keep their policy after capacity and fee changes, while fresh quotes use the successor', async t => {
  const f = await setup(t), original = f.document, oldHash = r.hashObject(original), p = await f.prepare('old-policy');
  const before = f.store.get('mints', p.id), originalEvidence = before.reservationEvidence;
  const successor = r.settingsRevision({ network, previous: original, effectiveBatch: '2', effectiveBitcoinWindow: '100',
    values: { ...original.values, paymentPage: 4, receiptSegmentEntries: 1, pendingBlocks: 400, firstMakerShareBps: 1000, compoundBurnBps: 5000, quoteLifetimeMs: 60000 } });
  f.useSettings(successor);
  // Reconstruct the original request before it has landed, from independently
  // pinned history. Substituting the successor would change its signed terms.
  assert.deepEqual(await f.independent.financialReservation(before, await f.stamp()), originalEvidence);
  const retriedQuote = await f.mints.quote({ asset: 'c1', amount: '3', kind: 'tap', feeQuote: p.body.feeQuote });
  assert.equal(retriedQuote.settingsHash, oldHash); assert.deepEqual(retriedQuote.split, before.quote.split);
  assert.equal(retriedQuote.payBy.untilBlock, 100 + original.values.pendingBlocks);
  assert.equal((await f.mints.quote({ asset: 'c1', amount: '3', kind: 'tap' })).payBy.untilBlock, 500);
  await f.mints.request({ ...p.body, reserve: p.action }); await f.execute(); await f.reopen();
  const references = Array.from({ length: 5 }, (_, i) => r.hash('historical-payment-' + i) + 'i0');
  for (const reference of references) f.transfers.set(reference, before.quote.fees.map(fee => ({ ins: reference, fail: false, int: true,
    addr: before.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
  // Reference recovery uses the original terms even when execution pages have
  // shrunk. The current planner still bounds the actual payment operations.
  assert.ok((await f.independent.financialReceipts(p.id, references, await f.stamp())).length > 0);
  await f.mints.payment({ id: p.id, paymentIds: references }); await f.execute();
  await f.mints.tick(); await f.execute(); await f.reopen(); await f.mints.tick();
  assert.equal(f.mints.public(p.id).state, 'permit_issued');
  assert.deepEqual(f.store.get('accountRecords', 'fp/' + p.id).paid, before.quote.fees.map(f => f.amount));
  const permit = f.mints.public(p.id).permit;
  await f.mints.tick(); assert.deepEqual(f.mints.public(p.id).permit, permit); assert.equal(f.signCount(), 1);
  const fresh = await f.prepare('new-policy'), row = f.store.get('mints', fresh.id);
  assert.equal(row.request.settingsHash, r.hashObject(successor));
  assert.equal(row.quote.split.firstMaker, '100'); assert.equal(row.quote.split.burn, '500');
  await f.mints.request({ ...fresh.body, reserve: fresh.action }); await f.execute();
  assert.equal(f.accepted.get(fresh.id).settingsHash, r.hashObject(successor));
  f.settingsDocuments.delete(oldHash);
  await assert.rejects(f.independent.financialReceipts(p.id, references, await f.stamp()), /financial_settings_history/);
  f.settingsDocuments.set(oldHash, successor);
  await assert.rejects(f.independent.financialReceipts(p.id, references, await f.stamp()), /financial_settings_history/);
});

test('renewal fencing blocks fresh quotes and financial admission while exact queued retries survive', async t => {
  const f = await setup(t), first = await f.prepare('already-queued'), second = await f.prepare('not-yet-reserved');
  await f.mints.request({ ...first.body, reserve: first.action });
  const queued = f.store.list('financialQueue', { limit: 1 })[0];
  f.financial.admissionReady = async () => false;
  assert.equal((await f.mints.request({ ...first.body, reserve: first.action })).id, first.id);
  assert.equal((await f.financial.submit(queued.value)).id, queued.id);
  await assert.rejects(f.mints.quote({ asset: 'c1', amount: '3', kind: 'tap' }), /financial_admission_fenced/);
  assert.equal((await f.mints.quote({ asset: 'c1', amount: '3', kind: 'tap', feeQuote: first.body.feeQuote })).settingsHash, first.body.request.settingsHash);
  await assert.rejects(f.mints.request({ ...second.body, reserve: second.action }), /financial_admission_fenced/);
  assert.equal(f.store.count('financialQueue'), 1);
  assert.deepEqual(f.store.get('financialQueue', queued.id), queued.value);
  f.financial.admissionReady = async () => true;
  await f.execute(); assert.equal(f.mints.public(first.id).reservation, 'reserved');
});

test('renewal fencing also covers link quotes, new intents and reservations while retaining exact retries', async t => {
  const f = await setup(t, {}, '100'), queued = await f.prepareLink('queued-link', '42'), waiting = await f.prepareLink('waiting-link', '43');
  await f.links.request({ ...queued.body, reserve: queued.action });
  const fresh = await f.prepareLink('fresh-link', '44');
  await f.store.transact([{ space: 'financialLinks', id: fresh.id }, { space: 'financialPendingLinks', id: fresh.id }, { space: 'financialLinkOwner/' + f.owner.address, id: fresh.id }]);
  f.financial.admissionReady = async () => false;
  assert.equal((await f.links.request({ ...queued.body, reserve: queued.action })).id, queued.id);
  assert.equal((await f.links.quote({ block: '43', payer: waiting.body.request.payer, feeQuote: waiting.body.feeQuote })).settingsHash, waiting.body.request.settingsHash);
  await assert.rejects(f.links.quote({ block: '45', payer: 'regtest-payer' }), /financial_admission_fenced/);
  await assert.rejects(f.links.request(fresh.body), /financial_admission_fenced/);
  await assert.rejects(f.links.request({ ...waiting.body, reserve: waiting.action }), /financial_admission_fenced/);
  assert.equal(f.store.count('financialQueue'), 1);
  f.financial.admissionReady = async () => true;
  await f.execute();
  assert.equal(f.store.get('accountRecords', 'fl/' + queued.id).state, 'reserved');
});

test('existing paid links keep their original reference capacity across an amendment and restart', async t => {
  const f = await setup(t, {}, '100'), original = f.document, p = await f.prepareLink('historic-link');
  await f.links.request({ ...p.body, reserve: p.action }); await f.execute();
  const row = f.store.get('financialLinks', p.id), references = Array.from({ length: 5 }, (_, i) => r.hash('historic-link-payment/' + i) + 'i0');
  for (const reference of references) f.transfers.set(reference, row.quote.fees.map(fee => ({ ins: reference, fail: false, int: true,
    addr: row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
  const successor = r.settingsRevision({ network, previous: original, effectiveBatch: '2', effectiveBitcoinWindow: '100', values: { ...original.values, paymentPage: 4 } });
  f.useSettings(successor); await f.reopen();
  await f.links.payment({ id: p.id, paymentIds: references }); await f.execute(); await f.execute();
  assert.equal((await f.links.public(p.id)).state, 'accepted');
  assert.deepEqual(f.store.get('financialLinks', p.id).request, row.request);
  assert.equal(f.store.get('accountRecords', 'fp/' + p.id).state, 'consumed');
});


test('independent link funding reads reject empty payment pages before reducing receipt heights', async t => {
  const f = await setup(t, {}, '100'), p = await f.prepareLink('empty-page');
  await f.links.request({ ...p.body, reserve: p.action }); await f.execute();
  const payment = r.hash('empty-page-payment') + 'i0'; f.transfers.set(payment, []);
  for (const type of ['fund', 'surplus']) {
    for (const items of [[], undefined, null]) {
      await assert.rejects(f.independent.financialEvidence({ type, id: p.id, items, references: [payment] }, await f.stamp()),
        { name: 'Error', message: 'financial_payment_items' });
    }
  }
});

test('a slow cached mint quote follows a settings amendment while explicit historical quotes keep their terms', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await setup(t), input = { asset: 'c1', amount: '3', kind: 'tap' };
  const assetContext = f.reads.assetContext;
  f.reads.assetContext = async (...args) => { const value = await assetContext(...args); t.mock.timers.tick(1600); return value; };
  const old = await f.mints.quote(input);
  assert.strictEqual(await f.mints.quote(input), old, 'a slow identical retry uses the completed quote');
  const successor = r.settingsRevision({ network, previous: f.document, effectiveBatch: '2', effectiveBitcoinWindow: '100',
    values: { ...f.document.values, pendingBlocks: 400, firstMakerShareBps: 1000, compoundBurnBps: 5000 } });
  f.useSettings(successor);
  const fresh = await f.mints.quote(input);
  assert.equal(fresh.settingsHash, r.hashObject(successor));
  assert.equal(fresh.payBy.untilBlock, 500);
  assert.equal(fresh.split.firstMaker, '100');
  const historical = await f.mints.quote({ ...input, feeQuote: old.feeQuote });
  assert.equal(historical.settingsHash, old.settingsHash);
  assert.deepEqual(historical.split, old.split);
});

for (const rail of ['tap', 'ethereum']) for (let tier = 1; tier <= 5; tier++) test(`native ${rail} compound tier ${tier} uses flat settings through reservation and signer evidence`, async t => {
  const f = await setup(t, {}, '100', { baseFee: flat.baseFee, feeSettings: flatSettings });
  f.context.tier = tier;
  const p = await f.prepare('flat', rail), row = f.store.get('mints', p.id);
  assert.equal(row.quote.price, flat.baseFee);
  assert.equal((await f.mints.quote({ asset: 'c1', amount: '9', kind: rail })).price, flat.baseFee);
  assert.equal(row.quote.fees.reduce((n, fee) => n + BigInt(fee.amount), 0n).toString(), flat.baseFee);
  const link = await f.links.quote({ block: '42', payer: 'regtest-payer' });
  assert.equal(link.price, flat.baseFee);
  await f.mints.request({ ...p.body, reserve: p.action }); await f.execute();
  assert.deepEqual(f.store.get('accountRecords', 'fp/' + p.id).fees.map(fee => fee.amount), row.quote.fees.map(fee => fee.amount));
  const evidence = await f.independent.financialEvidence({ type: 'reserve', id: p.id, action: p.action, fees: [] }, await f.stamp());
  assert.deepEqual(evidence.feeItems.map(fee => fee.amount), row.quote.fees.map(fee => fee.amount));
});
