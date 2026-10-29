const valid = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const key = id => 'dmw-public-mint-requester/' + id;

export function requesterSecret(id) {
  if (!valid(id)) return null;
  try { const value = localStorage.getItem(key(id)); return valid(value) ? value : null; } catch { return null; }
}
export function rememberRequester(result) {
  if (!result?.publicMint || !valid(result.requestId) || !valid(result.requesterSecret)) return;
  try { localStorage.setItem(key(result.requestId), result.requesterSecret); }
  catch { throw Error('public_mint_storage_unavailable'); }
}
export function requesterHeaders(path, body) {
  const match = /^(?:\/gateway)?\/(?:web-api\/)?mint\/([0-9a-f]{64})$/.exec(path);
  const id = match?.[1] ?? (/^(?:\/gateway)?\/mint\/payment$/.test(path) ? body?.id ?? body?.requestId : null);
  const secret = requesterSecret(id);
  return secret ? { 'X-Mint-Requester-Secret': secret } : {};
}
