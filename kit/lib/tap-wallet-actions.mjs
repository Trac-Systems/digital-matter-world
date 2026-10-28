// TAP Wallet 1.0.48: action receipts describe inscriptions, not confirmation.
// getCurrentAuthority selects global authorities only, including for transfers.
const inscription = value => /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(value ?? '');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw Error(message); };
export const GLOBAL_AUTHORITY_NOTICE = 'TAP Wallet needs a global authority covering all TAP tokens. Review that scope in the wallet. Creating it and activating it each cost Bitcoin fees; future payments still need your wallet approval.';
export const isGlobalAuthority = (value, address) => inscription(value?.ins) && Array.isArray(value.auth) && value.auth.length === 0 && value.addr === address;
export const noAuthority = error => error?.message === 'No authority found';
export function requireAuthorityAPI(tap) {
  if (!['getCurrentAuthority', 'getAuthorityStatus', 'createGlobalTapAuthority', 'sendInscription', 'getInscriptions', 'getTapActionOrderResult'].every(name => typeof tap?.[name] === 'function'))
    fail('This TAP Wallet cannot set up the authority needed for this payment. Update TAP Wallet before continuing.');
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
export async function ensureTapAuthority(tap, address, journal, { notify = () => {}, checkAccount = async () => {}, attempts = 90, wait = pause } = {}) {
  requireAuthorityAPI(tap);
  await checkAccount();
  let active = await tap.getCurrentAuthority();
  if (isGlobalAuthority(active, address)) return active.ins;
  // Reuse this journal, or let the wallet finish an existing setup. Status
  // summaries in 1.0.48 have no inscription/order ID and cannot be paid again.
  if (!await journal.getStep('authority-order')) {
    const status = await tap.getAuthorityStatus();
    if (status?.readyToTap || status?.pendingAuthority)
      fail('An authority setup already exists in TAP Wallet. Check it there before creating another; this payment needs an active global authority.');
  }
  notify(GLOBAL_AUTHORITY_NOTICE);
  await checkAccount();
  const order = await journal.step('authority-order', async () => ({ ...await tap.createGlobalTapAuthority(), requestedScope: 'global' }));
  // Older DMW journals requested ['tap'], which 1.0.48 will never select.
  // Do not activate that receipt as if it were global, or buy a replacement.
  if (order.requestedScope !== 'global') fail('This saved authority was requested by an older payment flow. Check the existing setup in TAP Wallet and select an active global authority before resuming.');
  const ins = await tapOrderResult(tap, order, { attempts, wait });
  if (!await journal.getStep('authority-activation')) {
    // A ready order can precede the inscription UTXO. Only offer activation
    // after the wallet lists the inscription as owned by this account.
    let available = false;
    for (let i = 0; i < attempts && !available; i++) {
      await checkAccount();
      for (let page = 0; page < 10; page++) {
        const result = await tap.getInscriptions(page * 100, 100);
        if (!Array.isArray(result?.list)) fail('Wallet inscriptions are unavailable. Resume to check again.');
        available = result.list.some(item => item.inscriptionId === ins);
        if (available || (page + 1) * 100 >= result.total || !result.list.length) break;
      }
      if (!available && i + 1 < attempts) await wait(2000);
    }
    if (!available) fail('Authority inscription is not available in the wallet yet. Resume after it appears.');
  }
  await checkAccount();
  notify('Approve the authority activation self-send in TAP Wallet, then wait for it to be indexed.');
  await journal.step('authority-activation', () => tap.sendInscription(address, ins), {
    // sendInscription throws this before building/signing/broadcasting its tx.
    definitelyNotSent: error => error?.message === 'UTXO not found.',
  });
  for (let i = 0; i < attempts; i++) {
    await checkAccount(); active = await tap.getCurrentAuthority();
    if (active?.ins === ins && isGlobalAuthority(active, address)) return ins;
    if (i + 1 < attempts) await wait(2000);
  }
  fail('Authority activation is pending. Resume after confirmation.');
}
