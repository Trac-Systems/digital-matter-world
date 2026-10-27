import test from 'node:test';
import assert from 'node:assert/strict';
import { rules } from '../src/rules.mjs';
import { Mints } from '../src/mints.mjs';
import { expectedEscrowSplit } from '../src/ethereum.mjs';
import { fixture, network } from '../../committee/test/fixture.mjs';
import { committeeAddress, hashSplit, escrowRelease } from '../../committee/signer/escrow.mjs';
import { Payouts } from '../src/payouts.mjs';
import { Store } from '../src/store.mjs';
import { temp, agent } from './helpers.mjs';

const address = n => '0x' + n.repeat(40), baseFee = rules.parseTapAmount('22.600000000000000001');
for (const kind of ['link']) test(`${kind}: both payment routes verify the same decimal TAP fee and split`, () => {
  const who = agent(), request = { owner: who.address, height: 10, nonce: 'ab'.repeat(32), until: 200 };
  const id = rules.linkId(network, request);
  const sig = rules.signLink(network, request, who.secret);
  const total = rules.feeFor(kind, baseFee), split = rules.splitFee(total, { kind });
  for (const route of ['tap', 'ethereum']) {
    const terms = { baseFee, treasury: route === 'tap' ? 'treasury' : address('1'), payer: route === 'tap' ? 'payer' : address('3'),
      hash: 'cd'.repeat(32), chainId: '31337', contract: address('4'), token: address('5') };
    const consumed = kind === 'link';
    const payment = { id, requestId: id, kind: route, payer: terms.payer, total, consumed, confirmations: 1, verifiedHeight: 100, eventIndex: 0,
      ...(consumed ? { settlement: { accepted: true, refund: false, paymentId: id, txid: 'ef'.repeat(32), confirmations: 1 } } : {}),
      ...(route === 'tap' ? { tick: 'tap', lockKind: 'htlc', conditionType: 'hashlock', hash: terms.hash, refund: terms.payer, claim: terms.treasury,
        base: split.treasury, allocations: rules.tapPaymentAllocations(split, {}, kind), refundAfter: 400 } : {
        chainId: terms.chainId, contract: terms.contract, token: terms.token, status: consumed ? 2 : 1, timestamp: '1000', expiry: '99999',
        split: expectedEscrowSplit(split, terms) }) };
    assert.equal(rules.verifyLinkInput({ request, sig, terms, payment }, network, 100, kind).id, id);
    assert.throws(() => rules.verifyLinkInput({ request, sig, terms, payment: { ...payment, total: (BigInt(total) + 1n).toString() } }, network, 100, kind), /link_price/);
  }
});
for (const type of ['dmt', 'compound']) for (let tier = 1; tier <= 5; tier++) test(`${type} tier ${tier}: gateway and independent signer price both routes identically`, async () => {
  const outcomes = [];
  for (const kind of ['tap', 'ethereum']) {
    const f = fixture(type, undefined, baseFee), context = f.data.context;
    context.tier = tier;
    if (kind === 'ethereum') {
      context.treasury = address('1'); context.finderAddress = context.firstMakerAddress = address('2'); f.data.payer = address('3');
    }
    const mints = new Mints({ network, reads: f.reads, inscriber: { quote: async () => '250' }, payments: { ethereumDomainMatches: () => true } });
    const quote = await mints.quote({ asset: f.proposal.request.asset, block: f.proposal.request.block, kind });
    assert.deepEqual(quote.unit, rules.TAP_UNIT); assert.deepEqual(quote.feeQuote.unit, rules.TAP_UNIT);
    f.data.payment.kind=kind;f.data.payment.payer=f.data.payer;f.reprice();
    const approval=await f.policy.mint(f.proposal);
    assert.equal(approval.details.price,quote.price);
    assert.equal(f.data.payment.fees.reduce((n,f)=>n+BigInt(f.amount),0n).toString(),quote.price);
    outcomes.push({price:quote.price,split:quote.split});
    f.data.payment.receipts[0].amount=(BigInt(f.data.payment.receipts[0].amount)-1n).toString();
    await assert.rejects(f.policy.mint(f.proposal),/payment_incomplete/);
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test('payout accruals, partial payments and published balances retain atomic TAP without rounding', async () => {
  const store = await Store.open(await temp('tap-payout-')), published = new Map();
  try {
    const payouts = new Payouts({ store, files: { json: async (path, body) => published.set(path, body) } });
    const split = rules.splitFee(rules.feeFor('find', baseFee, 3), { discovered: true, linked: true });
    const commissions = rules.commissionOwed('mint', split, { discoverer: 'beneficiary', landowner: 'beneficiary' }, 'ethereum');
    const accrued = commissions.reduce((sum, c) => sum + BigInt(c.amount), 0n);
    await store.transact(payouts.accruals({ proposal: { batch: { n: 1 } }, items: [{ output: { file: { observation: 1, commissions } } }] }));
    await payouts.record({ beneficiary: 'beneficiary', amount: '1', txid: 'ab'.repeat(32), reference: 'one-atom' });
    const page = published.get('records/payouts/beneficiaries/0.json');
    assert.deepEqual(page.unit, rules.TAP_UNIT); assert.deepEqual(published.get('records/payouts/index.json').unit, rules.TAP_UNIT);
    assert.equal(page.rows[0].accrued, accrued.toString()); assert.equal(page.rows[0].owed, (accrued - 1n).toString());
    assert.equal(published.get('records/payouts/paid/0.json').rows[0].amount, '1');
  } finally { await store.close(); }
});
