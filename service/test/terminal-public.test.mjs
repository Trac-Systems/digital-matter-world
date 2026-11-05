import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { migrateTerminalPublic } from '../scripts/migrate-terminal-public.mjs';
import { extendedPublicRead } from '../src/public-projections.mjs';
import { temp, agent } from './helpers.mjs';
import { rules as r } from '../src/rules.mjs';

test('terminal public import retains legacy agent scores and historical events, resumes and preserves canonical headers', async t => {
  const store = await Store.openForMaintenance(join(await temp('ms1-public-'), 'gateway')); t.after(() => store.close());
  const a = agent(9820).address, b = agent(9821).address;
  await store.transact([
    { space: 'meta', id: 'ruleState', value: { counted: 7, discoveryCommits: [{ agent: a }], batchVersion: 1 } },
    { space: 'meta', id: 'patterns', value: [] },
    { space: 'meta', id: 'publicObservation', value: '0000000000000001' },
    { space: 'batches', id: '0000000000000001', value: { batch: { n: 1, to: 7, from: 0, root: r.hash('batch') } } },
    { space: 'headers', id: '0000000000000007', value: { fields: { height: 7, time: 100 }, raw: 'original' } },
    { space: 'headerObjects', id: r.hash('header'), value: { original: true } },
    { space: 'publicEvents', id: '0000000000000001', value: { sequence: 1, type: 'craft', data: { agent: b }, at: 100 } }
  ]);
  const original = store.get('headers', '0000000000000007');
  await store.transact([
    { space: 'meta', id: 'ruleState', value: { ...store.get('meta', 'ruleState'), batchVersion: 2 } },
    { space: 'meta', id: 'v2Activation', value: r.hash('manifest') },
    { space: 'meta', id: 'legacyPendingWork', value: { commitment: { sourceRoot: r.hash('source'), counted: '7' } } }
  ]);
  assert.equal(extendedPublicRead(store, new URL('http://local/agents')).agents.length, 0);
  // Simulate interruption after the first agent page commits.
  const transact = store.transact.bind(store); let calls = 0;
  store.transact = async operations => { if (++calls === 2) throw Error('interrupted'); return transact(operations); };
  await assert.rejects(migrateTerminalPublic(store, { pageRows: 1 }), /interrupted/);
  assert.throws(() => extendedPublicRead(store, new URL('http://local/agents')), /public_projection_migration_required/);
  store.transact = transact;
  const result = await migrateTerminalPublic(store, { pageRows: 1 }); assert.equal(result.agents, 2);
  const rows = extendedPublicRead(store, new URL('http://local/agents')).agents;
  assert.equal(rows.find(row => row.address === a).crafts, '0'); assert.equal(rows.find(row => row.address === b).crafts, '1');
  assert.equal(extendedPublicRead(store, new URL('http://local/events')).events.length, 1);
  assert.deepEqual(store.get('headers', '0000000000000007'), original);
  assert.deepEqual(await migrateTerminalPublic(store), result);
  assert.deepEqual(store.get('meta', 'v2Last'), { n: '1', to: '7' });
  assert.deepEqual(store.get('meta', 'v2PublicProgress'), { batch: '1', observation: '1' });
});
