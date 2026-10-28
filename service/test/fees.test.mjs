import { localReads } from '../local/reads.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FeeQuotes, changeBaseFee, changeFeePolicy, currentFee, mintFeeScope, QUOTE_MILLISECONDS, createFeePolicy, validateFeePolicy } from '../src/fees.mjs';
import { Mints, payerDigest } from '../src/mints.mjs';
import { Store } from '../src/store.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reloadBaseFee } from '../scripts/base-fee.mjs';
import { fixture, network } from '../../committee/test/fixture.mjs';
import { secret, gateway, temp, signEd } from './helpers.mjs';
import { publicIdentities, wireIdentities } from '../../rules/src/trac-address.js';
import { presentRead } from '../../kit/lib/reads.mjs';

function setup() {
  let registry = { feePolicy: createFeePolicy('100') }, now = 1000;
  const read = async () => structuredClone(registry);
  return { issuer: new FeeQuotes({ network, secret, registry: read, now: () => now }), verifier: new FeeQuotes({ network, gateway, registry: read }),
    change: value => { registry = changeBaseFee(registry, value, ++now); },
    settings: value => { registry = changeFeePolicy(registry, value, ++now); }, time: value => now = value, read };
}

test('HTTP and kit presentation preserve signed fee quotes and payout identities byte for byte', async () => {
  const f = setup(), scope = mintFeeScope('p0', 10, 'tap');
  const quote = await f.issuer.issue(scope, 100, { finder: { agent: 'ab'.repeat(32), address: 'wallet', nonce: '1' } });
  const authorization = await f.issuer.accept(quote, scope, 'request', 532, 100);
  const response = presentRead(publicIdentities({ feeQuote: quote, feeAuthorization: authorization, finder: 'ab'.repeat(32) }));
  assert.match(response.finder, /^trac1/);
  assert.deepEqual(response.feeQuote, quote);
  assert.deepEqual(response.feeAuthorization, authorization);
  assert.deepEqual(wireIdentities(response).feeQuote, quote);
  await f.verifier.validate(response.feeQuote, scope);
  await f.verifier.accepted(response.feeAuthorization, scope, 'request', 532);
});

test('live B changes immediately for new quotes and preserves authorized earlier quotes through multiple changes', async () => {
  const f = setup(), scope = mintFeeScope('p0', 10, 'tap'), q = await f.issuer.issue(scope, 100);
  f.change('250');
  assert.equal((await f.issuer.issue(scope, 100)).baseFee, '250');
  const admitted = await f.issuer.accept(q, scope, 'request', 532, 100);
  f.change('300'); f.time(q.expiresAt + 1);
  assert.deepEqual(await f.verifier.accepted(admitted, scope, 'request', 532), { baseFee: '100' });
  await assert.rejects(f.issuer.accept(q, scope, 'late', 532, 100), /fee_quote_expired/);
  assert.equal(currentFee(await f.read()).baseFee, '300');
});

test('a registry replacement during a quote read issues the new rate without a clock error', async () => {
  let now = 1000;
  const issuer = new FeeQuotes({ network, secret, now: () => now, registry: async () => changeBaseFee({ feePolicy: createFeePolicy('100') }, '250', ++now) });
  const quote = await issuer.issue('link/example', 100);
  assert.equal(quote.baseFee, '250'); assert.equal(quote.issuedAt, 1001);
});

test('quotes reject forged rates, scope, windows, request bindings and post-retirement issuance', async () => {
  const f = setup(), scope = 'link/request', q = await f.issuer.issue(scope, 100);
  const a = await f.issuer.accept(q, scope, 'request', 500, 100);
  for (const quote of [{ ...q, baseFee: '1' }, { ...q, validUntil: 9999 }, { ...q, expiresAt: q.expiresAt + 1 }]) await assert.rejects(f.verifier.validate(quote, scope), /fee_quote_signature/);
  await assert.rejects(f.verifier.accepted(a, 'link/different-scope', 'request', 500), /fee_quote_policy/);
  await assert.rejects(f.verifier.accepted(a, scope, 'other', 500), /fee_quote_binding/);
  await assert.rejects(f.verifier.accepted(a, scope, 'request', 501), /fee_quote_binding/);
  await assert.rejects(f.issuer.accept(q, scope, 'request', q.validUntil + 1, 100), /fee_quote_expired/);
  f.change('200');
  const { signature, ...payload } = q;
  for (const unit of [undefined, { currency: 'TAP', denomination: 'atomic', decimals: 0 }, { currency: 'TAP', denomination: 'whole', decimals: 18 }]) {
    const changed = { ...payload }; if (unit === undefined) delete changed.unit; else changed.unit = unit;
    await assert.rejects(f.verifier.validate(f.issuer.sign('dmw-fee-quote-v1', changed), scope));
  }
  const backdatedPolicy = f.issuer.sign('dmw-fee-quote-v1', { ...payload, issuedAt: 2000, expiresAt: 2000 + QUOTE_MILLISECONDS });
  await assert.rejects(f.verifier.validate(backdatedPolicy, scope), /fee_quote_window/);
  for (const price of ['0', '-1', '1.0', '1e2', '01', (1n << 256n).toString()]) assert.throws(() => changeBaseFee({ feePolicy: createFeePolicy('100') }, price, 1000));
});

for (const kind of ['dmt', 'compound']) test(`${kind}: gateway payment and independent committee pricing agree across a live change`, async () => {
  const fees = setup(), f = fixture(kind), store = await Store.open(await temp('live-fees-'));
  const reads = { ...f.reads, feeQuotes: fees.issuer, balance: async () => '100' };
  const mints = new Mints({ store, network, reads, operations: { supportsMintBatches: true }, inscriber: { quote: async () => '250' }, payments: { mint: async () => f.data.payment } });
  try {
    const input = { asset: f.proposal.request.asset, block: f.proposal.request.block, kind: 'tap' };
    const quote = await mints.quote(input); fees.change('250');
    const body = { ...f.proposal, kind: 'tap', payer: f.data.payer, feeQuote: quote.feeQuote }; body.authorization = signEd(payerDigest(network, body), f.secret);
    const accepted = await mints.request(body); assert.equal(accepted.baseFee, '100'); assert.equal(accepted.price, f.data.payment.total);
    const row = store.get('mints', f.id);
    f.reads.mintFeeTerms = async id => fees.verifier.accepted(store.get('mints', id).feeAuthorization, mintFeeScope(input.asset, input.block, input.kind), id, f.proposal.request.expires);
    reads.mintFeeTerms = f.reads.mintFeeTerms;
    await store.put('mints', f.id, { ...row, state: 'waiting_payment', paymentHash: f.data.payment.hash, expiry: f.proposal.request.expires });
    await mints.payment({ id: f.id, paymentId: f.data.payment.id });
    assert.equal((await f.policy.mint(f.proposal)).details.price, quote.price);
    assert.equal((await mints.quote(input)).baseFee, '250');
    fees.change('400'); assert.equal((await f.policy.mint(f.proposal)).details.price, quote.price);
  } finally { await store.close(); }
});

test('the registry requires one valid global feePolicy', () => {
  assert.throws(() => currentFee({}), /feePolicy is required in the operator registry/);
  assert.throws(() => changeBaseFee({}, '250'), /feePolicy is required in the operator registry/);
  const registry = { feePolicy: createFeePolicy('100') };
  assert.equal(validateFeePolicy(registry).current, registry.feePolicy.current);
  for (const policy of [{ ...registry.feePolicy, current: 'missing' }, { current: 'missing', revisions: [] },
    { ...registry.feePolicy, revisions: [{ ...registry.feePolicy.revisions[0], baseFee: '1' }] }]) {
    assert.throws(() => validateFeePolicy({ feePolicy: policy }), /fee_policy/);
  }
});

test('operator reload atomically updates a registry while its gateway store stays open', async () => {
  const directory = await temp('fee-reload-'), store = await Store.open(join(directory, 'data'));
  const registryPath = join(directory, 'registry.json'), configPath = join(directory, 'gateway.json');
  const registry = () => readFile(registryPath, 'utf8').then(JSON.parse);
  try {
    const endpoint = 'http://127.0.0.1:1';
    await writeFile(configPath, JSON.stringify({ version: 1, mode: 'regtest', network, listen: { host: '127.0.0.1', port: 0 }, data: store.directory,
      gatewayKey: join(directory, 'gateway.key'), adapter: fileURLToPath(new URL('../local/adapter.mjs', import.meta.url)),
      endpoints: Object.fromEntries(['ethereum', 'trac'].map(k => [k, endpoint])), committee: Array.from({ length: 5 }, () => ({ url: endpoint })), local: { registry: registryPath, tapSourceFile: join(directory, 'tap-source.url') } }));
    await writeFile(registryPath, JSON.stringify({ feePolicy: createFeePolicy('100'), link: { treasury: 'local' } }));
    const issuer = new FeeQuotes({ network, secret, registry });
    assert.equal((await issuer.issue('link/new', 10)).baseFee, '100');
    const quote = await issuer.issue('link/accepted', 10);
    const authorization = await issuer.accept(quote, 'link/accepted', 'accepted', 50, 10);
    const updated = await reloadBaseFee(configPath, '22.6');
    assert.equal(updated.baseFee, '22600000000000000000');
    assert.deepEqual(updated.unit, { currency: 'TAP', denomination: 'atomic', decimals: 18 });
    assert.equal((await issuer.issue('link/new', 10)).baseFee, updated.baseFee);
    for (const value of ['0', '1.0000000000000000001', '1e2', '-1', '01', 22.6]) {
      await assert.rejects(reloadBaseFee(configPath, value));
      assert.equal((await issuer.issue('link/new', 10)).baseFee, updated.baseFee);
    }
    assert.equal((await registry()).feePolicy.revisions.length, 2);
    assert.deepEqual(await issuer.accepted(authorization, 'link/accepted', 'accepted', 50), { baseFee: '100' });
    await store.put('meta', 'stillWritable', true); assert.equal(store.get('meta', 'stillWritable'), true);
  } finally { await store.close(); }
});

test('gateway and signer readers refuse a missing policy before contacting dependencies', async () => {
  const directory = await temp('fee-startup-'), registry = join(directory, 'registry.json');
  await writeFile(registry, JSON.stringify({ assets: {} }));
  for (const store of [undefined, {}]) await assert.rejects(localReads({ local: { registry } }, store), /feePolicy is required in the operator registry/);
});

test('mint admission requires a quote issuer and persists signed authorization from the start', async () => {
  const f = fixture(), store = await Store.open(await temp('fee-admission-'));
  const fees = setup(), reads = { ...f.reads, feeQuotes: fees.issuer, balance: async () => '100' };
  const mints = new Mints({ store, network, reads, operations: { supportsMintBatches: true }, inscriber: { quote: async () => '250' }, payments: {} });
  const body = { ...f.proposal, kind: 'tap', payer: f.data.payer }; body.authorization = signEd(payerDigest(network, body), f.secret);
  try {
    reads.feeQuotes = undefined;
    await assert.rejects(mints.request(body), /fee_quotes_unavailable/); assert.equal(store.count('mints'), 0);
    reads.feeQuotes = fees.issuer;
    await mints.request(body);
    const row = store.get('mints', f.id), scope = mintFeeScope(body.request.asset, body.request.block, body.kind);
    assert.deepEqual(await fees.verifier.accepted(row.feeAuthorization, scope, f.id, body.request.expires), { baseFee: '100' });
    await assert.rejects(fees.verifier.accepted(undefined, scope, f.id, body.request.expires), /fee_quote_signature/);
  } finally { await store.close(); }
});

for (const kind of ['dmt', 'compound']) test(`${kind}: configured multipliers remain fixed through gateway payment and committee approval`, async () => {
  const fees = setup(), f = fixture(kind), store = await Store.open(await temp('multiplier-mints-'));
  const settings = { link: 3, tierMultipliers: [2, 6, 20, 60, 200], compoundMinimum: 12 };
  fees.settings(settings); f.data.context.feeSettings = settings; f.reprice();
  const reads = { ...f.reads, feeQuotes: fees.issuer, balance: async () => '100' };
  const mints = new Mints({ store, network, reads, operations: { supportsMintBatches: true }, payments: { mint: async () => f.data.payment } });
  try {
    const input = { asset: f.proposal.request.asset, block: f.proposal.request.block, kind: 'tap' };
    const quote = await mints.quote(input);
    assert.deepEqual(quote.feeQuote.feeSettings, settings);
    fees.settings({ tierMultipliers: [3, 9, 30, 90, 300], compoundMinimum: 25 });
    // Even a newly read context must not override the admitted quote's settings.
    f.data.context.feeSettings = (await fees.read()).feePolicy.revisions.at(-1).feeSettings;
    const body = { ...f.proposal, kind: 'tap', payer: f.data.payer, feeQuote: quote.feeQuote }; body.authorization = signEd(payerDigest(network, body), f.secret);
    const accepted = await mints.request(body); assert.equal(accepted.price, quote.price);
    f.reads.mintFeeTerms = async id => fees.verifier.accepted(store.get('mints', id).feeAuthorization, mintFeeScope(input.asset, input.block, input.kind), id, body.request.expires);
    const row = store.get('mints', f.id);
    await store.put('mints', f.id, { ...row, state: 'waiting_payment', expiry: body.request.expires });
    await mints.payment({ id: f.id, paymentId: f.data.payment.id });
    assert.equal((await f.policy.mint(f.proposal)).details.price, quote.price);
    assert.notEqual((await mints.quote(input)).price, quote.price);
  } finally { await store.close(); }
});
