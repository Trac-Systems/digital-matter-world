import { stableJSON, decimalV2, verifyCraftPreview, craftActionDigest, verifyNamedRecord } from '../../rules/src/index.js';
import { sendNamedMove } from './named-discovery.mjs';
import { signBytes } from './signing.mjs';
import { check, nonce, sha256 } from './check.mjs';

// The authenticated preview the craft action signs: the gateway's proof,
// verified against the accepted catalog root at the current snapshot. Signs
// and saves nothing; the local dashboard shows it before the owner confirms.
export async function previewCraftNamed(agent, { recipe, inputs }, context) {
  const head = await agent.trac.head(), height = decimalV2(head.counted), snapshot = { height, hash: await agent.trac.hashAt(height) };
  const ordered = [...inputs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const proof = await agent.service.craftPreview({ recipe, inputs: ordered, snapshot }, context.settings.values.proofBytes);
  return { height, snapshot, ordered, result: verifyCraftPreview(proof, { root: context.catalogRoot, recipe, inputs: ordered, snapshot, settings: context.settings, executionHeight: height }) };
}
export async function craftNamed(agent, { actionId, recipe, inputs }, context) {
  agent.actionId(actionId);
  const id = `craft/${actionId}`, intent = { recipe, inputs }, saved = agent.journal.get(`${id}/v2-intent`);
  check(!agent.journal.get(id) || saved, 'Reconcile the saved legacy craft before using v2');
  if (saved) check(saved.fingerprint === sha256(stableJSON(intent)), 'Conflicting craft action ID');
  let chosen = saved?.body;
  if (!chosen) {
    const { height, snapshot, ordered, result } = await previewCraftNamed(agent, { recipe, inputs }, context);
    if (agent.dryRun) return { state: 'dry-run', action: 'craft-v2', signed: false, compound: result.record, amount: result.amount, existing: result.existing };
    const account = await agent.trac.accountRoot(agent.owner);
    check(account && typeof account.revision === 'string', 'No accepted matter account');
    const action = { type: 'craft', owner: agent.owner, revision: account.revision, nonce: nonce(),
      until: String(BigInt(height) + BigInt(context.settings.values.requestMaxBlocks)), in: ordered,
      out: [[result.record.id, result.amount]], compound: result.record.commitment };
    action.sig = signBytes(agent.wallet, craftActionDigest(agent.network, action));
    chosen = agent.journal.reserve(`${id}/v2-intent`, intent, { payload: { recipe, snapshot, action }, settings: context.settings, result }).body;
  }
  return { ...await sendNamedMove(agent, id, 'craft-v2', chosen.payload, chosen.settings), compound: chosen.result.record, amount: chosen.result.amount, existing: chosen.result.existing };
}
export async function refineCompoundNamed(agent, { actionId, asset, steps }, context) {
  agent.actionId(actionId); const id = `compound-refine/${actionId}`, intent = { asset, steps: steps ?? null };
  const old = agent.journal.get(`${id}/intent`);
  if (old) check(old.fingerprint === sha256(stableJSON(intent)), 'Conflicting compound refinement action ID');
  let chosen = old?.body;
  if (!chosen) {
    const read = async kind => verifyNamedRecord(await agent.service.compoundProof(asset, kind, context.settings.values.proofBytes),
      { root: context.catalogRoot, key: `compound/${kind}/${asset}`, settings: context.settings });
    const record = await read('assets'); check(record, 'Unknown compound');
    const progress = await read('tiers');
    if ((progress?.value ?? record.tier.value) !== null) return { state: 'complete', asset, tier: progress?.value ?? record.tier.value };
    chosen = { payload: { asset, cursor: progress?.cursor ?? '0', steps: steps ?? context.settings.values.compoundWorkBudget }, settings: context.settings };
    if (!agent.dryRun) chosen = agent.journal.reserve(`${id}/intent`, intent, chosen).body;
  }
  return sendNamedMove(agent, id, 'compound-refine-v2', chosen.payload, chosen.settings);
}
