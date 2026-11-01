import { hashObject, stableJSON, mintRight, decimalV2, addUint, validateSettingsDocument, multiTickerActive, perTickerSupplyActive } from '../../rules/src/index.js';
import { wireIdentities, encodeTracAddress } from '../../rules/src/trac-address.js';
import { financialMintDigest, financialMintId } from '../../rules/src/financial-mint.js';
import { accountActionDigest } from '../../contract/root-accounts.js';
import { check, sha256, nonce } from './check.mjs';
import { signBytes, signPaymentIntent } from './signing.mjs';

// Two durable packets: the owner's mint intent and its exact account
// reservation. A lost response never changes either signature or nonce.
export async function makeFinancialMint(agent, intent, actionId, candidate, context) {
  const { journal, service, network, wallet, owner } = agent, key = `mint/${actionId}`, old = journal.get(key);
  if (old) check(old.fingerprint === sha256(stableJSON(intent)), 'Conflicting mint action ID');
  if (!agent.dryRun && old && ['submitted', 'accepted', 'rejected'].includes(old.state)) return { ...old.result, state: old.state, replayed: true };
  const { asset: requestedAsset, amount, receiver, payer, kind, compound } = intent, block = intent.block === undefined ? undefined : decimalV2(intent.block);
  // Imported p2 catalog entries still spend their original pN ledger units.
  // Never rewrite a saved signed intent, and only accept the exact numeric alias.
  const legacy = /^p2:(0|[1-9][0-9]*)$/.test(requestedAsset) ? 'p' + BigInt(requestedAsset.slice(3)).toString(36) : null;
  const asset = old?.body.request.asset ?? (!compound && legacy && candidate?.find?.asset === legacy ? legacy : requestedAsset);
  const policyHash = old?.body.request.settingsHash ?? context.settingsHash;
  const policy = policyHash === context.settingsHash ? context.settings : await agent.trac.settingsByHash(policyHash);
  check(hashObject(validateSettingsDocument(policy)) === policyHash && policy.network === network, 'Financial request settings mismatch');
  const v = policy.values;
  const head = await agent.trac.head();
  check(compound ? block === undefined : candidate?.find?.asset === asset && decimalV2(candidate.find.block) === block && String(candidate.find.count) === amount &&
    !candidate.void && !candidate.pending && !candidate.minted && mintRight({ find: candidate.find, owner, counted: head.counted,
      link: candidate.link, currentHolder: candidate.currentHolder, finderWindow: v.finderWindow, settings: policy }).allowed, 'Mint right unavailable');
  check(intent.deployment === undefined || multiTickerActive(head.counted), 'multi_ticker_inactive');
  const quoteInput = { ...(intent.deployment === undefined ? {} : { deployment: intent.deployment }), asset, amount, ...(block === undefined ? {} : { block }), kind, payer, receiver };
  const quote = old?.body.feeQuote ? { feeQuote: old.body.feeQuote } : await service.mintQuote(quoteInput);
  if (quote.deploymentNeeded || quote.state === 'deployment_pending') return { ...quote, signed: false,
    ...(quote.deploymentNeeded ? { deploymentLink: service.deploymentLink?.(quote.catalogAsset ?? asset, encodeTracAddress(owner), agent.paymentOrigin),
      next: [{ tool: 'inscribe_deployment', arguments: { asset: quote.asset ?? asset } }] } :
      { next: [{ tool: 'mint_on_chain', arguments: { ...intent, actionId } }] }) };
  check(!quote.asset || quote.asset === asset, 'Mint ledger asset mismatch');
  check(compound || !intent.deployment || !perTickerSupplyActive(head.counted) || candidate?.deployment === quote.feeQuote?.deploymentId, 'Mint candidate deployment mismatch');
  check(quote.feeQuote?.settingsHash === policyHash, 'Financial quote settings mismatch');
  const request = old?.body.request ?? { v: 2, owner, asset, amount, ...(intent.deployment === undefined ? {} : { deployment: quote.feeQuote.deploymentId }), receive: sha256(receiver), ...(block === undefined ? {} : { block }), nonce: nonce(),
    until: addUint(decimalV2(head.counted), String(v.moveFreshnessTips)), expires: addUint(decimalV2(head.counted), String(v.pendingBlocks)), settingsHash: policyHash };
  if (!old) check(BigInt(request.expires) - BigInt(head.counted) >= BigInt(v.requestMinBlocks) && BigInt(request.expires) - BigInt(head.counted) <= BigInt(v.requestMaxBlocks), 'Mint request expired');
  if (agent.dryRun) return { state: 'dry-run', request, receiver, payer, quote, signatureExposed: false };
  const body = old?.body ?? { version: 2, request, receiver, payer, kind, feeQuote: quote.feeQuote,
    signature: signBytes(wallet, financialMintDigest(network, request)),
    authorization: signPaymentIntent(wallet, network, { request, receiver, payer, kind, feeQuote: quote.feeQuote }) };
  const saved = journal.reserve(key, intent, body), id = financialMintId(network, request), reservationKey = key + '/reservation-v2';
  await journal.waitTurn(() => agent.trac.head()); journal.mark(key, 'sending');
  try {
    let reservation = journal.get(reservationKey), response;
    if (!reservation) {
      response = wireIdentities(await service.requestMint(saved.body));
      if (response.deploymentNeeded || response.state === 'deployment_pending') {
        journal.mark(key, 'unknown');
        return { ...response, signed: true, next: response.deploymentNeeded ? [{ tool: 'inscribe_deployment', arguments: { asset } }] :
          [{ tool: 'mint_on_chain', arguments: { ...intent, actionId } }] };
      }
      check((response.id ?? response.requestId) === id, 'Mint request ID mismatch');
      const action = response.reservationAction, evidence = response.reservationEvidence;
      check(response.state === 'authorizing' && evidence && evidence.version === 2 && evidence.requestId === id && evidence.owner === owner &&
        evidence.asset === asset && evidence.amount === amount && evidence.receiver === receiver && evidence.payer === payer && evidence.rail === kind &&
        evidence.expiry === request.expires && evidence.settingsHash === request.settingsHash &&
        stableJSON(evidence.request) === stableJSON(request) && stableJSON(evidence.quote) === stableJSON(saved.body.feeQuote) &&
        evidence.signature === saved.body.signature && evidence.authorization === saved.body.authorization, 'Mint reservation terms mismatch');
      check(action && /^(0|[1-9][0-9]*)$/.test(action.revision) && stableJSON(action) === stableJSON({ type: 'reserve', id, owner, asset, amount,
        terms: hashObject(evidence), revision: action.revision, nonce: request.nonce, until: request.until }), 'Mint reservation action mismatch');
      const reserve = { ...action, sig: signBytes(wallet, accountActionDigest(network, action)) };
      reservation = journal.reserve(reservationKey, { id, terms: action.terms }, { version: 2, reserve });
    }
    response = wireIdentities(await service.requestMint({ ...saved.body, reserve: reservation.body.reserve }));
    check((response.id ?? response.requestId) === id && response.state !== 'authorizing', 'Mint reservation not acknowledged');
    const result = { state: 'submitted', request: response, paymentLink: service.paymentLink(id, agent.paymentOrigin),
      next: [{ tool: 'poll_mint', arguments: { id } }, { tool: 'pay_mint', arguments: { id } }, { tool: 'inscribe_mint', arguments: { id } }] };
    journal.mark(reservationKey, 'submitted', { id }); journal.mark(key, 'submitted', result); return result;
  } catch (error) { journal.mark(key, 'unknown'); throw error; }
  finally { journal.finishTurn(); }
}
