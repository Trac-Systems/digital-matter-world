// TAP Wallet 1.0.48: action receipts describe inscriptions, not confirmation.
// getCurrentAuthority selects global authorities only, including for transfers.
const inscription = value => /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(value ?? '');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw Error(message); };
// Players turn on 1-TX Transfers in TAP Wallet themselves; DMW only checks it.
export const GLOBAL_AUTHORITY_NOTICE = 'Turn on 1-TX Transfers in TAP Wallet first: open Settings, then Manage Authority, then Create Authority (it covers all tokens). When it is ready, press Tap and wait until it shows Tapped. This is a one-time step with a small Bitcoin fee. Nothing was paid or reserved here.';
export const AUTHORITY_PENDING_NOTICE = 'TAP Wallet is still setting up 1-TX Transfers. Open Settings, then Manage Authority: press Tap when it is ready and wait until it shows Tapped, then try again. Nothing was paid or reserved here.';
// The one minimum TAP Wallet version for every DMW TAP Wallet action (site, dashboard, kit).
export const TAP_WALLET_MIN_VERSION = '1.0.49';
export const TAP_WALLET_TOO_OLD = `This needs TAP Wallet ${TAP_WALLET_MIN_VERSION} or newer. Update TAP Wallet, then reload this page.`;
const versionParts = value => typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){0,3}$/.test(value) ? value.split('.').map(Number) : null;
// Numeric comparison: 1.0.100 is newer than 1.0.49. A missing or malformed version is too old.
export function versionAtLeast(version, minimum = TAP_WALLET_MIN_VERSION) {
  const a = versionParts(version), b = versionParts(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}
// Asked before any other wallet call; a wallet without getCapabilities predates 1.0.49.
export async function tapWalletCapabilities(tap) {
  let capabilities = null;
  try { capabilities = typeof tap?.getCapabilities === 'function' ? await tap.getCapabilities() : null; } catch {}
  if (!versionAtLeast(capabilities?.version)) fail(TAP_WALLET_TOO_OLD);
  return capabilities;
}
export const isGlobalAuthority = (value, address) => inscription(value?.ins) && Array.isArray(value.auth) && value.auth.length === 0 && value.addr === address;
export const noAuthority = error => error?.message === 'No authority found';
export function requireAuthorityAPI(tap) {
  if (!['getCurrentAuthority', 'getAuthorityStatus'].every(name => typeof tap?.[name] === 'function'))
    fail('This TAP Wallet does not support 1-TX Transfers. Update TAP Wallet before continuing.');
}
export async function tapOrderResult(tap, result, { attempts = 90, wait = pause } = {}) {
  if (inscription(result?.inscriptionId) && result.pending === false) return result.inscriptionId;
  if (!result?.orderId) fail('Wallet did not return an inscription order. Inspect the wallet before retrying.');
  for (let i = 0; i < attempts; i++) {
    let next;
    try { next = await tap.getTapActionOrderResult(result.orderId); }
    catch { fail('The wallet could not read the saved inscription order. Resume to read it again; do not pay again. TAP Wallet 1.0.48 may need an order lookup update.'); }
    if (next?.orderId !== result.orderId) fail('The wallet returned a different inscription order. Keep the saved receipt and inspect the wallet.');
    if (inscription(next.inscriptionId) && next.pending === false) return next.inscriptionId;
    if (i + 1 < attempts) await wait(2000);
  }
  fail('Inscription order is pending. Resume to check the saved order again.');
}
// Returns the active global authority (1-TX Transfers on), or explains how to
// turn it on in TAP Wallet. It never creates or activates an authority.
export async function ensureTapAuthority(tap, address, _journal, { checkAccount = async () => {} } = {}) {
  requireAuthorityAPI(tap);
  await checkAccount();
  const active = await tap.getCurrentAuthority();
  if (isGlobalAuthority(active, address)) return active.ins;
  const status = await tap.getAuthorityStatus().catch(() => null);
  fail(status?.readyToTap || status?.pendingAuthority ? AUTHORITY_PENDING_NOTICE : GLOBAL_AUTHORITY_NOTICE);
}
