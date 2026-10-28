import { stableJSON, hashObject, decimalV2, addUint } from '../../rules/src/index.js';
import { lifecycleDigest } from '../../contract/financial-lifecycle.js';
import { payoutAddress } from '../../rules/src/payout-bindings.mjs';
import { wireIdentities } from '../../rules/src/trac-address.js';
import { check, hex32, sha256 } from './check.mjs';
import { signBytes } from './signing.mjs';

export async function claimFinancialCustody(agent, { actionId, id, destination }) {
  const { journal, network, owner, service, wallet } = agent, key = `financial-custody/${actionId}`, intent = { id, destination }, old = journal.get(key);
  check(hex32(id), 'Invalid custody ID');
  if (old) check(old.fingerprint === sha256(stableJSON(intent)), 'Conflicting custody action ID');
  if (!agent.dryRun && old && ['submitted', 'accepted'].includes(old.state)) return { ...old.result, replayed: true };
  let body = old?.body;
  if (!body) {
    const context = await agent.namedContext(), row = wireIdentities(await agent.trac.financialRecord('bc/' + id));
    check(context && row?.owner === owner && row.state === 'claimable', 'Custody claim unavailable');
    payoutAddress(row.rail, destination, agent.bitcoinNetwork);
    check(destination !== row.custodian, 'Custody destination must differ from custodian');
    const action = { type: 'custody-claim', id, revision: row.revision, destination,
      until: addUint(decimalV2((await agent.trac.head()).counted), String(context.settings.values.pendingBlocks)) };
    if (agent.dryRun) return { state: 'dry-run', action, signed: false };
    body = { version: 2, action: { ...action, sig: signBytes(wallet, lifecycleDigest(network, action)) } };
  }
  const saved = journal.reserve(key, intent, body), action = saved.body.action;
  const expected = hashObject(['dmw-financial-transition-v2', { type: 'lifecycle', id, action }]);
  await journal.waitTurn(() => agent.trac.head()); journal.mark(key, 'sending');
  try {
    const result = await service.financialAction(action);
    check(result.id === expected && ['queued', 'accepted'].includes(result.state), 'Custody response mismatch');
    journal.mark(key, result.state === 'accepted' ? 'accepted' : 'submitted', result); return result;
  } catch (error) { journal.mark(key, 'unknown'); throw error; }
  finally { journal.finishTurn(); }
}
