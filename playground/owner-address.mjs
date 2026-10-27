import { encodeTracAddress, validateTracAddress } from '../rules/src/trac-address.js';

// Saved players may contain a public address or a raw public key. Validate and
// normalize at the adapter boundary; UI/API identities always use trac1.
export function ownerAddress(owner) {
  return typeof owner === 'string' && owner.startsWith('trac1')
    ? validateTracAddress(owner) : encodeTracAddress(owner);
}
