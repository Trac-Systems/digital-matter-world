import { ed25519 } from '@noble/curves/ed25519';
import { assert, exactKeys, hex, hexToBytes, digest } from './core.js';
import { uintV2, compareUint } from './integers-v2.js';
import { financialAsset } from './financial-mint.js';
import { publicMintActive } from './public-mint.js';
import { namedGet, namedSet } from './named-index.js';

export const transferActionDigest = (network, { sig, ...action }) => digest('dmw-account-action-v2', network, action);

export function validateTransferPayload(p, settings) {
  assert(settings.values.publicMintActivationHeight !== undefined, 'transfer_v2_unavailable');
  assert(exactKeys(p, ['actions']) && Array.isArray(p.actions) && p.actions.length > 0 &&
    p.actions.length <= Math.min(16, settings.values.accountActions), 'transfer_payload');
  const assets = new Set(), nonces = new Set(), first = p.actions[0];
  for (const a of p.actions) {
    assert(exactKeys(a, ['type', 'owner', 'to', 'asset', 'amount', 'revision', 'nonce', 'until', 'sig']) &&
      a.type === 'transfer' && hex(a.owner, 32) && hex(a.to, 32) && hex(a.nonce, 32) && hex(a.sig, 64), 'transfer_authorization');
    uintV2(a.revision); uintV2(a.until);
    assert(financialAsset(a.asset) && typeof a.amount === 'string' && /^[1-9][0-9]{0,77}$/.test(a.amount), 'transfer_assets');
    assert(a.owner === first.owner && a.to === first.to && a.revision === first.revision && a.until === first.until &&
      !assets.has(a.asset) && !nonces.has(a.nonce), 'transfer_actions');
    assets.add(a.asset); nonces.add(a.nonce);
  }
}

export function executeTransferV2(state, { move, settings, tip, counted, executionHeight = counted, provenance }) {
  validateTransferPayload(move.p, settings);
  assert(publicMintActive(settings, tip) && publicMintActive(settings, counted), 'transfer_v2_unavailable');
  let records = state.records;
  // A queued receipt can execute later than its observation; the account
  // engine authorizes at the batch execution height as well.
  for (const action of move.p.actions) {
    assert(action.owner === move.a && compareUint(executionHeight, action.until) <= 0 &&
      ed25519.verify(hexToBytes(action.sig), transferActionDigest(settings.network, action), hexToBytes(action.owner), { zip215: false }), 'transfer_authorization');
    const key = `transfer-nonce/${action.owner}/${action.nonce}`;
    assert(!namedGet(records, key), 'account_replay');
    records = namedSet(records, key, { provenance });
  }
  return { state: { ...state, records }, transfers: move.p.actions.map(action => ({ action })) };
}
