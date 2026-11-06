import { check, hash } from './util.mjs';
import { rules } from './rules.mjs';
import { snapshotMemo } from './snapshot-memo.mjs';
import { createRequire } from 'node:module';
const { secp256k1 } = createRequire(new URL('../../local/package.json', import.meta.url))('@noble/curves/secp256k1');

export const same = (a, b) => a === undefined || b === undefined ? a === b : rules.stableJSON(a) === rules.stableJSON(b);
// Words for a taken ticker or element name: the same name plus a word, then two words.
export const NAME_WORDS = Object.freeze(['amber', 'basalt', 'cobalt', 'dune', 'ember', 'flint', 'garnet', 'granite', 'jade', 'jasper',
  'onyx', 'opal', 'pearl', 'quartz', 'ruby', 'slate', 'topaz', 'agate', 'beryl', 'coral', 'delta', 'fern', 'frost', 'gneiss',
  'gypsum', 'halite', 'iron', 'ivory', 'lava', 'lichen', 'marble', 'mica', 'moss', 'nickel', 'ochre', 'pumice', 'pyrite', 'reef',
  'river', 'sand', 'shale', 'silver', 'spruce', 'stone', 'talc', 'tide', 'zinc', 'zircon', 'aspen', 'birch', 'cedar', 'cliff',
  'comet', 'crest', 'dawn', 'drift', 'dusk', 'glade', 'grove', 'mesa', 'peak', 'ridge', 'storm', 'vale', 'willow', 'brook',
  'canyon', 'cave', 'clay', 'copper', 'dew', 'elm', 'fjord', 'gale', 'glacier', 'gold', 'hail', 'heath', 'isle', 'kelp', 'lake',
  'leaf', 'loam', 'maple', 'marsh', 'meadow', 'mist', 'nova', 'oak', 'oasis', 'pine', 'prism', 'rain', 'sage', 'snow', 'summit',
  'thorn', 'umber', 'wave', 'wind']);
// Every party derives the same name from the job and attempt. The name part is
// shortened to fit 32 characters; existing dmw names keep their prefix.
export function candidate(job, domain, attempt, base) {
  check(Number.isSafeInteger(attempt) && attempt >= 1 && typeof base === 'string' && (/^[a-z0-9]{3,32}$/.test(base) || /^dmw[a-z0-9]*$/.test(base)), 'candidate_name');
  const seed = hash(rules.stableJSON(['dmw-allocation-v2', job.network, job.asset, job.generation, domain, job.salt]));
  const n = NAME_WORDS.length, a = parseInt(seed.slice(0, 8), 16), b = parseInt(seed.slice(8, 16), 16), k = attempt - 1;
  const word = (offset, i) => NAME_WORDS[(offset + i) % n];
  const suffix = k < n ? word(a, k) : k < n + n * n ? word(a, k - n) + word(b, Math.floor((k - n) / n)) : word(a, k) + String(Math.floor(k / n));
  return base.slice(0, Math.max(3, 32 - suffix.length)) + suffix;
}
export const deploymentOptions = kind => kind === 'dmt' ? {} : { max: '18446744073709551615', dec: '0' };
// prov names the pattern's discoverer or the compound's first maker (a trac1 address).
// Entries registered before it existed carry none.
export function deploymentPayload(entry) {
  const prov = entry.prov === undefined ? {} : { prov: entry.prov };
  return entry.kind === 'dmt' ? { p: 'tap', op: 'dmt-deploy', tick: entry.tick, elem: entry.elementId, dt: entry.dt, prv: entry.privilege, ...prov, ...entry.options } :
    { p: 'tap', op: 'token-deploy', tick: entry.tick, prv: entry.privilege, ...prov, ...entry.options };
}
export function generationDigest(entry) {
  const keys = ['network', 'asset', 'generation', 'id', 'privilege', 'authorityKey', 'elementId', 'elementName', 'receiver', 'dt', 'kind', 'tick', 'indexTick', 'options'];
  return hash(rules.stableJSON({ ...Object.fromEntries([...keys, ...(entry.prov === undefined ? [] : ['prov']), ...(entry.officialDeployment === undefined ? [] : ['officialDeployment']), ...(entry.tickerRequestId === undefined ? [] : ['tickerRequestId'])].map(k => [k, entry[k] ?? null])),
    ...(rules.fieldValueMode(entry.pattern ?? {}) ? { amountMode: 'field-value' } : {}) }));
}
// All callers (operator, gateway and each signer) verify indexed semantics as
// well as the exact inscription. Sharing an authority is not an approval.
// Everything this check reads (TAP's deploy, element and privilege records, inscription contents and confirmations)
// can only change with a new Bitcoin block. Inside a snapshot whose block is known, a successful check is reused for
// the same deployment until the block changes; refusals are never kept. Signers verify independently.
const verified = new WeakMap();
function verifiedCache(reads) { let cache = verified.get(reads); if (!cache) verified.set(reads, cache = snapshotMemo({ limit: 512 })); return cache; }
export async function verifyDeployment(reads, entry, options = {}) {
  const financialSnapshot = reads.financialSnapshot?.();
  const verify = () => financialSnapshot && reads.memoFinancialRead ? reads.memoFinancialRead('verifiedDeployment',
    [entry, options, reads.feeQuotes?.document ? rules.hashObject(reads.feeQuotes.document) : null],
    () => verifyDeploymentRecords(reads, entry, options), options.view ?? financialSnapshot) : verifyDeploymentRecords(reads, entry, options);
  if (!reads.withTapSnapshot) return verify();
  try {
    return await reads.withTapSnapshot(options.view, async stamp => {
      if (!stamp?.hash || financialSnapshot) return verify();
      const key = rules.stableJSON([stamp, entry, options.confirmations ?? 1, options.verifyReceiver ?? null, options.view ?? null]);
      return structuredClone(await verifiedCache(reads)(key, verify));
    });
  } catch (error) { verified.get(reads)?.clear(); throw error; }
}
// The reads are independent, so they all start at once inside the same TAP snapshot; the checks then run in their
// original order, and a read error surfaces only where that read was used before, so refusals keep their reasons.
const settled = promise => Promise.resolve().then(() => promise).then(value => ({ value }), error => ({ error }));
const take = result => { if (result.error) throw result.error; return result.value; };
async function verifyDeploymentRecords(reads, entry, { confirmations = 1, view, verifyReceiver } = {}) {
  check(entry && entry.suspended !== true, 'asset_provisioning');
  const known = entry.elementId, dmt = entry.kind === 'dmt';
  const early = {
    d: settled(reads.tap('getDeployment/' + encodeURIComponent(entry.indexTick ?? entry.tick))),
    payload: settled(reads.content(entry.id)),
    authority: typeof reads.privilegeAuthority === 'function' ? settled(reads.privilegeAuthority(entry.privilege)) : null,
    cancelled: settled(reads.tap('getPrivilegeAuthCancelled/' + entry.privilege)),
    auth: settled(reads.content(entry.privilege)),
    inclusion: settled(reads.included(entry.id, view)),
    ...(dmt && known && typeof reads.element === 'function' ? { element: settled(reads.element(known)), elementText: settled(reads.content(known)),
      elementInclusion: settled(reads.included(known, view)) } : {}),
  };
  const d = take(await early.d);
  check(d?.ins === entry.id && d.prv === entry.privilege, 'deployment_binding');
  const payload = take(await early.payload);
  const elementId = entry.elementId ?? payload.elem, dt = entry.dt ?? entry.pattern?.dt;
  const normalized = { ...entry, elementId, dt, options: entry.options ?? deploymentOptions(entry.kind) };
  check(same(payload, deploymentPayload(normalized)), 'deployment_options');
  check(d.tick === (entry.indexTick ?? entry.tick) && Number(d.dec) === 0, 'deployment_semantics');
  if (dmt) {
    check(d.elem === elementId && d.dt === dt, 'deployment_definition');
    check(typeof reads.element === 'function', 'tap_element_lookup_required');
    const element = take(await (early.element ?? settled(reads.element(elementId))));
    const pat = rules.tapElementPattern(entry.pattern);
    check(element?.ins === elementId && (element.pat ?? null) === pat && Number(element.fld) === entry.pattern.fld, 'element_binding');
    check(typeof element.tick === 'string' && (!entry.elementName || element.tick === entry.elementName), 'element_name');
    const text = take(await (early.elementText ?? settled(reads.content(elementId)))), parts = typeof text === 'string' ? text.trim().split('.') : [];
    check((pat === null ? parts.length === 3 : parts.length >= 4) && parts[0].toLowerCase() === element.tick && parts.at(-1) === 'element' &&
      parts.at(-2) === String(element.fld) && (pat === null || parts.slice(1, -2).join('.') === element.pat), 'element_content');
    check(take(await (early.elementInclusion ?? settled(reads.included(elementId, view))))?.confirmations >= confirmations, 'element_confirmations');
  } else check(d.max === normalized.options.max && (d.lim ?? '0') === (normalized.options.lim ?? '0'), 'deployment_supply');
  check(early.authority, 'tap_authority_lookup_required');
  const authority = take(await early.authority);
  check(!authority || authority.ins === entry.privilege, 'privilege_binding');
  check(authority, 'privilege_inactive');
  check(take(await early.cancelled) === false, 'privilege_cancelled');
  const auth = take(await early.auth), digest = hash(JSON.stringify(auth.auth) + auth.salt);
  check(auth.hash === digest, 'privilege_digest');
  const compact = ['r', 's'].map(k => BigInt(auth.sig[k]).toString(16).padStart(64, '0')).join('');
  const key = secp256k1.Signature.fromCompact(compact).addRecoveryBit(Number(auth.sig.v)).recoverPublicKey(digest).toHex(true);
  check(key === (entry.authorityKey ?? (await reads.authority()).committee), 'privilege_binding');
  const inclusion = take(await early.inclusion);
  check(inclusion?.confirmations >= confirmations, 'deployment_confirmations');
  if (entry.receiver && (verifyReceiver ?? (!entry.inclusion || !rules.multiTickerActive(view?.executionHeight ?? view?.counted ?? await reads.counted())))) check((await reads.inscription(entry.id, view))?.address === entry.receiver, 'deployment_receiver');
  if (entry.approval) check(entry.approval === generationDigest(entry), 'deployment_approval');
  return { deployment: d, inclusion, authority, authorityKey: key, elementId, dt };
}

// Absence checks must come from a complete current indexed view, never a list
// search hidden in deployment verification or provisioning.
export async function elementByDefinition(reads, pattern) {
  check(typeof reads.elementByDefinition === 'function', 'tap_element_lookup_required');
  const pat = rules.tapElementPattern(pattern), row = await reads.elementByDefinition(pat, pattern.fld);
  check(!row || (row.pat ?? null) === pat && Number(row.fld) === pattern.fld, 'element_binding'); return row;
}
export async function elementByName(reads, name) {
  check(typeof reads.elementByName === 'function', 'tap_element_lookup_required');
  const row = await reads.elementByName(name);
  check(!row || row.tick.toLowerCase() === name.toLowerCase(), 'element_name'); return row;
}
