import assert from 'node:assert/strict';
import { ed25519 } from '../../contract/node_modules/@noble/curves/ed25519.js';
import { secp256k1 } from '../../contract/node_modules/@noble/curves/secp256k1.js';
import { rules as r } from '../src/rules.mjs';
import { Store } from '../src/store.mjs';
import { AccountExecution } from '../src/account-batch.mjs';
import { FinancialExecution } from '../src/financial-execution.mjs';
import { FinancialMints } from '../src/financial-mints.mjs';
import { FinancialLinks } from '../src/financial-links.mjs';
import { installFinancialSources } from '../src/financial-sources.mjs';
import { installFinancialChain } from '../src/financial-chain.mjs';
import { verifyFinancialExecution } from '../../committee/signer/financial-execution.mjs';
import { Policy } from '../../committee/signer/policy.mjs';
import { attachPermit } from '../../committee/signer/adapter.mjs';
import { verifyMintResult } from '../../committee/signer/certificate.mjs';
import { accountActionDigest, reserveNonceDigest } from '../../contract/root-accounts.js';
import { financialMintDigest, financialMintId } from '../../rules/src/financial-mint.js';
import { financialLinkDigest } from '../../rules/src/financial-link.js';
import { lifecycleDigest } from '../../contract/financial-lifecycle.js';
import { payerDigest } from '../src/mints.mjs';
import { FeeQuotes, createFeePolicy } from '../src/fees.mjs';
import { deploymentPayload } from '../src/deployments.mjs';
import { bitcoinAddress } from '../../kit/test/helpers.mjs';
import { temp, network, secret, agent } from './helpers.mjs';

export async function financialSourceFixture(t, values = {}, initialCounted = 100, options = {}) {
  const asset = options.legacyElement ? 'p2:0' : 'c1', bitcoinNetwork = options.legacyElement ? 'mainnet' : 'regtest';
  let store = await Store.open(await temp('g3b-sources-')); t.after(() => store.close());
  const owner = agent(100), signerSecret = new Uint8Array(32).fill(2), publicKey = Buffer.from(secp256k1.getPublicKey(signerSecret)).toString('hex');
  const feePolicy = createFeePolicy(options.baseFee ?? '100', 0, options.feeSettings, options.feeHeight ?? '0');
  let document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: options.feeHeight ?? '100', values: { ...r.SETTINGS_PROFILE, feePolicyRevision: feePolicy.current, linkMultiplier: options.feeSettings?.link ?? r.FEE_DEFAULTS.link, ...values } });
  const privilege = r.hash('privilege') + 'i0';
  const d = { id: r.hash('deploy') + 'i0', tick: 'dmwcompound', kind: options.legacyElement ? 'dmt' : 'compound', ...(options.legacyElement ? { elementId: options.legacyElement, dt: 'n', privilege } : {}), active: true, privilegePublicKey: publicKey, decimals: 0, remaining: '100', limit: '0' };
  const context = { deployment: d, find: options.legacyElement ? { asset, block: '42', count: '3', finder: owner.address, findHeight: '100', finderUntil: '101', settingsHash: r.hashObject(document) } : null, link: null, tier: 1, treasury: 'regtest-treasury', firstMakerAddress: options.custody ? null : 'regtest-maker',
    finderAddress: options.legacyElement ? 'legacy-finder' : null, beneficiaries: { firstMaker: owner.address }, payouts: { firstMaker: null } };
  const auth = { p: 'tap', op: 'privilege-auth', auth: { name: 'fixture' }, salt: r.hash('salt') };
  auth.hash = r.hash(JSON.stringify(auth.auth) + auth.salt);
  const authSig = secp256k1.sign(auth.hash, signerSecret, { lowS: true, prehash: false });
  auth.sig = { r: String(authSig.r), s: String(authSig.s), v: String(authSig.recovery) };
  const entry = { ...d, asset: asset, privilege, authorityKey: publicKey, options: { max: '100', dec: '0' }, ...(options.legacyElement ? { pattern: { pat: '123', fld: 4, dt: 'n' } } : {}) };
  const extra = { ...entry, id: r.hash('second-deploy') + 'i0', tick: options.chosenTicker ?? 'second', officialDeployment: d.id };
  const entries = [entry, ...(options.twoTickers ? [extra] : []), ...(options.threeTickers ? [{ ...extra, id: r.hash('third-deploy') + 'i0', tick: 'third' }] : [])];
  const chosen = selection => { const found = entries.find(e => !selection ? e.id === d.id : [e.id, e.tick].includes(selection)); assert.ok(found, 'asset_unregistered'); return found; };
  const registry = { ...(options.twoTickers ? { deployment: (_, selection) => chosen(selection), asset: (_, selection) => chosen(selection) } : {}), feePolicy, link: { treasury: 'regtest-treasury' }, assets: { [asset]: entry } }, accepted = new Map(), transfers = new Map();
  let counted = initialCounted, confirmations = 1, revision = 0, signCount = 0, minted = null, holder = { agent: owner.address, address: 'regtest-payer' }, paymentHeight = initialCounted;
  let legacyHolder = bitcoinAddress('mainnet', 10);
  const escrow = { chainId: '31337', address: '0x' + 'a'.repeat(40), token: '0x' + 'b'.repeat(40) }, ethereum = {};
  const settings = new Map([[r.hashObject(document), document]]);
  const stamp = async () => ({ counted, last: { n: revision, to: counted }, revision, tip: counted, tipHash: r.hash('tip') });
  const base = { isMinted: async () => false, element: async () => ({ ins: options.legacyElement, pat: '123', fld: 4, tick: 'existing' }),
    deploymentHolders: async ids => ids.map(id => ({ id, address: legacyHolder })), bitmap: async () => holder, link: async block => { const value = store.get('accountRecords', 'k/link/' + BigInt(block).toString(36)); return value ? JSON.parse(value) : null; }, mint: async id => structuredClone(typeof minted === 'function' ? minted(id) : minted), settingsByHash: async hash => settings.get(hash), counted: async () => counted, batchStamp: stamp, authority: async () => ({ network, committee: publicKey, epoch: 0 }), assetContext: async (_asset, _block, _at, quote, _admitted, selection) => structuredClone(options.twoTickers ? { ...context, deployment: chosen(selection ?? quote?.deploymentId) } : context),
    registry: async () => registry, included: async () => confirmations ? { confirmations, height: paymentHeight } : null,
    content: async id => id === privilege ? auth : id === options.legacyElement ? 'existing.123.4.element' : entries.some(e => e.id === id) ? deploymentPayload(entries.find(e => e.id === id)) : ({ p: 'tap', op: 'token-auth', redeem: { items: transfers.get(id).map(x => ({ dta: x.dta, address: x.taddr, tick: x.tick, amt: r.formatTapAmount(x.amt) })) } }),
    tap: async key => key.startsWith('getDeployment/') ? { ins: chosen(decodeURIComponent(key.slice('getDeployment/'.length))).id, prv: privilege, tick: chosen(decodeURIComponent(key.slice('getDeployment/'.length))).tick, ...(options.legacyElement ? { elem: options.legacyElement, dt: 'n' } : {}), dec: '0', max: '100', lim: '0' } : key.startsWith('getPrivilegeAuthCancelled/') ? false : '100',
    privilegeAuthority: async () => ({ ins: privilege }),
    escrowDeposit: async () => structuredClone(ethereum.snapshot), escrowSettled: async () => structuredClone(ethereum.event),
    paymentTransfers: async id => transfers.get(id).map((value, index) => ({ index, value })),
    discoverPaymentIds: () => assert.fail('history scan'), bitcoinTransaction: () => assert.fail('mempool funding'),
  };
  const makeReads = () => {
    const raw = { ...base, feeQuotes: new FeeQuotes({ network, secret, registry: async () => registry, settings: () => document }) };
    options.sources?.(raw, { store, entries, stamp });
    return installFinancialSources(raw, {
    network, document, bitcoinNetwork, recoveryVersion: 2, escrow, suspense: options.custody ? { tap: bitcoinAddress('regtest', 2) } : {},
    payout: id => store.get('financialCustodyPayments', id),
    request: id => store.get('financialLinks', id) ?? store.get('mints', id), reservation: async id => accepted.get(id), record: options.record ? (key, at) => options.record(key, at, store) : async key => store.get('accountRecords', key) }); };
  const reads = makeReads(), independent = makeReads();
  if (options.custody) for (const reader of [reads, independent]) installFinancialChain(reader, { bitcoinHash: async () => r.hash('tip') });
  const seed = new AccountExecution({ store, document, height: counted });
  await seed.accounts([{ type: 'credit', owner: owner.address, asset: asset, amount: options.initialUnits ?? '100' }]); await store.transact(seed.result().writes);
  const financial = new FinancialExecution({ store, reads, document });
  const policy = new Policy({ network, publicKey, reads: independent });
  const committee = { signature: async (_key, proposal) => {
    const approval = await policy.approve(proposal); signCount++;
    const s = secp256k1.sign(approval.digest, signerSecret, { lowS: true, prehash: false });
    const signature = { compact: s.toCompactHex(), r: String(s.r), s: String(s.s), v: s.recovery };
    verifyMintResult(approval.details, signature, { network, publicKey, id: approval.details.id });
    return { session: r.hash('session'), payload: attachPermit(approval.permit, signature) };
  } };
  const mints = new FinancialMints({ store, reads, financial, committee, network, document, bitcoinNetwork });
  const links = new FinancialLinks({ store, reads, financial, network, document });
  const prepareLink = async (label = 'link', block = '42') => {
    const quote = await links.quote({ block, payer: 'regtest-payer' }), request = { v: 2, kind: 'link', owner: owner.address, block, payer: 'regtest-payer', nonce: r.hash(label),
      until: (BigInt(counted) + 432n).toString(), settingsHash: quote.settingsHash, quoteHash: r.hashObject(quote.feeQuote) };
    const body = { request, feeQuote: quote.feeQuote, signature: Buffer.from(ed25519.sign(financialLinkDigest(network, request), owner.secret)).toString('hex') };
    const pending = await links.request(body), action = pending.reservationAction;
    return { body, id: pending.id, action: { ...action, sig: Buffer.from(ed25519.sign(lifecycleDigest(network, action), owner.secret)).toString('hex') } };
  };
  const prepare = async (nonce = 'first', kind = 'tap', who = owner, selection) => {
    if (kind === 'ethereum') { context.finderAddress = '0x' + 'f'.repeat(40); context.treasury = '0x' + 'c'.repeat(40); context.firstMakerAddress = '0x' + 'd'.repeat(40); }
    const retained = options.retainedQuotes ? await reads.feeQuotes.issue(r.stableJSON(['mint', asset, options.legacyElement ? '42' : null, kind]), counted, context.payouts, chosen(selection).id) : undefined;
    const quote = await mints.quote({ ...(retained ? { feeQuote: retained } : {}), asset, ...(options.legacyElement ? { block: '42' } : {}), amount: '3', kind, ...(selection ? { deployment: selection } : {}) });
    const request = { v: 2, owner: who.address, asset, ...(selection ? { deployment: quote.feeQuote.deploymentId } : {}), ...(options.legacyElement ? { block: '42' } : {}), amount: '3', receive: r.hash('regtest-receiver'), nonce: r.hash(nonce), until: r.ordinalCodec(typeof counted === 'string').add(counted, Math.min(20, document.values.pendingBlocks - 1)), expires: r.ordinalCodec(typeof counted === 'string').add(counted, document.values.pendingBlocks), settingsHash: quote.feeQuote.settingsHash };
    const body = { request, signature: Buffer.from(ed25519.sign(financialMintDigest(network, request), who.secret)).toString('hex'), receiver: 'regtest-receiver', payer: kind === 'tap' ? 'regtest-payer' : '0x' + 'e'.repeat(40), kind, feeQuote: quote.feeQuote };
    body.authorization = Buffer.from(ed25519.sign(payerDigest(network, body), who.secret)).toString('hex');
    const pending = await mints.request(body); let action = pending.reservationAction;
    if (options.legacyReservations) {
      action = { ...action, type: 'reserve', revision: store.get('accountRecords', 'ar/' + who.address).revision };
      await store.put('mints', pending.id, { ...store.get('mints', pending.id), reservationAction: action });
    }
    return { body, id: financialMintId(network, request), action: { ...action, sig: Buffer.from(ed25519.sign((action.type === 'reserve-n' ? reserveNonceDigest : accountActionDigest)(network, action), who.secret)).toString('hex') } };
  };
  const execute = async () => {
    const result = await financial.build({ height: counted, at: await stamp() });
    assert.equal(result.deferred.length, 0, JSON.stringify(result.deferred));
    await verifyFinancialExecution({ files: [{ ops: result.operations, financialOperations: result.inputs }], reads: independent, document, network, height: counted, at: await stamp() });
    for (const input of result.inputs) if (input.transition.type === 'reserve' || input.transition.action?.type === 'link-reserve') accepted.set(input.transition.id, input.evidence);
    const draft = { proposal: { batch: { n: ++revision } }, items: [{ output: { file: { financialOperations: result.inputs } } }] };
    const writes = [...result.writes, ...financial.acceptedOperations(draft)];
    if (writes.length) await store.transact(writes);
    return result;
  };
  const generation = await reads.financialDeployment(asset, await stamp());
  await financial.submit({ type: 'lifecycle', id: generation.id, action: generation.action }); await execute();
  return { get store() { return store; }, reads, independent, financial, mints, links, prepare, prepareLink, execute, context, transfers, accepted, document, owner, stamp, escrow, ethereum,
    entries, additional: extra, makeReads, legacyHolder: value => legacyHolder = value, holder: value => holder = value, paymentHeight: value => paymentHeight = value,
    minted: observation => minted = observation,
    settingsDocuments: settings, useSettings: next => { settings.set(r.hashObject(next), next); document = financial.document = mints.document = links.document = next; mints.pendingBlocks = next.values.pendingBlocks; },
    amend: next => { settings.set(r.hashObject(next), next); reads.feeQuotes.settings = independent.feeQuotes.settings = () => next; links.document = mints.document = financial.document = next; },
    confirmations: n => confirmations = n, counted: n => counted = n, signCount: () => signCount,
    reopen: async () => { const path = store.directory; await store.close(); store = await Store.open(path); financial.store = financial.linkReconciler.store = mints.store = links.store = store; } };
}
