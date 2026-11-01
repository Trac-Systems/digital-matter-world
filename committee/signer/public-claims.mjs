import { capacityPlotKey, mintPlotKey } from '../../rules/src/per-ticker-supply-activation.js';
import { check, equal } from './crypto.mjs';
import { hex } from '../../rules/src/core.js';
import { publicPlotId } from '../../rules/src/public-mint.js';
import { POINT_BATCH_SIZE, pointBatch, pointResults } from '../../rules/src/point-read-batch.js';

// All reads here belong to this verifier's predecessor. A gateway may supply
// its own draft overlay, but no signer receives another reader's answers.
export async function readPublicWinners(reads, pairs, at, overlay) {
  pointBatch(pairs.map(([asset, block, deployment]) => capacityPlotKey(asset, block, deployment)));
  check(typeof reads.financialRecord === 'function', 'public_mint_evidence_missing');
  const records = async keys => {
    const result = new Map(), remote = [];
    for (const key of new Set(keys)) {
      if (overlay?.hasOverlay('accountRecords', key)) result.set(key, { value: overlay.get('accountRecords', key) });
      else remote.push(key);
    }
    if (remote.length) {
      let rows;
      if (reads.financialRecords) {
        try {
          const values = await reads.financialRecords(remote, at);
          check(Array.isArray(values) && values.length === remote.length, 'point_read_batch');
          rows = values.map(value => ({ value }));
        } catch { /* Isolate unused speculative failures with ordinary reads. */ }
      }
      rows ??= await pointResults(remote, key => reads.financialRecord(key, at));
      remote.forEach((key, i) => result.set(key, rows[i]));
    }
    return result;
  };
  const keys = pairs.map(([asset, block, deployment]) => capacityPlotKey(asset, block, deployment)), plots = await records(keys);
  const ids = [...plots.values()].filter(row => !row.error && hex(row.value, 32)).map(row => 'fp/' + row.value);
  const funding = await records(ids);
  return keys.map(key => {
    const row = plots.get(key);
    if (row.error) return row;
    const id = row.value;
    if (id === null || id === undefined) return { value: null };
    if (!hex(id, 32)) return { error: 'public_mint_evidence' };
    const found = funding.get('fp/' + id);
    if (found.error) return found;
    if (!found.value) return { error: 'public_mint_evidence_missing' };
    return { value: found.value.publicMint === true && found.value.owner === null ? id : null };
  });
}

export async function readPublicWinner(reads, asset, block, at, deployment = null) {
  check(typeof reads.financialRecord === 'function', 'public_mint_evidence_missing');
  const id = await reads.financialRecord(capacityPlotKey(asset, block, deployment), at);
  if (id === null || id === undefined) return null;
  check(hex(id, 32), 'public_mint_evidence');
  const funding = await reads.financialRecord('fp/' + id, at);
  check(funding, 'public_mint_evidence_missing');
  return funding.publicMint === true && funding.owner === null ? id : null;
}

// Supplied replay answers cannot bypass independent notary reads. They bind
// only to the accepted predecessor; new winners are in the replayed claim map.
export async function verifyPublicMintEvidence(files, reads, at) {
  const checked = new Map();
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const rows = await readPublicWinners(reads, pending.map(row => [row.asset, row.block, ...(row.deployment ? [row.deployment] : [])]), at);
    pending.forEach((row, i) => checked.set(mintPlotKey(row.asset, row.block, row.deployment), rows[i]));
    pending = [];
  };
  for (const file of files) for (const row of file.publicMintEvidence ?? []) {
    const key = mintPlotKey(row.asset, row.block, row.deployment);
    if (!checked.has(key)) { checked.set(key, null); pending.push(row); }
    if (pending.length === POINT_BATCH_SIZE) await flush();
  }
  await flush();
  // Validate in the original evidence order, including duplicate rows. Reads
  // are concurrent; evidence bytes and the first failed comparison are stable.
  for (const file of files) for (const row of file.publicMintEvidence ?? []) {
    const answer = checked.get(mintPlotKey(row.asset, row.block, row.deployment));
    if (answer.error) throw Error(answer.error);
    check(answer.value === row.id, 'public_mint_evidence_read');
  }
}

export async function verifyPublicPermit({ reads, source, funding, permit, id, at }) {
  check(source?.publicMint === true && source.requestId === id && funding?.publicMint === true && funding.owner === null &&
    funding.state === 'consumed' && funding.permitHash === permit.digest, 'public_permit_binding');
  check(await readPublicWinner(reads, source.asset, source.request.block, at, source.capacity?.supplyScope) === id, 'public_minted');
  const scan = await reads.financialRecord('fp/public/' + publicPlotId(source.asset, source.request.block, source.capacity?.supplyScope), at);
  check(scan?.winner?.id === id && scan.winner.permitHash === permit.digest &&
    equal(scan.winner.source, source), 'public_permit_binding');
}
