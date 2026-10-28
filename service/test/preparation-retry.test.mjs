import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Committee } from '../src/committee.mjs';
import { Store } from '../src/store.mjs';
import { hash } from '../src/util.mjs';
import { temp } from './helpers.mjs';
import { batchFixture, network } from '../../committee/test/fixture.mjs';

async function setup(t) {
  const store = await Store.open(await temp('st1-committee-')), servers = [], signers = [];
  const { proposal, built } = batchFixture(), digest = Buffer.from(built.signingDigest).toString('hex');
  const state = { heights: [94,94,95,95,94], refusals: new Set(), wrongProof: false, ambiguous: false, mismatch: false, reserved: false, statusFailure: false, prepares: [], starts: [], sessions: new Map() };
  for (let i = 0; i < 5; i++) {
    const server = createServer(async (req, res) => {
      let text = ''; for await (const chunk of req) text += chunk; const body = JSON.parse(text);
      const send = value => res.end(JSON.stringify(value));
      const fail = value => { res.writeHead(409); send(value); };
      if (req.url === '/batch-ready') return send({ id: 's'+i, network, epoch: 1, counted: state.heights[i], tip: 100 });
      if (req.url === '/prepare') {
        state.prepares.push({ i, body });
        if (state.refusals.has(i)) return fail({ error: state.ambiguous ? 'host_signer_unavailable' : 'evidence_reorg',
          ...(!state.ambiguous ? { unreserved: { id: body.ceremony.id, proposalHash: state.wrongProof ? hash('wrong') : hash(JSON.stringify(body.proposal)) } } : {}) });
        assert.ok(!state.sessions.has(i), 'never reserve a member twice');
        state.sessions.set(i, { id: body.ceremony.id, status: 'prepared' });
        return send({ id: body.ceremony.id, digest: state.mismatch && i === 1 ? hash('other') : digest });
      }
      if (req.url === '/preparation-state') return send({ id: body.id, reserved: state.reserved || state.sessions.has(i), retired: false });
      if (req.url === '/status') {
        const s = state.sessions.get(i);
        if (state.statusFailure) return fail({ error: 'http_timeout' });
        if (!s) return fail({ error: 'ceremony_id' });
        assert.equal(s.id, body.id);
        return send({ status: s.status, ...(s.status === 'complete' ? { signature: { compact: 'ab'.repeat(64) }, result: {} } : {}) });
      }
      if (req.url === '/go') { state.starts.push(i); state.sessions.get(i).status = 'complete'; return send({ ok: true }); }
      throw Error('unexpected endpoint');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
    signers.push({ id: 's'+i, url: 'http://127.0.0.1:'+server.address().port, token: 'local-test', peer: { id: 's'+i } });
  }
  t.after(async () => { for (const s of servers) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); } await store.close(); });
  return { store, signers, state, proposal, key: 'batch/0/1', committee: () => new Committee({ store, signers, network }) };
}

test('19:19 sequence: wait for quorum, preserve partial reservations across catch-up and gateway restart', async t => {
  const f = await setup(t); let c = f.committee();
  assert.equal(await c.ready({ counted: 95, tip: 100 }), false);
  assert.equal(await c.signature(f.key, f.proposal), null); assert.equal(f.store.count('ceremonies'), 0);
  f.state.heights = [95,95,95,95,95]; f.state.refusals = new Set([1,2]);
  assert.equal(await c.signature(f.key, f.proposal), null);
  const original = f.store.get('ceremonies', f.key); assert.equal(original.retryPrepare, true);
  assert.deepEqual(original.unreserved, ['s1','s2']); assert.equal(f.state.starts.length, 0);
  assert.equal(await c.retireUnprepared(f.key), null);
  c = f.committee(); f.state.heights.fill(96); f.state.refusals.clear();
  assert.equal(await c.signature(f.key, f.proposal), null);
  assert.equal(f.state.prepares.length, 5); assert.equal(f.state.prepares.filter(p => p.i === 0).length, 1);
  assert.ok(f.state.prepares.every(p => p.body.ceremony.id === original.id && JSON.stringify(p.body.proposal) === JSON.stringify(f.proposal)));
  assert.equal((await c.signature(f.key, f.proposal)).session, original.id);
  await assert.rejects(c.signature(f.key, { ...f.proposal, changed: true }), /ceremony_proposal_changed/);
});

test('timeouts and wrong refusal bindings cannot authorize preparation retries', async t => {
  const f = await setup(t), c = f.committee(); f.state.heights.fill(95); f.state.refusals = new Set([0,1,2]); f.state.wrongProof = true;
  await assert.rejects(c.signature(f.key, f.proposal), /committee_prepare_incomplete/);
  f.state.refusals.clear();
  await assert.rejects(c.signature(f.key, f.proposal), /ceremony_requires_recovery/);
  assert.equal(f.state.prepares.length, 3);
});

test('ambiguous blocked session recovers only with all original journals unreserved', async t => {
  const f = await setup(t), c = f.committee(); f.state.heights.fill(95); f.state.refusals = new Set([0,1,2]); f.state.ambiguous = true;
  await assert.rejects(c.signature(f.key, f.proposal), /committee_prepare_incomplete/);
  const original = f.store.get('ceremonies', f.key);
  f.state.reserved = true; await assert.rejects(c.recoverPreparation(f.key), /ceremony_reservation_unresolved/);
  assert.deepEqual(f.store.get('ceremonies', f.key), original);
  f.state.reserved = false; assert.equal((await c.recoverPreparation(f.key)).session, original.id);
  f.state.refusals.clear(); f.state.statusFailure = true;
  assert.equal(await c.signature(f.key, f.proposal), null); assert.equal(f.state.prepares.length, 3);
  f.state.statusFailure = false; assert.equal(await c.signature(f.key, f.proposal), null);
  assert.equal(f.state.prepares.length, 6); assert.equal((await c.signature(f.key, f.proposal)).session, original.id);
});

test('a digest disagreement during a partial retry stays blocked after restart and never starts signing', async t => {
  const f = await setup(t), c = f.committee(); f.state.heights.fill(95); f.state.refusals = new Set([1,2]);
  await c.signature(f.key, f.proposal); f.state.refusals.clear(); f.state.mismatch = true;
  await assert.rejects(c.signature(f.key, f.proposal), /signature_disagreement/);
  await assert.rejects(f.committee().signature(f.key, f.proposal), /signature_disagreement/);
  assert.equal(f.state.starts.length, 0);
});
