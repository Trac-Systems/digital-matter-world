import { createHash } from 'node:crypto';
import { base58, bech32, bech32m } from '@scure/base';
import { check } from './check.mjs';

// Decode checksums as well as prefixes; no wallet/RPC access is needed.
export function bitcoinAddress(value, network = 'mainnet', role = 'address') {
  check(['mainnet', 'regtest'].includes(network), 'Invalid Bitcoin network');
  const fail = () => { throw Error(`Invalid Bitcoin ${role} for ${network}`); };
  if (typeof value !== 'string' || value.length > 90 || !value.length) return fail();
  try {
    if (/^(?:bc|bcrt)1/i.test(value)) {
      const decoded = bech32.decodeUnsafe(value, 90) ?? bech32m.decodeUnsafe(value, 90);
      if (!decoded || decoded.prefix !== (network === 'regtest' ? 'bcrt' : 'bc')) return fail();
      const version = decoded.words[0], program = bech32.fromWords(decoded.words.slice(1));
      if (version > 16 || program.length < 2 || program.length > 40 || version === 0 && ![20, 32].includes(program.length)) return fail();
      (version === 0 ? bech32 : bech32m).decode(value, 90);
    } else {
      const bytes = Buffer.from(base58.decode(value));
      const versions = network === 'regtest' ? [111, 196] : [0, 5];
      const hash = data => createHash('sha256').update(data).digest();
      if (bytes.length !== 25 || !versions.includes(bytes[0]) || !hash(hash(bytes.subarray(0, 21))).subarray(0, 4).equals(bytes.subarray(21))) return fail();
    }
  } catch { return fail(); }
  return value;
}
