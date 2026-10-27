import { BUILD as configuredBuildRoot } from '../../local/common.mjs';
import { bech32m } from '@scure/base';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { parseHeader, attestReceiptRoot, CLAIM_DEFAULTS } from '../../rules/src/index.js';
import { chain, checkpoint, mine } from '../../contract/tests/helpers/chain.mjs';
import { TracClient } from '../lib/trac.mjs';
export const build = `${configuredBuildRoot}/target/kit-tests`;
const cleanups = new WeakMap();
export function cleanup(t, fn) {
  if (!cleanups.has(t)) {
    const list = []; cleanups.set(t, list);
    t.after(async () => { const errors = []; for (const close of list.reverse()) try { await close(); } catch (e) { errors.push(e); } if (errors.length) throw new AggregateError(errors); });
  }
  cleanups.get(t).push(fn);
}
export async function temp(t) {
  await mkdir(build, { recursive: true, mode: 0o700 }); const dir = await mkdtemp(join(build, 'test-'));
  cleanup(t, () => rm(dir, { recursive: true, force: true })); return dir;
}
export function testWallet(n = 1) {
  const seed = Buffer.alloc(32, n), key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { publicKey, secretKey: seed, sign: bytes => sign(null, bytes, key), address: 'local-test-account' };
}
export function witnesses() {
  const wallets = Array.from({ length: 5 }, (_, i) => testWallet(20 + i));
  const members = wallets.map((w, i) => ({ id: `signer-${i}`, identity: w.publicKey.toString('hex') }));
  return { members, attest: (seal, observedTip = seal.tip, indices = [0, 1, 2]) => indices.map(i => attestReceiptRoot(seal, observedTip, members[i].id, wallets[i].secretKey)) };
}
export function history(count = 40) {
  const raw = [mine('0'.repeat(64), 1000), ...chain(count, checkpoint)], headers = raw.map((r, h) => parseHeader(r, h));
  return { raw: h => raw[h], get: h => headers[h], hashAt: h => headers[h]?.hash ?? null, length: raw.length,
    field: (h, f, dt = 'n') => (f === 4 ? h : f === 10 ? headers[h].nonce : headers[h].bits).toString(dt === 'h' ? 16 : 10) };
}
export const patterns = [0, 1, 2, 3].map(number => ({ number, name: 'dmwtest' + number, pat: number === 0 ? '[0-9]' : `${number}`, fld: 4, dt: 'n', rarity: 20 - number, historyHeight: 39, tier: 5 }));
export function fakeTrac(hist, { network = 'dmw-kit-test', tip = 20, balance = '100' } = {}) {
  const state = { tip, balances: {}, sent: [] };
  const context = { networkId: 1, txv: '01'.repeat(32), incomingWritingKey: '02'.repeat(32), subnetBootstrap: '03'.repeat(32), msbBootstrap: '04'.repeat(32) };
  const trac = new TracClient({ network, context: async () => context, submit: async p => { state.sent.push(p); return { tx: p.tx, state: 'submitted' }; }, status: async () => ({ state: 'pending' }), api: {
    dmwAuthority: async () => ({ network }), dmwHead: async () => ({ tip: hist.get(state.tip), counted: state.tip, revision: 0 }),
    dmwHashAt: async h => hist.hashAt(h), dmwBalance: async (o, a) => state.balances[a] ?? balance,
    dmwSettings: async () => ({ pending_blocks: 432, ...CLAIM_DEFAULTS }),
    dmwBatchLast: async () => ({ n: 0, to: 0 }), dmwBatchRoot: async () => null, dmwRecord: async () => null, dmwMint: async () => null
  } });
  return { trac, state, context };
}

export const bitcoinAddress = (network = 'regtest', n = 1) => bech32m.encode(network === 'regtest' ? 'bcrt' : 'bc', [1, ...bech32m.toWords(new Uint8Array(32).fill(n))]);
