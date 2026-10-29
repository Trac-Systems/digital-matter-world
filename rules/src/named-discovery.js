import { assert, exactKeys, hashObject, hex, stableJSON, utf8 } from './core.js';
import { validateDefinition, countWith } from './patterns.js';
import { discoveryCommitment } from '../legacy/v1/rules/src/discovery.js';
import { uintV2, compareUint, nextUint, addUint, decimalV2 } from './integers-v2.js';
import { namedGet, namedSet, namedRoot, EMPTY_NAMED_ROOT } from './named-index.js';
import { validateSettingsDocument } from './settings-v2.js';
import { recordGet, recordSet } from './record-index.js';
import { publicMintActive } from './public-mint.js';

function policy(document) { validateSettingsDocument(document); return document.values; }
export function canonicalDefinition(proposal, document) {
  const s = policy(document);
  assert(exactKeys(proposal, ['name', 'pat', 'fld', 'dt']) && /^dmw[a-z0-9]{2,29}$/.test(proposal.name), 'pattern_name');
  validateDefinition(proposal, { maxLength: s.patternMaxLength, maxLiteralDigits: s.patternMaxLiteralDigits,
    maxAlternatives: s.patternMaxAlternatives, maxAtoms: s.patternMaxAtoms, maxQuantifiers: s.patternMaxQuantifiers, minMatchingBlocks: s.minMatchingBlocks });
  assert(!new RegExp(proposal.pat).test(''), 'pattern_nullable');
  // Only character-class spelling is normalized. Alternative order is semantic
  // under global, non-overlapping matching and must never be sorted.
  const pat = proposal.pat.replace(/\[([^\]]+)\]/g, (_, source) => {
    const chars = new Set();
    for (let i = 0; i < source.length; i++) {
      if (source[i + 1] === '-') { for (let c = source.charCodeAt(i); c <= source.charCodeAt(i + 2); c++) chars.add(String.fromCharCode(c)); i += 2; }
      else chars.add(source[i]);
    }
    return '[' + [...chars].sort().join('') + ']';
  });
  return { pat, fld: proposal.fld, dt: proposal.dt };
}
export const definitionKey = (proposal, document) => hashObject(['dmw-pattern-v2', canonicalDefinition(proposal, document)]);
export function witnessRoot(matches) { return hashObject(['dmw-witnesses-v2', matches]); }
export function namedCommitment({ proposal, salt, agent, anchor, matches, settings }) {
  assert(hex(salt, 32) && hex(agent, 32), 'discovery_commitment');
  return hashObject(['dmw-discovery-v2', settings.network, settings.ruleset, settings.revision, hashObject(settings), agent,
    canonicalDefinition(proposal, settings), proposal.name, salt, anchor, witnessRoot(matches)]);
}
export const emptyNamedDiscovery = () => ({ version: 2, nextPattern: '0', catalogRevision: '0', records: null, evidence: {}, evidenceByRoot: {} });
const read = (state, key) => namedGet(state.records, key);
const write = (state, key, value) => { state.records = namedSet(state.records, key, value); };
const commitKey = (agent, commitment) => `commit/${agent}/${commitment}`;
function evidenceSet(index, key, value) {
  const old = recordGet(index, key), size = decimalV2(index?.$dmwIndex ? index.size : Object.keys(index ?? {}).length);
  return { ...recordSet(index, key, value), size: old === undefined ? nextUint(size) : size };
}

// Expired entries cannot block admission. The due index is an archival cleanup
// input, not a resident-array capacity or a scan performed on every reveal.
export function commitNamedDiscovery(state, { agent, commitment, tip, receiptPosition, settings }) {
  const s = policy(settings); uintV2(tip); uintV2(receiptPosition);
  assert(hex(agent, 32) && hex(commitment, 32), 'discovery_commitment');
  const key = commitKey(agent, commitment), old = read(state, key);
  assert(!old, 'discovery_commit_exists');
  const expires = addUint(tip, String(s.commitLifetime)), next = { ...state };
  write(next, key, { agent, commitment, tip, receiptPosition, eligible: addUint(tip, String(s.minRevealDelay)), expires,
    settingsHash: hashObject(settings), settingsRevision: settings.revision, network: settings.network, format: 2, opened: false });
  write(next, `expiry/${expires}/${agent}/${commitment}`, key);
  return next;
}
export function migrateLegacyCommit(state, commitment, { network, settingsHash, receiptPosition, lifetime = 144, minDelay = 2 }) {
  assert(hex(commitment.agent, 32) && hex(commitment.commitment, 32) && Number.isSafeInteger(commitment.tip) && commitment.tip >= 0, 'legacy_commit');
  assert(Number.isSafeInteger(lifetime) && lifetime > 0 && Number.isSafeInteger(minDelay) && minDelay >= 0, 'legacy_commit_window');
  uintV2(receiptPosition);
  const tip = String(commitment.tip), key = commitKey(commitment.agent, commitment.commitment), next = { ...state };
  assert(!read(state, key), 'discovery_commit_exists');
  const expires = addUint(tip, String(lifetime));
  write(next, key, { ...commitment, tip, receiptPosition, eligible: addUint(tip, String(minDelay)), expires,
    settingsHash, network, format: 1, opened: false, status: 'awaiting_block_evidence' });
  write(next, `expiry/${expires}/${commitment.agent}/${commitment.commitment}`, key); return next;
}
function order(a, b) { return compareUint(a.tip, b.tip) || (a.commitment < b.commitment ? -1 : a.commitment > b.commitment ? 1 : a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0); }
export function knownTier(count, settings) {
  uintV2(count); const at = policy(settings).tierThresholds.findIndex(t => compareUint(count, t) <= 0); return at < 0 ? 1 : 5 - at;
}
function checkHeader(history, height, expectedHash) {
  const row = history.get(height); // Independent verified canonical view only.
  assert(row && row.hash === expectedHash && String(row.height) === height, 'occurrence_branch');
  return row;
}
export function verifyNamedWitnesses(proposal, anchor, matches, settings, history, counted, minimum = 1) {
  const s = policy(settings);
  assert(exactKeys(anchor, ['height', 'hash']) && hex(anchor.hash, 32), 'discovery_anchor'); uintV2(anchor.height); uintV2(counted);
  assert(compareUint(anchor.height, counted) <= 0, 'discovery_anchor');
  assert(Array.isArray(matches) && matches.length >= minimum && matches.length <= s.occurrencePageSize, 'discovery_witness_budget');
  assert(utf8(stableJSON({ proposal, anchor, matches })).length <= s.moveBytes, 'discovery_bytes');
  // Structural checks precede any header read, including the anchor.
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]; assert(exactKeys(m, ['height', 'hash', 'count']) && hex(m.hash, 32), 'occurrence');
    uintV2(m.height); uintV2(m.count);
    assert(compareUint(m.count, '0') > 0 && compareUint(m.height, anchor.height) <= 0 && (!i || compareUint(matches[i - 1].height, m.height) < 0), 'occurrence_order');
  }
  const anchorRow = checkHeader(history, anchor.height, anchor.hash), re = new RegExp(proposal.pat, 'g');
  for (const m of matches) {
    const row = m.height === anchor.height ? anchorRow : checkHeader(history, m.height, m.hash);
    const field = proposal.fld === 4 ? m.height : (proposal.fld === 10 ? row.nonce : row.bits).toString(proposal.dt === 'h' ? 16 : 10);
    assert(String(countWith(re, field)) === m.count, 'occurrence_count');
  }
  return true;
}
function addMatches(next, record, matches, agent, settings) {
  const results = []; let evidence = recordGet(next.evidence, record.key) ?? null;
  assert(namedRoot(evidence) === (record.evidenceRoot ?? EMPTY_NAMED_ROOT), 'occurrence_index_root');
  for (const m of matches) {
    const old = namedGet(evidence, m.height);
    if (old) { assert(old.hash === m.hash && old.count === m.count, 'occurrence_requires_reorg_correction'); results.push('already_known'); continue; }
    evidence = namedSet(evidence, m.height, { ...m, contribution: agent });
    write(next, `height/${m.height}/${m.hash}/${record.key}`, true);
    record.knownMatchCount = nextUint(record.knownMatchCount); record.knownOccurrenceTotal = addUint(record.knownOccurrenceTotal, m.count);
    results.push('added');
  }
  record.evidenceRoot = namedRoot(evidence); record.tier = knownTier(record.knownMatchCount, settings);
  next.evidence = evidenceSet(next.evidence, record.key, evidence);
  next.evidenceByRoot = evidenceSet(next.evidenceByRoot, record.evidenceRoot, evidence);
  return results;
}
function storeRecord(next, record, settings) {
  next.catalogRevision = nextUint(next.catalogRevision); record.catalogRevision = next.catalogRevision;
  record.tier = knownTier(record.knownMatchCount, settings);
  record.settingsHash = hashObject(settings);
  write(next, `pattern/${record.key}`, record);
  write(next, `revision/${record.key}/${record.catalogRevision}`, record);
}
export function revealNamedDiscovery(state, { agent, commitmentId, proposal, salt, anchor, matches, witnessRoot: root,
  tip, counted, receiptPosition, settings, currentSettings = settings, history, provenance = null }) {
  const s = policy(settings); uintV2(tip); uintV2(receiptPosition);
  assert(Array.isArray(matches) && matches.length >= s.minMatchingBlocks && matches.length <= s.occurrencePageSize, 'discovery_witness_budget');
  assert(utf8(stableJSON({ proposal, anchor, matches })).length <= s.moveBytes, 'discovery_bytes');
  const c = read(state, commitKey(agent, commitmentId));
  const acceptedOpening = c?.format === 1 && read(state, `legacy-reveal/${agent}/${commitmentId}`);
  assert(c && !c.opened && compareUint(tip, c.eligible) >= 0 && (acceptedOpening || compareUint(tip, c.expires) <= 0), 'discovery_reveal_window');
  if (acceptedOpening) assert(stableJSON(acceptedOpening.original.proposal) === stableJSON(proposal), 'legacy_reveal_binding');
  assert(c.network === settings.network && c.settingsHash === hashObject(settings), 'discovery_settings');
  const identity = definitionKey(proposal, settings);
  const expected = c.format === 1 ? discoveryCommitment(proposal, salt, agent) : namedCommitment({ proposal, salt, agent, anchor, matches, settings });
  assert(commitmentId === expected && root === witnessRoot(matches), 'discovery_opening');
  assert(compareUint(c.receiptPosition, receiptPosition) < 0, 'discovery_receipt_order');
  const existing = read(state, `pattern/${identity}`), nameOwner = read(state, `name/${proposal.name}`);
  assert(!nameOwner || nameOwner === identity, 'pattern_exists');
  verifyNamedWitnesses(proposal, anchor, matches, settings, history, counted, s.minMatchingBlocks);
  const next = { ...state }, record = existing ? { ...existing } : {
    key: identity, number: state.nextPattern, ...proposal, discoverer: agent, attribution: c,
    attributionCloses: c.expires, firstRevealPosition: receiptPosition, attributionProvisional: true,
    anchor, knownMatchCount: '0', knownOccurrenceTotal: '0', provenance,
    definitionSettingsHash: hashObject(settings),
    ...(publicMintActive(currentSettings, tip) ? { releaseHeight: tip, releaseFinderWindow: currentSettings.values.finderWindow } : {})
  };
  if (!existing) { next.nextPattern = nextUint(next.nextPattern); write(next, `number/${record.number}`, identity); }
  else if (compareUint(tip, record.attributionCloses) <= 0 && compareUint(c.receiptPosition, record.firstRevealPosition) < 0 && order(c, record.attribution) < 0) {
    record.discoverer = agent; record.attribution = c;
  }
  // The display name and closing deadline never move. An earlier committed
  // unused name becomes an indexed alias to the same immutable asset number.
  write(next, `name/${proposal.name}`, identity);
  if (compareUint(anchor.height, record.anchor.height) > 0) record.anchor = anchor;
  const results = addMatches(next, record, matches, agent, currentSettings);
  storeRecord(next, record, currentSettings);
  write(next, commitKey(agent, commitmentId), { ...c, opened: true });
  return { state: next, record, results };
}
export function submitOccurrences(state, { patternKey, agent, anchor, matches, settings, history, counted }) {
  assert(hex(agent, 32), 'occurrence_agent');
  const old = read(state, `pattern/${patternKey}`); assert(old, 'pattern_unknown');
  verifyNamedWitnesses(old, anchor, matches, settings, history, counted, 1);
  const next = { ...state }, record = { ...old }, results = addMatches(next, record, matches, agent, settings);
  if (results.includes('added')) { record.anchor = compareUint(anchor.height, old.anchor.height) > 0 ? anchor : old.anchor; storeRecord(next, record, settings); }
  return { state: next, record, results };
}
// A verifier reads the exact accepted statement by revision; an extra block is
// a contribution, never fraud. A replaced canonical hash is a reorg incident.
export function challengeNamedCount(state, { patternKey, revision, height, history }) {
  uintV2(revision); uintV2(height);
  const record = read(state, `revision/${patternKey}/${revision}`); assert(record, 'catalog_revision_unknown');
  const evidence = recordGet(state.evidenceByRoot, record.evidenceRoot);
  assert(namedRoot(evidence) === record.evidenceRoot, 'occurrence_index_root');
  const leaf = namedGet(evidence, height); assert(leaf, 'occurrence_not_asserted');
  const row = history.get(height); assert(row && String(row.height) === height, 'occurrence_header_missing');
  if (row.hash !== leaf.hash) return { outcome: 'reorg', reward: '0' };
  const field = record.fld === 4 ? height : (record.fld === 10 ? row.nonce : row.bits).toString(record.dt === 'h' ? 16 : 10);
  return { outcome: String(countWith(new RegExp(record.pat, 'g'), field)) === leaf.count ? 'correct' : 'incorrect_count', reward: '0' };
}
export function closeNamedAttribution(state, { patternKey, tip, settings }) {
  uintV2(tip);
  const old = read(state, `pattern/${patternKey}`); assert(old, 'pattern_unknown');
  assert(compareUint(tip, old.attributionCloses) > 0, 'attribution_still_open');
  if (!old.attributionProvisional) return { state, record: old, closed: false };
  const next = { ...state }, record = { ...old, attributionProvisional: false };
  storeRecord(next, record, settings);
  return { state: next, record, closed: true };
}
// Corrections are named, revision-bound transitions. A stale branch is not
// misconduct. Removing evidence leaves historical roots intact and never
// changes a find or paid obligation implicitly.
export function correctNamedOccurrence(state, { patternKey, revision, height, history, settings, provenance = null }) {
  uintV2(height); uintV2(revision);
  const old = read(state, `pattern/${patternKey}`); assert(old && old.catalogRevision === revision, 'catalog_revision_stale');
  let evidence = recordGet(state.evidence, patternKey);
  assert(namedRoot(evidence) === old.evidenceRoot, 'occurrence_index_root');
  const leaf = namedGet(evidence, height); assert(leaf, 'occurrence_not_asserted');
  const row = history.get(height); assert(row && String(row.height) === height, 'occurrence_header_missing');
  const field = old.fld === 4 ? height : (old.fld === 10 ? row.nonce : row.bits).toString(old.dt === 'h' ? 16 : 10);
  const count = String(countWith(new RegExp(old.pat, 'g'), field));
  assert(row.hash !== leaf.hash || count !== leaf.count, 'occurrence_already_correct');
  const next = { ...state }, record = { ...old, correction: { height, previousHash: leaf.hash, canonicalHash: row.hash,
    reason: row.hash !== leaf.hash ? 'reorg' : 'incorrect_count', provenance } };
  // A replacement block must be submitted independently. Never backfill it.
  evidence = namedSet(evidence, height, null);
  next.evidence = evidenceSet(next.evidence, patternKey, evidence);
  record.evidenceRoot = namedRoot(evidence); next.evidenceByRoot = evidenceSet(next.evidenceByRoot, record.evidenceRoot, evidence);
  record.knownMatchCount = String(BigInt(old.knownMatchCount) - 1n);
  record.knownOccurrenceTotal = String(BigInt(old.knownOccurrenceTotal) - BigInt(leaf.count));
  record.tier = knownTier(record.knownMatchCount, settings);
  write(next, `height/${height}/${leaf.hash}/${patternKey}`, null);
  storeRecord(next, record, settings);
  return { state: next, record, incident: record.correction };
}
