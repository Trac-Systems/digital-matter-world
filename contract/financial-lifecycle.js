import { releaseFinancialCapacity } from './financial-capacity.js';
import { ordinalCodec } from '../rules/src/integers-v2.js';
import { financialRecoveryKey } from './financial-records.js';
import { ed25519 } from '@noble/curves/ed25519';
import { canonicalJSON, sha256, utf8ToBytes, bytesToHex } from './signing.js';

const check = (ok, reason) => { if (!ok) throw Error(reason); };
const hex = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x);
const positive = x => uint(x) && x !== '0';
const hash = x => bytesToHex(sha256(utf8ToBytes(canonicalJSON(x))));
const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const keys = (a, names) => equal(Object.keys(a).sort(), names.sort());
export const lifecycleDigest = (network, action) => {
  const { sig, ...body } = action;
  return sha256(utf8ToBytes('dmw-financial-lifecycle-v2|' + network + '|' + canonicalJSON(body)));
};
export const custodyId = (request, fee) => hash(['dmw-custody-v2', request, fee]);
export const recoveryEnd = hash(['dmw-financial-recovery-end-v2']);
export const recoveryPageHash = (items, next) => hash(['dmw-financial-recovery-page-v2', items, next]);

export async function financialUnfrozen(store, records) {
  check(!await store.get('fr/active'), 'financial_recovery_active');
  for (const key of records) check(!await store.get('fq/' + key), 'financial_quarantined');
}

// These effects execute only in a quorum-authenticated v2 batch. The matching
// rules planner checks independently reconstructed chain evidence. No elapsed
// timeout revokes a permit or proves an external transfer/refund.
export async function applyFinancialLifecycle(store, op, { network, height, limits }) {
  const a = op.action, clock = ordinalCodec(typeof height === 'string');
  check(keys(op, ['op', 'v', 'id', 'type', 'action', 'evidence']) && hex(op.evidence) && a?.id === op.id && typeof a.type === 'string', 'lifecycle_operation');
  const exact = names => check(keys(a, ['type', 'id', ...names]), 'lifecycle_fields');
  const writes = new Map(), get = key => writes.has(key) ? writes.get(key) : store.get(key);
  const put = (key, value) => writes.set(key, value);
  const signed = owner => check(hex(owner) && clock.valid(a.until) && clock.compare(a.until, height) >= 0 &&
    typeof a.sig === 'string' && /^[0-9a-f]{128}$/.test(a.sig) && ed25519.verify(a.sig, lifecycleDigest(network, a), owner, { zip215: false }), 'lifecycle_signature');
  if (!a.type.startsWith('recovery-')) await financialUnfrozen(store, ['fp/' + a.id, 'fl/' + a.id, 'bc/' + a.id, 'dc/' + a.id]);

  if (a.type === 'legacy-link-complete' || a.type === 'legacy-link-exit') {
    exact([]);
    const source = await get('fi/source/' + a.id), funding = await get('fp/' + a.id), complete = a.type === 'legacy-link-complete';
    check(source?.legacy?.kind === 'link' && source.requestId === a.id && funding?.terms === hash(source) &&
      funding.owner === source.owner && funding.state === (complete ? 'consumed' : 'credited') && !await get('fl/' + a.id), 'legacy_link_terminal');
    if (complete) {
      check(!await get('fl/slot/' + source.block) && !await get('k/link/' + BigInt(source.block).toString(36)) &&
        funding.permitHash === hash(['dmw-legacy-link-completion-v1', a.id, funding.terms]), 'legacy_link_conflict');
      put('k/link/' + BigInt(source.block).toString(36), canonicalJSON({ block: source.block, linkHeight: String(height) }));
    }
    put('fl/' + a.id, { state: complete ? 'complete' : 'credited', owner: source.owner, block: source.block, terms: funding.terms, until: source.until, evidence: op.evidence });
  } else if (a.type === 'credit-repair-open') {
    exact(['credit', 'recovery', 'before']);
    const row = await get('fc/' + a.credit), frozen = await get('fq/fc/' + a.credit), funding = await get('fp/' + a.id);
    check(hex(a.credit) && row && frozen?.recovery === a.recovery && hash(row) === a.before &&
      funding?.state === 'open' && funding.owner === row.owner && equal(funding.fees, row.fees.filter(f => f.amount !== '0')) &&
      !await get('ao/' + a.id) && !await get('fl/' + a.id) && !await get('fr/backing/' + a.id), 'credit_repair_binding');
    put('fr/backing/' + a.id, { credit: a.credit, recovery: a.recovery, before: a.before, state: 'funding' });
  } else if (a.type === 'credit-repair-finish') {
    exact([]);
    const repair = await get('fr/backing/' + a.id), funding = await get('fp/' + a.id);
    check(repair?.state === 'funding' && (await get('fq/fc/' + repair.credit))?.recovery === repair.recovery &&
      hash(await get('fc/' + repair.credit)) === repair.before && funding?.state === 'consumed' &&
      funding.permitHash === hash(['dmw-credit-repair-v2', a.id, repair]), 'credit_repair_funding');
    put('fq/fc/' + repair.credit, null); put('fr/backing/' + a.id, { ...repair, state: 'complete', evidence: op.evidence });
  } else if (a.type === 'link-reserve') {
    exact(['owner', 'block', 'terms', 'until', 'sig']); signed(a.owner);
    check(uint(a.block) && hex(a.terms) && !await get('fl/' + a.id) && !await get('fl/slot/' + a.block) &&
      !await get('k/link/' + BigInt(a.block).toString(36)), 'link_reserved');
    const funding = await get('fp/' + a.id);
    check(funding?.state === 'open' && funding.owner === a.owner && funding.terms === a.terms, 'link_funding');
    put('fl/' + a.id, { state: 'reserved', owner: a.owner, block: a.block, terms: a.terms, until: a.until });
    put('fl/slot/' + a.block, a.id);
  } else if (a.type === 'link-complete' || a.type === 'link-exit') {
    exact([]);
    const row = await get('fl/' + a.id), funding = await get('fp/' + a.id);
    check(row?.state === 'reserved' && await get('fl/slot/' + row.block) === a.id && funding?.owner === row.owner && funding.terms === row.terms, 'link_terminal');
    const complete = a.type === 'link-complete';
    check(complete ? funding.state === 'consumed' : ['credited', 'refunded'].includes(funding.state), 'link_settlement');
    put('fl/' + a.id, { ...row, state: complete ? 'complete' : funding.state, evidence: op.evidence });
    // A paid reservation survives a holder change. The published link belongs
    // to the Bitmap, just as legacy links do; payment does not buy its holder.
    if (complete) {
      check(!await get('k/link/' + BigInt(row.block).toString(36)), 'link_exists');
      put('k/link/' + BigInt(row.block).toString(36), canonicalJSON({ block: row.block, linkHeight: String(height) }));
    }
    put('fl/slot/' + row.block, null);
  } else if (a.type === 'custody-accrue') {
    exact(['request', 'fee', 'owner', 'rail', 'custodian', 'amount']);
    const funding = await get('fp/' + a.request), fee = funding?.fees.find(f => f.key === a.fee), obligation = await get('ao/' + a.request);
    await financialUnfrozen(store, ['fp/' + a.request]);
    check(a.id === custodyId(a.request, a.fee) && funding?.state === 'consumed' && obligation?.state === 'consumed' &&
      obligation.terms === funding.terms && !await get('fr/backing/' + a.request) && fee?.amount === a.amount && positive(a.amount) &&
      hex(a.owner) && ['tap', 'ethereum'].includes(a.rail) && typeof a.custodian === 'string' && a.custodian.length > 0 && !await get('bc/' + a.id), 'custody_funding');
    put('bc/' + a.id, { request: a.request, fee: a.fee, owner: a.owner, rail: a.rail, custodian: a.custodian,
      amount: a.amount, state: 'claimable', revision: '0', evidence: op.evidence });
  } else if (a.type === 'custody-claim') {
    exact(['revision', 'destination', 'until', 'sig']);
    const row = await get('bc/' + a.id); check(row?.state === 'claimable' && row.revision === a.revision, 'custody_revision'); signed(row.owner);
    check(typeof a.destination === 'string' && a.destination.length > 0 && a.destination !== row.custodian, 'custody_destination');
    const claim = hash(['dmw-custody-claim-v2', network, a]);
    put('bc/' + a.id, { ...row, state: 'paying', claim, destination: a.destination, revision: (BigInt(row.revision) + 1n).toString() });
  } else if (a.type === 'custody-settle' || a.type === 'custody-reopen') {
    exact(a.type === 'custody-settle' ? ['claim', 'receipt'] : ['claim']);
    const row = await get('bc/' + a.id);
    check(row?.state === 'paying' && row.claim === a.claim, 'custody_claim');
    const settle = a.type === 'custody-settle';
    if (settle) { check(hex(a.receipt) && !await get('bc/receipt/' + a.receipt), 'custody_receipt'); put('bc/receipt/' + a.receipt, a.id); }
    const { claim, destination, ...rest } = row;
    put('bc/' + a.id, { ...rest, state: settle ? 'settled' : 'claimable', revision: (BigInt(row.revision) + 1n).toString(),
      evidence: op.evidence, ...(settle ? { claim, destination, receipt: a.receipt } : {}) });
  } else if (a.type === 'deployment-open') {
    exact(['asset', 'deployment', 'generation', 'previous', 'maximum', 'limit']);
    check(typeof a.asset === 'string' && /^([0-9a-z]{1,24}|p2:(0|[1-9][0-9]*)|c2:[0-9a-f]{64})$/.test(a.asset) &&
      typeof a.deployment === 'string' && a.deployment.length > 0 && uint(a.generation) && positive(a.maximum) && uint(a.limit) &&
      !await get('fd/' + a.id) && !await get('fd/external/' + hash(a.deployment)), 'deployment_identity');
    const current = await get('fd/asset/' + a.asset);
    if (!current) check(a.previous === null && a.generation === '0', 'deployment_initial');
    else {
      const old = await get('fd/' + current); await financialUnfrozen(store, ['fd/' + current]);
      check(a.previous === current && old.asset === a.asset && a.generation === (BigInt(old.generation) + 1n).toString() &&
        old.minted === old.maximum && old.reserved === '0', 'deployment_unexhausted');
    }
    put('fd/' + a.id, { asset: a.asset, deployment: a.deployment, generation: a.generation, previous: a.previous,
      maximum: a.maximum, limit: a.limit, reserved: '0', minted: '0', evidence: op.evidence });
    put('fd/asset/' + a.asset, a.id); put('fd/external/' + hash(a.deployment), a.id);
  } else if (a.type === 'capacity-reserve') {
    exact(['deployment', 'plot']);
    const d = await get('fd/' + a.deployment), obligation = await get('ao/' + a.id);
    await financialUnfrozen(store, ['fd/' + a.deployment, 'ao/' + a.id]);
    check(hex(a.deployment) && d && obligation?.state === 'reserved' && obligation.asset === d.asset && !await get('dc/' + a.id) &&
      await get('fd/asset/' + d.asset) === a.deployment && (a.plot === null || uint(a.plot)), 'capacity_identity');
    check(BigInt(d.reserved) + BigInt(d.minted) + BigInt(obligation.amount) <= BigInt(d.maximum) &&
      (d.limit === '0' || BigInt(obligation.amount) <= BigInt(d.limit)), 'capacity_exhausted');
    const plot = a.plot === null ? null : 'dc/plot/' + d.asset + '/' + a.plot;
    check(!plot || !await get(plot), 'capacity_plot');
    put('dc/' + a.id, { state: 'reserved', deployment: a.deployment, asset: d.asset, amount: obligation.amount, plot: a.plot, terms: obligation.terms });
    put('fd/' + a.deployment, { ...d, reserved: (BigInt(d.reserved) + BigInt(obligation.amount)).toString() });
    if (plot) put(plot, a.id);
  } else if (['capacity-issue', 'capacity-finish', 'capacity-release'].includes(a.type)) {
    exact(a.type === 'capacity-release' ? [] : ['permitHash']);
    const row = await get('dc/' + a.id), obligation = await get('ao/' + a.id), d = row && await get('fd/' + row.deployment);
    if (!row && a.type === 'capacity-finish') {
      const source = await get('fi/source/' + a.id), funding = await get('fp/' + a.id);
      check(source?.legacy && funding?.capacity && !funding.minted && funding.state === 'consumed' && funding.permitHash === a.permitHash &&
        obligation?.state === 'consumed' && obligation.permitHash === a.permitHash && obligation.terms === funding.terms &&
        hash(source) === funding.terms, 'legacy_capacity_terminal');
      for (const [key, value] of await releaseFinancialCapacity(store, a.id, funding.capacity, { minted: true })) put(key, value);
      put('fp/' + a.id, { ...funding, minted: op.evidence });
      for (const [key, value] of writes) store.put(key, value);
      return;
    }
    const publicFunding = row?.publicMint && a.type === 'capacity-finish' ? await get('fp/' + a.id) : null;
    check(row && d && row.terms === (publicFunding?.publicMint && publicFunding.state === 'consumed' ? publicFunding.terms : obligation?.terms), 'capacity_request');
    await financialUnfrozen(store, ['fd/' + row.deployment, 'ao/' + a.id]);
    if (a.type === 'capacity-issue') {
      check(row.state === 'reserved' && obligation.state === 'consumed' && hex(a.permitHash) && obligation.permitHash === a.permitHash, 'capacity_permit');
      put('dc/' + a.id, { ...row, state: 'issued', permitHash: a.permitHash });
    } else {
      const minted = a.type === 'capacity-finish';
      if (minted) for (const [key, value] of await releaseFinancialCapacity(store, a.id, (await get('fp/' + a.id))?.capacity, { minted: true })) put(key, value);
      check(minted ? row.state === 'issued' && row.permitHash === a.permitHash : row.state === 'reserved' && obligation.state === 'refunded', 'capacity_terminal');
      check(BigInt(d.reserved) >= BigInt(row.amount), 'capacity_accounting');
      put('fd/' + row.deployment, { ...d, reserved: (BigInt(d.reserved) - BigInt(row.amount)).toString(), minted: (BigInt(d.minted) + (minted ? BigInt(row.amount) : 0n)).toString() });
      put('dc/' + a.id, { ...row, state: minted ? 'minted' : 'released', evidence: op.evidence });
      if (!minted && row.plot !== null) put('dc/plot/' + row.asset + '/' + row.plot, null);
    }
  } else if (a.type === 'recovery-inventory') {
    exact(['previous', 'tip']);
    const stage = await get('br/' + a.id + '/meta');
    check(stage?.state === 'building' && stage.previous.hash === a.previous && hex(a.tip) &&
      !await get('fr/active') && !await get('fr/' + a.id), 'financial_recovery_begin');
    put('fr/active', a.id); put('fr/' + a.id, { state: 'inventory', inventory: true, previous: a.previous, tip: a.tip,
      cursor: '', manifest: recoveryEnd, count: '0' });
  } else if (a.type === 'recovery-inventory-page') {
    exact(['cursor', 'items', 'limit']);
    const row = await get('fr/' + a.id);
    check(await get('fr/active') === a.id && row?.state === 'inventory' && row.cursor === a.cursor &&
      Number.isSafeInteger(a.limit) && a.limit > 0 && a.limit <= limits.paymentPage && Array.isArray(a.items) &&
      a.items.length > 0 && a.items.length <= a.limit, 'financial_inventory_page');
    let cursor = a.cursor;
    for (const item of a.items) {
      check(keys(item, ['key', 'before', 'outcome']) && financialRecoveryKey(item.key) && item.key > cursor &&
        hex(item.before) && ['retain', 'quarantine'].includes(item.outcome) && hash(await get(item.key)) === item.before, 'financial_inventory_record');
      cursor = item.key;
    }
    const manifest = recoveryPageHash(a.items, row.manifest);
    put('fr/' + a.id + '/page/' + manifest, { items: a.items, next: row.manifest });
    put('fr/' + a.id, { ...row, cursor, manifest, count: (BigInt(row.count) + BigInt(a.items.length)).toString() });
  } else if (a.type === 'recovery-inventory-seal') {
    exact([]);
    const row = await get('fr/' + a.id);
    check(await get('fr/active') === a.id && row?.state === 'inventory', 'financial_inventory_state');
    put('fr/' + a.id, { ...row, state: 'reconciling', next: row.manifest, processed: '0', sequence: '0' });
  } else if (a.type === 'recovery-begin') {
    exact(['previous', 'tip', 'manifest', 'count']);
    const stage = await get('br/' + a.id + '/meta');
    check(stage?.state === 'building' && stage.previous.hash === a.previous && hex(a.tip) && hex(a.manifest) && uint(a.count) &&
      (a.count === '0') === (a.manifest === recoveryEnd) && !await get('fr/active') && !await get('fr/' + a.id), 'financial_recovery_begin');
    put('fr/active', a.id); put('fr/' + a.id, { state: 'reconciling', previous: a.previous, tip: a.tip, manifest: a.manifest,
      next: a.manifest, count: a.count, processed: '0', sequence: '0' });
  } else if (a.type === 'recovery-page') {
    exact(['sequence', 'items', 'next']);
    const row = await get('fr/' + a.id);
    check(await get('fr/active') === a.id && row?.state === 'reconciling' && a.sequence === row.sequence &&
      Array.isArray(a.items) && a.items.length > 0 && a.items.length <= limits.paymentPage && hex(a.next) &&
      recoveryPageHash(a.items, a.next) === row.next, 'financial_recovery_page');
    for (const item of a.items) {
      check(keys(item, ['key', 'before', 'outcome']) && financialRecoveryKey(item.key) &&
        hex(item.before) && ['retain', 'quarantine'].includes(item.outcome), 'financial_recovery_item');
      const record = await get(item.key), marker = 'fr/' + a.id + '/item/' + hash(item.key);
      check((record !== null && record !== undefined || row.inventory && item.outcome === 'retain') &&
        hash(record ?? null) === item.before && !await get(marker), 'financial_recovery_record');
      put(marker, item);
      // Orphan evidence does not erase spent money, reclaimable liabilities or
      // issued permits. Keep identity/usage and fence dependent spending.
      if (item.outcome === 'quarantine' && !await get('fq/' + item.key)) put('fq/' + item.key, { recovery: a.id, before: item.before, evidence: op.evidence });
    }
    const processed = (BigInt(row.processed) + BigInt(a.items.length)).toString();
    check(BigInt(processed) <= BigInt(row.count) && (processed === row.count) === (a.next === recoveryEnd), 'financial_recovery_count');
    put('fr/' + a.id, { ...row, next: a.next, processed, sequence: (BigInt(row.sequence) + 1n).toString() });
  } else if (a.type === 'recovery-approve') {
    exact(['batch']);
    const row = await get('fr/' + a.id), last = (await get('bt/last'))?.n ?? 0;
    check(await get('fr/active') === a.id && row?.state === 'reconciling' && row.next === recoveryEnd && row.processed === row.count &&
      clock.valid(a.batch) && clock.compare(a.batch, last) === 0, 'financial_recovery_incomplete');
    const root = hash(['dmw-financial-reconciliation-v2', a.id, row.previous, row.tip, row.manifest, row.count]);
    // Approval is for adoption in the immediately following batch. Any other
    // accepted batch makes it stale; recovery-refresh can safely renew it.
    put('recoveryApproved/' + a.id, { previous: row.previous, tip: row.tip, root, lastBatch: clock.add(last) });
    put('fr/' + a.id, { ...row, state: 'approved', root });
  } else if (a.type === 'recovery-refresh') {
    exact(['batch']);
    const row = await get('fr/' + a.id), last = (await get('bt/last'))?.n ?? 0;
    check(await get('fr/active') === a.id && row?.state === 'approved' && clock.valid(a.batch) && clock.compare(a.batch, last) === 0, 'financial_recovery_refresh');
    put('recoveryApproved/' + a.id, { previous: row.previous, tip: row.tip, root: row.root, lastBatch: clock.add(last) });
  } else if (a.type === 'recovery-finish') {
    exact(a.anchor ? ['anchor'] : []);
    const row = await get('fr/' + a.id), adopted = await get('b/recovery');
    check(await get('fr/active') === a.id && row?.state === 'approved' && adopted?.id === a.id && adopted.reconciliation === row.root &&
      adopted.previous.hash === row.previous && adopted.tip.hash === row.tip, 'financial_recovery_unadopted');
    if (a.anchor) {
      check(uint(a.anchor.bitcoin?.height) && a.anchor.bitcoin.hash === adopted.tip.hash &&
        a.anchor.bitcoin.height === String(adopted.tip.height) && (a.anchor.ethereum === null || uint(a.anchor.ethereum?.height) &&
        positive(a.anchor.ethereum.chainId) && /^0x[0-9a-f]{64}$/.test(a.anchor.ethereum.hash)), 'financial_recovery_anchor');
      put('fp/chain', a.anchor); put('fq/fp/chain', null);
    }
    put('fr/' + a.id, { ...row, state: 'complete' }); put('fr/active', null);
  } else if (a.type === 'recovery-abort') {
    exact([]);
    const row = await get('fr/' + a.id), stage = await get('br/' + a.id + '/meta');
    check(await get('fr/active') === a.id && ['inventory', 'reconciling', 'approved'].includes(row?.state) && stage?.state === 'building', 'financial_recovery_abort');
    put('fr/' + a.id, { ...row, state: 'aborted' }); put('fr/active', null); put('recoveryApproved/' + a.id, null);
  } else if (a.type === 'recovery-release') {
    exact(['key', 'before']);
    check(!await get('fr/active') && typeof a.key === 'string' && (await get('fq/' + a.key))?.recovery === a.id &&
      hash(await get(a.key)) === a.before, 'financial_recovery_release');
    put('fq/' + a.key, null);
  } else throw Error('lifecycle_type');
  // No writes, including claims/slots, survive a failed validation.
  for (const [key, value] of writes) store.put(key, value);
}
