import { stableJSON, hashObject, decimalV2, addUint } from '../../rules/src/index.js';
import { paymentCreditDigest } from '../../contract/payment-pages.js';
import { decodeTracAddress, wireIdentities } from '../../rules/src/trac-address.js';
import { signBytes } from './signing.mjs';
import { check, sha256, hex32 } from './check.mjs';

export async function submitFinancialCredit(agent, { actionId, credit, request, items, to }) {
  const { journal, owner, network, service, wallet } = agent, transfer = to !== undefined;
  check(hex32(credit) && (transfer ? request === undefined && items === undefined : hex32(request)), 'Invalid credit action');
  if (transfer) to = decodeTracAddress(to);
  const intent = transfer ? { credit, to } : { credit, request, items }, key = `financial-credit/${actionId}`, old = journal.get(key);
  if (old) check(old.fingerprint === sha256(stableJSON(intent)), 'Conflicting credit action ID');
  if (!agent.dryRun && old && ['submitted', 'accepted'].includes(old.state)) return { ...old.result, replayed: true };
  let body = old?.body;
  if (!body) {
    const context = await agent.namedContext(); check(context, 'Activated financial rules required');
    const row = wireIdentities(await agent.trac.financialRecord('fc/' + credit));
    check(row?.owner === owner, 'Credit owner mismatch');
    if (!transfer) {
      const target = wireIdentities(await agent.trac.financialRecord('fp/' + request));
      check(target?.state === 'open' && target.owner === owner && Array.isArray(items) && items.length > 0 &&
        items.length <= context.settings.values.paymentPage && new Set(items.map(i => i.fee)).size === items.length, 'Invalid credit target');
      for (const item of items) {
        const source = row.fees.find(f => f.key === item.fee), index = target.fees.findIndex(f => f.key === item.fee);
        check(source && index >= 0 && /^[1-9][0-9]*$/.test(item.amount) && BigInt(source.amount) >= BigInt(item.amount) &&
          BigInt(target.paid[index]) + BigInt(item.amount) <= BigInt(target.fees[index].amount), 'Credit amount unavailable');
      }
    }
    const op = { op: 'fp', v: 2, type: transfer ? 'transfer' : 'use', id: transfer ? credit : request, credit,
      revision: row.revision, until: addUint(decimalV2((await agent.trac.head()).counted), String(context.settings.values.pendingBlocks)),
      ...(transfer ? { to } : { items }) };
    if (agent.dryRun) return { state: 'dry-run', operation: op, signed: false };
    body = { version: 2, action: { type: transfer ? 'credit-transfer' : 'credit-use', id: op.id,
      operation: { ...op, sig: signBytes(wallet, paymentCreditDigest(network, op)) } } };
  }
  const saved = journal.reserve(key, intent, body), action = saved.body.action;
  const id = hashObject(['dmw-financial-transition-v2', { type: 'lifecycle', id: action.id, action }]);
  await journal.waitTurn(() => agent.trac.head()); journal.mark(key, 'sending');
  try {
    const result = await service.financialAction(action);
    check(result.id === id && ['queued', 'accepted'].includes(result.state), 'Credit response mismatch');
    journal.mark(key, result.state === 'accepted' ? 'accepted' : 'submitted', result); return result;
  } catch (error) { journal.mark(key, 'unknown'); throw error; }
  finally { journal.finishTurn(); }
}
