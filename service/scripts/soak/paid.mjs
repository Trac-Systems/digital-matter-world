import assert from 'node:assert/strict';
import { sleep } from './common.mjs';

// Validator connection rotation can drop a successful-looking send. Persist the
// signed identity first and resend that packet until the peer records its exit.
export async function settlePaid({ client, wallet, op, value, connect, persist, now = Date.now, wait = sleep, timeout = 30000, retryMs = 500 }) {
  const packet = await client.prepare(wallet, op, value);
  await persist({ state: 'prepared', packet });
  const deadline = now() + timeout;
  while (now() < deadline) {
    const status = await client.transactionStatus(packet.tx);
    if (status.state === 'accepted') { await persist({ state: 'accepted', tx: packet.tx }); return packet.tx; }
    assert.notEqual(status.state, 'rejected', 'paid_transaction_rejected');
    try {
      await connect();
      const sent = await client.submit(packet); assert.equal(sent.tx, packet.tx, 'paid_identity_changed');
    } catch (e) {
      if (e.message?.includes('paid_identity_changed')) throw e;
      // An acknowledgement can be lost after acceptance. Status is authoritative.
    }
    await wait(retryMs);
  }
  throw Error('paid_transaction_timeout: ' + packet.tx);
}
