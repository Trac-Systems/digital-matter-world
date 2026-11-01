import { assert, exactKeys, hex, hashObject, stableJSON } from '../rules/src/core.js';
import { BULK_LIMITS, validateBulkTerms, bulkBytes, bulkOrderId, bulkMemberId, bulkPermitPlans, bulkIndices,
  bulkAllMask, bulkRecoveryFees, bulkReceiptKey, bulkCustodyFeeKey, bulkUint, bulkInscription } from '../rules/src/bulk-mint.js';
import { tickerSupplyScope, capacityPlotKey, mintRetainsUnits } from '../rules/src/per-ticker-supply-activation.js';
import { capacityKey, plotKey } from './financial-capacity.js';
import { financialUnfrozen, custodyId } from './financial-lifecycle.js';

const same = (a, b) => stableJSON(a) === stableJSON(b);
const amount = value => { assert(bulkUint(value), 'bulk_capacity_amount'); return BigInt(value); };
const bit = i => 1n << BigInt(i);
const inscription = value => assert(bulkInscription(value), 'bulk_inscription');

// Only called by the existing quorum-authenticated fp envelope. Stage all
// effects and check every touched quarantine key before the first write.
export async function applyBulkPayment(store, op, { network, height, executionHeight = height, settings = {} }) {
  bulkBytes(op, BULK_LIMITS.operationBytes);
  assert(op?.op === 'fp' && op.v === 2 && hex(op.id, 32) && hex(op.evidence, 32) && bulkUint(height) && bulkUint(executionHeight), 'bulk_operation');
  const writes = new Map(), touched = new Set(['fp/' + op.id, 'ao/' + op.id]);
  const get = async key => { touched.add(key); return writes.has(key) ? writes.get(key) : await store.get(key); };
  const put = (key, value) => { touched.add(key); writes.set(key, value); };
  const exact = fields => assert(exactKeys(op, ['op', 'v', 'type', 'id', 'evidence', ...fields]), 'bulk_operation_fields');
  const old = await get('fp/' + op.id), obligation = await get('ao/' + op.id);
  let t;
  if (op.type === 'bulk-open') {
    exact(['terms', 'capacity']); t = validateBulkTerms(op.terms);
    assert(t.network === network && op.id === bulkOrderId(network, t.owner, t.nonce) && !old &&
      obligation?.state === 'reserved' && obligation.owner === t.owner && obligation.asset === t.asset &&
      obligation.amount === t.totalAmount && obligation.terms === hashObject(t) && BigInt(height) <= BigInt(t.until) &&
      BigInt(t.expires) - BigInt(height) >= BigInt(settings.requestMinBlocks ?? 6) &&
      BigInt(t.expires) - BigInt(height) <= BigInt(settings.requestMaxBlocks ?? 2016), 'bulk_obligation');
    assert(exactKeys(op.capacity, ['remaining', 'limit']) && bulkUint(op.capacity.remaining) && bulkUint(op.capacity.limit), 'bulk_capacity');
    const d = await get('fd/' + t.generation), current = await get('fd/asset/' + t.asset);
    assert(d && d.asset === t.asset && d.deployment === t.deployment && await get('fd/external/' + hashObject(t.deployment)) === t.generation &&
      (current === t.generation || hex(d.official, 32) && (await get('fd/' + d.official))?.asset === t.asset) &&
      tickerSupplyScope(d, executionHeight) === t.supplyScope, 'bulk_deployment');
    const externalKey = capacityKey(t.deployment), external = amount(await get(externalKey) ?? '0'), imported = amount(await get('fi/deployment/' + t.deployment) ?? '0');
    const total = amount(t.totalAmount), reserved = amount(d.reserved), minted = amount(d.minted);
    assert(reserved + minted + total <= amount(d.maximum) && external + imported + total <= amount(op.capacity.remaining), 'bulk_capacity_exhausted');
    for (const [i, m] of t.members.entries()) {
      const id = bulkMemberId(op.id, i), internalPlot = capacityPlotKey(t.asset, m.block, t.supplyScope), externalPlot = plotKey(t.asset, m.block, t.supplyScope);
      assert((d.limit === '0' || amount(m.amount) <= amount(d.limit)) &&
        (op.capacity.limit === '0' || amount(m.amount) <= amount(op.capacity.limit)), 'bulk_member_limit');
      assert(!await get('dc/' + id) && !await get(internalPlot) && !await get(externalPlot) &&
        (t.supplyScope || !await get('fi/plot/' + t.asset + '/' + m.block)), 'bulk_member_conflict');
      put('dc/' + id, { state: 'reserved', deployment: t.generation, asset: t.asset, amount: m.amount, plot: m.block,
        terms: obligation.terms, bulk: op.id, index: i, ...(t.supplyScope ? { supplyScope: t.supplyScope } : {}) });
      put(internalPlot, id); put(externalPlot, { id, state: 'reserved' });
    }
    put(externalKey, (external + total).toString()); put('fd/' + t.generation, { ...d, reserved: (reserved + total).toString() });
    put('fp/' + op.id, { kind: 'bulk-v1', state: 'bulk-open', owner: t.owner, created: height, terms: obligation.terms, manifest: t,
      paid: t.groups.map(() => '0'), reference: null, receiptRoot: null, permitRoot: null, issuedMask: '0', finishedMask: '0', releasedMask: '0' });
  } else {
    assert(old?.kind === 'bulk-v1', 'bulk_funding_missing'); t = validateBulkTerms(old.manifest);
    assert(t.network === network && old.owner === t.owner && op.id === bulkOrderId(network, t.owner, t.nonce) && op.terms === old.terms && old.terms === hashObject(t) &&
      obligation?.terms === old.terms && obligation.owner === t.owner && obligation.asset === t.asset && obligation.amount === t.totalAmount, 'bulk_terms_binding');
    const all = bulkAllMask(t.members.length);
    for (const field of ['issuedMask', 'finishedMask', 'releasedMask']) assert(bulkUint(old[field]) && BigInt(old[field]) <= all, 'bulk_mask');
    const issued = BigInt(old.issuedMask), finished = BigInt(old.finishedMask), released = BigInt(old.releasedMask);
    assert((issued === 0n || issued === all) && (finished & issued) === finished && !(released & issued), 'bulk_mask');
    const credit = async (reference, receiptRoot, paid) => {
      const receiptKey = bulkReceiptKey(t.bitcoinNetwork, reference), key = 'fp/bulk-credit/' + receiptKey;
      assert(!await get(key) && same(await get('fp/bulk-receipt/' + receiptKey), { orderId: op.id, receiptRoot }), 'bulk_credit_receipt');
      const fees = op.feeManifest ? bulkRecoveryFees(t, op.feeManifest, paid) : null;
      if (fees?.length) {
        assert(!await get('fc/' + receiptKey), 'bulk_credit_exists');
        put('fc/' + receiptKey, { owner: t.owner, fees, revision: '0' });
      }
      put(key, { orderId: op.id, owner: t.owner, payer: t.payer, reference, receiptRoot, state: fees ? 'credited' : 'owed',
        ...(fees?.length ? { creditId: receiptKey } : {}),
        groups: t.groups.flatMap((g, index) => paid[index] === '0' ? [] : [{ index, to: g.to, ticker: g.ticker, amount: paid[index] }]), feeRoot: t.feeRoot });
    };
    if (op.type === 'bulk-fund' || op.type === 'bulk-credit') {
      exact(['terms', 'reference', 'block', 'paid', 'receiptRoot', ...(op.type === 'bulk-credit' && op.feeManifest ? ['feeManifest'] : [])]); inscription(op.reference);
      assert(exactKeys(op.block, ['height', 'hash']) && bulkUint(op.block.height) && hex(op.block.hash, 32) &&
        BigInt(op.block.height) <= BigInt(executionHeight) && hex(op.receiptRoot, 32) &&
        Array.isArray(op.paid) && op.paid.length === t.groups.length &&
        op.paid.every((n, i) => n === '0' || n === t.groups[i].amount), 'bulk_payment');
      const receiptKey = 'fp/bulk-receipt/' + bulkReceiptKey(t.bitcoinNetwork, op.reference);
      assert(!await get(receiptKey), 'bulk_receipt_reused');
      put(receiptKey, { orderId: op.id, receiptRoot: op.receiptRoot });
      if (op.type === 'bulk-fund') {
        assert(old.state === 'bulk-open' && obligation.state === 'reserved' && old.reference === null && released === 0n && issued === 0n &&
          BigInt(op.block.height) >= BigInt(old.created) && BigInt(op.block.height) <= BigInt(t.expires), 'bulk_funding_window');
        const full = op.paid.every((n, i) => n === t.groups[i].amount);
        put('fp/' + op.id, { ...old, state: full ? 'bulk-funded' : 'bulk-open', paid: op.paid,
          reference: op.reference, receiptRoot: op.receiptRoot });
      } else await credit(op.reference, op.receiptRoot, op.paid);
    } else if (op.type === 'bulk-consume') {
      exact(['terms', 'receiptRoot', 'permitRoot']);
      assert(old.state === 'bulk-funded' && obligation.state === 'reserved' && issued === 0n && released === 0n &&
        BigInt(height) <= BigInt(t.expires) && BigInt(executionHeight) <= BigInt(t.expires) && old.paid.every((n, i) => n === t.groups[i].amount) &&
        old.receiptRoot === op.receiptRoot && same(await get('fp/bulk-receipt/' + bulkReceiptKey(t.bitcoinNetwork, old.reference)),
          { orderId: op.id, receiptRoot: op.receiptRoot }), 'bulk_funding_incomplete');
      const plans = bulkPermitPlans(t, op.receiptRoot);
      assert(op.permitRoot === plans.permitRoot, 'bulk_permit_root');
      for (const p of plans.plans) {
        const m = t.members[p.index], row = await get('dc/' + p.memberId);
        assert(row?.state === 'reserved' && row.bulk === op.id && row.index === p.index && row.terms === old.terms &&
          row.deployment === t.generation && row.asset === t.asset && row.amount === m.amount && row.plot === m.block &&
          await get(capacityPlotKey(t.asset, m.block, t.supplyScope)) === p.memberId &&
          same(await get(plotKey(t.asset, m.block, t.supplyScope)), { id: p.memberId, state: 'reserved' }), 'bulk_member_binding');
        put('dc/' + p.memberId, { ...row, state: 'issued', permitHash: p.digest });
      }
      for (const c of t.custody) {
        const fee = bulkCustodyFeeKey(op.id, c), key = 'bc/' + custodyId(op.id, fee);
        assert(!await get(key), 'bulk_custody_exists');
        put(key, { request: op.id, fee, owner: c.owner, rail: 'tap', custodian: t.groups[c.group].to,
          amount: c.amount, state: 'claimable', revision: '0', evidence: op.evidence });
      }
      put('fp/' + op.id, { ...old, state: 'bulk-consumed', permitRoot: op.permitRoot, issuedMask: all.toString() });
    } else if (op.type === 'bulk-finish' || op.type === 'bulk-release') {
      const finish = op.type === 'bulk-finish'; exact(['terms', 'members', ...(finish ? [] : ['reason', ...(op.feeManifest ? ['feeManifest'] : [])])]);
      const indices = bulkIndices(op.members, t.members.length, finish);
      if (finish) assert(['bulk-consumed', 'bulk-complete'].includes(old.state) && obligation.state === 'bulk-issued' && issued === all &&
        new Set(op.members.map(m => m.inscription)).size === op.members.length, 'bulk_finish_state');
      else assert(op.reason === 'expired' && ['bulk-open', 'bulk-funded', 'bulk-releasing'].includes(old.state) && obligation.state === 'reserved' &&
        issued === 0n && finished === 0n && BigInt(height) > BigInt(t.expires) && BigInt(executionHeight) > BigInt(t.expires), 'bulk_release_state');
      let mask = finish ? finished : released, total = 0n;
      const d = await get('fd/' + t.generation), externalKey = capacityKey(t.deployment), external = amount(await get(externalKey));
      assert(d?.asset === t.asset && d.deployment === t.deployment, 'bulk_deployment');
      for (const [position, i] of indices.entries()) {
        const id = bulkMemberId(op.id, i), m = t.members[i], row = await get('dc/' + id), externalPlot = plotKey(t.asset, m.block, t.supplyScope), internalPlot = capacityPlotKey(t.asset, m.block, t.supplyScope);
        assert(!(mask & bit(i)) && row?.state === (finish ? 'issued' : 'reserved') && row.bulk === op.id && row.index === i &&
          row.terms === old.terms && row.amount === m.amount && row.asset === t.asset && row.deployment === t.generation && row.plot === m.block &&
          (row.supplyScope ?? null) === t.supplyScope && await get(internalPlot) === id &&
          same(await get(externalPlot), { id, state: 'reserved' }), 'bulk_terminal_member');
        mask |= bit(i); total += BigInt(m.amount);
        put('dc/' + id, { ...row, state: finish ? 'minted' : 'released', evidence: op.evidence,
          ...(finish ? { inscription: op.members[position].inscription } : {}) });
        put(externalPlot, finish ? { id, state: 'minted' } : null);
        if (!finish) put(internalPlot, null);
      }
      assert(amount(d.reserved) >= total && external >= total, 'bulk_capacity_accounting');
      put('fd/' + t.generation, { ...d, reserved: (BigInt(d.reserved) - total).toString(), minted: (amount(d.minted) + (finish ? total : 0n)).toString() });
      put(externalKey, (external - total).toString());
      if (!finish && released === 0n && old.reference !== null) await credit(old.reference, old.receiptRoot, old.paid);
      put('fp/' + op.id, { ...old, state: finish ? (mask === all ? 'bulk-complete' : 'bulk-consumed') : (mask === all ? 'bulk-released' : 'bulk-releasing'),
        [finish ? 'finishedMask' : 'releasedMask']: mask.toString() });
    } else throw Error('bulk_operation_type');
  }
  await financialUnfrozen(store, [...touched, 'ar/' + t.owner, 'ar/supply', 'fp/chain', 'fd/' + t.generation,
    'fd/asset/' + t.asset, 'fd/external/' + hashObject(t.deployment), capacityKey(t.deployment), 'fi/deployment/' + t.deployment]);
  for (const [key, value] of writes) store.put(key, value);
  return { writes: writes.size };
}

// Account terminal actions share the existing proof engine and never require
// a second owner signature. Funding and member terminal bits authorize them.
export async function bulkAccountEffect(store, action, obligation) {
  assert(['consume-many', 'release-many'].includes(action.type) && hex(action.id, 32) && hex(action.evidence, 32), 'bulk_account_action');
  const funding = await store.get('fp/' + action.id), t = funding?.manifest;
  validateBulkTerms(t);
  assert(funding.kind === 'bulk-v1' && funding.terms === hashObject(t) && action.terms === funding.terms && obligation?.terms === funding.terms &&
    obligation.owner === t.owner && obligation.asset === t.asset && obligation.amount === t.totalAmount, 'bulk_account_binding');
  const touched = ['fp/' + action.id, 'ao/' + action.id, 'fp/chain', 'fd/' + t.generation, capacityKey(t.deployment),
    ...(funding.reference ? ['fp/bulk-receipt/' + bulkReceiptKey(t.bitcoinNetwork, funding.reference)] : [])], all = bulkAllMask(t.members.length);
  const held = mintRetainsUnits({ supplyScope: t.supplyScope, plot: t.members[0].block });
  let release = 0n, burn = 0n, next;
  if (action.type === 'consume-many') {
    assert(exactKeys(action, ['type', 'id', 'terms', 'permitRoot', 'evidence']) && obligation.state === 'reserved' &&
      funding.state === 'bulk-consumed' && funding.issuedMask === all.toString() && funding.releasedMask === '0' &&
      action.permitRoot === funding.permitRoot && action.permitRoot === bulkPermitPlans(t, funding.receiptRoot).permitRoot, 'bulk_account_consume');
    if (!held) burn = BigInt(t.totalAmount);
    next = { ...obligation, state: 'bulk-issued', permitRoot: action.permitRoot, evidence: action.evidence, releasedMask: '0' };
  } else {
    assert(exactKeys(action, ['type', 'id', 'terms', 'members', 'reason', 'evidence']) && ['minted', 'expired'].includes(action.reason), 'bulk_account_release');
    const minted = action.reason === 'minted', indices = bulkIndices(action.members, t.members.length);
    assert(minted ? held && obligation.state === 'bulk-issued' && ['bulk-consumed', 'bulk-complete'].includes(funding.state) :
      obligation.state === 'reserved' && funding.issuedMask === '0' && ['bulk-releasing', 'bulk-released'].includes(funding.state), 'bulk_account_state');
    assert(obligation.releasedMask === undefined || bulkUint(obligation.releasedMask) && BigInt(obligation.releasedMask) <= all, 'bulk_account_mask');
    let mask = BigInt(obligation.releasedMask ?? '0');
    for (const i of indices) {
      const key = 'dc/' + bulkMemberId(action.id, i), row = await store.get(key); touched.push(key);
      assert(!(mask & bit(i)) && (BigInt(funding[minted ? 'finishedMask' : 'releasedMask']) & bit(i)) &&
        row?.state === (minted ? 'minted' : 'released') && row.bulk === action.id && row.index === i && row.amount === t.members[i].amount && row.terms === funding.terms, 'bulk_account_member');
      mask |= bit(i); release += BigInt(t.members[i].amount);
    }
    next = { ...obligation, releasedMask: mask.toString(), ...(!minted && mask === all ? { state: 'bulk-released' } : {}) };
  }
  await financialUnfrozen(store, touched);
  return { available: release, held: -release - burn, burned: burn, obligation: next };
}

// New bulk claims retain the existing claim/settle digest and record shape.
// Their backing lives in the bulk receipt namespace, never legacy fee pages.
export async function bulkCustodyBacking(store, id, row, funding) {
  const t = validateBulkTerms(funding.manifest), obligation = await store.get('ao/' + row.request);
  const c = t.custody.find(c => bulkCustodyFeeKey(row.request, c) === row.fee), receiptKey = bulkReceiptKey(t.bitcoinNetwork, funding.reference);
  assert(funding.kind === 'bulk-v1' && funding.terms === hashObject(t) && ['bulk-consumed', 'bulk-complete'].includes(funding.state) &&
    obligation?.state === 'bulk-issued' && obligation.terms === funding.terms && funding.issuedMask === bulkAllMask(t.members.length).toString() &&
    funding.releasedMask === '0' && id === custodyId(row.request, row.fee) && c && c.owner === row.owner && c.amount === row.amount &&
    row.rail === 'tap' && row.custodian === t.groups[c.group].to &&
    same(await store.get('fp/bulk-receipt/' + receiptKey), { orderId: row.request, receiptRoot: funding.receiptRoot }) &&
    !await store.get('fp/bulk-credit/' + receiptKey), 'bulk_custody_backing');
  await financialUnfrozen(store, ['bc/' + id, 'fp/' + row.request, 'ao/' + row.request, 'fp/chain',
    'fp/bulk-receipt/' + receiptKey, 'fp/bulk-credit/' + receiptKey]);
}
