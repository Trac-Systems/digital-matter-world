import { stableJSON, hashObject, decimalV2, addUint, TAP_UNIT } from '../../rules/src/index.js';
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

// Public pages discover IDs and provenance. Accepted notary records alone
// decide ownership, available atoms, revision and matching fee denominations.
export function matchingCreditItems(credit, target) {
  if (!credit || target?.state !== 'open' || target.owner !== credit.owner || !Array.isArray(target.fees)) return [];
  return target.fees.flatMap((fee, index) => {
    const source = credit.fees.find(f => f.key === fee.key), remaining = BigInt(fee.amount) - BigInt(target.paid[index]);
    const amount = source && BigInt(source.amount) < remaining ? BigInt(source.amount) : source ? remaining : 0n;
    return amount > 0n ? [{ fee: fee.key, amount: String(amount) }] : [];
  });
}

export async function listFeeCredits(agent, { cursor, limit = 25, request } = {}) {
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50 && (cursor === undefined || typeof cursor === 'string' && cursor.length <= 8192) &&
    (request === undefined || hex32(request)), 'Invalid credit page');
  const page = await agent.service.results({ collection: 'credits', owner: agent.address, limit, ...(cursor ? { cursor } : {}) });
  check(Array.isArray(page.credits), 'Invalid credit page');
  const target = request ? wireIdentities(await agent.trac.financialRecord('fp/' + request)) : null;
  check(!request || target?.owner === agent.owner, 'Credit target owner mismatch');
  const credits = [];
  for (const entry of page.credits) {
    check(hex32(entry.id), 'Invalid credit identity');
    const accepted = wireIdentities(await agent.trac.financialRecord('fc/' + entry.id));
    if (!accepted || accepted.owner !== agent.owner) continue;
    const amount = accepted.fees.reduce((n, f) => n + BigInt(f.amount), 0n).toString(), items = matchingCreditItems(accepted, target);
    credits.push({ id: entry.id, amount, creditedAmount: entry.creditedAmount ?? null,
      origin: entry.origin ?? null, state: amount === '0' ? 'spent' : 'available', revision: accepted.revision,
      fees: accepted.fees, ...(request ? { requestId: request, matchingAmount: items.reduce((n, i) => n + BigInt(i.amount), 0n).toString(), items,
        usable: items.length > 0 } : {}) });
  }
  return { credits, next: page.next ?? page.nextCursor ?? null, unit: page.unit ?? TAP_UNIT, ...(request ? { requestId: request } : {}) };
}

export async function applyMatchingCredit(agent, { actionId, credit, request }) {
  check(typeof actionId === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(actionId) && hex32(credit) && hex32(request), 'Invalid credit action');
  const saved = agent.journal.get('financial-credit/' + actionId), op = saved?.body?.action?.operation;
  let items;
  if (saved) {
    check(op?.type === 'use' && op.credit === credit && op.id === request, 'Conflicting credit action ID');
    items = op.items;
  } else {
    const source = wireIdentities(await agent.trac.financialRecord('fc/' + credit)), target = wireIdentities(await agent.trac.financialRecord('fp/' + request));
    check(source?.owner === agent.owner && target?.owner === agent.owner, 'Credit owner mismatch');
    items = matchingCreditItems(source, target);
    check(items.length > 0, 'No matching fee credit is available for this request');
  }
  return agent.useCredit({ actionId, credit, request, items });
}
