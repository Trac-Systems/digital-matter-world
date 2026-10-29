import { stableJSON, decimalV2, verifyNamedRecord, publicMintActive } from '../../rules/src/index.js';
import { sendNamedMove } from './named-discovery.mjs';
import { accountActionDigest } from '../../contract/root-accounts.js';
import { decodeTracAddress } from '../../rules/src/trac-address.js';
import { check, exact, nonce, sha256 } from './check.mjs';
import { isAsset, patternId } from './api-values.mjs';
import { signBytes } from './signing.mjs';

// Catalog reads only distinguish an unknown asset from an empty balance.
// Only the independently verified account balance authorizes signing, and
// ledger keys are never replaced with a catalog alias.
async function knownAsset(agent, asset, context) {
  if (asset.startsWith('c2:')) return !!verifyNamedRecord(
    await agent.service.compoundProof(asset, 'assets', context.settings.values.proofBytes),
    { root: context.catalogRoot, key: `compound/assets/${asset}`, settings: context.settings });
  return (await agent.catalog()).some(p => patternId(p) === asset || p.legacy?.asset === asset);
}

// Prepare only the existing account engine's owner authorizations. Account
// multiproofs and a receipt envelope belong to the gateway's admitted batch.
export async function prepareTransferV2(agent, { actionId, value }, context) {
  agent.actionId(actionId); exact(value, ['to', 'assets']);
  const to = decodeTracAddress(value.to), pairs = value.assets;
  check(Array.isArray(pairs) && pairs.length > 0 && pairs.length <= 16 &&
    pairs.every(p => Array.isArray(p) && p.length === 2 && isAsset(p[0]) && typeof p[1] === 'string' && /^[1-9][0-9]{0,77}$/.test(p[1])) &&
    new Set(pairs.map(([asset]) => asset)).size === pairs.length, 'transfer_assets');
  const assets = structuredClone(pairs);
  const id = `tx/${actionId}`, intent = { op: 'tf', value: { to, assets } }, key = `${id}/v2-intent`, saved = agent.journal.get(key);
  check(!agent.journal.get(id), 'transfer_legacy_action');
  if (saved) {
    check(saved.fingerprint === sha256(stableJSON(intent)), 'Conflicting transaction action ID');
    return saved.body;
  }
  const v = context.settings.values;
  check(context.ready, 'ruleset_not_ready');
  check(assets.length <= v.accountActions && assets.length * (to === agent.owner ? 2 : 3) <= v.accountLeaves, 'transfer_capacity');
  const account = await agent.trac.accountRoot(agent.owner);
  for (const [asset, amount] of assets) {
    const available = await agent.trac.balance(agent.owner, asset);
    check(typeof available === 'string' && /^(0|[1-9][0-9]*)$/.test(available), 'transfer_balance');
    if (available === '0') check(await knownAsset(agent, asset, context), 'transfer_unknown_asset');
    check(BigInt(available) >= BigInt(amount), 'transfer_insufficient_units');
  }
  check(account && typeof account.revision === 'string' && /^(0|[1-9][0-9]*)$/.test(account.revision), 'transfer_account_changed');
  const head = await agent.trac.head(), fresh = await agent.trac.accountRoot(agent.owner);
  check(fresh?.root === account.root && fresh?.revision === account.revision, 'transfer_account_changed');
  const until = String(BigInt(decimalV2(head.counted)) + BigInt(v.requestMaxBlocks));
  const actions = assets.map(([asset, amount]) => ({ type: 'transfer', owner: agent.owner, to, asset, amount,
    revision: account.revision, nonce: nonce(), until }));
  if (agent.dryRun) return { version: 2, actions };
  for (const action of actions) action.sig = signBytes(agent.wallet, accountActionDigest(agent.network, action));
  return agent.journal.reserve(key, intent, { version: 2, actions }).body;
}

export async function transferNamed(agent, args, context) {
  const prepared = await prepareTransferV2(agent, args, context);
  const head = await agent.trac.head();
  const active = publicMintActive(context.settings, decimalV2(head.counted)) &&
    publicMintActive(context.settings, decimalV2(head.tip.height));
  if (agent.dryRun) return { state: 'dry-run', action: 'transfer-v2', actionId: args.actionId,
    value: { to: prepared.actions[0].to, assets: prepared.actions.map(a => [a.asset, a.amount]) },
    supported: active, ...(active ? {} : { reason: 'transfer_v2_unavailable' }), signed: false, sent: false };
  if (!active) throw Object.assign(new Error('transfer_v2_unavailable'), { code: 'transfer_v2_unavailable', actionId: args.actionId, prepared: true, sent: false });
  const id = `tx/${args.actionId}/v2-move`;
  const validate = async head => {
    // An uncertain or acknowledged send must retain its exact packet and may
    // already have consumed its revision. Only check unsent/refused intents.
    const row = agent.journal.get(id);
    if (row && !['prepared', 'refused'].includes(row.state)) return;
    check(prepared.actions.every(a => BigInt(a.until) >= BigInt(decimalV2(head.counted))), 'transfer_intent_expired');
    const account = await agent.trac.accountRoot(agent.owner);
    check(account?.revision === prepared.actions[0].revision, 'transfer_intent_stale');
    for (const a of prepared.actions) check(BigInt(await agent.trac.balance(agent.owner, a.asset)) >= BigInt(a.amount), 'transfer_insufficient_units');
  };
  return { ...await sendNamedMove(agent, id, 'transfer-v2', { actions: prepared.actions }, context.settings, validate), actionId: args.actionId };
}
