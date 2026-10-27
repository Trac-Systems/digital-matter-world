import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Outbox } from '../src/transport.mjs';
import { temp } from './helpers.mjs';
test('message fallback journals one paid transaction and resends its exact identity after restart', async () => {
  const path = await temp(); let s = await Store.open(path), prepares = 0, accepted = false; const sent = [];
  const transport = { prepareMessage: async () => ({ signature: 'message' }), sendMessage: async () => {},
    prepareTransaction: async () => ({ tx: String(++prepares), nonce: 'fixed', signature: 'signed' }),
    sendTransaction: async tx => { sent.push(tx); throw Error('validator_dropped'); }, status: async () => ({ state: accepted ? 'accepted' : 'pending' }) };
  let outbox = new Outbox({ store: s, transport, fallbackMs: 0, retryMs: 1 });
  try {
    await outbox.enqueue('batch/1', 'bt', { n: 1 }); await outbox.tick(Date.now() + 100);
    await s.close(); s = await Store.open(path); outbox = new Outbox({ store: s, transport, fallbackMs: 0, retryMs: 1 });
    await outbox.tick(Date.now() + 200); assert.equal(prepares, 1); assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]);
    accepted = true; await outbox.tick(Date.now() + 300); assert.equal(s.count('outbox'), 0); assert.equal(s.get('sent', 'batch/1').tx, '1');
  } finally { await s.close(); }
});

test('headers remain free across backoff, acceptance delays and restart while batches still fall back', async () => {
  const path = await temp(); let s = await Store.open(path), paid = 0; const messages = [], transactions = [], accepted = new Set();
  const transport = { prepareMessage: async (op, value) => ({ op, value, signature: 'fixed' }), sendMessage: async message => messages.push(message),
    prepareTransaction: async op => { assert.equal(op, 'bt'); return { tx: String(++paid) }; },
    sendTransaction: async transaction => transactions.push(transaction), status: async job => ({ state: accepted.has(job.id) ? 'accepted' : 'pending' }) };
  let outbox = new Outbox({ store: s, transport });
  try {
    await outbox.enqueue('header/1', 'hd', { headers: ['first'] });
    await outbox.enqueue('header/2', 'hd', { headers: ['second'] }, { after: 'header/1' });
    await outbox.enqueue('batch/1', 'bt', { n: 1 });
    const now = Date.now();
    for (const offset of [0, 1000, 3000, 7000, 15000, 31000]) await outbox.tick(now + offset);
    assert.equal(paid, 1); assert.equal(messages.filter(m => m.op === 'hd').length, 6);
    assert.ok(messages.filter(m => m.op === 'hd').every(m => m.value.headers[0] === 'first'));
    const saved = s.get('outbox', 'header/1'); assert.equal(saved.next, now + 61000); assert.equal(saved.transaction, undefined);
    await s.close(); s = await Store.open(path); outbox = new Outbox({ store: s, transport });
    accepted.add('header/1'); await outbox.tick(now + 32000);
    assert.equal(s.get('sent', 'header/1').tx, null);
    assert.equal(messages.at(-1).value.headers[0], 'second', 'next message is released without waiting for the retry backoff');
    assert.equal(paid, 1);
    // Even a legacy prepared transaction must not turn a header retry into a paid send.
    await s.put('outbox', 'header/2', { ...s.get('outbox', 'header/2'), transaction: { tx: 'legacy' } });
    await outbox.tick(now + 65000); assert.equal(messages.at(-1).op, 'hd'); assert.equal(paid, 1);
    assert.ok(transactions.length > 0); assert.ok(transactions.every(tx => tx.tx === '1'));
  } finally { await s.close(); }
});
