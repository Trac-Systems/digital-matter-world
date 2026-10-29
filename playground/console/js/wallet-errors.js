export const publicMintMessages = {
  someone_paid_first: 'Someone else’s payment for this block confirmed first, so it can no longer be minted here.',
  already_minted: 'This block is already minted.',
  claimed: 'This block was claimed in its claim week, so it is not public.',
  claim_window_open: 'The claim week of this block is not over yet.',
  bitmap_holder_only: 'Only the TAP Wallet holding this block’s Bitmap can mint it. Select that account in TAP Wallet and try again.',
  public_mint_inactive: 'Public minting opens soon.',
  public_index_warming: 'The list of public blocks is still being built. Try again in a few minutes.',
  public_scan_pending: 'Recent Bitcoin payments for this block are still being checked. Try again in a few minutes.',
  payment_unconfirmed: 'The payment is waiting for a Bitcoin confirmation. Keep this request and check again; do not pay again.',
  public_payment_incomplete: 'The payment did not cover every quoted fee. Check this request and its refund record before sending another payment.',
  quote_expired: 'The price changed. Press Mint again for a new quote.',
};
const messages = {
  ...publicMintMessages,
  binding_wallet_signature: "Your wallet's signature was not accepted. Make sure the wallet shown above is the active account and try again.",
  binding_expired: 'Request expired. Ask your agent for a new binding link.',
  binding_nonce: 'A newer payout binding already exists. Ask your agent for a new binding link.',
  binding_conflict: 'This binding was already signed with a different signature. Refresh to check its receipt before trying again.',
  binding_request_missing: 'This binding link could not be found. Ask your agent for a new binding link.',
  binding_missing: 'This payout binding could not be found. Ask your agent to check its binding request.',
  binding_agent_signature: 'The agent signature was not accepted. Ask your agent for a new binding link.',
  binding_address: 'The wallet address is invalid. Ask your agent for a new request with the correct wallet address.',
  binding_taproot_required: 'Select a Bitcoin Taproot wallet and ask your agent for a request using that address.',
  binding_network: 'The Bitcoin network does not match this request. Select the requested network in your wallet.',
  binding_quorum: 'The payout binding is waiting for committee approval. Retry this same request shortly.',
  binding_transition: 'A payout wallet change is still being approved. Wait for its receipt, then try again.',
  binding_clock: 'The binding could not be accepted at this time. Ask your agent for a new binding link.',
  link_owner: 'The connected payer must own this Bitmap. Check the active account and ask your agent for a new link request.',
  link_deadline: 'This link request has expired. Ask your agent for a new link request.',
  link_terms_conflict: 'This link payment was already prepared with different details. Continue in the browser that prepared it.',
  link_signature: 'The agent signature was not accepted. Ask your agent for a new link request.',
  request_not_found: 'This request could not be found. Check the link with your agent.',
  mint_missing: 'This mint request could not be found. Check the link with your agent.',
  mint_expired: 'This mint request has expired. Ask your agent to check its status before creating a new request.',
  deployment_confirmations: 'Wait until the inscription is included in a Bitcoin block, then register the same receipt again.',
  deployment_receiver: 'Use the wallet that received the pattern element for its token deployment.',
  web_target_unavailable: 'Wallet payments are temporarily unavailable. Try again shortly.',
};
// Keep existing plain wallet guidance, but never put a bare protocol code on a
// payment page. Unknown codes get a retry message without implying a new send.
export function walletError(error) {
  if (Number(error?.code) === 4001) return 'Wallet request cancelled. You can retry.';
  const message = typeof error === 'string' ? error : error?.message;
  if (Object.hasOwn(messages, message)) return messages[message];
  if (typeof message === 'string' && message && !/^[a-z][a-z0-9_]{0,80}$/.test(message)) return message;
  return `The wallet or gateway request could not be completed${typeof message === 'string' && message ? ` (${message})` : ''}. Refresh its status before trying again.`;
}
