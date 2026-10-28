import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

export function check(ok, message) { if (!ok) throw new Error(message); }
export const hex32 = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const integer = v => Number.isSafeInteger(v) && v >= 0;
export const sha256 = v => createHash('sha256').update(v).digest('hex');
export const nonce = () => randomBytes(32).toString('hex');
export function exact(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'Unexpected fields');
}
export async function privateDirectory(directory, create = true) {
  const path = resolve(directory);
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  check(stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077), 'State directory must be private (0700) and not a symlink');
  return path;
}
export async function privateRead(path, maxBytes = 16384) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    check(stat.isFile() && !(stat.mode & 0o077) && stat.size <= maxBytes, 'Expected a small private regular file (0600)');
    return await fd.readFile();
  } finally { await fd.close(); }
}
export async function atomicWrite(path, bytes) {
  const stage = `${resolve(path)}.${nonce()}.stage`;
  const fd = await open(stage, 'wx', 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  try { await rename(stage, path); } catch (e) { await unlink(stage); throw e; }
  const parent = await open(dirname(resolve(path)), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
export async function diskSpace(output, expectedBytes, { statfsImpl = statfs } = {}) {
  check(typeof output === 'string' && output.length > 0 && integer(expectedBytes), 'Expected output path and write size');
  const directory = dirname(resolve(output));
  const stat = await statfsImpl(directory, { bigint: true });
  const available = BigInt(stat.bavail) * BigInt(stat.bsize);
  // Budget the additional files at their peak, plus 10% and 512 MiB for
  // metadata and concurrent activity. Never demand a node-sized startup disk.
  const needed = (BigInt(expectedBytes) * 11n + 9n) / 10n + 512n * 1024n * 1024n;
  const mib = bytes => `${(bytes + 1048575n) / 1048576n} MiB`;
  check(available >= needed, `Not enough free disk space in ${directory}: need ${mib(needed)}, available ${mib(available)} for ${resolve(output)}`);
  return { directory, needed, available };
}
export function localOrigin(value) {
  let u; try { u = new URL(value); } catch { throw new Error('Invalid local endpoint'); }
  check(u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname) && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/', 'Endpoint must be a loopback HTTP origin without credentials');
  return u.origin;
}
export function publicOrigin(value, mode) {
  if (mode !== 'mainnet') return localOrigin(value);
  let u; try { u = new URL(value); } catch { throw Error('Invalid public endpoint'); }
  check(u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' && /^[a-zA-Z0-9.-]+\.[a-zA-Z]+$/.test(u.hostname) && !/localhost|\.local$|\.internal$/.test(u.hostname), 'Public production endpoint must be a credential-free HTTPS origin');
  return u.origin;
}
export const MAINNET_GATEWAY = 'https://dmtworld.tap-protocol.com';
// The first public name serves the same gateway; profiles created with it stay valid.
export const MAINNET_GATEWAYS = Object.freeze([MAINNET_GATEWAY, 'https://dmtworld.much.fun']);
export function gatewayOrigin(value, mode) {
  const origin = publicOrigin(value, mode);
  check(mode !== 'mainnet' || MAINNET_GATEWAYS.includes(origin), 'Production gateway must be https://dmtworld.tap-protocol.com');
  return origin;
}
