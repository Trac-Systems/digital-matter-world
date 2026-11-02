import { hashObject, stableJSON, decimalV2, addUint, validateSettingsDocument, feeFor } from '../../rules/src/index.js';
import { wireIdentities } from '../../rules/src/trac-address.js';
import { financialLinkDigest, financialLinkId } from '../../rules/src/financial-link.js';
import { lifecycleDigest } from '../../contract/financial-lifecycle.js';
import { check, sha256, nonce } from './check.mjs';
import { signBytes } from './signing.mjs';

// These refusals happen before a new request is saved by the gateway. A prior
// ambiguous send still stays unknown, even if a later attempt is refused.
export const LINK_RENEW_REFUSALS = ['fee_quote_expired', 'financial_link_deadline', 'financial_link_quote_changed'];
const LINK_FINAL_REFUSALS = ['link_exists', 'bitmap_missing', 'bitmap_agent_binding', 'financial_link_owner'];

export async function makeFinancialLink(agent, { actionId, height, payer, freeOnly = false }, context) {
  const { journal, service, network, wallet, owner } = agent, key = `link/${actionId}`, block = decimalV2(height), intent = { block, payer }, old = journal.get(key);
  if (old) check(old.fingerprint === sha256(stableJSON(intent)), 'Conflicting plot action ID');
  if (!agent.dryRun && old && ['submitted', 'accepted', 'rejected'].includes(old.state)) return { ...old.result, state: old.state, replayed: true };
  const settingsHash = old?.body.request.settingsHash ?? context.settingsHash;
  const settings = validateSettingsDocument(settingsHash === context.settingsHash ? context.settings : await agent.trac.settingsByHash(settingsHash));
  check(settings.network === network && hashObject(settings) === settingsHash, 'Link settings mismatch');
  const head = await agent.trac.head(); check(BigInt(block) <= BigInt(head.counted), freeOnly ? 'not_a_bitmap' : 'Plot is ahead of Bitcoin tip');
  const preview = old ? null : wireIdentities(await service.linkQuote({ block, payer }));
  const quote = old?.body.feeQuote ?? preview.feeQuote;
  if (freeOnly && preview) check(preview.bitmap?.agent === owner && preview.bitmap?.address === payer, 'not_in_wallet');
  check(quote.settingsHash === settingsHash, 'Link quote settings mismatch');
  const request = old?.body.request ?? { v: 2, kind: 'link', owner, block, payer, nonce: nonce(),
    until: addUint(decimalV2(head.counted), String(settings.values.pendingBlocks)), settingsHash, quoteHash: hashObject(quote) };
  const free = settings.values.linkMultiplier === 0 && feeFor('link', quote.baseFee, 1, quote.feeSettings, head.counted) === '0';
  check(settings.values.linkMultiplier !== 0 || free, 'Link fee mismatch');
  check(!freeOnly || free, 'link_not_free');
  if (agent.dryRun) return { state: 'dry-run', action: 'link', request, payer, signed: false, ...(free ? { fee: 'Free' } : {}) };
  const body = old?.body ?? { version: 2, request, feeQuote: quote, signature: signBytes(wallet, financialLinkDigest(network, request)) };
  const saved = journal.reserve(key, intent, body), id = financialLinkId(network, request), reservationKey = key + '/reservation-v2';
  await journal.waitTurn(() => agent.trac.head()); journal.mark(key, 'sending');
  try {
    let reserved = journal.get(reservationKey);
    if (!reserved) {
      const response = wireIdentities(await service.requestLink(saved.body)), a = response.reservationAction, e = response.reservationEvidence;
      check(response.id === id && response.state === 'authorizing' && e?.version === 2 && e.state === 'reservable' && e.requestId === id &&
        e.owner === owner && e.bitmapOwner === owner && e.block === block && e.until === request.until && e.payer === payer && e.receiver === payer &&
        e.rail === 'tap' && e.settingsHash === settingsHash && stableJSON(e.request) === stableJSON(request) && stableJSON(e.quote) === stableJSON(quote) &&
        e.signature === saved.body.signature, 'Link reservation terms mismatch');
      if (freeOnly) check(e.bitmap?.address === payer, 'not_in_wallet');
      check(stableJSON(a) === stableJSON({ type: 'link-reserve', id, owner, block, terms: hashObject(e), until: request.until }), 'Link reservation action mismatch');
      reserved = journal.reserve(reservationKey, { id, terms: a.terms }, { version: 2, reserve: { ...a, sig: signBytes(wallet, lifecycleDigest(network, a)) } });
    }
    const response = wireIdentities(await service.requestLink({ ...saved.body, reserve: reserved.body.reserve }));
    check(response.id === id && response.state !== 'authorizing', 'Link reservation not acknowledged');
    check((response.price === '0') === free, 'Link fee mismatch');
    const result = { state: 'submitted', request: response, paymentLink: service.paymentLink(id, agent.paymentOrigin, 'link'),
      ...(response.price === '0' ? { fee: 'Free' } : {}),
      next: [{ tool: 'poll_link', arguments: { id } }, ...(response.price === '0' ? [] : [{ tool: 'pay_link', arguments: { id } }])] };
    journal.mark(reservationKey, 'submitted', { id }); journal.mark(key, 'submitted', result); return result;
  } catch (error) {
    const refused = [400, 409].includes(error.status) && [...LINK_RENEW_REFUSALS, ...LINK_FINAL_REFUSALS].includes(error.code) &&
      (!old || ['prepared', 'refused'].includes(old.state)) && !journal.get(reservationKey);
    journal.mark(key, refused ? 'refused' : 'unknown', refused ? { code: error.code } : null); throw error;
  }
  finally { journal.finishTurn(); }
}
