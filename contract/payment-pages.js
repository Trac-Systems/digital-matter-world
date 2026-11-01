import { ed25519 } from '@noble/curves/ed25519';
import { canonicalJSON, sha256, utf8ToBytes, bytesToHex, jsonBytes } from './signing.js';
import { accountKey, EMPTY_ACCOUNT_ROOT, verifyAccountProof } from './account-tree.js';
import { assetSettings } from './asset-settings.js';
import { reserveFinancialCapacity, releaseFinancialCapacity } from './financial-capacity.js';
import { applyFinancialLifecycle, financialUnfrozen } from './financial-lifecycle.js';
import { ordinalCodec } from '../rules/src/integers-v2.js';
import { applyPublicScan } from './public-mint.js';
import { applyPublicPayment } from './public-payment.js';
import { applyBulkPayment } from './bulk-mint.js';

const check = (ok, reason) => { if (!ok) throw Error(reason); };
const hash = value => bytesToHex(sha256(utf8ToBytes(canonicalJSON(value))));
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const positive = value => uint(value) && value !== '0';
export const EMPTY_ALLOCATION_ROOT = hash(['dmw-allocation-pages-v2']);
export const surplusCreditId = (id, sequence) => hash(['dmw-surplus-credit-v2', id, sequence]);
export const paymentCreditDigest = (network, action) => {
  const { sig, ...body } = action;
  return sha256(utf8ToBytes('dmw-payment-credit-v2|' + network + '|' + canonicalJSON(body)));
};

// The containing batch authenticates the independent chain checks. Payment
// usage is a sparse authenticated set, so a request can fund an arbitrary
// number of bounded pages without retaining a growing allocation array.
export async function applyPaymentPage(store, op, { network, height, executionHeight = height, settings = {}, capture = null }) {
  const limits = assetSettings(settings), clock = ordinalCodec(typeof height === 'string');
  check(op?.op === 'fp' && op.v === 2 && hex(op.id) && jsonBytes(op) <= limits.proofBytes, 'funding_operation');
  if (op.type?.startsWith('bulk-')) return applyBulkPayment(store, op, { network, height, executionHeight, settings });
  if (op.type === 'public-scan') return applyPublicScan(store, op, { network, height, settings: limits });
  if (op.type === 'public-payment') return applyPublicPayment(store, op, { network, height, settings: limits });
  if (op.type === 'lifecycle') return applyFinancialLifecycle(store, op, { network, height, executionHeight, limits });
  await financialUnfrozen(store, ['fp/' + op.id, 'fp/usage', ...(op.credit ? ['fc/' + op.credit] : [])]);
  const key = 'fp/' + op.id, old = await store.get(key), writes = [];
  if (op.type === 'checkpoint') {
    const prior = await store.get('fp/chain'), anchor = op.anchor;
    check(op.previous === hash(prior ?? null) && anchor && uint(anchor.bitcoin?.height) && hex(anchor.bitcoin.hash) &&
      (anchor.ethereum === null || uint(anchor.ethereum?.height) && positive(anchor.ethereum.chainId) && /^0x[0-9a-f]{64}$/.test(anchor.ethereum.hash)) &&
      (!prior?.bitcoin || BigInt(anchor.bitcoin.height) >= BigInt(prior.bitcoin.height)) &&
      (!prior?.ethereum || anchor.ethereum && anchor.ethereum.chainId === prior.ethereum.chainId && BigInt(anchor.ethereum.height) >= BigInt(prior.ethereum.height)), 'financial_chain_checkpoint');
    writes.push(['fp/chain', anchor]);
  } else if (op.type === 'open') {
    check(!old && hex(op.owner) && hex(op.terms) && Array.isArray(op.fees) && op.fees.length > 0 && op.fees.length <= limits.paymentPage &&
      op.fees.every(f => hex(f.key) && positive(f.amount)) && new Set(op.fees.map(f => f.key)).size === op.fees.length, 'funding_terms');
    if (op.capacity) writes.push(...await reserveFinancialCapacity(store, op.id, op.capacity, executionHeight));
    writes.push([key, { owner: op.owner, terms: op.terms, fees: op.fees, paid: op.fees.map(() => '0'), sequence: '0', root: EMPTY_ALLOCATION_ROOT, state: 'open', ...(op.capacity ? { capacity: op.capacity } : {}) }]);
  } else if (op.type === 'page' || op.type === 'surplus') {
    const surplus = op.type === 'surplus';
    check(old && (old.state === 'open' || surplus && ['consumed', 'credited', 'refunded'].includes(old.state)) &&
      op.sequence === old.sequence && op.previous === old.root, 'funding_sequence');
    check(Array.isArray(op.items) && op.items.length > 0 && op.items.length <= limits.paymentPage && new Set(op.items.map(p => p.key)).size === op.items.length, 'funding_page');
    const usage = await store.get('fp/usage') ?? { root: EMPTY_ACCOUNT_ROOT, revision: '0' };
    check(op.revision === usage.revision, 'funding_revision');
    const leaves = new Map(op.proof.leaves.map(l => [l.key, l.value])), changes = new Map(), paid = [...old.paid];
    // Each surplus page gets its own stable identity. A previous credit may
    // already have been transferred or spent; that cannot strand later money.
    const creditId = surplus ? surplusCreditId(op.id, old.sequence) : null;
    if (surplus) check(!await store.get('fc/' + creditId), 'surplus_credit_exists');
    const fees = surplus ? old.fees.map(f => ({ key: f.key, amount: '0' })) : null;
    for (const item of op.items) {
      check(hex(item.key) && positive(item.amount) && positive(item.total) && hex(item.fee), 'funding_item');
      const index = old.fees.findIndex(f => f.key === item.fee); check(index >= 0, 'funding_fee');
      const receiptKey = accountKey('payment', item.key); check(leaves.has(receiptKey), 'funding_proof');
      const prior = leaves.get(receiptKey);
      check(!prior || prior.total === item.total && uint(prior.used) && BigInt(prior.used) <= BigInt(prior.total), 'funding_total');
      const used = BigInt(prior?.used ?? '0') + BigInt(item.amount), amount = BigInt(paid[index]) + BigInt(item.amount);
      check(used <= BigInt(item.total) && (surplus || amount <= BigInt(old.fees[index].amount)), 'funding_reused');
      changes.set(receiptKey, { total: item.total, used: used.toString() });
      if (surplus) fees[index].amount = (BigInt(fees[index].amount) + BigInt(item.amount)).toString();
      else paid[index] = amount.toString();
    }
    const root = verifyAccountProof(usage.root, op.proof, changes, limits);
    writes.push(['fp/usage', { root, revision: (BigInt(usage.revision) + 1n).toString() }],
      [key, { ...old, paid, sequence: (BigInt(old.sequence) + 1n).toString(), root: hash([surplus ? 'dmw-surplus-page-v2' : 'dmw-allocation-page-v2', op.id, old.root, old.sequence, op.items]) }]);
    if (surplus) writes.push(['fc/' + creditId, { owner: old.owner, fees, revision: '0' }]);
    if (capture) capture(usage.root, op.proof, changes);
  } else if (op.type === 'consume') {
    check(old?.state === 'open' && old.fees.every((f, i) => f.amount === old.paid[i]) && hex(op.permitHash) && op.root === old.root, 'funding_incomplete');
    writes.push([key, { ...old, state: 'consumed', permitHash: op.permitHash, consumedRoot: old.root }]);
  } else if (op.type === 'credit') {
    check(old?.state === 'open' && hex(op.evidence) && op.root === old.root, 'funding_exit');
    // Exactly the amounts reserved by these pages become transferable fee
    // credits. Never mint a credit for missing/unverified payment evidence.
    const credit = await store.get('fc/' + op.id);
    check(!credit, 'funding_credit_exists');
    writes.push(...await releaseFinancialCapacity(store, op.id, old.capacity));
    writes.push([key, { ...old, state: 'credited', evidence: op.evidence, terminalRoot: old.root }], ['fc/' + op.id, {
      owner: old.owner, revision: '0', fees: old.fees.map((f, i) => ({ key: f.key, amount: old.paid[i] })),
    }]);
  } else if (op.type === 'refund') {
    // An escrow refund returns external money. It must never also issue a
    // reusable fee credit. Settled allocations cannot be externally refunded.
    check(old?.state === 'open' && old.paid.every(n => n === '0') && hex(op.evidence) && op.root === old.root, 'funding_refund');
    writes.push(...await releaseFinancialCapacity(store, op.id, old.capacity));
    writes.push([key, { ...old, state: 'refunded', evidence: op.evidence, terminalRoot: old.root }]);
  } else if (op.type === 'transfer' || op.type === 'use') {
    const creditKey = 'fc/' + op.credit, credit = await store.get(creditKey);
    check(hex(op.credit) && credit && op.revision === credit.revision && clock.valid(op.until) && clock.compare(height, op.until) <= 0 &&
      typeof op.sig === 'string' && /^[0-9a-f]{128}$/.test(op.sig) && ed25519.verify(op.sig, paymentCreditDigest(network, op), credit.owner, { zip215: false }), 'credit_signature');
    const revision = (BigInt(credit.revision) + 1n).toString();
    if (op.type === 'transfer') {
      check(op.id === op.credit && hex(op.to), 'credit_owner');
      writes.push([creditKey, { ...credit, owner: op.to, revision }]);
    } else {
      check(old?.state === 'open' && old.owner === credit.owner && Array.isArray(op.items) && op.items.length > 0 && op.items.length <= limits.paymentPage &&
        new Set(op.items.map(i => i.fee)).size === op.items.length, 'credit_request');
      const fees = credit.fees.map(f => ({ ...f })), paid = [...old.paid];
      for (const item of op.items) {
        const source = fees.find(f => f.key === item.fee), index = old.fees.findIndex(f => f.key === item.fee);
        check(source && index >= 0 && positive(item.amount) && BigInt(source.amount) >= BigInt(item.amount), 'credit_amount');
        source.amount = (BigInt(source.amount) - BigInt(item.amount)).toString();
        paid[index] = (BigInt(paid[index]) + BigInt(item.amount)).toString(); check(BigInt(paid[index]) <= BigInt(old.fees[index].amount), 'credit_excess');
      }
      writes.push([creditKey, { ...credit, fees, revision }], [key, { ...old, paid, sequence: (BigInt(old.sequence) + 1n).toString(),
        root: hash(['dmw-credit-page-v2', op.id, old.root, old.sequence, op.credit, op.revision, op.items]) }]);
    }
  } else throw Error('funding_type');
  for (const [k, value] of writes) store.put(k, value);
}
