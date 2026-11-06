import { rules } from './rules.mjs';
import { check, heightKey } from './util.mjs';
import { same } from './deployments.mjs';

// A valid detached permit can be inscribed by anyone. Follow the official
// deployment/block's winning record rather than requiring our reveal txid.
export async function winningMint(reads, row, entry, recovered, view) {
  if (!row.permit) return null;
  const d = row.context.deployment;
  let inscription = entry?.id;
  if (d.kind === 'dmt') {
    const deployment = await reads.tap('getDeployment/' + encodeURIComponent('dmt-' + d.tick));
    check(deployment?.ins === d.id, 'deployment_binding');
    const winner = await reads.tap('getDmtMintHolderByBlock/' + encodeURIComponent('dmt-' + d.tick) + '/' + row.request.block);
    if (!winner) return null;
    inscription = winner.ins;
  }
  if (!inscription && d.kind === 'compound') {
    check(typeof reads.mintByPermit === 'function', 'tap_mint_lookup_required');
    const candidate = await reads.mintByPermit(row.receiver, d.tick, row.permit.dta, row.request.amount);
    inscription = candidate?.ins;
  }
  if (!inscription) return null;
  check(typeof reads.mintedInscription === 'function', 'tap_mint_lookup_required');
  const minted = await reads.mintedInscription(inscription);
  check(!minted || minted.ins === inscription, 'indexed_mint_binding');
  if (!minted || minted.fail !== false) return null;
  const canonical = await reads.included(inscription, view); if (!canonical) return null;
  const payload = await reads.content(inscription);
  check(same(payload, row.permit) && payload.tick === d.tick && minted.tick === (d.kind === 'dmt' ? 'dmt-' + d.tick : d.tick) &&
    payload.prv.address === row.receiver && minted.addr === row.receiver && minted.amt === row.request.amount && payload.dta === minted.dta, 'indexed_mint_binding');
  check(d.kind !== 'dmt' || payload.dep === d.id && rules.decimalV2(payload.blk) === rules.decimalV2(row.request.block), 'indexed_mint_deployment');
  const committee = recovered(payload.prv.hash, payload.prv.sig);
  check(committee === d.privilegePublicKey, 'indexed_mint_authority');
  return { accepted: true, fail: false, confirmations: canonical.confirmations, inscription, deployment: d.id, tick: d.tick,
    receiver: minted.addr, amount: minted.amt, dta: payload.dta, permitHash: payload.prv.hash, committee,
    ...(d.kind === 'dmt' ? { block: row.request.v === 2 ? rules.decimalV2(payload.blk) : Number(payload.blk) } : {}) };
}

// Signers keep no site (public) mint rows. Rebuild one from the accepted source
// record and the deterministic permit plan for that accepted payment; only the
// committee signature comes from the winning inscription, and winningMint checks
// it against the committee key like every other field.
export async function acceptedPublicMintRow(reads, id, at) {
  const source = await reads.financialRecord('fi/source/' + id, at);
  if (source?.publicMint !== true || source.requestId !== id || !source.deployment) return null;
  const { permit: p } = await reads.publicMintPermit(id, at), d = source.deployment;
  const expected = { ...p.payload, prv: { address: p.address, salt: p.salt, hash: p.digest } };
  const holder = d.kind === 'dmt' ? await reads.tap('getDmtMintHolderByBlock/' + encodeURIComponent('dmt-' + d.tick) + '/' + source.request.block)
    : d.kind === 'compound' && typeof reads.mintByPermit === 'function' ? await reads.mintByPermit(source.receiver, d.tick, expected.dta, source.request.amount) : null;
  const payload = holder?.ins ? await reads.content(holder.ins) : null, { sig, ...prv } = payload?.prv ?? {};
  const permit = payload && sig && rules.stableJSON({ ...payload, prv }) === rules.stableJSON(expected) ? payload : expected;
  return { id, publicMint: true, request: source.request, receiver: source.receiver, context: { deployment: d }, permit };
}

// An accepted financial batch runs at its final counted height. The callback
// verifies the audit's Merkle root against Trac before any frozen term is used.
export async function admittedMint({ store, reads, audits, network, id }) {
  const pending = await reads.pendingAcceptance(id);
  check(pending?.id === id && Number.isSafeInteger(pending.created), 'pending_acceptance');
  const provenance = await store.get('mintAdmissions', id);
  check(provenance && Number.isSafeInteger(provenance.n) && Number.isSafeInteger(provenance.file) && Number.isSafeInteger(provenance.index), 'mint_admission_index_required');
  const batch = await store.get('batches', heightKey(provenance.n));
  check(batch?.batch.to === pending.created, 'mint_admission_evidence_missing');
  const file = (await audits(provenance.n))[provenance.file], input = file?.mintOperations?.[provenance.index];
  check(input?.op === 'rq' && file.mintOutcomes?.[provenance.index]?.reason === 'accepted' && rules.pendingId(network, input.request) === id, 'mint_admission_evidence_missing');
  check(rules.verifyRequest('rq', network, input.request, input.sig, input.request.until), 'owner_signature');
  return { context: input.evidence.context, bitmap: input.evidence.bitmap };
}
