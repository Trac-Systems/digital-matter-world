import { permit, attachPermit } from '../../committee/signer/adapter.mjs';
import { measureBulkInscriptions } from '../../kit/lib/inscription-batch-core.mjs';
import { rules } from './rules.mjs';
import { check } from './util.mjs';

export async function quoteBulkFunding({ orderId, network, bitcoinNetwork, members, deployment, receiver, payer, settings, feeRate, address }) {
  const { BULK_LIMITS, bulkMemberId } = await import('../../rules/src/bulk-mint.js');
  check(/^[0-9a-f]{64}$/.test(orderId) && Array.isArray(members) && members.length > 0 && members.length <= BULK_LIMITS.members, 'bulk_funding_input');
  check(Number.isFinite(feeRate) && feeRate >= 1 && feeRate <= settings.maxFeeRate, 'bulk_fee_unavailable');
  // Signed terms carry whole numbers only; fee estimates can be fractional (e.g. 2.125 sat/vB).
  const quotedRate = Math.ceil(feeRate), feeRateCeiling = Math.ceil(feeRate * settings.feeMargin);
  check(feeRateCeiling <= settings.maxFeeRate, 'bulk_fee_wait');
  check(deployment?.kind === 'dmt' && typeof deployment.id === 'string' && typeof deployment.tick === 'string', 'bulk_funding_deployment');
  const texts = members.map((m, i) => rules.stableJSON(attachPermit(permit(network, m, deployment, receiver, bulkMemberId(orderId, i), 'f'.repeat(64)), { r: '9'.repeat(78), s: '9'.repeat(78), v: 1 })));
  let best = null, low = 1, high = texts.length;
  // Layout costs grow monotonically, including the extra fee output at each
  // reveal boundary. Binary search avoids rebuilding every smaller prefix.
  while (low <= high) {
    const n = Math.floor((low + high) / 2);
    const sizes = measureBulkInscriptions({ texts: texts.slice(0, n), receiver, payer, network: bitcoinNetwork });
    if (sizes.templateBytes.some(bytes => bytes > BULK_LIMITS.mintPayloadBytes) || sizes.revealWeights.some(w => w > BULK_LIMITS.revealWeight)) { high = n - 1; continue; }
    const maxFeeSats = Math.ceil(sizes.commitVsize * feeRateCeiling) + sizes.revealVsizes.reduce((sum, v) => sum + Math.max(546, Math.ceil(v * feeRateCeiling)), 0);
    const satoshis = n * 546 + maxFeeSats + 6000 + 546;
    if (maxFeeSats > Math.min(90000, settings.maxFeeSats) || satoshis > Math.min(100000, settings.maxFundingSats)) { high = n - 1; continue; }
    best = { fits: n === members.length, maxMembers: n, mintFunding: { address, satoshis, feeRate: quotedRate, feeRateCeiling, maxFeeSats: String(maxFeeSats), postageSats: 546, returnReserveSats: 6000, label: 'your bulk mint inscriptions' },
      templateBytes: sizes.templateBytes, commitVsize: sizes.commitVsize, revealVsizes: sizes.revealVsizes };
    low = n + 1;
  }
  return best ?? { fits: false, maxMembers: 0, mintFunding: null, templateBytes: [], commitVsize: 0, revealVsizes: [] };
}
