const valid = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const key = id => 'dmw-public-mint-requester/' + id;
// Public bulk orders started in this browser (newest first), so the Mint page can reopen them.
const ORDERS = 'dmw-public-bulk-orders', ORDERS_KEPT = 20;

export function requesterSecret(id) {
  if (!valid(id)) return null;
  try { const value = localStorage.getItem(key(id)); return valid(value) ? value : null; } catch { return null; }
}
// A single public mint ({ publicMint, requestId }) or a public bulk order ({ publicBulk, orderId }).
export function rememberRequester(result) {
  const id = result?.publicMint ? result.requestId : result?.publicBulk ? result.orderId : null;
  if (!valid(id) || !valid(result.requesterSecret)) return;
  try { localStorage.setItem(key(id), result.requesterSecret); }
  catch { throw Error('public_mint_storage_unavailable'); }
}
export function rememberOrder({ orderId, asset, blocks, at = Date.now() }) {
  if (!valid(orderId)) return;
  try { localStorage.setItem(ORDERS, JSON.stringify([{ orderId, asset, blocks, at }, ...savedOrders().filter(o => o.orderId !== orderId)].slice(0, ORDERS_KEPT))); }
  catch { /* the order page still opens from its address */ }
}
export function savedOrders() {
  try {
    const rows = JSON.parse(localStorage.getItem(ORDERS) ?? '[]');
    return Array.isArray(rows) ? rows.filter(o => valid(o?.orderId) && requesterSecret(o.orderId) && typeof o.asset === 'string' && Number.isSafeInteger(o.blocks)) : [];
  } catch { return []; }
}
export function requesterHeaders(path, body) {
  const match = /^(?:\/gateway)?\/(?:web-api\/)?(?:mint|public-mints\/bulk)\/([0-9a-f]{64})(?:\/(?:payment|inscriptions))?$/.exec(path);
  const id = match?.[1] ?? (/^(?:\/gateway)?\/mint\/payment$/.test(path) ? body?.id ?? body?.requestId : null);
  const secret = requesterSecret(id);
  return secret ? { 'X-Mint-Requester-Secret': secret } : {};
}
