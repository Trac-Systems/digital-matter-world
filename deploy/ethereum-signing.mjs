import { createRequire } from 'node:module';
import { check } from '../service/src/util.mjs';
import { keccak } from '../committee/signer/escrow.mjs';
const { secp256k1 } = createRequire(new URL('../local/package.json', import.meta.url))('@noble/curves/secp256k1');
const bytes = value => { if (typeof value === 'bigint') { if (value === 0n) return Buffer.alloc(0); let text = value.toString(16); return Buffer.from(text.length % 2 ? '0' + text : text, 'hex'); } return Buffer.from(value.slice(2), 'hex'); };
export function rlp(value) {
  const list = Array.isArray(value), data = list ? Buffer.concat(value.map(rlp)) : bytes(value);
  if (!list && data.length === 1 && data[0] < 128) return data;
  const base = list ? 192 : 128;
  if (data.length <= 55) return Buffer.concat([Buffer.from([base + data.length]), data]);
  const length = bytes(BigInt(data.length)); return Buffer.concat([Buffer.from([base + 55 + length.length]), length, data]);
}
export function signLegacy(params, secret) {
  const fields = [params.nonce, params.gasPrice, params.gas].map(BigInt).concat([params.to, 0n, params.data]);
  const chain = BigInt(params.chainId), signature = secp256k1.sign(keccak(rlp([...fields, chain, 0n, 0n])), secret, { lowS: true });
  check(signature.recovery <= 1, 'ethereum_signature');
  return '0x' + rlp([...fields, chain * 2n + 35n + BigInt(signature.recovery), signature.r, signature.s]).toString('hex');
}
