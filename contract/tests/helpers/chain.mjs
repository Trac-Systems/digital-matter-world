import assert from 'node:assert/strict';
export { parseHeader } from '../../beacon/bitcoin.js';
import { parseHeader, workFor, targetFromBits, REGTEST_PARAMS, BitcoinBeacon } from '../../beacon/bitcoin.js';
export const addr = n => n.toString(16).padStart(64, '0');
export function mine(prev, time, bits = REGTEST_PARAMS.powLimitBits, tag = 0) {
  const raw = Buffer.alloc(80); raw.writeInt32LE(1); Buffer.from(prev, 'hex').reverse().copy(raw, 4);
  raw.writeUInt32LE(tag, 36); raw.writeUInt32LE(time, 68); raw.writeUInt32LE(bits, 72);
  for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
    raw.writeUInt32LE(nonce, 76);
    const hx = raw.toString('hex'); const h = parseHeader(hx);
    if (BigInt(`0x${h.hash}`) <= targetFromBits(bits)) return hx;
  }
  throw new Error('Mining exhausted');
}
const genesis = parseHeader(mine('0'.repeat(64), 1000));
export const checkpoint = { height: 0, hash: genesis.hash, bits: genesis.bits, time: genesis.time, chainwork: workFor(genesis.bits).toString() };
export const beaconOptions = { checkpoint, params: REGTEST_PARAMS };
export function chain(count, start = checkpoint, step = 600, tag = 0, bits = start.bits) {
  const headers = []; let prev = start.hash; let time = start.time;
  for (let i = 0; i < count; i++) { const hx = mine(prev, time += step, bits, tag); headers.push(hx); prev = parseHeader(hx).hash; }
  return headers;
}
