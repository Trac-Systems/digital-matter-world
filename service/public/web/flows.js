// Public stand-in for the console's flows.js (served as /web/console/js/flows.js): visitors pay through
// their own wallets on the gateway pages, so each action opens its wallet page.
const open = (path, q) => { location.assign(path + (q ? '?' + new URLSearchParams(q) : '')); return false; };
export const mintFlow = ({ asset, block }) => open('/mint', { asset, ...(block === undefined || block === null ? {} : { block }) });
export const compoundMintFlow = asset => open('/mint', { asset });
export const linkFlow = height => open('/link', { block: height });
export { wallet } from '../../connect.js';
export function run() { return Promise.reject(new Error('read_only')); }
