import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { serve } from '../src/http.mjs';
import { edPublic } from '../src/util.mjs';
import { temporary } from '../prod/test/helpers.mjs';
import { evidenceSnapshotPolicy, validateConfig } from '../prod/config.mjs';
import { evidencePublisher, signEvidence, verifyEvidence } from '../prod/evidence.mjs';

async function fixture(t, policy) {
  let store;
  const root = await temporary(t, () => store?.close());
  store = await Store.open(join(root, 'store'));
  const secret = randomBytes(32), identity = randomBytes(32);
  const config = { data: root, network: 'evidence-test', epoch: 1,
    committee: [{ id: 'reader', peer: { identity: edPublic(identity) } }], prod: { evidenceSnapshot: policy } };
  await store.put('types', 'one', ['before']);
  const stamp = { tip: 1, tipHash: 'ab'.repeat(32), counted: 1, revision: 1, last: { n: 0 } };
  const reads = { trac: async () => structuredClone(stamp) };
  const request = (query = { op: 'open' }) => {
    const challenge = { version: 2, network: config.network, epoch: 1, member: 'reader', nonce: randomBytes(32).toString('hex'), time: Date.now(), query };
    return { ...challenge, signature: signEvidence(challenge, identity) };
  };
  const publish = evidencePublisher({ config, store, reads, secret }); t.after(() => publish.close());
  return { store, config, secret, stamp, reads, request, publish };
}

test('changed opening snapshot with retries disabled returns gateway HTTP 400', async t => {
  const f = await fixture(t, { retries: 0, backoffMs: 0 });
  f.reads.trac = async () => ({ ...f.stamp, revision: ++f.stamp.revision });
  const http = await serve({ evidence: f.publish }); t.after(() => http.close());
  const response = await fetch(http.url + '/operator-evidence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f.request()) });
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'evidence_snapshot_changed' });
});

test('opening retries changed Trac state and signs one coherent paged snapshot', async t => {
  const f = await fixture(t, { retries: 1, backoffMs: 0 }); let stamps = 0;
  f.reads.trac = async () => {
    if (++stamps === 2) { f.stamp.revision++; await f.store.put('types', 'one', ['after']); }
    return structuredClone(f.stamp);
  };
  const request = f.request(), result = await f.publish(request), p = result.payload;
  assert.equal(stamps, 4); assert.equal(p.result.revision, f.store.sequence); assert.equal(p.result.stamp.revision, 2);
  assert.ok(verifyEvidence(p, result.signature, edPublic(f.secret)));
  const page = await f.publish(f.request({ op: 'get', snapshot: p.result.id, space: 'types', id: 'one' }));
  assert.deepEqual(page.payload.result.rows[0].value, ['after']);
  await assert.rejects(f.publish(request), /evidence_replay/);
});

test('gateway writes after snapshot open preserve earlier pages without global retry', async t => {
  const f = await fixture(t); let stamps = 0;
  f.reads.trac = async () => { if (++stamps === 2) await f.store.put('types', 'one', ['after']); return structuredClone(f.stamp); };
  const { payload } = await f.publish(f.request());
  const page = await f.publish(f.request({ op: 'get', snapshot: payload.result.id, space: 'types', id: 'one' }));
  assert.deepEqual(page.payload.result.rows[0].value, ['before']); assert.ok(payload.result.revision < f.store.sequence);
});

test('persistent Trac churn exhausts bounded retries and consumes the nonce', async t => {
  const f = await fixture(t, { retries: 2, backoffMs: 0 }); let stamps = 0;
  f.reads.trac = async () => { stamps++; return { ...f.stamp, revision: ++f.stamp.revision }; };
  const request = f.request(); await assert.rejects(f.publish(request), /evidence_snapshot_changed/); assert.equal(stamps, 6);
  await assert.rejects(f.publish(request), /evidence_replay/); assert.equal(stamps, 6);
});

test('independent reader snapshot errors retry; unrelated failures never retry', async t => {
  const f = await fixture(t, { retries: 1, backoffMs: 0 }); let stamps = 0;
  f.reads.trac = async () => { if (++stamps === 1) throw Error('trac_snapshot_changed'); return structuredClone(f.stamp); };
  await f.publish(f.request()); assert.equal(stamps, 3);
  f.reads.trac = async () => { stamps++; throw Error('bad_evidence'); };
  await assert.rejects(f.publish(f.request()), /bad_evidence/); assert.equal(stamps, 4);
});

test('snapshot policy has bounded operator settings and is validated at startup', async () => {
  assert.deepEqual(evidenceSnapshotPolicy(), { retries: 3, backoffMs: 50 });
  assert.deepEqual(evidenceSnapshotPolicy({ retries: 0 }), { retries: 0, backoffMs: 50 });
  assert.deepEqual(evidenceSnapshotPolicy({ retries: 5, backoffMs: 1000 }), { retries: 5, backoffMs: 1000 });
  for (const value of [null, [], { retries: -1 }, { retries: 6 }, { retries: 1.5 }, { backoffMs: -1 }, { backoffMs: 1001 }, { retries: '1' }, { attempts: 2 }]) {
    assert.throws(() => evidenceSnapshotPolicy(value), /evidence_snapshot_policy/);
  }
  const config = { version: 1, mode: 'prod', network: 'evidence-test', listen: { host: '127.0.0.1', port: 12345 },
    adapter: new URL('../prod/adapter.mjs', import.meta.url).pathname, prod: { evidenceSnapshot: { retries: -1 } } };
  await assert.rejects(validateConfig(config), /evidence_snapshot_policy/);
});
