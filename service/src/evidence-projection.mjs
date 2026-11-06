import { check } from './util.mjs';
const projections = {
  mints: ['id','request','signature','receiver','payer','kind','authorization','requestedFeeQuote','quote','context','feeAuthorization','paymentId','paymentIds','creditIds','permit','mintInscription','publicMint'],
  batches: ['batch','publications'], receiptObservations: ['seal','receipts','archive'],
  financialLinks: ['id','request','signature','payer','receiver','kind','requestedFeeQuote','quote','feeAuthorization','legacyLink'],
  linkRequests: ['id','request','sig','terms','paymentId'],
  payoutBindings: ['id','request','agentSignature','walletSignature','acceptedAt','attestations'], payoutTransitions: ['id','acceptedAt']
};
const plain = new Set(['activeMints','paymentRequests','receiptCertificates','receiptCutoffPages','finds','findProvenance','patternProvenance','typeProvenance','types','payoutCurrent','mintAdmissions','financialAdmissions','financialRecordProvenance','financialCustodyPayments','assetCheckpoint','evidenceContexts','patternsByAsset','officialCatalogNames','officialCatalogNameIndex','tickerPayments']);
export function exportableSpace(space) { return Object.hasOwn(projections, space) || plain.has(space) || ['meta', 'ceremonies'].includes(space) || /^payoutHistory\/[0-9a-f]{64}\/(tap|ethereum)$/.test(space) || /^payoutOwners\/[0-9a-f]{64}$/.test(space); }
export function projectEvidence(space, id, row) {
  check(exportableSpace(space), 'evidence_space');
  if (space === 'meta' && id !== 'patterns' || space === 'ceremonies' && !id.startsWith('mint/')) return undefined;
  if (row == null) return null;
  if (space === 'ceremonies') return { stage: row.stage, result: { certificate: row.result?.certificate ?? null } };
  if (projections[space]) return Object.fromEntries(projections[space].filter(k => row[k] !== undefined).map(k => [k, row[k]]));
  return row;
}
export function noSecrets(value, maxDepth, depth = 0) {
  check(depth < maxDepth, 'evidence_depth');
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    check(!/^(secret|secretKey|privateKey|gatewayKey|gatewaySecret|passphrase|password|journalKey|apiToken|sidecarToken|preimage|shares|keys|credentials)$/i.test(key), 'evidence_secret_field');
    noSecrets(item, maxDepth, depth + 1);
  }
}
