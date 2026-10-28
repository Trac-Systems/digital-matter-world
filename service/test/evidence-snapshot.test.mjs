import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { serve } from '../src/http.mjs';
import { edPublic, hash } from '../src/util.mjs';
import { temporary } from '../prod/test/helpers.mjs';
import { evidenceSnapshotPolicy, validateConfig } from '../prod/config.mjs';

let duringArchive;
mock.module('node:fs/promises', { exports: { ...fs, open: async (...args) => {
  if (String(args[0]).endsWith('.bin')) await duringArchive?.();
  return fs.open(...args);
} } });
const { evidencePublisher, signEvidence, verifyEvidence } = await import('../prod/evidence.mjs');

async function fixture(t, policy) {
  let store;
  const root = await temporary(t, () => store?.close());
  store = await Store.open(join(root, 'store'));
  const secret = randomBytes(32), identity = randomBytes(32), contexts = join(root, 'contexts');
  await fs.mkdir(contexts); await fs.mkdir(join(root, 'static/blocks'), { recursive: true });
  const config = { data: root, network: 'evidence-test', epoch: 1,
    committee: [{ id: 'reader', peer: { identity: edPublic(identity) } }], prod: { contexts, evidenceSnapshot: policy } };
  const stamp = { tip: 1, tipHash: 'ab'.repeat(32), counted: 1, revision: 1, last: { n: 0 } };
  const bytes = Buffer.from('audit before'), path = '/blocks/before.bin';
  await fs.writeFile(join(root, 'static', path), bytes);
  await store.put('batches', '1', { batch: { n: 1 }, publications: [{ audit: { path, hash: hash(bytes) } }] });
  await store.put('meta', 'patterns', ['before']);
  await fs.writeFile(join(contexts, '1.json'), JSON.stringify({ marker: 'before' }));
  let stamps = 0;
  const reads = { trac: async () => { stamps++; return structuredClone(stamp); } };
  duringArchive = undefined; t.after(() => { duringArchive = undefined; });
  const request = () => {
    const challenge = { version: 1, network: config.network, epoch: 1, member: 'reader', nonce: randomBytes(32).toString('hex'), time: Date.now() };
    return { ...challenge, signature: signEvidence(challenge, identity) };
  };
  return { root, store, config, secret, stamp, reads, request, stamps: () => stamps,
    publisher: () => evidencePublisher({ config, store, reads, secret }) };
}

test('concurrent archive-assembly write with retries disabled returns gateway HTTP 400', async t => {
  const f = await fixture(t, { retries: 0, backoffMs: 0 });
  duringArchive = () => f.store.put('meta', 'patterns', ['after']);
  const http = await serve({ evidence: f.publisher() }); t.after(() => http.close());
  const response = await fetch(http.url + '/operator-evidence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f.request()) });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'evidence_snapshot_changed' });
});

test('concurrent write retries the whole envelope, including rows, archives and context', async t => {
  const f = await fixture(t); let attempts = 0;
  duringArchive = async () => {
    if (++attempts !== 1) return;
    const bytes = Buffer.from('audit after'), path = '/blocks/after.bin';
    await fs.writeFile(join(f.root, 'static', path), bytes);
    await f.store.transact([
      { space: 'meta', id: 'patterns', value: ['after'] },
      { space: 'batches', id: '1', value: { batch: { n: 1 }, publications: [{ audit: { path, hash: hash(bytes) } }] } }
    ]);
    await fs.writeFile(join(f.config.prod.contexts, '1.json'), JSON.stringify({ marker: 'after' }));
  };
  const publish = f.publisher(), request = f.request(), result = await publish(request), p = result.payload;
  assert.equal(attempts, 2); assert.equal(p.revision, f.store.sequence);
  assert.deepEqual(p.rows.find(r => r.space === 'meta').value, ['after']);
  assert.deepEqual(Object.keys(p.archives), ['/blocks/after.bin']);
  assert.equal(Buffer.from(p.archives['/blocks/after.bin'], 'base64').toString(), 'audit after');
  assert.equal(p.contexts[1].marker, 'after');
  assert.ok(verifyEvidence(p, result.signature, edPublic(f.secret)));
  await assert.rejects(publish(request), /evidence_replay/);
});

test('write while awaiting the final Trac stamp is detected and retried', async t => {
  const f = await fixture(t, { retries: 1, backoffMs: 0 }); let stamps = 0;
  f.reads.trac = async () => {
    if (++stamps === 2) await f.store.put('meta', 'patterns', ['after']);
    return structuredClone(f.stamp);
  };
  const { payload } = await f.publisher()(f.request());
  assert.equal(stamps, 4); assert.equal(payload.revision, f.store.sequence);
  assert.deepEqual(payload.rows.find(r => r.space === 'meta').value, ['after']);
});

test('Trac changes retry and persistent churn stops at the configured retry bound', async t => {
  const f = await fixture(t, { retries: 2, backoffMs: 0 }); let attempts = 0;
  duringArchive = () => { attempts++; f.stamp.revision++; };
  await assert.rejects(f.publisher()(f.request()), /evidence_snapshot_changed/);
  assert.equal(attempts, 3); assert.equal(f.stamps(), 6);
});

test('archive corruption is never retried or signed', async t => {
  const f = await fixture(t); let attempts = 0;
  duringArchive = async () => { attempts++; await fs.writeFile(join(f.root, 'static/blocks/before.bin'), 'corrupt'); };
  await assert.rejects(f.publisher()(f.request()), /evidence_archive_hash/);
  assert.equal(attempts, 1);
});

test('a changed Trac stamp and a write during the opening stamp both rebuild', async t => {
  const f = await fixture(t, { retries: 2, backoffMs: 0 }); let stamps = 0;
  f.reads.trac = async () => {
    if (++stamps === 1) await f.store.put('meta', 'patterns', ['after']);
    if (stamps === 4) f.stamp.revision++;
    return structuredClone(f.stamp);
  };
  const { payload } = await f.publisher()(f.request());
  assert.equal(stamps, 6); assert.equal(payload.stamp.revision, 2);
  assert.deepEqual(payload.rows.find(r => r.space === 'meta').value, ['after']);
});

test('persistent store churn exhausts retries and still consumes the nonce', async t => {
  const f = await fixture(t, { retries: 1, backoffMs: 0 }); let writes = 0;
  duringArchive = () => f.store.put('meta', 'patterns', [++writes]);
  const publish = f.publisher(), request = f.request();
  await assert.rejects(publish(request), /evidence_snapshot_changed/);
  assert.equal(writes, 2);
  await assert.rejects(publish(request), /evidence_replay/);
  assert.equal(writes, 2);
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
