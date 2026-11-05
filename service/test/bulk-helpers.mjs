import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'node:test';

// Before the tracks are merged, only the foreign implementation is substituted
// at its real seam. No alternate bulk wire schema lives in these tests.
if (process.env.BULK_TRACK_A_ROOT) {
  const root = await import(pathToFileURL(resolve(process.env.BULK_TRACK_A_ROOT, 'contract/root-accounts.js')));
  mock.module('../../contract/root-accounts.js', { namedExports: root });
}
export const sharedFixture = JSON.parse(await readFile(new URL('../../rules/test/fixtures/bulk-v1.json', import.meta.url)));
export const r = (await import('../src/rules.mjs')).rules;
export const b = await import('../../rules/src/bulk-mint.js');
const { Store } = await import('../src/store.mjs');
const { AccountExecution } = await import('../src/account-batch.mjs');
const { FinancialExecution, buildFinancialExecution } = await import('../src/financial-execution.mjs');
const { BulkMints } = await import('../src/bulk-mints.mjs');
const { installFinancialSources } = await import('../src/financial-sources.mjs');
const { FeeQuotes, createFeePolicy } = await import('../src/fees.mjs');
const { reserveNonceDigest } = await import('../../contract/root-accounts.js');
const { financialGenerationId } = await import('../src/financial-capacity-sources.mjs');
const { beneficiaryFeePlan } = await import('../../rules/src/beneficiary-credits.js');
const { installFinancialChain } = await import('../src/financial-chain.mjs');
const { deploymentPayload } = await import('../src/deployments.mjs');
const { ed25519 } = await import('../../contract/node_modules/@noble/curves/ed25519.js');
const { secp256k1 } = await import('../../contract/node_modules/@noble/curves/secp256k1.js');
const { p2tr, NETWORK } = await import('../../rules/node_modules/@scure/btc-signer/index.js');
export const address = n => p2tr(secp256k1.getPublicKey(new Uint8Array(32).fill(n)).slice(1), undefined, NETWORK).address;
export const digest = n => r.hash(String(n));

export async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bulk-gateway-'));
  let store = await Store.open(directory);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true }); });
  const network = 'bulk-test', bitcoinNetwork = 'mainnet', asset = sharedFixture.terms.asset;
  const secret = new Uint8Array(32).fill(13), owner = Buffer.from(ed25519.getPublicKey(secret)).toString('hex');
  const signer = new Uint8Array(32).fill(14), publicKey = Buffer.from(secp256k1.getPublicKey(signer)).toString('hex');
  const feeSettings = { tierMultipliers: [1, 3, 10, 30, 100], compoundMinimum: 10, link: 3 };
  const policy = createFeePolicy(options.baseFee ?? '101', 0, feeSettings), registry = { feePolicy: policy };
  const document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '974137', values: {
    ...r.SETTINGS_PROFILE, feePolicyRevision: policy.current, linkMultiplier: 3, ...options.values } });
  const deployment = { id: sharedFixture.terms.deployment, tick: 'example', kind: 'dmt', active: true, decimals: 0,
    remaining: options.remaining ?? '100000', limit: options.limit ?? '0', privilegePublicKey: publicKey,
    elementId: digest('element') + 'i0', privilege: digest('privilege') + 'i0', dt: 'n',
    ...(options.extra ? { officialDeployment: digest('official') + 'i0' } : {}) };
  const entry = { ...deployment, asset, pattern: { pat: '123', fld: 4, dt: 'n' }, options: {} };
  registry.assets = { [asset]: entry };
  const auth = { auth: { name: 'bulk-test' }, salt: digest('authsalt') }; auth.hash = r.hash(JSON.stringify(auth.auth) + auth.salt);
  const authSig = secp256k1.sign(auth.hash, signer, { lowS: true, prehash: false });
  auth.sig = { r: String(authSig.r), s: String(authSig.s), v: String(authSig.recovery) };
  const generation = financialGenerationId(network, asset, deployment.id), accepted = new Map(), transactions = new Map();
  let height = '974137', revision = 0, stampHook, count = 0, active = 0, maxActive = 0, holderAddress = address(5);
  const contexts = new Map(), skipped = new Set();
  const stamp = () => ({ counted: height, tip: height, tipHash: digest('tip'), revision, last: { n: String(revision) } });
  const context = block => contexts.get(block) ?? { deployment, find: { asset, block, count: options.amount ?? '3',
    finder: owner, findHeight: height, finderUntil: (BigInt(height) + 1000n).toString(), settingsHash: r.hashObject(document) },
    tier: 1, link: null, holder: null, treasury: address(3), finderAddress: options.suspense ? null : address(4),
    discoverer: null, beneficiaries: { finder: owner } };
  const base = { batchStamp: async () => { stampHook?.(); return stamp(); }, counted: async () => height,
    registry: async () => registry, authority: async () => ({ committee: publicKey }),
    assetContext: async (_asset, block, at) => { assert.equal(at.bulkMint, true); return structuredClone(context(block)); },
    isMinted: async (_id, _tick, block) => skipped.has(block), bitmap: async block => context(block).holder,
    settingsByHash: async hash => hash === r.hashObject(document) ? document : null,
    withBulkSnapshot: async (_at, fn) => fn({ stamp: { height, hash: digest('tip') } }),
    content: async id => id === deployment.privilege ? auth : id === deployment.elementId ? 'fixture.123.4.element' : deploymentPayload(entry),
    element: async () => ({ ins: deployment.elementId, pat: '123', fld: 4, tick: 'fixture' }),
    privilegeAuthority: async () => ({ ins: deployment.privilege }), included: async () => ({ confirmations: 1, height }),
    tap: async key => key.startsWith('getDeployment/') ? { ins: deployment.id, prv: deployment.privilege, tick: deployment.tick,
      dec: '0', elem: deployment.elementId, dt: 'n' } : key.startsWith('getPrivilegeAuthCancelled/') ? false : deployment.remaining,
    bulkTransactions: async (txids, { kinds }) => txids.map(txid => { count++; return structuredClone(transactions.get(txid) ??
      { txid, inscriptions: [], transfers: [], mints: [], complete: Object.fromEntries(kinds.map(k => [k, false])) }); }),
    discoverPaymentIds: () => assert.fail('legacy payment lookup'), paymentTransfers: () => assert.fail('per-member payment reads'),
    deploymentHolders: async ids => ids.map(id => ({ id, address: holderAddress })),
  };
  const makeReads = () => installFinancialSources({ ...base, feeQuotes: new FeeQuotes({ network, secret: Buffer.alloc(32, 9),
    registry: async () => registry, settings: () => document }) }, { network, bitcoinNetwork, document, recoveryVersion: 2,
    suspense: { tap: address(6) }, request: id => store.get('mints', id), reservation: id => accepted.get(id), record: key => store.get('accountRecords', key) });
  const reads = makeReads(), independent = makeReads();
  for (const reader of [reads, independent]) installFinancialChain(reader, { bitcoinHash: async () => digest('tip') });
  const seed = new AccountExecution({ store, document, height });
  await seed.accounts([{ type: 'credit', owner, asset, amount: options.units ?? '100000' }]); await store.transact(seed.result().writes);
  const official = options.extra ? digest('official-generation') : generation;
  const registered = { asset, deployment: deployment.id, maximum: options.maximum ?? '100000', limit: options.limit ?? '0', reserved: '0', minted: '0',
    ...(options.extra ? { official } : {}) };
  await store.transact([{ space: 'accountRecords', id: 'fd/' + generation, value: registered },
    { space: 'accountRecords', id: 'fd/asset/' + asset, value: official },
    { space: 'accountRecords', id: 'fd/external/' + r.hashObject(deployment.id), value: generation },
    ...(options.extra ? [{ space: 'accountRecords', id: 'fd/' + official, value: { asset, deployment: deployment.officialDeployment } }] : [])]);
  const senderView = { keyId: digest('key'), settings: {}, ready: () => true, address: () => address(7), authorized: token => token === 'Bearer local-test',
    bulkFunding: async ({ members }) => {
      const maxMembers = Math.min(members.length, options.maxMembers ?? 64), maxFeeSats = 5000;
      return { fits: maxMembers === members.length, maxMembers, mintFunding: { address: address(7), satoshis: members.length * 546 + 6546 + maxFeeSats,
        feeRate: 1, feeRateCeiling: 2, maxFeeSats: String(maxFeeSats), postageSats: 546, returnReserveSats: 6000, label: 'your bulk mint inscriptions' },
        templateBytes: members.map(() => 800), commitVsize: 200, revealVsizes: [1000] };
    } };
  const financial = new FinancialExecution({ store, reads, document, resources: { bulkMintEnabled: true } });
  const committee = { signature: async (key, proposal) => {
    assert.equal(key, 'mint/' + b.bulkMemberId(proposal.orderId, proposal.index));
    active++; maxActive = Math.max(maxActive, active);
    try {
      const verified = await independent.bulkPermit(proposal.orderId, proposal.index, stamp());
      if (options.withhold === proposal.index) return null;
      const p = verified.permit, sig = secp256k1.sign(p.digest, signer, { lowS: true, prehash: false });
      return { session: digest(key), payload: { ...p.payload, prv: { address: p.address, salt: p.salt, hash: p.digest,
        sig: { r: String(sig.r), s: String(sig.s), v: String(sig.recovery) } } } };
    } finally { active--; }
  } };
  let bulk = new BulkMints({ store, reads, financial, committee, document, network, bitcoinNetwork, senderView, resources: { bulkMintEnabled: true, ...options.resources } });
  const input = (n = 1, nonce = 'order') => ({ v: 1, owner, nonce: digest(nonce), asset, deployment: deployment.id,
    payer: options.self ? address(4) : address(1), receiver: address(2), blocks: Array.from({ length: n }, (_, i) => String(900000 + i)) });
  const sign = quote => {
    const reserve = b.bulkReserveAction(quote.terms);
    reserve.sig = Buffer.from(ed25519.sign(reserveNonceDigest(network, reserve), secret)).toString('hex');
    return { version: 1, terms: structuredClone(quote.terms), feeManifest: structuredClone(quote.feeManifest), reserve };
  };
  const execute = async () => {
    const result = await financial.build({ height, at: stamp() });
    assert.equal(result.deferred.length, 0, JSON.stringify(result.deferred));
    // Each signer reconstructs evidence independently, never using gateway
    // evidence as an oracle. The shared planner binds it to the same effects.
    for (const i of result.inputs) assert.deepEqual(await independent.financialEvidence(i.transition, stamp()), i.evidence);
    const draft = { proposal: { batch: { n: String(++revision) } }, items: [{ output: { accountWrites: result.writes, file: { observation: '1', financialOperations: result.inputs } } }] };
    for (const i of result.inputs) if (i.transition.type === 'reserve-many') accepted.set(i.transition.id, structuredClone(i.evidence));
    await store.transact([...result.writes, ...financial.acceptedOperations(draft)]);
    return { ...result, draft };
  };
  const payment = (quote, label = 'payment', failed = [], paymentHeight = height) => {
    const id = digest(label) + 'i0', terms = quote.terms, orderId = b.bulkOrderId(network, terms.owner, terms.nonce);
    transactions.set(id.slice(0, 64), { txid: id.slice(0, 64), stamp: { height, hash: digest('tip') },
      inclusion: { height: paymentHeight, hash: digest('payment-block'), confirmations: 1 },
      inscriptions: [{ id, content: { p: 'tap', op: 'token-auth', redeem: { auth: digest('auth') + 'i0', items: [...b.bulkWalletItems(terms), ...(quote.deployerPayment ? [{ address: quote.deployerPayment.to, tick: 'tap', amt: r.formatTapAmount(quote.deployerPayment.amount), dta: quote.deployerPayment.dta }] : [])] } } }],
      transfers: terms.groups.map((g, index) => ({ index, value: { ins: id, fail: failed.includes(index), int: true,
        addr: terms.payer, taddr: g.to, tick: 'tap', amt: g.amount, dta: b.bulkPaymentData(orderId, index) } })).concat(quote.deployerPayment ? [{ index: terms.groups.length, value: { ins: id, fail: failed.includes(terms.groups.length), int: true, addr: terms.payer, taddr: quote.deployerPayment.to, tick: 'tap', amt: quote.deployerPayment.amount, dta: quote.deployerPayment.dta } }] : []), mints: [], complete: { transfers: true, mints: true } });
    return id;
  };
  const reveal = async (id, indices) => {
    const rows = [];
    for (let offset = 0; offset < 64; offset += 16) {
      if (offset >= bulk.row(id).body.terms.members.length) break;
      rows.push(...(await bulk.permit(id, { offset, limit: 16 })).members);
    }
    const selected = rows.filter(r => !indices || indices.includes(r.index)), txid = digest('reveal-' + selected[0].index);
    transactions.set(txid, { txid, inclusion: { height, hash: digest('reveal-block'), confirmations: 1 },
      inscriptions: selected.map((m, i) => ({ id: txid + 'i' + i, content: m.mintContent })),
      transfers: [], mints: selected.map((m, index) => ({ index, value: { ins: txid + 'i' + index, fail: false,
        addr: m.mintContent.prv.address, tick: 'dmt-example', amt: m.amount, dta: m.mintContent.dta } })), complete: { transfers: true, mints: true } });
    return selected.map((m, i) => ({ index: m.index, inscription: txid + 'i' + i }));
  };
  return { get store() { return store; }, get bulk() { return bulk; }, document, network, bitcoinNetwork, reads, independent, financial,
    senderView, owner, secret, deployment, generation, contexts, skipped, accepted, transactions, input, sign, execute, payment, reveal, stamp,
    count: () => count, maxActive: () => maxActive, height: v => { height = v; }, advanceBatch: () => { revision++; }, stampHook: v => { stampHook = v; },
    holderAddress: value => { holderAddress = value; },
    rebuild: () => new BulkMints({ store, reads, financial, committee, document, network, bitcoinNetwork, senderView, resources: { bulkMintEnabled: false } }),
    build: transitions => buildFinancialExecution({ store, reads, document, height, at: stamp(), transitions }),
    async restart() { await store.close(); store = await Store.open(directory); financial.store = store; financial.linkReconciler.store = store;
      bulk = new BulkMints({ store, reads, financial, committee, document, network, bitcoinNetwork, senderView, resources: { bulkMintEnabled: false } }); return bulk; },
  };
}
