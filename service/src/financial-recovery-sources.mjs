import { BitcoinBeacon } from '../../contract/beacon/bitcoin.js';
import { rules } from './rules.mjs';
import { check } from './util.mjs';

const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
export function installRecoverySources(reads) {
  reads.financialNotaryHashAt = async (height, at) => {
    const deployment = await reads.financialBeaconConfig();
    return new BitcoinBeacon({ get: key => reads.financialRecord(key, at) }, { ...deployment.beacon, integerVersion: 2 }).hashAt(height);
  };
  reads.financialBeaconEvidence = async (op, at) => {
    check(op?.op === 'br' && op.v === 2 && rules.hex(op.id, 32), 'financial_beacon_operation');
    if (op.type === 'begin') {
      check(op.previous === at.tipHash && await reads.financialCanonicalBitcoinHash(op.anchor.height) === op.anchor.hash, 'financial_recovery_anchor');
    } else if (op.type === 'append') {
      const candidate = await reads.financialRecoveryStage(op.id, at);
      check(candidate.meta.state === 'building' && candidate.meta.sequence === op.sequence && Array.isArray(op.headers), 'financial_recovery_sequence');
      let height = rules.decimalV2(candidate.tip.height);
      for (const raw of op.headers) {
        height = rules.nextUint(height);
        check(rules.parseHeader(raw, height)?.hash === await reads.financialCanonicalBitcoinHash(height), 'financial_recovery_header_source');
      }
    } else {
      check(op.type === 'adopt', 'financial_beacon_operation');
      const candidate = await reads.financialRecoveryStage(op.id, at), row = await reads.financialRecord('fr/' + op.id, at), approval = await reads.financialRecord('recoveryApproved/' + op.id, at);
      check(row?.inventory && row.state === 'approved' && op.previous === at.tipHash && op.tip === candidate.tip.hash && approval?.root === op.reconciliation &&
        rules.compareOrdinal(approval.lastBatch, at.last.n) === 0 && await reads.financialCanonicalBitcoinHash(candidate.tip.height) === op.tip, 'financial_recovery_adoption');
    }
    return { requestId: op.id, state: 'beacon_verified', operation: rules.hashObject(op) };
  };
  reads.financialRecoveryStage = async (id, at) => {
    const meta = await reads.financialRecord('br/' + id + '/meta', at);
    check(meta, 'financial_recovery_stage');
    const deployment = await reads.financialBeaconConfig(), store = { get: key => reads.financialRecord('br/' + id + '/' + key, at) };
    const beacon = new BitcoinBeacon(store, { ...deployment.beacon, checkpoint: meta.anchor, recovery: false, integerVersion: 2 });
    return { meta, tip: await beacon.tip() };
  };
  const stage = async (id, at) => {
    const candidate = await reads.financialRecoveryStage(id, at);
    check(candidate.meta.state === 'building' && candidate.meta.previous.hash === at.tipHash &&
      await reads.financialCanonicalBitcoinHash(candidate.tip.height) === candidate.tip.hash, 'financial_recovery_heads');
    return candidate;
  };
  reads.financialRecoveryItems = async (range, at) => {
    const rows = await reads.financialInventoryPage(range, at), items = [];
    for (const { key, value } of rows) {
      let canonical = true;
      // Game units, locks, obligations, imported identities and tombstones
      // remain exact. Imported identities do not grant new native funding;
      // their separate migration must still prove any active conversion.
      if (value !== null && !/^(ar|al|ao|fi)\//.test(key) && key !== 'fp/usage') {
        const anchor = key === 'fp/chain' ? value : (await reads.financialRecordProvenance(key, value)).anchor;
        canonical = await reads.financialAnchorCanonical(anchor);
      }
      items.push({ key, before: rules.hashObject(value), outcome: canonical ? 'retain' : 'quarantine' });
    }
    return items;
  };
  reads.financialRecoveryEvidence = async (a, at) => {
    const base = { requestId: a.id }, row = await reads.financialRecord('fr/' + a.id, at);
    if (a.type === 'recovery-inventory') {
      const candidate = await stage(a.id, at);
      check(a.previous === candidate.meta.previous.hash && a.tip === candidate.tip.hash, 'financial_recovery_heads');
      return { ...base, state: 'inventory_snapshot', previous: a.previous, tip: a.tip, snapshot: rules.hashObject(at) };
    }
    if (a.type === 'recovery-inventory-page') {
      check(row?.state === 'inventory' && a.cursor === row.cursor, 'financial_inventory_state');
      await stage(a.id, at);
      const items = await reads.financialRecoveryItems({ after: row.cursor, limit: a.limit }, at);
      check(items.length > 0 && same(items, a.items), 'financial_inventory_complete_range');
      return { ...base, state: 'inventory_page', cursor: row.cursor, limit: a.limit, items };
    }
    if (a.type === 'recovery-inventory-seal') {
      check(row?.state === 'inventory' && !(await reads.financialInventoryPage({ after: row.cursor, limit: 1 }, at)).length, 'financial_inventory_incomplete');
      await stage(a.id, at); return { ...base, state: 'inventory_complete', cursor: row.cursor };
    }
    if (a.type === 'recovery-page') {
      check(row?.inventory && row.state === 'reconciling' && row.sequence === a.sequence, 'financial_recovery_inventory_required');
      const page = await reads.financialRecord('fr/' + a.id + '/page/' + row.next, at);
      check(page && same(page.items, a.items) && page.next === a.next, 'financial_recovery_inventory_page');
      return { ...base, state: 'reconciled', items: page.items, next: page.next, sequence: row.sequence };
    }
    if (['recovery-approve', 'recovery-refresh'].includes(a.type)) {
      const candidate = await stage(a.id, at);
      check(row?.inventory && row.processed === row.count && row.previous === candidate.meta.previous.hash && row.tip === candidate.tip.hash &&
        rules.compareOrdinal(a.batch, at.last.n) === 0, 'financial_recovery_incomplete');
      return { ...base, state: 'reconciled', batch: a.batch, previous: row.previous, tip: row.tip, manifest: row.manifest };
    }
    if (a.type === 'recovery-finish') {
      const adopted = await reads.financialRecord('b/recovery', at);
      check(row?.state === 'approved' && adopted?.id === a.id && adopted.reconciliation === row.root && adopted.previous.hash === row.previous && adopted.tip.hash === row.tip, 'financial_recovery_unadopted');
      check(a.anchor, 'financial_recovery_anchor');
      const anchor = await reads.financialRecoveryAnchor(at, a.anchor);
      return { ...base, state: 'adopted', reconciliation: row.root, anchor };
    }
    if (a.type === 'recovery-abort') {
      const candidate = await reads.financialRecoveryStage(a.id, at);
      check(candidate.meta.state === 'building' && await reads.financialCanonicalBitcoinHash(candidate.tip.height) !== candidate.tip.hash, 'financial_recovery_candidate_live');
      return { ...base, state: 'candidate_abandoned', manifest: row.manifest };
    }
    if (a.type === 'recovery-release') {
      const value = await reads.financialRecord(a.key, at), frozen = await reads.financialRecord('fq/' + a.key, at);
      check(frozen?.recovery === a.id && rules.hashObject(value) === a.before, 'financial_recovery_release');
      const proof = await reads.financialRecordProvenance(a.key, value);
      check(await reads.financialAnchorCanonical(proof.anchor), 'financial_recovery_backing_orphaned');
      return { ...base, state: 'canonical_again', key: a.key, before: a.before, confirmations: 1 };
    }
    throw Error('financial_recovery_native_transition');
  };
}
