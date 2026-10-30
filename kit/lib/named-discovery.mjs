import { canonicalDefinition, namedCommitment, witnessRoot, verifyNamedWitnesses, hashObject, stableJSON,
  decimalV2, addUint, compareUint, safeNumberV2, discoveryCommitment, RESOURCE_PROFILE, verifyNamedRecord, activationManifest, validateSettingsDocument, validateNamedPayload } from '../../rules/src/index.js';
import { signNamedMove } from './signing.mjs';
import { searchMatchPage } from './search-matches.mjs';
import { check, nonce, sha256 } from './check.mjs';
import { historyProof } from './headers.mjs';
import { fieldValueAmountActive } from '../../rules/src/pattern-amount.js';

const localView = history => ({ get: h => history.get(safeNumberV2(h)) });
async function evidence(agent, proposal, history, settings, supplied) {
  historyProof(history);
  canonicalDefinition(proposal, settings);
  const head = await agent.trac.head(), at = Math.min(history.length - 1, safeNumberV2(decimalV2(head.counted))), hash = history.get(at).hash;
  check(proposal.amountMode === undefined || fieldValueAmountActive(head.counted), 'pattern_amount_inactive');
  check(await agent.trac.hashAt(at) === hash, 'Discovery snapshot is not canonical');
  const page = supplied ?? await searchMatchPage({ history, proposal, tip: { height: at, hash }, pageSize: settings.values.minMatchingBlocks, settings });
  const anchor = { height: decimalV2(page.anchor?.height ?? page.searchSnapshot.height), hash: page.anchor?.hash ?? page.searchSnapshot.hash };
  const matches = page.matches.map(m => ({ ...m, height: decimalV2(m.height), count: decimalV2(m.count) }));
  verifyNamedWitnesses(proposal, anchor, matches, settings, localView(history), decimalV2(head.counted), settings.values.minMatchingBlocks);
  check(await agent.trac.hashAt(safeNumberV2(anchor.height)) === anchor.hash, 'Discovery snapshot is not canonical');
  return { anchor, matches, witnessRoot: witnessRoot(matches) };
}
export async function sendNamedMove(agent, id, type, payload, settings, validate = async () => {}) {
  const executionHeight = type === 'discovery-reveal-v2' && payload.proposal?.amountMode !== undefined
    ? decimalV2((await agent.trac.head()).counted) : type === 'craft-v2' ? payload.snapshot?.height ?? '0' : '0';
  validateNamedPayload(type, payload, settings, executionHeight);
  let row = agent.journal.get(id); const intent = { type, payload };
  if (row) check(row.fingerprint === sha256(stableJSON(intent)), 'Conflicting action refused; use the saved intent');
  if (!agent.dryRun && row && ['received', 'accepted', 'rejected'].includes(row.state)) return { state: row.state, receipt: row.result, replayed: true };
  if (!agent.dryRun && row?.state === 'refused' && Number.isSafeInteger(row.result?.retryAt)) {
    const remaining = row.result.retryAt - Date.now();
    if (remaining > 0 && remaining <= 2147483647) await new Promise(resolve => setTimeout(resolve, remaining));
  }
  const head = await agent.trac.head(); await validate(head);
  if (agent.dryRun) return { state: 'dry-run', action: type, signed: false };
  const prepare = async head => {
    const move = await signNamedMove(agent.wallet, { type, payload, tip: head.tip, settings }, { resources: agent.resources ?? RESOURCE_PROFILE });
    const fresh = await agent.trac.head(); check(decimalV2(head.tip.height) === decimalV2(fresh.tip.height) && head.tip.hash === fresh.tip.hash, 'Tip changed while solving; retry');
    row = row ? agent.journal.renewMove(id, intent, move, row) : agent.journal.reserve(id, intent, move);
  };
  if (!row || row.state === 'refused') await prepare(head);
  await agent.journal.waitTurn(async () => {
    const head = await agent.trac.head(); await validate(head);
    const age = BigInt(decimalV2(head.tip.height)) - BigInt(row.body.b);
    if (age < 0n || age > BigInt(settings.values.moveFreshnessTips) || await agent.trac.hashAt(safeNumberV2(row.body.b)) !== row.body.h) {
      check(row.state === 'prepared', 'Saved packet outcome is unknown; reconcile it before refreshing'); await prepare(head);
    }
    return head;
  });
  agent.journal.mark(id, 'sending');
  try {
    const receipt = await agent.service.submit(row.body, { hashAt: h => agent.trac.hashAt(safeNumberV2(decimalV2(h))) });
    agent.journal.mark(id, 'received', receipt); return { state: 'received', receipt, inclusion: 'unverified' };
  } catch (e) {
    const refused = row.state === 'prepared' && e.refusedBeforeAcceptance === true;
    agent.journal.mark(id, refused ? 'refused' : 'unknown', refused ? { code: e.code, status: e.status,
      ...(Number.isSafeInteger(e.retryAfterMs) ? { retryAt: Date.now() + e.retryAfterMs } : {}) } : null); throw e;
  } finally { agent.journal.finishTurn(); }
}
const send = sendNamedMove;
export async function proposeNamed(agent, { actionId, proposal, history, witnesses }, context) {
  agent.actionId(actionId); const id = `discovery/${actionId}`, old = agent.journal.get(id), settings = context.settings;
  if (old) check(old.fingerprint === sha256(stableJSON(proposal)), 'Conflicting discovery action ID');
  if (old && old.body.version !== 2) throw Error('Saved legacy commitment must be resumed with reveal_pattern and a witness attachment');
  const chosen = old?.body ?? { version: 2, proposal, salt: nonce(), ...await evidence(agent, proposal, history, settings, witnesses), settings };
  if (agent.dryRun) return { state: 'dry-run', action: 'discovery-commit-v2', actionId, witnesses: chosen.matches.length, signed: false };
  const saved = old ?? agent.journal.reserve(id, proposal, chosen);
  const commitment = namedCommitment({ ...saved.body, agent: agent.owner });
  const result = await send(agent, `${id}/commit`, 'discovery-commit-v2', { commitment }, saved.body.settings);
  return { ...result, actionId, commitment, revealFrom: addUint(result.receipt.tip, String(saved.body.settings.values.minRevealDelay)), revealUntil: addUint(result.receipt.tip, String(saved.body.settings.values.commitLifetime)) };
}
export async function revealNamed(agent, { actionId, history, witnesses }, context) {
  agent.actionId(actionId); const id = `discovery/${actionId}`, saved = agent.journal.get(id), commit = agent.journal.get(`${id}/commit`);
  check(saved && commit, 'No saved discovery commitment');
  const legacy = saved.body.version !== 2, commitment = legacy ? discoveryCommitment(saved.body.proposal, saved.body.salt, agent.owner) : namedCommitment({ ...saved.body, agent: agent.owner });
  const previous = agent.journal.get(legacy ? `${id}/reveal-v2` : `${id}/reveal`);
  if (!agent.dryRun && previous && ['received', 'accepted', 'rejected'].includes(previous.state)) return { state: previous.state, receipt: previous.result, actionId, phase: 'reveal', replayed: true };
  check(commit.body.p.commitment === commitment, 'Saved discovery commitment mismatch');
  // The independently verified accepted commitment is required, including
  // original expiry/settings. A gateway delivery receipt is insufficient.
  let accepted;
  if (agent.service.namedCommitmentProof && agent.trac.rulesContext) {
    const current = await agent.trac.rulesContext();
    const manifest = activationManifest(current.manifest, current.manifestHash);
    validateSettingsDocument(current.settings);
    check(current.ready && current.manifestHash === context.manifestHash && manifest.network === agent.network &&
      current.settings.network === agent.network && hashObject(current.settings) === current.settingsHash, 'Commitment activation mismatch');
    const proof = await agent.service.namedCommitmentProof(agent.owner, commitment, current.settings.values.proofBytes);
    accepted = verifyNamedRecord(proof, { root: current.catalogRoot, key: `commit/${agent.owner}/${commitment}`, settings: current.settings });
  } else {
    check(typeof agent.trac.discoveryCommitment === 'function', 'upgrade_required: accepted commitment proof adapter required');
    accepted = await agent.trac.discoveryCommitment(agent.owner, commitment);
  }
  check(accepted?.agent === agent.owner && accepted.commitment === commitment && !accepted.opened, 'Discovery commitment is not accepted or already opened');
  const original = legacy ? await agent.trac.settingsByHash(accepted.settingsHash) : saved.body.settings;
  check(hashObject(original) === accepted.settingsHash, 'Commitment settings mismatch');
  let chosen = saved.body;
  if (legacy) {
    const attached = agent.journal.get(`${id}/witnesses-v2`);
    chosen = attached?.body ?? { ...await evidence(agent, saved.body.proposal, history, original, witnesses), settings: original };
    if (!agent.dryRun && !attached) chosen = agent.journal.reserve(`${id}/witnesses-v2`, { commitment }, chosen).body;
  }
  const payload = { commitmentId: commitment, proposal: saved.body.proposal, salt: saved.body.salt, anchor: chosen.anchor, matches: chosen.matches, witnessRoot: chosen.witnessRoot };
  const validate = async head => {
    historyProof(history);
    const tip = decimalV2(head.tip.height);
    check(compareUint(tip, accepted.eligible) >= 0 && compareUint(tip, accepted.expires) <= 0, 'Discovery reveal window is closed or not yet open');
    verifyNamedWitnesses(payload.proposal, payload.anchor, payload.matches, original, localView(history), decimalV2(head.counted), original.values.minMatchingBlocks);
    check(await agent.trac.hashAt(safeNumberV2(payload.anchor.height)) === payload.anchor.hash, 'Discovery snapshot is not canonical');
  };
  // A legacy packet may still have an uncertain outcome. The attachment gets
  // its own journal row; never overwrite the old packet or claim it succeeded.
  if (legacy) {
    const old = agent.journal.get(`${id}/reveal`);
    check(!old || ['refused', 'rejected', 'accepted'].includes(old.state), 'Reconcile the uncertain legacy reveal before attaching evidence');
  }
  return { ...await send(agent, legacy ? `${id}/reveal-v2` : `${id}/reveal`, 'discovery-reveal-v2', payload, context.settings, validate), actionId, phase: 'reveal' };
}
export async function addNamedOccurrences(agent, { actionId, patternKey, anchor, matches }, context) {
  agent.actionId(actionId);
  return send(agent, `occurrences/${actionId}`, 'submit-occurrences-v2', { patternKey, anchor, matches }, context.settings);
}
