import { check, equal } from './crypto.mjs';
import { hex } from '../../rules/src/core.js';
import { publicPlotId } from '../../rules/src/public-mint.js';

export async function readPublicWinner(reads, asset, block, at) {
  check(typeof reads.financialRecord === 'function', 'public_mint_evidence_missing');
  const id = await reads.financialRecord(`dc/plot/${asset}/${block}`, at);
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
  for (const file of files) for (const row of file.publicMintEvidence ?? []) {
    const key = row.asset + '/' + row.block;
    if (!checked.has(key)) checked.set(key, await readPublicWinner(reads, row.asset, row.block, at));
    check(checked.get(key) === row.id, 'public_mint_evidence_read');
  }
}

export async function verifyPublicPermit({ reads, source, funding, permit, id, at }) {
  check(source?.publicMint === true && source.requestId === id && funding?.publicMint === true && funding.owner === null &&
    funding.state === 'consumed' && funding.permitHash === permit.digest, 'public_permit_binding');
  check(await readPublicWinner(reads, source.asset, source.request.block, at) === id, 'public_minted');
  const scan = await reads.financialRecord('fp/public/' + publicPlotId(source.asset, source.request.block), at);
  check(scan?.winner?.id === id && scan.winner.permitHash === permit.digest &&
    equal(scan.winner.source, source), 'public_permit_binding');
}
