import { createHash, randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdir, open, rename, unlink, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const check = (ok, code, status = 400) => { if (!ok) throw Object.assign(Error(code), { status }); };
export const serial = () => { let tail = Promise.resolve(); return fn => { const p = tail.then(fn); tail = p.catch(() => {}); return p; }; };
export const heightKey = n => String(n).padStart(16, '0');
export const hex32 = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
export const edPublic = secret => createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(secret)]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
export async function diskCheck() { const s = await statfs('/'); check(s.bavail * s.bsize >= 100_000_000_000, 'disk_floor', 503); }
export async function syncDirectory(path) { const fd = await open(path, 'r'); try { await fd.sync(); } finally { await fd.close(); } }
export async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  const fd = await open(tmp, 'wx', 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  try { await rename(tmp, path); await syncDirectory(dirname(path)); } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
}
