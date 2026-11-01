import { Address, NETWORK, TEST_NETWORK } from '@scure/btc-signer';
import { assert, exactKeys, hex, hash, hashObject, stableJSON, utf8, integer, networkId } from './core.js';
import { merkleRoot } from './merkle.js';
import { tapAtoms, formatTapAmount, TAP_UNIT } from './fees.js';
import { tapBurnAddress } from './tap-burn.js';
import { validateChosenTicker } from './ticker-grammar.js';
import { patternCatalogId } from './public-claims.js';
import { settingsRevision, settingsSuccessor } from './settings-v2.js';

// These limits apply exclusively to the additive bulk-v1 protocol.
export const BULK_LIMITS = Object.freeze({ members: 64, groups: 131, feeShares: 320, custody: 192,
  terminalPage: 64, permitPage: 16, revealMembers: 16, revealBatches: 4,
  quoteInputBytes: 16384, termsBytes: 49152, feeManifestBytes: 98304, quoteBytes: 196608,
  requestBytes: 196608, permitBytes: 196608, transitionBytes: 65536, operationBytes: 65536,
  evidenceBytes: 262144, redeemBytes: 65536, mintPayloadBytes: 2048, revealWeight: 100000,
  memberWork: 2048, groupWork: 4096, sourcePageRows: 500, sourcePages: 4,
  sourcePageBytes: 2000000, rawTransactionBytes: 400000, transactionConcurrency: 4,
  transactionCache: 128, transactionCacheBytes: 16777216, fundingInputs: 1,
  postageSats: 546, changeDustSats: 546, setAsideSats: 100000, maxFeeSats: 90000 });
export const BULK_CAPACITY_VALUES = Object.freeze({ mintOperationBudget: 128, batchBytes: 120000 });
// Prepare an ordinary amendment at the operator's selected release batch and
// current Bitcoin window. No parser/operation is gated on this amendment.
export function bulkCapacitySuccessor(previous, { effectiveBatch, effectiveBitcoinWindow }) {
  return settingsSuccessor(previous, settingsRevision({ network: previous.network, previous, effectiveBatch,
    effectiveBitcoinWindow, values: { ...previous.values, ...BULK_CAPACITY_VALUES } }));
}
export const bulkUint = x => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x);
export const bulkInscription = x => typeof x === 'string' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(x);
const positive = x => bulkUint(x) && x !== '0';
const unit = x => positive(x) && BigInt(x) <= 18446744073709551615n;
const same = (a, b) => stableJSON(a) === stableJSON(b);
export function bulkBytes(value, limit, reason = 'bulk_byte_limit') {
  assert(utf8(stableJSON(value)).length <= limit, reason); return value;
}
export function bulkAddress(address, network) {
  assert(['mainnet', 'regtest'].includes(network) && typeof address === 'string' && address.length <= 128, 'bulk_address');
  Address(network === 'mainnet' ? NETWORK : { ...TEST_NETWORK, bech32: 'bcrt' }).decode(address);
  return address;
}
export function bulkOrderId(network, owner, nonce) {
  networkId(network); assert(hex(owner, 32) && hex(nonce, 32), 'bulk_identity');
  return hashObject(['dmw-bulk-order-v1', network, owner, nonce]);
}
export function bulkMemberId(orderId, index) {
  assert(hex(orderId, 32) && integer(index, BULK_LIMITS.members - 1), 'bulk_member');
  return hashObject(['dmw-bulk-member-id-v1', orderId, index]);
}
export const bulkMembersRoot = members => merkleRoot(members.map((m, i) => stableJSON(['dmw-bulk-member-v1', i, m.block, m.amount])));
export const bulkFeeRoot = manifest => merkleRoot(manifest.map(m => stableJSON(['dmw-bulk-fee-v1', m])));
export const bulkPaymentData = (orderId, index) => `dmw-bulk-pay-v1|${orderId}|${index}`;
export const bulkReceiptKey = (bitcoinNetwork, reference) => hashObject(['dmw-bulk-receipt-key-v1', bitcoinNetwork, reference]);
export const bulkCustodyFeeKey = (orderId, row) => hashObject(['dmw-bulk-custody-fee-v1', orderId, row]);
export const bulkAllMask = count => (1n << BigInt(count)) - 1n;
export function bulkIndices(rows, count, objects = false) {
  assert(Array.isArray(rows) && rows.length > 0 && rows.length <= BULK_LIMITS.terminalPage, 'bulk_member_page');
  let last = -1;
  return rows.map(row => {
    const i = objects ? row?.index : row;
    assert(integer(i, count - 1) && i > last && (!objects || exactKeys(row, ['index', 'inscription']) && bulkInscription(row.inscription)), 'bulk_member_page');
    last = i; return i;
  });
}
export function validateBulkQuoteInput(input) {
  bulkBytes(input, BULK_LIMITS.quoteInputBytes);
  assert(exactKeys(input, ['v', 'owner', 'nonce', 'asset', 'deployment', 'receiver', 'payer', 'blocks']) && input.v === 1 &&
    hex(input.owner, 32) && hex(input.nonce, 32) && patternCatalogId(input.asset) !== null && bulkInscription(input.deployment) &&
    typeof input.receiver === 'string' && typeof input.payer === 'string' && Array.isArray(input.blocks) && input.blocks.length > 0 &&
    input.blocks.length <= BULK_LIMITS.members && input.blocks.every(bulkUint) && new Set(input.blocks).size === input.blocks.length, 'bulk_quote_input');
  return input;
}
function validateFeeQuote(q, t) {
  assert(exactKeys(q, ['network', 'scope', 'revision', 'baseFee', 'unit', 'feeSettings', 'settingsHash', 'issuedAt', 'expiresAt',
    'validFrom', 'validUntil', 'deploymentId', 'mintOwnershipHash', 'signature']) && q.network === t.network &&
    q.scope === stableJSON(['mint-bulk-v1', t.asset, t.deployment, t.membersRoot]) && hex(q.revision, 32) &&
    same(q.unit, TAP_UNIT) && q.settingsHash === t.settingsHash && integer(q.issuedAt) && integer(q.expiresAt) &&
    q.expiresAt > q.issuedAt && q.expiresAt - q.issuedAt <= 300000 && bulkUint(q.validFrom) && bulkUint(q.validUntil) &&
    BigInt(q.validUntil) >= BigInt(q.validFrom) && BigInt(q.validUntil) - BigInt(q.validFrom) <= 2016n &&
    q.deploymentId === t.deployment && hex(q.mintOwnershipHash, 32) && hex(q.signature, 64), 'bulk_fee_quote');
  tapAtoms(q.baseFee);
  const f = q.feeSettings;
  assert(exactKeys(f, ['tierMultipliers', 'compoundMinimum', 'link']) && Array.isArray(f.tierMultipliers) && f.tierMultipliers.length === 5 &&
    f.tierMultipliers.every(n => integer(n) && n > 0) && integer(f.compoundMinimum) && f.compoundMinimum > 0 && integer(f.link), 'bulk_fee_settings');
}
export function validateBulkTerms(t) {
  bulkBytes(t, BULK_LIMITS.termsBytes);
  assert(exactKeys(t, ['v', 'network', 'bitcoinNetwork', 'owner', 'nonce', 'asset', 'deployment', 'generation', 'ticker', 'supplyScope',
    'receiver', 'payer', 'members', 'membersRoot', 'feeRoot', 'groups', 'custody', 'totalAmount', 'grossFeeAtoms', 'payableFeeAtoms',
    'settingsHash', 'feeQuote', 'until', 'expires', 'mintFunding', 'terminalPolicy']) && t.v === 1, 'bulk_terms');
  const orderId = bulkOrderId(t.network, t.owner, t.nonce);
  assert(patternCatalogId(t.asset) !== null && bulkInscription(t.deployment) && hex(t.generation, 32) &&
    (t.supplyScope === null || t.supplyScope === t.deployment) && validateChosenTicker(t.ticker) === t.ticker &&
    hex(t.membersRoot, 32) && hex(t.feeRoot, 32) && hex(t.settingsHash, 32) &&
    bulkUint(t.until) && bulkUint(t.expires) && BigInt(t.expires) > BigInt(t.until) &&
    t.terminalPolicy === 'hold-issued-credit-unissued-v1', 'bulk_terms');
  bulkAddress(t.receiver, t.bitcoinNetwork); bulkAddress(t.payer, t.bitcoinNetwork);
  assert(Array.isArray(t.members) && t.members.length > 0 && t.members.length <= BULK_LIMITS.members, 'bulk_members');
  let last = -1n, total = 0n;
  for (const m of t.members) {
    assert(exactKeys(m, ['block', 'amount']) && bulkUint(m.block) && BigInt(m.block) > last && unit(m.amount), 'bulk_members');
    last = BigInt(m.block); total += BigInt(m.amount);
  }
  assert(unit(t.totalAmount) && total.toString() === t.totalAmount && bulkMembersRoot(t.members) === t.membersRoot, 'bulk_members_root');
  assert(Array.isArray(t.groups) && t.groups.length > 0 && t.groups.length <= Math.min(BULK_LIMITS.groups, 2 * t.members.length + 3), 'bulk_groups');
  let prior = null, payable = 0n;
  for (const g of t.groups) {
    assert(exactKeys(g, ['to', 'ticker', 'tt', 'amount']) && g.ticker === 'tap' && g.tt === 'a' && tapAtoms(g.amount) > 0n, 'bulk_group');
    bulkAddress(g.to, t.bitcoinNetwork);
    const key = utf8(stableJSON([g.ticker, g.tt, g.to]));
    assert(prior === null || compareBytes(prior, key) < 0, 'bulk_group_order'); prior = key; payable += BigInt(g.amount);
  }
  assert(tapAtoms(t.payableFeeAtoms) === payable && tapAtoms(t.grossFeeAtoms) >= payable, 'bulk_totals');
  assert(Array.isArray(t.custody) && t.custody.length <= BULK_LIMITS.custody, 'bulk_custody');
  let previous = -1;
  for (const c of t.custody) {
    const role = ['finder', 'landowner', 'discoverer'].indexOf(c.role), key = c.member * 5 + role;
    assert(exactKeys(c, ['member', 'role', 'group', 'owner', 'amount']) && integer(c.member, t.members.length - 1) && role >= 0 &&
      key > previous && integer(c.group, t.groups.length - 1) && hex(c.owner, 32) && tapAtoms(c.amount) > 0n, 'bulk_custody'); previous = key;
  }
  validateFeeQuote(t.feeQuote, t);
  const f = t.mintFunding;
  assert(exactKeys(f, ['address', 'satoshis', 'feeRate', 'feeRateCeiling', 'maxFeeSats', 'postageSats', 'returnReserveSats', 'label']) &&
    integer(f.satoshis, BULK_LIMITS.setAsideSats) && Number.isFinite(f.feeRate) && f.feeRate > 0 && f.feeRate <= 1000 &&
    integer(f.feeRateCeiling, 1000) && f.feeRateCeiling >= f.feeRate && bulkUint(f.maxFeeSats) && BigInt(f.maxFeeSats) <= BigInt(BULK_LIMITS.maxFeeSats) &&
    f.postageSats === 546 && f.returnReserveSats === 6000 && f.label === 'your bulk mint inscriptions' &&
    BigInt(f.satoshis) === BigInt(t.members.length * 546 + 6546) + BigInt(f.maxFeeSats), 'bulk_funding');
  bulkAddress(f.address, t.bitcoinNetwork);
  assert(Address(t.bitcoinNetwork === 'mainnet' ? NETWORK : { ...TEST_NETWORK, bech32: 'bcrt' }).decode(f.address).type === 'tr', 'bulk_funding_address');
  const placeholder = '0'.repeat(64), sig = { r: '9'.repeat(78), s: '9'.repeat(78), v: '1' };
  for (const [index, m] of t.members.entries()) bulkBytes({ p: 'tap', op: 'dmt-mint', tick: t.ticker, blk: m.block, dep: t.deployment,
    dta: `dmw-mint-v1|${t.network}|${bulkMemberId(orderId, index)}|${placeholder}|${placeholder}`,
    prv: { address: t.receiver, salt: placeholder, hash: placeholder, sig } }, BULK_LIMITS.mintPayloadBytes, 'bulk_mint_payload_bytes');
  return t;
}
function compareBytes(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
export function validateBulkFees(t, manifest) {
  validateBulkTerms(t); bulkBytes(manifest, BULK_LIMITS.feeManifestBytes);
  assert(Array.isArray(manifest) && manifest.length === t.members.length && bulkFeeRoot(manifest) === t.feeRoot, 'bulk_fee_manifest');
  const groups = t.groups.map(() => 0n), custody = []; let gross = 0n, net = 0n, shares = 0;
  for (const [index, m] of manifest.entries()) {
    assert(exactKeys(m, ['member', 'grossFeeAtoms', 'shares', 'deferred']) && m.member === index && Array.isArray(m.shares) &&
      exactKeys(m.deferred, ['legacyDeploy', 'deployer']), 'bulk_fee_member');
    const deferred = tapAtoms(m.deferred.legacyDeploy) + tapAtoms(m.deferred.deployer);
    let sum = 0n, last = -1, treasury = 0n;
    for (const s of m.shares) {
      const role = ['finder', 'landowner', 'discoverer', 'treasury', 'burn'].indexOf(s.role);
      assert(exactKeys(s, ['role', 'group', 'beneficiary', 'gross', 'payable']) && role > last && tapAtoms(s.gross) > 0n &&
        tapAtoms(s.payable) <= BigInt(s.gross) && (s.payable === '0' || s.payable === s.gross) &&
        (s.beneficiary === null || role < 3 && hex(s.beneficiary, 32)), 'bulk_fee_share');
      last = role; shares++; sum += BigInt(s.gross); net += BigInt(s.payable);
      if (role === 3) treasury = BigInt(s.gross);
      if (s.payable === '0') assert(s.group === null && s.beneficiary === null && s.role !== 'burn', 'bulk_fee_exemption');
      else {
        assert(integer(s.group, t.groups.length - 1), 'bulk_fee_group'); groups[s.group] += BigInt(s.payable);
        assert(s.role === 'burn' || t.groups[s.group].to !== t.payer, 'bulk_fee_self_payment');
        if (s.role === 'burn') assert(t.groups[s.group].to === tapBurnAddress(t.bitcoinNetwork) && s.beneficiary === null, 'bulk_fee_burn');
        if (s.beneficiary !== null) custody.push({ member: index, role: s.role, group: s.group, owner: s.beneficiary, amount: s.payable });
      }
    }
    assert(sum === tapAtoms(m.grossFeeAtoms) && treasury >= deferred, 'bulk_fee_sum'); gross += sum;
  }
  assert(shares <= BULK_LIMITS.feeShares && gross === tapAtoms(t.grossFeeAtoms) && net === tapAtoms(t.payableFeeAtoms) &&
    groups.every((n, i) => n === BigInt(t.groups[i].amount)) && same(custody, t.custody), 'bulk_fee_conservation');
}
export function bulkReserveAction(t) {
  validateBulkTerms(t);
  return { type: 'reserve-n', id: bulkOrderId(t.network, t.owner, t.nonce), owner: t.owner, asset: t.asset,
    amount: t.totalAmount, terms: hashObject(t), nonce: t.nonce, until: t.until };
}
export function bulkWalletItems(t) {
  validateBulkTerms(t); const id = bulkOrderId(t.network, t.owner, t.nonce);
  return t.groups.map((g, i) => ({ address: g.to, tick: 'tap', amt: formatTapAmount(g.amount), dta: bulkPaymentData(id, i) }));
}
export function bulkPermitPlans(t, receiptRoot) {
  validateBulkTerms(t); assert(hex(receiptRoot, 32), 'bulk_receipt_root');
  const id = bulkOrderId(t.network, t.owner, t.nonce), paymentHash = hashObject(['dmw-bulk-paid-v1', hashObject(t), receiptRoot]);
  const plans = t.members.map((m, index) => {
    const memberId = bulkMemberId(id, index), data = `dmw-mint-v1|${t.network}|${memberId}|${hash(t.deployment)}|${paymentHash}`,
      salt = hash(`dmw-mint-salt-v1|${t.network}|${memberId}`),
      payload = { p: 'tap', op: 'dmt-mint', tick: t.ticker, blk: m.block, dep: t.deployment, dta: data };
    return { memberId, index, payload, digest: hash(['tap', 'dmt-mint', t.ticker, m.block, t.deployment, t.receiver, data, salt].join('-')), address: t.receiver, salt };
  });
  return { paymentHash, permitRoot: merkleRoot(plans.map(p => stableJSON(['dmw-bulk-permit-v1', p.memberId, p.digest]))), plans };
}
