import { readFile, writeFile, statfs, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
export const BUILD = resolve(process.env.DMW_BUILD_ROOT || resolve(ROOT, '../build'));
export const DATA = `${BUILD}/data`;
export const CURRENT = `${DATA}/current.json`;
export const ORD = `${BUILD}/target/release/ord`;
export const PORTS = Object.freeze({ bitcoin: 18443, ord: 55888, gateway: 55999, ethereum: 58545 });
export const run = promisify(execFile);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const jsonFile = async path => JSON.parse(await readFile(path, 'utf8'));
export async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
export async function diskCheck() {
  const fs = await statfs('/');
  if (fs.bavail * fs.bsize < 100 * 1024 ** 3) throw new Error('Less than 100 GiB free; stopping');
}
export function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Only loopback HTTP is allowed');
  return url;
}
export async function rpc(url, method, params = [], cookie) {
  localUrl(url);
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { authorization: `Basic ${Buffer.from(cookie).toString('base64')}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (data.error) throw Object.assign(new Error(`${method}: ${data.error.message}`), { rpcCode: data.error.code });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  return data.result;
}
export async function bitcoin(manifest, method, params = [], wallet) {
  const cookie = (await readFile(`${manifest.root}/bitcoin/regtest/.cookie`, 'utf8')).trim();
  return rpc(manifest.bitcoin.rpc + (wallet ? `/wallet/${encodeURIComponent(wallet)}` : ''), method, params, cookie);
}
export async function current() { return jsonFile((await jsonFile(CURRENT)).manifest); }
export async function ordJson(manifest, path) {
  const response = await fetch(manifest.ord.url + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Object.assign(new Error(`ord ${path}: HTTP ${response.status}`), { status: response.status });
  return response.json();
}
export async function waitFor(fn, label, timeout = 60000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const result = await fn(); if (result) return result; } catch (error) { if (error.fatal) throw error; last = error; }
    await sleep(250);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
export async function waitIndexed(manifest) {
  const height = await bitcoin(manifest, 'getblockcount');
  await waitFor(async () => Number((await ordJson(manifest, '/r/tap/getCurrentBlock')).result) >= height, 'TAP indexing');
  return height;
}
export async function mine(manifest, count = 1) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100000) throw new Error('Block count must be 1..100000');
  await diskCheck();
  const blocks = await bitcoin(manifest, 'generatetoaddress', [count, manifest.bitcoin.miningAddress]);
  await waitIndexed(manifest);
  return blocks;
}
export function ordArgs(manifest) {
  return ['--regtest', '--bitcoin-data-dir', `${manifest.root}/bitcoin`, '--bitcoin-rpc-url', manifest.bitcoin.rpc, '--data-dir', `${manifest.root}/ord`, '--index', `${manifest.root}/ord/index.redb`];
}
export async function ordWallet(manifest, args) {
  const { stdout } = await run(ORD, [...ordArgs(manifest), 'wallet', '--server-url', manifest.ord.url, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
  return JSON.parse(stdout);
}
export async function receiveAddress(manifest) {
  const result = await ordWallet(manifest, ['receive']);
  return result.address ?? result.addresses?.[0];
}
