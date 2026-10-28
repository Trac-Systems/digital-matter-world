import { migrateRegistry } from '../../src/registry.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BUILD as configuredBuildRoot } from '../../../local/common.mjs';
import { createFeePolicy } from '../../src/fees.mjs';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GENESIS, MAINNET_PARAMS } from '../../../contract/beacon/bitcoin.js';
export const genesis = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
export const genesisTx = '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000';
export const genesisTxid = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b';
export async function temporary(t, beforeCleanup = async () => {}) {
  const path = await mkdtemp(`${configuredBuildRoot}/prod-adapters-test-`);
  t.after(async () => { await beforeCleanup(); await rm(path, { recursive: true, force: true }); }); return path;
}
export async function mockServer(t, handler) {
  const server = createServer((request, response) => { Promise.resolve(handler(request, response)).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); }); });
  await new Promise(resolve => server.listen(Number(process.env.DMW_TEST_PORT ?? 0), '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port;
}
export const json = (response, value) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
export async function body(request) { const bytes = []; for await (const chunk of request) bytes.push(chunk); return JSON.parse(Buffer.concat(bytes)); }
export class MemoryStore {
  rows = new Map();
  get(space, id) { return structuredClone(this.rows.get(space + '/' + id) ?? null); }
  async put(space, id, value) { if (value === undefined) this.rows.delete(space + '/' + id); else this.rows.set(space + '/' + id, structuredClone(value)); }
  async transact(rows) { for (const { space, id, value } of rows) await this.put(space, id, value); }
  list(space) { return [...this.rows].filter(([key]) => key.startsWith(space + '/')).map(([key, value]) => ({ id: key.slice(space.length + 1), value: structuredClone(value) })); }
}
export async function configFixture(t) {
  const root = await temporary(t), file = async (name, value) => { const path = join(root, name); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); return path; };
  const dir = async name => { const path = join(root, name); await mkdir(path, { mode: 0o700 }); return path; };
  const endpoint = async name => ({ urlFile: await file(name + '-url', 'https://' + name + '.invalid') });
  const deployment = { network: 'fixture-main', admin: '99'.repeat(32), committee: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', beacon: { checkpoint: GENESIS, params: MAINNET_PARAMS } };
  const config = { version: 1, mode: 'prod', network: 'fixture-main', listen:{host:'127.0.0.1',port:58910}, adapter:fileURLToPath(new URL('../adapter.mjs',import.meta.url)), data: await dir('data'), gatewayKey: await file('gateway-key', '01'.repeat(32)), committee: Array.from({ length: 5 }, (_, i) => ({ id: `member-${i+1}`, peer: { id: `member-${i+1}`, identity: String(i + 1).padStart(64, '0') } })), prod: { lookupSettings: { refreshMs: 2147483647 },
    contexts: await dir('contexts'), readerData: await dir('reader'), registry: await file('registry', { feePolicy: createFeePolicy('100'), assets: {} }), deployment: await file('deployment', deployment), startTip: 6, maxHeadersPerView: 20,
    bitcoin: { kind: 'ord', ...await endpoint('bitcoin') },
    tap: { endpoints: [{ urlFile: join(root, 'bitcoin-url') }], agreement: 1 },
    ethereum: { ...await endpoint('ethereum'), chainId: '1', address: '0x' + '22'.repeat(20), token: '0x' + '33'.repeat(20), fromBlock: '0x0', confirmations: 1, maxLogRange: 100, maxLogPages: 10 },
    trac: { bootstrap: '44'.repeat(32), msbBootstrap: '55'.repeat(32), networkId: 918, runtimeConfig: await file('runtime', { mode: 'prod' }) },
  } };
  await migrateRegistry(config.prod.registry);
  return { config, root, file, deployment };
}

const { RawTx } = createRequire(new URL('../../../local/package.json', import.meta.url))('@scure/btc-signer/script');
export const genesisInfo = { hash: GENESIS.hash, height: 0, version: 1, previous_block: null, merkle_root: genesisTxid, timestamp: 1231006505, bits: 486604799, nonce: 2083236893, transaction_count: 1 };
const genesisDecoded = RawTx.decode(Buffer.from(genesisTx, 'hex'));
export const genesisBlock = { hash: GENESIS.hash, height: 0, transactions: [{ version: 1, lock_time: 0,
  input: genesisDecoded.inputs.map(i => ({ previous_output: Buffer.from(i.txid).toString('hex') + ':' + i.index, script_sig: Buffer.from(i.finalScriptSig).toString('hex'), sequence: i.sequence, witness: [] })),
  output: genesisDecoded.outputs.map(o => ({ value: Number(o.amount), script_pubkey: Buffer.from(o.script).toString('hex') })) }] };
