import { check, hash } from './util.mjs';
import { rules } from './rules.mjs';
import { createRequire } from 'node:module';
const { secp256k1 } = createRequire(new URL('../../local/package.json', import.meta.url))('@noble/curves/secp256k1');

export const same = (a, b) => a === undefined || b === undefined ? a === b : rules.stableJSON(a) === rules.stableJSON(b);
export const candidate = (job, domain, attempt) => 'dmw' + hash(rules.stableJSON(['dmw-allocation-v1', job.network, job.asset, job.generation, domain, job.salt, attempt])).slice(0, 29);
export const deploymentOptions = kind => kind === 'dmt' ? {} : { max: '18446744073709551615', dec: '0' };
export function deploymentPayload(entry) {
  return entry.kind === 'dmt' ? { p: 'tap', op: 'dmt-deploy', tick: entry.tick, elem: entry.elementId, dt: entry.dt, prv: entry.privilege, ...entry.options } :
    { p: 'tap', op: 'token-deploy', tick: entry.tick, prv: entry.privilege, ...entry.options };
}
export function generationDigest(entry) {
  return hash(rules.stableJSON(Object.fromEntries(['network', 'asset', 'generation', 'id', 'privilege', 'authorityKey', 'elementId', 'elementName', 'receiver', 'dt', 'kind', 'tick', 'indexTick', 'options'].map(k => [k, entry[k] ?? null]))));
}
// All callers (operator, gateway and each signer) verify indexed semantics as
// well as the exact inscription. Sharing an authority is not an approval.
export async function verifyDeployment(reads, entry, options = {}) {
  return reads.withTapSnapshot ? reads.withTapSnapshot(options.view, () => verifyDeploymentRecords(reads, entry, options)) : verifyDeploymentRecords(reads, entry, options);
}
async function verifyDeploymentRecords(reads, entry, { confirmations = 1, view } = {}) {
  check(entry && entry.suspended !== true, 'asset_provisioning');
  const d = await reads.tap('getDeployment/' + encodeURIComponent(entry.indexTick ?? entry.tick));
  check(d?.ins === entry.id && d.prv === entry.privilege, 'deployment_binding');
  const payload = await reads.content(entry.id);
  const elementId = entry.elementId ?? payload.elem, dt = entry.dt ?? entry.pattern?.dt;
  const normalized = { ...entry, elementId, dt, options: entry.options ?? deploymentOptions(entry.kind) };
  check(same(payload, deploymentPayload(normalized)), 'deployment_options');
  check(d.tick === (entry.indexTick ?? entry.tick) && Number(d.dec) === 0, 'deployment_semantics');
  if (entry.kind === 'dmt') {
    check(d.elem === elementId && d.dt === dt, 'deployment_definition');
    check(typeof reads.element === 'function', 'tap_element_lookup_required');
    const element = await reads.element(elementId);
    check(element?.ins === elementId && element.pat === entry.pattern.pat && Number(element.fld) === entry.pattern.fld, 'element_binding');
    check(typeof element.tick === 'string' && (!entry.elementName || element.tick === entry.elementName), 'element_name');
    const text = await reads.content(elementId), parts = typeof text === 'string' ? text.trim().split('.') : [];
    check(parts.length >= 4 && parts[0].toLowerCase() === element.tick && parts.at(-1) === 'element' &&
      parts.at(-2) === String(element.fld) && parts.slice(1, -2).join('.') === element.pat, 'element_content');
    check((await reads.included(elementId, view))?.confirmations >= confirmations, 'element_confirmations');
  } else check(d.max === normalized.options.max && (d.lim ?? '0') === (normalized.options.lim ?? '0'), 'deployment_supply');
  check(typeof reads.privilegeAuthority === 'function', 'tap_authority_lookup_required');
  const authority = await reads.privilegeAuthority(entry.privilege);
  check(!authority || authority.ins === entry.privilege, 'privilege_binding');
  check(authority, 'privilege_inactive');
  check(await reads.tap('getPrivilegeAuthCancelled/' + entry.privilege) === false, 'privilege_cancelled');
  const auth = await reads.content(entry.privilege), digest = hash(JSON.stringify(auth.auth) + auth.salt);
  check(auth.hash === digest, 'privilege_digest');
  const compact = ['r', 's'].map(k => BigInt(auth.sig[k]).toString(16).padStart(64, '0')).join('');
  const key = secp256k1.Signature.fromCompact(compact).addRecoveryBit(Number(auth.sig.v)).recoverPublicKey(digest).toHex(true);
  check(key === (entry.authorityKey ?? (await reads.authority()).committee), 'privilege_binding');
  const inclusion = await reads.included(entry.id, view);
  check(inclusion?.confirmations >= confirmations, 'deployment_confirmations');
  if (entry.receiver) check((await reads.inscription(entry.id, view))?.address === entry.receiver, 'deployment_receiver');
  if (entry.approval) check(entry.approval === generationDigest(entry), 'deployment_approval');
  return { deployment: d, inclusion, authority, authorityKey: key, elementId, dt };
}

// Absence checks must come from a complete current indexed view, never a list
// search hidden in deployment verification or provisioning.
export async function elementByDefinition(reads, pattern) {
  check(typeof reads.elementByDefinition === 'function', 'tap_element_lookup_required');
  const row = await reads.elementByDefinition(pattern.pat, pattern.fld);
  check(!row || row.pat === pattern.pat && Number(row.fld) === pattern.fld, 'element_binding'); return row;
}
export async function elementByName(reads, name) {
  check(typeof reads.elementByName === 'function', 'tap_element_lookup_required');
  const row = await reads.elementByName(name);
  check(!row || row.tick.toLowerCase() === name.toLowerCase(), 'element_name'); return row;
}
