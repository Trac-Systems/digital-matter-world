import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { ed25519 } from '../../contract/node_modules/@noble/curves/ed25519.js';
import { secp256k1 } from '../../contract/node_modules/@noble/curves/secp256k1.js';
import * as r from '../../rules/src/index.js';
import { financialSplit } from '../../rules/src/financial-fees.js';
import { financialMintDigest, financialMintId } from '../../rules/src/financial-mint.js';
import { accountActionDigest } from '../../contract/root-accounts.js';
import { Store } from '../src/store.mjs';
import { AccountExecution } from '../src/account-batch.mjs';
import { buildFinancialExecution } from '../src/financial-execution.mjs';
import { installFinancialSources, financialFees } from '../src/financial-sources.mjs';
import { financialGenerationId } from '../src/financial-capacity-sources.mjs';
import { FeeQuotes, createFeePolicy, mintFeeScope } from '../src/fees.mjs';
import { payerDigest } from '../src/mints.mjs';
import { temp } from './helpers.mjs';

export async function bitmapMintFixture(t, { height = '110', activation = '110', finder = false, linked = true, balance = '3' } = {}) {
  const store = await Store.open(await temp('bitmap-mint-'));
  t.after(async () => { await store.close(); await rm(store.directory, { recursive: true, force: true }); });
  const network = 'bitmap-mint-test', secret = new Uint8Array(32).fill(31), owner = r.bytesToHex(ed25519.getPublicKey(secret));
  const asset = 'p2:0', block = '10', payer = 'regtest-payer', receiver = 'regtest-receiver';
  const publicKey = r.bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(32)));
  const feePolicy = createFeePolicy('100'), document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '100', values: {
    ...r.SETTINGS_PROFILE, ...r.PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '100', claimsNeverCloseHeight: '100',
    feePolicyRevision: feePolicy.current, linkMultiplier: r.FEE_DEFAULTS.link, ...(activation === undefined || activation === null ? {} : { bitmapMintOpenHeight: activation }) } });
  const deployment = { id: r.hash('deployment') + 'i0', active: true, kind: 'dmt', tick: 'dmwbitmap', privilegePublicKey: publicKey, decimals: 0, remaining: '30', limit: '0' };
  const generation = financialGenerationId(network, asset, deployment.id);
  const context = { deployment, tier: 1, treasury: 'regtest-treasury', finderAddress: 'regtest-finder', payouts: {}, beneficiaries: {},
    find: { asset, block, count: '3', finder: finder ? owner : r.hash('finder'), findHeight: '102', finderUntil: finder ? '120' : '105', settingsHash: r.hash('creation-policy') },
    link: linked ? { block, linkHeight: '101' } : null };
  let holder = { agent: r.hash('new-holder'), address: 'regtest-current-holder' };
  const stamp = async () => ({ counted: height, last: { n: '1', to: height }, revision: '0', tip: height, tipHash: r.hash('tip') });
  const registry = { feePolicy, assets: { [asset]: deployment } };
  const makeReads = () => installFinancialSources({
    counted: async () => height, batchStamp: stamp, rulesContext: async () => ({ settings: document }),
    settingsByHash: async hash => hash === r.hashObject(document) ? document : null,
    assetContext: async () => structuredClone(context), bitmap: async () => holder, isMinted: async () => false,
    authority: async () => ({ committee: publicKey }), registry: async () => registry,
    feeQuotes: new FeeQuotes({ network, secret: Buffer.alloc(32, 33), registry: async () => registry, settings: () => document, now: () => 1000 })
  }, { network, document, bitcoinNetwork: 'regtest', recoveryVersion: 2,
    request: id => store.get('mints', id), reservation: async () => null, record: async key => store.get('accountRecords', key) });
  const reads = makeReads(), independent = makeReads();
  const seed = new AccountExecution({ store, document, height });
  await seed.accounts([{ type: 'credit', owner, asset, amount: balance }]);
  await store.transact([...seed.result().writes,
    { space: 'accountRecords', id: 'fd/asset/' + asset, value: generation },
    { space: 'accountRecords', id: 'fd/' + generation, value: { asset, deployment: deployment.id, minted: '0', reserved: '0', maximum: '30', limit: '0' } }]);
  const quote = await reads.feeQuotes.issue(mintFeeScope(asset, block, 'tap'), height, context.payouts, deployment.id);
  const request = { v: 2, owner, asset, block, amount: '3', receive: r.hash(receiver), nonce: r.hash('request'),
    until: r.addUint(height, '20'), expires: r.addUint(height, '432'), settingsHash: r.hashObject(document) };
  const id = financialMintId(network, request), fee = r.feeFor('find', quote.baseFee, 1, quote.feeSettings);
  const split = financialSplit(fee, { kind: 'find', linked }, document);
  const destinations = { treasury: context.treasury, finder: context.finderAddress, landowner: linked ? holder.address : null };
  const plan = reads.financialFeePlan({ split, destinations, id, payer, rail: 'tap' });
  const body = { request, signature: r.bytesToHex(ed25519.sign(financialMintDigest(network, request), secret)), receiver, payer, kind: 'tap', feeQuote: quote };
  body.authorization = r.bytesToHex(ed25519.sign(payerDigest(network, body), secret));
  const row = { ...body, id, requestedFeeQuote: quote, quote: { feeQuote: quote, price: fee, split, fees: plan.fees, custody: plan.custody },
    feeAuthorization: await reads.feeQuotes.accept(quote, mintFeeScope(asset, block, 'tap'), id, request.expires, height) };
  await store.put('mints', id, row);
  const prepare = async () => {
    const evidence = await reads.financialReservation(row, await stamp());
    const action = { type: 'reserve', id, owner, asset, amount: '3', terms: r.hashObject(evidence),
      revision: store.get('accountRecords', 'ar/' + owner).revision, nonce: request.nonce, until: request.until };
    action.sig = r.bytesToHex(ed25519.sign(accountActionDigest(network, action), secret));
    const transition = { type: 'reserve', id, action, fees: financialFees(row.quote.fees) };
    const result = await buildFinancialExecution({ store, reads, document, height, at: await stamp(), transitions: [transition] });
    assert.equal(result.inputs.length, 1);
    return { evidence, transition, result, files: [{ ops: result.operations, financialOperations: result.inputs }] };
  };
  return { store, reads, independent, document, context, row, owner, network, height, id, stamp, prepare, setHolder: value => holder = value };
}
