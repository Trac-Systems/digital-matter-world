import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { DeploymentRounds } from '../src/deployment-rounds.mjs';
import { temp } from './helpers.mjs';

test('issued capacity is reserved across restart; renewal preserves the logical asset and old plot identity', async t => {
  const directory = await temp(); let store = await Store.open(directory); t.after(() => store.close());
  let remaining = '3';
  const options = () => ({ store, readDeployment: async id => ({ id, asset: 'c0', kind: 'compound', remaining, limit: '0', active: true }),
    verifyTerminal: async (terms, evidence) => ({ ...evidence, id: terms.id, deployment: terms.deployment }), prepareRound: async intent => intent });
  let rounds = new DeploymentRounds(options());
  await rounds.reserve({ id: 'a', asset: 'c0', deployment: 'old', amount: '2' });
  await assert.rejects(rounds.reserve({ id: 'b', asset: 'c0', deployment: 'old', amount: '2' }), /capacity_reserved/);
  await store.close(); store = await Store.open(directory); rounds = new DeploymentRounds(options());
  await rounds.reserve({ id: 'b', asset: 'c0', deployment: 'old', amount: '1' });
  remaining = '0'; await assert.rejects(rounds.renew('c0', 'old'), /round_unresolved_permits/);
  for (const id of ['a', 'b']) await rounds.finish(id, { state: 'minted', commitment: 'ab'.repeat(32) });
  const next = await rounds.renew('c0', 'old'); assert.equal(next.asset, 'c0'); assert.equal(next.round, '1');
  assert.deepEqual(await rounds.renew('c0', 'old'), next, 'a lost response does not allocate another round');
  assert.equal(store.get('capacityRequests', 'a').terms.deployment, 'old');
  assert.equal((await rounds.renew('c0', 'new')).round, '2');
});
