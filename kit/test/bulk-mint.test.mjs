import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import fixture from '../../rules/test/fixtures/bulk-v1.json' with { type: 'json' };
import { hashObject, stableJSON } from '../../rules/src/core.js';
import { bulkOrderId, bulkMembersRoot, bulkFeeRoot } from '../../rules/src/bulk-mint.js';
import { reserveNonceDigest } from '../../contract/root-accounts.js';
import { Journal } from '../lib/journal.mjs';
import { quoteBulkMint, makeBulkMint, payBulkMint, pollBulkMint } from '../lib/bulk-mint.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { testWallet } from './helpers.mjs';

function quote(input, count = input.blocks.length) {
  const terms = structuredClone(fixture.terms), feeManifest = [];
  Object.assign(terms, { owner: input.owner, nonce: input.nonce, asset: input.asset, deployment: input.deployment, receiver: input.receiver, payer: input.payer });
  terms.members = input.blocks.slice(0, count).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1).map(block => ({ block, amount: '3' }));
  for (let i = 0; i < count; i++) feeManifest.push({ ...structuredClone(fixture.feeManifest[0]), member: i });
  terms.totalAmount = String(3 * count); terms.membersRoot = bulkMembersRoot(terms.members); terms.feeRoot = bulkFeeRoot(feeManifest);
  terms.payableFeeAtoms = terms.grossFeeAtoms = terms.groups[0].amount = String(100 * count);
  terms.mintFunding.satoshis = count * 546 + 6546 + Number(terms.mintFunding.maxFeeSats);
  terms.feeQuote.scope = stableJSON(['mint-bulk-v1', terms.asset, terms.deployment, terms.membersRoot]);
  return { v: 1, orderId: bulkOrderId(terms.network, terms.owner, terms.nonce), quoteId: hashObject(terms), terms, feeManifest,
    skipped: [], deferred: input.blocks.slice(count).map(block => ({ block, reason: 'bulk_funding_limit' })), payable: false };
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bulk-kit-')), journal = await Journal.open(dir, 'bulk-tests');
  t.after(async () => { journal.close(); await rm(dir, { recursive: true }); });
  const wallet = testWallet(), requests = [], quotes = [];
  const agent = { journal, wallet, owner: wallet.publicKey.toString('hex'), network: fixture.terms.network,
    bitcoinNetwork: fixture.terms.bitcoinNetwork, dryRun: false, service: {
      bulkMintQuote: async input => { quotes.push(structuredClone(input)); return quote(input); },
      requestBulkMint: async body => { requests.push(structuredClone(body)); return { orderId: bulkOrderId(body.terms.network, body.terms.owner, body.terms.nonce), termsHash: hashObject(body.terms), state: 'reserving' }; },
      paymentLink: (id, origin, kind) => 'http://127.0.0.1/' + kind + '/' + id
    } };
  journal.waitTurn = () => { throw Error('Bulk must not acquire the global mint turn'); };
  const args = { actionId: 'bulk-001', asset: fixture.terms.asset, deployment: fixture.terms.deployment, blocks: ['900000'], receiver: fixture.terms.receiver, payer: fixture.terms.payer };
  const submit = q => ({ actionId: args.actionId, quoteId: q.quoteId, maxPayableFeeAtoms: '1000000000000000000', maxSetAsideSats: 100000 });
  return { agent, args, submit, quotes, requests, dir };
}

test('bulk saves one nonce, quote and exact reserve-n signature across lost request replies and reopened journals', async t => {
  const f = await setup(t), q = await quoteBulkMint(f.agent, f.args), send = f.agent.service.requestBulkMint;
  f.agent.service.requestBulkMint = async body => { await send(body); throw Error('lost response'); };
  await assert.rejects(makeBulkMint(f.agent, f.submit(q)), /lost response/);
  const original = f.requests[0], { sig, ...action } = original.reserve;
  assert.equal(ed25519.verify(sig, reserveNonceDigest(f.agent.network, action), f.agent.owner), true);
  assert.equal(action.type, 'reserve-n'); assert.equal('revision' in action, false);
  const reopened = await Journal.open(f.dir, 'bulk-tests'); t.after(() => reopened.close());
  const resumed = { ...f.agent, journal: reopened, service: { ...f.agent.service, requestBulkMint: send } };
  assert.deepEqual(await quoteBulkMint(resumed, f.args), q);
  const result = await makeBulkMint(resumed, f.submit(q));
  assert.deepEqual(f.requests[1], original); assert.equal(f.quotes.length, 1);
  assert.match(result.paymentLink, /\/mint\/bulk\//);
});

test('bulk saves its nonce before a failed quote and rejects a changed action intent', async t => {
  const f = await setup(t), read = f.agent.service.bulkMintQuote;
  f.agent.service.bulkMintQuote = async input => { await read(input); throw Error('lost quote'); };
  await assert.rejects(quoteBulkMint(f.agent, f.args), /lost quote/);
  f.agent.service.bulkMintQuote = read;
  await quoteBulkMint(f.agent, f.args);
  assert.equal(f.quotes[0].nonce, f.quotes[1].nonce);
  await assert.rejects(quoteBulkMint(f.agent, { ...f.args, blocks: ['900001'] }), /Conflicting bulk action ID/);
});

test('bulk ceilings and dry-run never submit, sign or pay; quote responses cannot mutate saved terms', async t => {
  const f = await setup(t), q = await quoteBulkMint(f.agent, f.args);
  await assert.rejects(makeBulkMint(f.agent, { ...f.submit(q), maxPayableFeeAtoms: '99' }), /ceiling/);
  await assert.rejects(makeBulkMint(f.agent, { ...f.submit(q), maxSetAsideSats: 1 }), /ceiling/);
  assert.equal((await makeBulkMint(f.agent, { ...f.submit(q), dryRun: true })).signed, false);
  assert.equal(f.agent.journal.get('bulk/bulk-001'), null); assert.equal(f.requests.length, 0);
  q.terms.members[0].amount = '999';
  const same = await quoteBulkMint(f.agent, f.args); assert.equal(same.terms.members[0].amount, '3');
});

test('bulk keeps funding-deferred members visible and rejects substituted or missing members', async t => {
  const f = await setup(t); f.args.blocks = ['900000', '900001'];
  f.agent.service.bulkMintQuote = async input => quote(input, 1);
  const q = await quoteBulkMint(f.agent, f.args); assert.deepEqual(q.deferred, [{ block: '900001', reason: 'bulk_funding_limit' }]);
  const bad = await setup(t); bad.agent.service.bulkMintQuote = async input => { const q = quote(input); q.terms.payer = q.terms.mintFunding.address; q.quoteId = hashObject(q.terms); return q; };
  // A different valid address, while all commitments have been recomputed, is still not this intent.
  bad.args.payer = fixture.terms.receiver === fixture.terms.mintFunding.address ? fixture.terms.groups[0].to : fixture.terms.receiver;
  if (bad.args.payer !== fixture.terms.mintFunding.address) await assert.rejects(quoteBulkMint(bad.agent, bad.args), /intent mismatch/);
});

test('bulk rejects 65 members and duplicate blocks; 64 members are one saved quote', async t => {
  const f = await setup(t), blocks = Array.from({ length: 64 }, (_, i) => String(900000 + i));
  await quoteBulkMint(f.agent, { ...f.args, blocks });
  const g = await setup(t);
  await assert.rejects(quoteBulkMint(g.agent, { ...g.args, blocks: [...blocks, '900064'] }), /Invalid bulk blocks/);
  await assert.rejects(quoteBulkMint(g.agent, { ...g.args, blocks: ['900000', '900000'] }), /Invalid bulk blocks/);
});

test('bulk independent actions submit concurrently without a global turn lock; matching calls coalesce', async t => {
  const f = await setup(t), q1 = await quoteBulkMint(f.agent, f.args), q2 = await quoteBulkMint(f.agent, { ...f.args, actionId: 'second', blocks: ['900001'] });
  let unblock; const hold = new Promise(resolve => { unblock = resolve; }), send = f.agent.service.requestBulkMint;
  let entered = 0;
  f.agent.service.requestBulkMint = async body => { entered++; if (entered === 2) unblock(); await hold; return send(body); };
  const a = f.submit(q1), b = { ...f.submit(q2), actionId: 'second' };
  await Promise.all([makeBulkMint(f.agent, a), makeBulkMint(f.agent, a), makeBulkMint(f.agent, b)]);
  assert.equal(entered, 2); assert.equal(f.requests.length, 2);
});

test('bulk client uses fixed routes, direct wire bodies, page bounds and explicit JSON Accept', async () => {
  const calls = [], client = new ServiceClient({ fetchImpl: async (url, opts) => { calls.push({ url, opts }); return Response.json({ ok: true }); } });
  const id = 'a'.repeat(64);
  await client.bulkMintStatus(id); await client.bulkMintMembers(id, { offset: 16, limit: 32 }); await client.bulkMintPermit(id, { offset: 0, limit: 16 });
  await client.reportBulkPayment({ orderId: id, paymentId: null, commitTxid: id, revealTxid: null });
  assert.match(calls[1].url, /\/mint\/bulk\/.+\/members\?offset=16&limit=32$/);
  assert.equal(calls[0].opts.headers.accept, 'application/json');
  await assert.rejects(client.bulkMintPermit(id, { limit: 17 }), /Invalid bulk page/);
  await assert.rejects(client.bulkMintMembers(id, { offset: -1 }), /Invalid bulk page/);
});

test('bulk pay tool rechecks accepted terms and returns a wallet plan without sending', async t => {
  const f = await setup(t), q = await quoteBulkMint(f.agent, f.args);
  f.agent.service.bulkMintStatus = async () => ({ orderId: q.orderId, termsHash: q.quoteId });
  f.agent.service.bulkMintTerms = async () => ({ v: 1, orderId: q.orderId, terms: q.terms, feeManifest: q.feeManifest });
  const plan = await payBulkMint(f.agent, { orderId: q.orderId });
  assert.equal(plan.sent, false); assert.equal(plan.items.length, 1); assert.equal(plan.extraOutputs.length, 1); assert.equal(f.requests.length, 0);
  f.agent.service.bulkMintTerms = async () => ({ v: 1, orderId: q.orderId, terms: { ...q.terms, nonce: 'a'.repeat(64) }, feeManifest: q.feeManifest });
  await assert.rejects(payBulkMint(f.agent, { orderId: q.orderId }), /terms mismatch/);
});

test('bulk pay tool lists the ticker deployer transfer the same approval pays', async t => {
  const f = await setup(t), q = await quoteBulkMint(f.agent, f.args);
  const side = { to: 'bcrt1pdeployerholder', amount: '50000000000000000', dta: `dmw-bulk-deployer-v1|${q.orderId}` };
  f.agent.service.bulkMintStatus = async () => ({ orderId: q.orderId, termsHash: q.quoteId, deployerPayment: side });
  f.agent.service.bulkMintTerms = async () => ({ v: 1, orderId: q.orderId, terms: q.terms, feeManifest: q.feeManifest, deployerPayment: side });
  const plan = await payBulkMint(f.agent, { orderId: q.orderId });
  assert.equal(plan.items.length, 2); assert.deepEqual(plan.items[1], { address: side.to, tick: 'tap', amt: '0.05', dta: side.dta });
  f.agent.service.bulkMintStatus = async () => ({ orderId: q.orderId, termsHash: q.quoteId, deployerPayment: { ...side, amount: '1' } });
  await assert.rejects(payBulkMint(f.agent, { orderId: q.orderId }), /deployer payment mismatch/);
});

test('bulk no-member quotes retain reasons and cannot be submitted; zero-payable quotes are rejected', async t => {
  const f = await setup(t);
  f.agent.service.bulkMintQuote = async () => ({ v: 1, orderId: null, quoteId: null, terms: null, feeManifest: [],
    skipped: [{ block: '900000', reason: 'already_minted' }], deferred: [], payable: false });
  const q = await quoteBulkMint(f.agent, f.args); assert.equal(q.skipped[0].reason, 'already_minted');
  await assert.rejects(makeBulkMint(f.agent, f.submit(q)), /Saved bulk quote required/); assert.equal(f.requests.length, 0);
  const g = await setup(t); g.agent.service.bulkMintQuote = async input => { const q = quote(input); q.terms.groups = []; q.terms.payableFeeAtoms = '0'; q.quoteId = hashObject(q.terms); return q; };
  await assert.rejects(quoteBulkMint(g.agent, g.args), /bulk_groups/);
});

test('bulk tool outputs preserve hex owner keys and quote commitments without presentation rewriting', async t => {
  const { gameTools } = await import('../lib/tools.mjs');
  const f = await setup(t), q = await quoteBulkMint(f.agent, f.args);
  const tools = gameTools({ agent: { ...f.agent, quoteBulkMint: async () => q } });
  const value = await tools.quote_bulk_mint.run(f.args);
  assert.equal(value.terms.owner, f.agent.owner); assert.equal(hashObject(value.terms), value.quoteId);
});
