import { createPrivateKey, createPublicKey, sign, verify, createHash } from 'node:crypto';
import { check, hex32, integer } from './check.mjs';

const domain = 'dmw-header-manifest-v1';
const decimal = v => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
const canonical = v => JSON.stringify(v, function (key, value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value;
});
export const manifestHash = m => createHash('sha256').update(canonical(m)).digest('hex');
export function manifestTrust(gatewayKey, epoch = '0') { return { keys: [{ key: gatewayKey, epoch }] }; }
export function validateManifestTrust(trust) {
  check(trust && Array.isArray(trust.keys) && trust.keys.length > 0 && trust.keys.every(k => hex32(k.key) && decimal(k.epoch)) &&
    new Set(trust.keys.map(k => k.epoch)).size === trust.keys.length, 'Pinned header manifest identities required');
  return trust;
}
export function headerManifestSigner(secret, epoch = '0') {
  check(Buffer.isBuffer(secret) && secret.length === 32 && decimal(epoch), 'Invalid header signing identity');
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), secret]), format: 'der', type: 'pkcs8' });
  const key = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  return { key, epoch, sign(manifest) {
    check(!manifest.authentication, 'Manifest already signed');
    const authentication = { domain, key, epoch };
    const signature = sign(null, Buffer.from(canonical({ ...manifest, authentication })), privateKey).toString('hex');
    return { ...manifest, authentication: { ...authentication, signature } };
  } };
}
export function verifyHeaderManifest(m, trust, { network, previous } = {}) {
  validateManifestTrust(trust);
  check(m?.version === 2 && ['mainnet', 'regtest'].includes(m.network) && (!network || m.network === network) &&
    integer(m.count) && m.count > 0 && integer(m.height) && m.height + 1 === m.count && integer(m.bytes) && m.bytes === m.count * 80 &&
    hex32(m.tip) && decimal(m.sequence) && m.root?.start === 0 && m.root.end === m.count && m.root.tip === m.tip && hex32(m.root.hash), 'Invalid signed header manifest');
  const a = m.authentication;
  check(a?.domain === domain && trust.keys.some(k => k.key === a.key && k.epoch === a.epoch) && /^[0-9a-f]{128}$/.test(a.signature), 'Untrusted header manifest identity');
  const { signature, ...authentication } = a;
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(a.key, 'hex')]), format: 'der', type: 'spki' });
  check(verify(null, Buffer.from(canonical({ ...m, authentication })), key, Buffer.from(signature, 'hex')), 'Invalid header manifest signature');
  const accepted = { network: m.network, epoch: a.epoch, sequence: m.sequence, hash: manifestHash(m) };
  if (previous) {
    check(previous.network === m.network && decimal(previous.epoch) && decimal(previous.sequence), 'Invalid saved header manifest identity');
    check(BigInt(a.epoch) >= BigInt(previous.epoch) && (a.epoch !== previous.epoch || BigInt(m.sequence) >= BigInt(previous.sequence)), 'Header manifest rollback');
    check(a.epoch !== previous.epoch || m.sequence !== previous.sequence || accepted.hash === previous.hash, 'Header manifest equivocation');
  }
  return accepted;
}
