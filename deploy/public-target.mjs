import { need } from './target.mjs';
import { publicOrigin } from '../kit/lib/check.mjs';
import { encodeTracAddress } from '../rules/src/trac-address.js';
import { stableJSON } from '../rules/src/core.js';
export const PUBLIC_FIELDS = ['version', 'mode', 'network', 'bitcoinNetwork', 'gateway', 'gatewayKey', 'receiptSigners', 'headerSource', 'paymentOrigin', 'trac', 'puzzleBits', 'powLimitBits'];
export function publicTarget(t) {
  const mode = t.mode;
  need(['mainnet', 'regtest'].includes(mode), 'public_target_mode');
  need(/^[a-zA-Z0-9._:-]{1,96}$/.test(t.network) && (mode !== 'mainnet' || !/regtest|localhost/i.test(t.network)), 'public_network');
  need([t.trac.bootstrap,t.trac.msbBootstrap,t.trac.adminPublicKey].every(k => /^[0-9a-f]{64}$/.test(k)) && /^(02|03)[0-9a-f]{64}$/.test(t.committee.publicKey), 'public_trac_pins');
  need(/^[1-9][0-9]*$/.test(t.trac.networkId) && Number.isSafeInteger(t.policy.puzzleBits) && t.policy.puzzleBits >= 0 && t.policy.puzzleBits <= 32, 'public_policy');
  const projection = { version: 1, mode, network: t.network, bitcoinNetwork: mode === 'mainnet' ? 'mainnet' : 'regtest',
    gateway: publicOrigin(t.public.gateway, mode), gatewayKey: t.public.gatewayKey,
    receiptSigners: t.committee.members.map(({ id, identity }) => ({ id, identity, address: encodeTracAddress(identity) })),
    headerSource: publicOrigin(t.public.headerSource, mode), paymentOrigin: publicOrigin(t.public.paymentOrigin, mode),
    trac: { networkId: t.trac.networkId, bootstrap: t.trac.bootstrap, msbBootstrap: t.trac.msbBootstrap, adminPublicKey: t.trac.adminPublicKey, committeePublicKey: t.committee.publicKey },
    puzzleBits: t.policy.puzzleBits, powLimitBits: mode === 'mainnet' ? 0x1d00ffff : 0x207fffff };
  need(/^[0-9a-f]{64}$/.test(projection.gatewayKey) && projection.receiptSigners.length === 5 && new Set(projection.receiptSigners.map(s => s.identity)).size === 5, 'public_identity_pins');
  need(projection.receiptSigners.every(s=>typeof s.id==='string' && /^[a-zA-Z0-9._:-]{1,96}$/.test(s.id)) && new Set(projection.receiptSigners.map(s=>s.id)).size===5, 'public_member_ids');
  return projection;
}
export function validatePublicTarget(value) {
  need(value && Object.keys(value).length === PUBLIC_FIELDS.length && PUBLIC_FIELDS.every(k => Object.hasOwn(value, k)), 'public_field_allowlist');
  const actual = publicTarget({ mode: value.mode, network: value.network, public: value, committee: { members: value.receiptSigners, publicKey: value.trac.committeePublicKey },
    trac: value.trac, policy: { puzzleBits: value.puzzleBits } });
  need(stableJSON(actual) === stableJSON(value), 'public_target_binding'); return value;
}
