import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as r from '../../rules/src/index.js';
import { Store } from '../src/store.mjs';
import { runtimeResources, configuredResources } from '../src/r3-settings.mjs';
import { sponsoredSender } from '../src/sponsorship.mjs';
import { HttpSource } from '../prod/http.mjs';
import { createServer } from 'node:http';
import { Committee } from '../src/committee.mjs';
import { evidenceSettings } from '../prod/evidence.mjs';

test('source limits and parser readiness come from the pinned resource document', async () => {
  const resources = r.resourceRevision({ operator: 'fixture', values: { ...r.RESOURCE_PROFILE, sourceQueue: 1, sourceRps: 1000, sourceRetries: 0, sourceResponseBytes: 2000000 } });
  const mapped = runtimeResources(resources);
  let release;
  const source = new HttpSource({ ...mapped.source, url: 'http://127.0.0.1:1', fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const first = source.request('/named'); await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => source.request('/overflow'), /http_capacity/);
  release(new Response('{"ok":true}')); assert.deepEqual(await first, { ok: true });
  const document = r.settingsRevision({ network: 'fixture', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE } });
  assert.equal(r.runtimeCapabilities(document, resources).settingsHash, r.hashObject(document));
  const tooSmall = r.resourceRevision({ operator: 'fixture', previous: resources, values: { ...resources.values, archiveObjectBytes: 1000 } });
  assert.throws(() => r.runtimeCapabilities(document, tooSmall), /resource_consensus_capacity/);
  assert.equal(mapped.replay.headerPageSize, resources.values.headerPageSize);
  assert.equal(mapped.committee.prepareMs, resources.values.signerPrepareMs);
  const independent = configuredResources({ v2: { resources }, prod: { evidenceSettings: { maxSnapshots: 5 }, evidence: { settings: {} } } });
  assert.equal(independent.prod.evidence.settings.cacheEntries, resources.values.archiveCacheEntries);
  assert.equal(independent.prod.readerSettings.auditFileBytes, resources.values.archiveObjectBytes);
  assert.equal(independent.prod.http.maxQueue, resources.values.sourceQueue);
  assert.equal(independent.prod.evidenceSettings.maxSnapshots, 5, 'archive retention cannot reduce concurrent committee readers');
  assert.equal(evidenceSettings(independent.prod.evidence.settings).nodeCacheEntries, 65536, 'immutable nodes have a separate working cache');
});

test('sponsorship reduction preserves uncertain reservations and exact counts through restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'g4b-sponsor-')); let store = await Store.open(directory);
  t.after(() => store.close());
  const base = '9'.repeat(80), bound = r.addUint(base, '2');
  let resources = r.resourceRevision({ operator: 'fixture', values: { ...r.RESOURCE_PROFILE, sponsorshipTransactions: bound, sponsorshipAtoms: bound } });
  const owner = { sponsorship: { transactions: bound, maxAtoms: bound }, funding: { writerMaxAtoms: bound } };
  await store.put('hostSponsorship', 'total', { count: base, atoms: base });
  const transaction = { tx: 'a'.repeat(64), payload: 'same intent' }; let sends = 0;
  const create = () => sponsoredSender({ store, resources: () => resources, owner, fee: async () => '1', balance: async () => bound,
    send: async () => { sends++; throw Error('reply_lost'); } });
  let send = create(); await assert.rejects(send(transaction), /reply_lost/);
  assert.equal(store.get('hostSponsorship', 'total').count, r.nextUint(base));
  resources = r.resourceRevision({ operator: 'fixture', previous: resources, values: { ...resources.values, sponsorshipTransactions: '0', sponsorshipAtoms: '0' } });
  await store.close(); store = await Store.open(directory); send = create();
  await assert.rejects(send(transaction), /reply_lost/); assert.equal(sends, 2);
  assert.equal(store.get('hostSponsorship', 'total').count, r.nextUint(base));
  await assert.rejects(send({ ...transaction, tx: 'b'.repeat(64) }), /sponsorship_ceiling/);
  assert.equal((await send.status()).remainingTransactions, '0');
});

test('committee readiness requires the selected settings and decimal parser on three independent replies', async t => {
  const resources = r.resourceRevision({ operator: 'fixture', values: { ...r.RESOURCE_PROFILE } });
  const document = r.settingsRevision({ network: 'fixture', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE } });
  const capabilities = r.runtimeCapabilities(document, resources), height = '9'.repeat(80), signers = []; let compatible = 3;
  for (let i = 0; i < 5; i++) {
    const id = String(i), server = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      assert.equal(JSON.parse(Buffer.concat(chunks)).settingsHash, r.hashObject(document));
      res.end(JSON.stringify({ id, network: 'fixture', epoch: 1, counted: height, tip: height,
        capabilities: { ...capabilities, integer: i < compatible ? 2 : 1 } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    signers.push({ id, url: `http://127.0.0.1:${server.address().port}`, token: 'disposable' });
  }
  const committee = new Committee({ store: {}, network: 'fixture', signers });
  const at = { counted: height, tip: height, settingsHash: r.hashObject(document) };
  assert.equal(await committee.ready(at), true); compatible = 2;
  assert.equal(await committee.ready(at), false);
});

test('committee resource budgets bound readiness, replies and status polling', async t => {
  const signers = [], rows = new Map(); let requests = 0;
  for (let i = 0; i < 5; i++) {
    const id = String(i), server = createServer(async (req, res) => {
      for await (const chunk of req) {} requests++;
      if (req.url === '/status') { res.end(JSON.stringify({ status: 'running' })); return; }
      if (req.url === '/slow') { setTimeout(() => res.end('{}'), 150).unref(); return; }
      res.end(JSON.stringify({ id, network: 'fixture', epoch: '9'.repeat(80), padding: 'x'.repeat(200) }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    signers.push({ id, url: `http://127.0.0.1:${server.address().port}`, token: 'disposable' });
  }
  const resources = r.resourceRevision({ operator: 'fixture', values: { ...r.RESOURCE_PROFILE,
    committeeHealthMs: 100, committeeReadyMs: 200, committeeRequestMs: 20, committeeResponseBytes: 100, committeePollMs: 10000 } });
  const store = { get: (space, id) => rows.get(space + '/' + id), list: () => [], put: async (space, id, value) => rows.set(space + '/' + id, value) };
  const committee = new Committee({ store, network: 'fixture', signers, epoch: '9'.repeat(80), ...runtimeResources(resources).committee });
  assert.equal((await committee.healthy()).length, 0, 'oversized replies cannot count as healthy');
  await assert.rejects(committee.request(signers[0], '/slow', {}), /timed out|aborted/i);
  committee.responseBytes = 1000;
  assert.equal((await committee.healthy()).length, 5, 'decimal roster epoch survives health negotiation');
  const proposal = { kind: 'fixture' }, id = 'a'.repeat(64);
  rows.set('ceremonies/key', { id, stage: 'running', peers: signers.slice(0, 3).map(s => s.id), proposal, started: Date.now() });
  await committee.signature('key', proposal); const polled = requests;
  await committee.signature('key', proposal); assert.equal(requests, polled, 'poll interval prevents another status fanout');
});
