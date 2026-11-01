// Public stand-in for the console's flows.js (served as /web/console/js/flows.js): visitors pay through
// their own wallets on the gateway pages, so each action opens its wallet page.
// In-page navigation (the site router follows popstate): a full reload would make
// wallet extensions ask to reconnect.
export const go = path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); };
const open = (path, q) => { go(path + (q ? '?' + new URLSearchParams(q) : '')); return false; };
export const mintFlow = ({ asset, block, deployment }) => open('/mint', { asset, ...(block === undefined || block === null ? {} : { block }),
  ...(/^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(deployment ?? '') ? { deployment } : {}) });
// A compound's page on /mint explains how it is made real on TAP.
export const compoundMintFlow = asset => { go('/mint/' + asset); return false; };
export const linkFlow = height => open('/link', { block: height });
export { wallet } from '../../connect.js';
import { wallet as connected } from '../../connect.js';
// Deploy your own ticker: the connected TAP Wallet requests it (on the agent dashboard, the agent's payout
// wallet), then the request's page takes the fee and the deploy inscription.
export async function tickerRequest(asset, ticker) {
  if (globalThis.DMW_LOCAL_AGENT !== true) {
    if (!connected.tap) await connected.connect('tap');
    if (!connected.tap?.address) throw Error('Connect TAP Wallet to deploy a ticker.');
  }
  const { requestTicker } = await import('../../ticker-deploy.js');
  return requestTicker(asset, ticker, connected.tap?.address);
}
export const tickerOpen = (asset, job) => go(`/mint/${asset}?` + new URLSearchParams({ ticker: job.id }));
export function run() { return Promise.reject(new Error('read_only')); }
