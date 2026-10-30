import { isTracAddress } from '../../rules/src/trac-address.js';
import { stableJSON } from '../../rules/src/index.js';
import { sha256, nonce } from './check.mjs';
import { formatTnk, parseTnk, requireTnk, tnkError, tnkQuote } from './tnk-values.mjs';

const actionKey = actionId => {
  requireTnk(typeof actionId === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(actionId), 'tnk_invalid_action_id');
  return `tnk/${actionId}`;
};
const intentFor = (agent, { to, amount }) => {
  requireTnk(isTracAddress(to), 'tnk_invalid_address');
  requireTnk(to !== agent.address, 'tnk_self');
  return { to, amount: amount === 'max' ? amount : formatTnk(parseTnk(amount)) };
};
const adapter = (agent, method) => {
  requireTnk(typeof agent.trac?.[method] === 'function', 'tnk_unavailable');
  return agent.trac[method].bind(agent.trac);
};

export async function tnkBalance(agent) {
  return adapter(agent, 'tnkBalance')(agent.address);
}

// Always unsigned, including when the agent was launched live.
export async function prepareTnkTransfer(agent, args) {
  const intent = intentFor(agent, args);
  return { ...tnkQuote(await tnkBalance(agent), intent.to, intent.amount), signed: false, sent: false };
}

export async function tnkTransferStatus(agent, actionId) {
  const id = actionKey(actionId), row = agent.journal.get(id), tx = row?.body.packet?.tx ?? null;
  if (!tx) return { actionId, tx, state: 'unknown', code: 'tnk_unknown_status' };
  if (row.state === 'accepted') return { actionId, tx, state: 'confirmed' };
  let status;
  try { status = await adapter(agent, 'tnkTransactionStatus')(tx); }
  catch { status = { tx, state: 'unknown', code: 'tnk_unknown_status' }; }
  requireTnk(status.tx === tx && ['confirmed', 'pending', 'unknown'].includes(status.state), 'tnk_unknown_status');
  if (status.state === 'confirmed' && !agent.dryRun) agent.journal.observe(id, 'accepted', { source: 'msb', tx, state: 'confirmed' });
  return { ...status, actionId };
}

export function sendTnkTransfer(agent, args) {
  return agent.exclusive(async () => {
    const { actionId } = args, id = actionKey(actionId), intent = intentFor(agent, args);
    let row = agent.journal.get(id);
    if (row) requireTnk(row.fingerprint === sha256(stableJSON(intent)), 'tnk_action_conflict');
    if (row && !row.body.packet) throw tnkError('tnk_unknown_status', { actionId, tx: null });
    if (agent.dryRun) {
      const quote = row?.body.packet.quote ?? await prepareTnkTransfer(agent, intent);
      return { ...quote, actionId, tx: row?.body.packet.tx ?? null, state: 'dry-run', signed: false, sent: false, replayed: !!row };
    }
    const replayed = !!row;
    if (row) {
      const status = await tnkTransferStatus(agent, actionId);
      if (status.state === 'confirmed') return { ...row.body.packet.quote, ...status, signed: false, sent: false, replayed: true };
    }
    if (!row) {
      const quote = await prepareTnkTransfer(agent, intent);
      await adapter(agent, 'tnkRequireValidators')();
      // Claim before the asynchronous signer, including across processes. An
      // interrupted preparation stays indeterminate and cannot sign twice.
      const preparationId = nonce();
      row = agent.journal.reserve(id, intent, { kind: 'tnk-transfer', preparationId, intent, packet: null });
      requireTnk(row.body.preparationId === preparationId, 'tnk_unknown_status');
      let packet;
      try { packet = await adapter(agent, 'prepareTnkTransfer')(quote); }
      catch (error) { throw tnkError(error.code?.startsWith('tnk_') ? error.code : 'tnk_prepare_failed', { actionId, tx: null }); }
      row = agent.journal.completePreparation(id, row.body, { kind: 'tnk-transfer', intent, packet });
    }
    const packet = row.body.packet;
    if (packet.blockedCode) throw tnkError(packet.blockedCode, { actionId, tx: packet.tx });
    await adapter(agent, 'tnkRequireValidators')();
    await agent.journal.waitTurn(() => agent.trac.head());
    agent.journal.mark(id, 'sending');
    try {
      const result = await adapter(agent, 'submitTnkTransfer')(packet);
      requireTnk(result.tx === packet.tx, 'tnk_packet');
      agent.journal.mark(id, 'submitted', { tx: packet.tx, state: 'pending' });
      return { ...packet.quote, actionId, tx: packet.tx, state: 'pending', signed: !replayed, sent: true, replayed };
    } catch (error) {
      agent.journal.mark(id, 'unknown');
      throw tnkError(error.code === 'tnk_validators' ? 'tnk_validators' : 'tnk_unknown_status', { actionId, tx: packet.tx });
    } finally { agent.journal.finishTurn(); }
  });
}
