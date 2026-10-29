import { assert, exactKeys, hex, stableJSON, utf8 } from './core.js';
import { decimalV2, findIdV2, patternAssetV2 } from './integers-v2.js';
import { recordGet, recordSet } from './record-index.js';
import { claimsNeverCloseActive, settlePublicPayments } from './public-mint.js';

// Catalog aliases are lookup hints. The catalog's legacy asset, when present,
// remains the sole ledger identity; an alias cannot create a second plot.
export function patternCatalogId(asset) {
  if (typeof asset !== 'string') return null;
  if (/^p2:(0|[1-9][0-9]*)$/.test(asset)) return asset;
  if (!/^p[0-9a-z]{1,23}$/.test(asset)) return null;
  let number = 0n;
  for (const digit of asset.slice(1)) number = number * 36n + BigInt(parseInt(digit, 36));
  return patternAssetV2(String(number));
}
export const patternLedgerAsset = pattern => pattern.legacy?.asset ?? patternAssetV2(decimalV2(pattern.number));
export function publicPatternForAsset(patterns, asset) {
  const catalogAsset = patternCatalogId(asset), number = catalogAsset?.slice(3);
  const pattern = number === undefined ? null : typeof patterns?.get === 'function' ? patterns.get(number) : recordGet(patterns, number);
  assert(pattern && decimalV2(pattern.number) === number &&
    (asset === catalogAsset || asset === patternLedgerAsset(pattern)), 'public_claim_asset');
  return { pattern, asset: patternLedgerAsset(pattern), catalogAsset };
}

// Only old public plots need a notary point read. New public winners are also
// committed in claimReservations, so later observations need no history scan.
export function publicTaken(state, slot) {
  const reservation = recordGet(state.claimReservations, slot.id);
  if (reservation?.publicMint === true) return reservation.winner;
  return state.publicMintGet?.(slot.asset, decimalV2(slot.block)) ?? null;
}
export function publicScanClaim({ state, pattern, asset, block, settings, height }) {
  assert(claimsNeverCloseActive(settings, height), 'claims_never_close_inactive');
  const number = decimalV2(pattern.number), id = findIdV2(decimalV2(block), number);
  assert(asset === patternLedgerAsset(pattern), 'public_claim_asset');
  const publicWinner = publicTaken(state, { id, asset, block });
  const reservation = recordGet(state.claimReservations, id), draw = recordGet(state.headerAwards, decimalV2(block));
  const claimed = !publicWinner && !!(recordGet(state.finds, id) || reservation ||
    draw && BigInt(draw.senderCount) > 0n && BigInt(number) < BigInt(draw.catalog.nextNumber));
  return { pattern: number, claimed, publicWinner };
}
export function validatePublicScanClaim(claim, asset) {
  assert(claim && exactKeys(claim, ['pattern', 'claimed', 'publicWinner']) &&
    patternCatalogId(asset) === patternAssetV2(decimalV2(claim.pattern)) && typeof claim.claimed === 'boolean' &&
    (claim.publicWinner === null || hex(claim.publicWinner, 32)) && !(claim.claimed && claim.publicWinner), 'public_claim_binding');
  return claim;
}
export function applyPublicClaimScan({ state, patterns, operation, settings, height }) {
  const { asset, block, payments } = operation;
  const { pattern } = publicPatternForAsset(patterns, asset);
  const claim = publicScanClaim({ state, pattern, asset, block, settings, height });
  validatePublicScanClaim(operation.claim, asset);
  assert(stableJSON(operation.claim) === stableJSON(claim), 'public_claim_binding');
  // The contract independently binds publicWinner to its existing scan row.
  const winner = claim.publicWinner ?? settlePublicPayments(null, payments, claim).winner?.id;
  if (winner && !claim.claimed) {
    const id = findIdV2(decimalV2(block), claim.pattern);
    state.claimReservations = recordSet(state.claimReservations, id,
      { publicMint: true, winner, asset, block: decimalV2(block), pattern: claim.pattern });
  }
  return claim;
}

// Read answers are included in the audit file and independently checked by
// signers against dc/plot + fp at the batch predecessor. Missing answers must
// abort replay, never turn into an ordinary rejected agent move.
export function publicMintEvidenceReader(evidence = [], read, maxBytes) {
  assert(Array.isArray(evidence) && utf8(stableJSON(evidence)).length <= maxBytes, 'public_mint_evidence_budget');
  const supplied = new Map(), used = new Map(), key = (asset, block) => `${asset}/${block}`;
  let usedBytes = 2;
  for (const row of evidence) {
    assert(exactKeys(row, ['asset', 'block', 'id']) && patternCatalogId(row.asset) && decimalV2(row.block) === row.block &&
      (row.id === null || hex(row.id, 32)) && !supplied.has(key(row.asset, row.block)), 'public_mint_evidence');
    supplied.set(key(row.asset, row.block), row);
  }
  return {
    get(asset, block) {
      const id = key(asset, block);
      if (!used.has(id)) {
        let row = supplied.get(id);
        if (!row) {
          let answer;
          try { answer = read?.(asset, block); } catch { throw Error('public_mint_evidence_missing'); }
          assert(answer === null || hex(answer, 32), 'public_mint_evidence_missing');
          row = { asset, block, id: answer };
        }
        usedBytes += utf8(stableJSON(row)).length + (used.size ? 1 : 0);
        assert(usedBytes <= maxBytes, 'public_mint_evidence_budget');
        used.set(id, row);
      }
      return used.get(id).id;
    },
    rows: () => [...used].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row)
  };
}
