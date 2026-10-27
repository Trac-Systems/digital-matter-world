import { BUILD as configuredBuildRoot } from '../../local/common.mjs';
import { FeeQuotes, createFeePolicy, mintFeeScope } from '../src/fees.mjs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { rules } from '../src/rules.mjs';
import { hash, edPublic } from '../src/util.mjs';
import { chain, checkpoint, mine } from '../../contract/tests/helpers/chain.mjs';
export const build = `${configuredBuildRoot}/service`;
export const network = 'dmw-regtest';
export async function temp(prefix = 'test-') { await mkdir(build, { recursive: true, mode: 0o700 }); return mkdtemp(join(build, prefix)); }
export const secret = Buffer.alloc(32, 9), gateway = edPublic(secret);
export function agent(i = 1) { const secret = Buffer.from(hash('agent-' + i), 'hex'); return { secret, address: edPublic(secret) }; }
export function signEd(digest, key) { return sign(null, digest, createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), key]), format: 'der', type: 'pkcs8' })).toString('hex'); }
export function fixtureHistory(count = 200) {
  const raw = [mine('0'.repeat(64), 1000), ...chain(count, checkpoint)], headers = raw.map((r, h) => rules.parseHeader(r, h));
  return { raw: h => raw[h], get: h => headers[h], hashAt: h => headers[h]?.hash ?? null, length: raw.length, field: (h, f, dt = 'n') => (f === 4 ? h : f === 10 ? headers[h].nonce : headers[h].bits).toString(dt === 'h' ? 16 : 10) };
}
export const patterns = [{ number: 0, name: 'dmwdigit', pat: '[0-9]', fld: 4, dt: 'n', rarity: 100, tier: 1, historyHeight: 99 }];
export function makeMove(history, tip, who = agent(), type = 'claim', bits = 0) {
  const header = { height: tip, raw: history.raw(tip) };
  return rules.solveMove({ v: 1, network, a: who.address, t: type, b: tip, h: history.hashAt(tip),
    p: type === 'header' ? header : { window: tip, plots: [{ block: tip, patterns: [0] }], header } }, who.secret, bits);
}
export const newStore = async () => Store.open(await temp());
export const receiptSigners = Array.from({ length: 5 }, (_, i) => ({ id: `test-${i}`, identity: agent(800 + i).address }));
export const attestRoot = async seal => receiptSigners.slice(0, 3).map((s, i) => rules.attestReceiptRoot(seal, seal.tip + 1, s.id, agent(800 + i).secret));

export function feeFixture({ baseFee = '100', store, network: feeNetwork = network, secret: feeSecret = secret } = {}) {
  const registry = { feePolicy: createFeePolicy(baseFee) };
  const feeQuotes = new FeeQuotes({ network: feeNetwork, secret: feeSecret, registry: async () => registry });
  const validateFeeTerms = async (kind, row) => {
    const fee = await feeQuotes.accepted(row.terms.feeAuthorization, `${kind}/${row.id}`, row.id, row.request.until);
    if (fee.baseFee !== row.terms.baseFee) throw Error('fee_quote_policy');
  };
  return { feeQuotes, validateFeeTerms,
    mintFeeTerms: async id => { const row = store.get('mints', id); return feeQuotes.accepted(row.feeAuthorization, mintFeeScope(row.request.asset, row.request.block, row.kind), id, row.request.expires); },
    terms: (kind, treasury) => async (id, until, counted) => {
      const scope = `${kind}/${id}`, quote = await feeQuotes.issue(scope, counted);
      return { treasury, baseFee: quote.baseFee, feeAuthorization: await feeQuotes.accept(quote, scope, id, until, counted) };
    }
  };
}

// Each reader fixture uses its own disposable source file; never consult the
// developer's real private endpoint when running isolated regression tests.
export async function withTapSource(config) {
  const directory = await temp('tap-source-'), tapSourceFile = join(directory, 'source.url');
  await writeFile(tapSourceFile, config.endpoints.indexer ?? 'http://127.0.0.1:59729', { mode: 0o600 });
  const { indexer, bitcoind, ...endpoints } = config.endpoints;
  return { ...config, endpoints, local: { ...config.local, tapSourceFile } };
}
