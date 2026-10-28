import { tapAccount, ethAccount } from '/web/wallets.js';
import { walletError } from '/web/console/js/wallet-errors.js';
const $ = id => document.getElementById(id), id = location.pathname.split('/').at(-1);
let pending, target;
function fail(message) { throw Object.assign(new Error(message), { display: true }); }
async function json(path, value) {
  const response = await fetch(path, value ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) } : {});
  const result = await response.json(); if (!response.ok) fail(/^[a-z][a-z0-9_]{0,80}$/.test(result.error) ? result.error : 'request_failed'); return result;
}
async function action(fn) { try { await fn(); } catch (e) { $('status').textContent = e.code === 4001 ? 'Signature request cancelled.' : walletError(e); } }
$('sign').onclick = () => action(async () => {
  let signature;
  if (pending.request.expiry <= Date.now()) fail('Request expired. Ask your agent for a new binding request.');
  if (pending.request.rail === 'ethereum') {
    await ethAccount(target, pending.request.address);
    const message = '0x' + Array.from(new TextEncoder().encode(pending.message), b => b.toString(16).padStart(2, '0')).join('');
    signature = await window.ethereum.request({ method: 'personal_sign', params: [message, pending.request.address] });
  } else {
    await tapAccount(target, pending.request.address);
    signature = await window.tapprotocol.signMessage(pending.message, 'bip322-simple');
  }
  $('status').textContent = 'Saving the binding…';
  await json('/payout-bindings/complete', { id, walletSignature: signature });
  $('status').textContent = 'Payout wallet bound.'; $('sign').disabled = true;
});
action(async () => {
  [pending, target] = await Promise.all([json('/payout-bindings/requests/' + id), json('/web-api/target')]);
  const r = pending.request;
  $('request').textContent = `Agent: ${r.agent}\nPayment: ${r.rail === 'ethereum' ? 'Bridged TAP' : 'TAP'}\nWallet: ${r.address}\nExpires: ${new Date(r.expiry).toLocaleString()}`;
  const accepted = pending.state === 'accepted'; $('sign').disabled = accepted;
  $('status').textContent = accepted ? 'This binding has already been accepted.' : 'Review the request, then sign with the wallet shown.';
});
