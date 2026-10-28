import { gatewayRowsRoot, iterableRoot, migrationGatewayRows, pendingRows } from './migration-pages.mjs';
import { rules as r } from './rules.mjs';
import { check } from './util.mjs';
import { terminalRecordsRoot } from './pending-financial.mjs';

// No timeout from a gateway or sidecar is retirement evidence. Only the
// terminal notary's acceptance/epoch/counted clock can fence a signed batch.
export function reconcileLegacySignatures({ rows, records, network, reservations = [] }) {
  rows = pendingRows(rows);
  const values = new Map(rows.filter(([space]) => space === 'meta' || space === 'batches').map(([space, id, value]) => [space + '/' + id, value]));
  const last = records.get('bt/last'), counted = records.get('b/cnt'), epoch = records.get('s/epoch') ?? 0;
  check(last && Number.isSafeInteger(counted) && Number.isSafeInteger(epoch), 'pending_signature_notary');
  const dispositions = [], writes = [], batches = new Map();
  const draft = values.get('meta/draft');
  if (draft) batches.set(`batch/${draft.proposal.batch.epoch}/${draft.proposal.batch.n}`, draft.proposal.batch);
  for (const [space, id, job] of rows) if (space === 'outbox') {
    if (job.op === 'bt') {
      const { sig, ...batch } = job.value;
      const old = batches.get(id);
      check(id === `batch/${batch.epoch}/${batch.n}` && (!old || r.stableJSON(old) === r.stableJSON(batch)), 'pending_transport_binding');
      batches.set(id, batch);
    } else {
      check(job.op === 'hd' && records.get('b/r/' + job.hash)?.[0] === job.height, 'pending_transport_evidence_required');
      dispositions.push({ id, state: 'accepted_header', height: job.height, hash: job.hash });
    }
  }
  // A gateway omission cannot erase a signer's live reservation. Known
  // drafts are checked against the exact digest below; other batch slots
  // require their own accepted root or notary retirement fence.
  const slots = new Set();
  for (const reservation of reservations) {
    check(Array.isArray(reservation.slots) && reservation.slots.length > 0 && r.hex(reservation.digest, 32), 'pending_signer_reservation');
    for (const slot of reservation.slots) {
      check(typeof slot === 'string' && !slots.has(slot), 'pending_signer_reservation'); slots.add(slot);
      if (slot.startsWith('batch/') && !batches.has(slot)) {
        const detail = reservation.details, root = records.get('bt/' + detail?.n) ?? null;
        check(detail && Number.isSafeInteger(detail.n) && Number.isSafeInteger(detail.epoch) && Number.isSafeInteger(detail.deadline) &&
          r.hex(detail.root, 32) && slot === `batch/${detail.epoch}/${detail.n}` &&
          (root === detail.root || root === null && last.n < detail.n && epoch >= detail.epoch &&
            (epoch > detail.epoch || counted > detail.deadline)), 'pending_signer_unrepresented_batch');
      }
      if (slot.startsWith('mint/request/')) {
        const raw = records.get('m/' + slot.slice('mint/request/'.length));
        check(raw?.s === 1 && raw.permitHash === reservation.digest, 'pending_signer_mint_binding');
      }
    }
  }
  for (const [id, batch] of [...batches].sort(([a], [b]) => a.localeCompare(b))) {
    const digest = r.bytesToHex(r.batchDigest(network, batch)), root = records.get('bt/' + batch.n) ?? null;
    for (const reservation of reservations.filter(row => row.slots?.includes(id)))
      check(reservation.digest === digest && reservation.details?.n === batch.n && reservation.details?.deadline === batch.deadline, 'pending_signer_draft_conflict');
    if (root === batch.root) {
      const checkpoint = values.get('meta/ruleState'), accepted = [...values.entries()].find(([key, row]) => key.startsWith('batches/') && row.batch?.n === batch.n)?.[1];
      check(checkpoint?.counted >= batch.to && accepted?.batch.root === root, 'pending_accepted_draft_replay_required');
      dispositions.push({ id, state: 'accepted', digest, root, n: batch.n });
    } else {
      check(root === null && last.n < batch.n && epoch >= batch.epoch &&
        (epoch > batch.epoch || counted > batch.deadline), 'pending_signed_draft_live');
      dispositions.push({ id, state: 'retired', digest, root: null, n: batch.n, proof: { last, epoch, counted } });
    }
  }
  for (const [space, id, archived] of rows) if (space === 'supersededDrafts') {
    const batch = archived.batch, root = records.get('bt/' + batch?.n) ?? null;
    check(archived.state === 'RETIRED' && r.hex(batch?.root, 32) && Number.isSafeInteger(batch.n) &&
      Number.isSafeInteger(batch.epoch) && Number.isSafeInteger(batch.deadline), 'pending_superseded_draft');
    // A later accepted replacement fences the old digest permanently. Before
    // replacement, only the terminal notary clock/epoch can fence it.
    check(root && last.n >= batch.n || root === null && last.n < batch.n && epoch >= batch.epoch &&
      (epoch > batch.epoch || counted > batch.deadline), 'pending_superseded_draft_live');
    if (root === batch.root) {
      const accepted = rows.find(([s, , v]) => s === 'batches' && v.batch?.n === batch.n)?.[2];
      check(values.get('meta/ruleState')?.counted >= batch.to && accepted?.batch.root === root, 'pending_accepted_draft_replay_required');
    }
    dispositions.push({ id: 'superseded/' + id, state: root === batch.root ? 'accepted' : root ? 'superseded_by_accepted' : 'retired',
      digest: r.bytesToHex(r.batchDigest(network, batch)), root, n: batch.n, proof: { last, epoch, counted } });
  }
  if (draft) writes.push({ space: 'legacySignedDrafts', id: r.hashObject(draft), value: draft }, { space: 'meta', id: 'draft' });
  for (const [space, id, value] of rows) if (space === 'outbox') writes.push({ space: 'legacySignedOutbox', id, value }, { space, id });
  const commitment = { version: 1, network, sourceRoot: gatewayRowsRoot(rows),
    notaryRoot: terminalRecordsRoot(records), dispositions };
  return { commitment, root: r.hashObject(['dmw-signature-reconciliation-v1', commitment]), writes };
}
