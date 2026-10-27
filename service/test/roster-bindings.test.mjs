import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingFixture } from './bindings-fixture.mjs';
import { agent, temp } from './helpers.mjs';
import { Store } from '../src/store.mjs';
import { bindingMessage, verifyBinding } from '../../rules/src/payout-bindings.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';

test('trac1 bindings remain verifiable after expiry and roster replacement', async () => {
  const store = await Store.open(await temp('roster-bindings-'));
  try {
    const f = bindingFixture(store), who = agent(79);
    for (const rail of ['tap', 'ethereum']) {
      const record = await f.bind(who, rail);
      const message = bindingMessage('dmw-regtest', 'regtest', record.request);
      assert.equal(JSON.parse(message.split('\n')[1]).agent, encodeTracAddress(who.address));
      const members = [{ id: 'new-member', identity: agent(80).address }, ...f.members.slice(1)];
      const options = { network: 'dmw-regtest', bitcoinNetwork: 'regtest', members, now: record.request.expiry + 1 };
      assert.throws(() => verifyBinding(record, options));
      assert.equal(verifyBinding(record, { ...options, rosterHistory: [{ members: f.members }] }).id, record.id);
      f.bindings.members = members; f.bindings.rosterHistory = [{ members: f.members }];
      assert.equal(f.bindings.current(who.address, rail).id, record.id);
    }
  } finally { await store.close(); }
});
