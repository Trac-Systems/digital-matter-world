import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Committee } from '../src/committee.mjs';
import { Store } from '../src/store.mjs';
import { temp, network } from './helpers.mjs';

for (const missing of [false, true]) test(`ambiguous preparation ${missing ? 'remains blocked without all sessions' : 'resumes the same three prepared sessions'}`, async () => {
  const store = await Store.open(await temp('committee-recovery-')), servers = [], signers = [], statuses = Array(5).fill('prepared'); let starts = 0;
  try {
    for (let i = 0; i < 5; i++) {
      const server = createServer(async (req, res) => {
        let text = ''; for await (const chunk of req) text += chunk; const body = JSON.parse(text);
        assert.equal(body.id, 'ac'.repeat(32));
        if (missing && i === 2) { res.writeHead(409).end('{"error":"ceremony_id"}'); return; }
        if (req.url === '/go') { starts++; statuses[i] = 'complete'; res.end('{}'); }
        else res.end(JSON.stringify({ status: statuses[i], ...(statuses[i] === 'complete' ? { signature: { compact: 'ab'.repeat(64) }, result: {} } : {}) }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
      signers.push({ id: 's' + i, url: 'http://127.0.0.1:' + server.address().port, token: 'local-test', peer: { id: 's' + i } });
    }
    const proposal = { kind: 'batch', network, batch: { n: 1 } }, key = 'batch/0/1';
    const original = { id: 'ac'.repeat(32), stage: 'blocked', reason: 'prepare_incomplete', failures: ['timeout'], peers: ['s0', 's1', 's2'], proposal, started: 0 };
    await store.put('ceremonies', key, original); const committee = new Committee({ store, network, signers });
    if (missing) { await assert.rejects(committee.signature(key, proposal), /ceremony_requires_recovery/); assert.deepEqual(store.get('ceremonies', key), original); assert.equal(starts, 0); }
    else {
      assert.equal(await committee.signature(key, proposal), null); assert.equal(starts, 3);
      const complete = await committee.signature(key, proposal); assert.equal(complete.session, original.id);
      assert.equal(store.get('ceremonies', key).stage, 'complete'); assert.equal(store.get('ceremonies', key).id, original.id);
      await assert.rejects(committee.signature(key, { ...proposal, batch: { n: 2 } }), /ceremony_proposal_changed/);
    }
  } finally { for (const s of servers) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); } await store.close(); }
});

test('a new ceremony waits for the active batch and explicit busy refusals retain their original identity', async () => {
  const store = await Store.open(await temp('committee-scheduling-')), servers = [], signers = [], statuses = Array(5).fill(null); let prepares=0, starts=0;
  const id='bd'.repeat(32),digest='ee'.repeat(32);
  try {
    for(let i=0;i<5;i++){
      const server=createServer(async(req,res)=>{
        let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
        if(req.url==='/prepare'){assert.equal(body.ceremony.id,id);prepares++;statuses[i]='prepared';res.end(JSON.stringify({digest}));return;}
        assert.equal(body.id,id);
        if(req.url==='/go'){starts++;statuses[i]='complete';res.end('{}');return;}
        if(!statuses[i]){res.writeHead(409).end('{"error":"ceremony_id"}');return;}
        res.end(JSON.stringify({status:statuses[i],...(statuses[i]==='complete'?{signature:{compact:'ab'.repeat(64)},result:{}}:{})}));
      });
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);signers.push({id:'s'+i,url:'http://127.0.0.1:'+server.address().port,token:'local-test',peer:{id:'s'+i}});
    }
    const committee=new Committee({store,network,signers}),proposal={kind:'ethereum-release',network,id:'12'.repeat(32)},key='release/example';
    await store.put('ceremonies','batch/active',{id:'aa'.repeat(32),stage:'running'});
    assert.equal(await committee.signature(key,proposal),null);assert.equal(store.get('ceremonies',key),null);assert.equal(prepares,0);
    await store.put('ceremonies','batch/active',{id:'aa'.repeat(32),stage:'complete'});
    await store.put('ceremonies',key,{id,stage:'blocked',reason:'prepare_incomplete',failures:Array(3).fill('committee_signer_busy'),peers:['s0','s1','s2'],proposal,started:0});
    assert.equal(await committee.signature(key,proposal),null);assert.equal(prepares,3);assert.equal(starts,3);
    const result=await committee.signature(key,proposal);assert.equal(result.session,id);assert.equal(store.get('ceremonies',key).stage,'complete');
  } finally {for(const s of servers){s.closeAllConnections();await new Promise(resolve=>s.close(resolve));}await store.close();}
});

test('a batch with operations but no new observation files asks signers for readiness at its own height', async () => {
  const store = await Store.open(await temp('committee-empty-files-')), servers = [], signers = [], asked = [];
  try {
    for (let i = 0; i < 5; i++) {
      const server = createServer(async (req, res) => { let text = ''; for await (const chunk of req) text += chunk; asked.push(req.url); res.writeHead(503).end('{"error":"busy"}'); });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
      signers.push({ id: 's' + i, url: 'http://127.0.0.1:' + server.address().port, token: 'local-test', peer: { id: 's' + i } });
    }
    const committee = new Committee({ store, network, signers });
    const proposal = { kind: 'batch', network, batch: { n: '280', to: '973672', settingsHash: 'ab'.repeat(32) }, files: [] };
    assert.equal(await committee.signature('batch/0/280', proposal), null, 'unready signers defer instead of crashing on empty files');
    assert.ok(asked.length >= 5 && asked.every(url => url === '/batch-ready'));
  } finally { for (const s of servers) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); } await store.close(); }
});

for (const wrongMember of [false, true]) test(`bulk detached results ${wrongMember ? 'reject a different member' : 'recover by order and index after restart'}`, async () => {
  const { bulkMemberId } = await import('../../rules/src/bulk-mint.js');
  const store = await Store.open(await temp('committee-bulk-recovery-'));
  try {
    const signers = Array.from({ length: 5 }, (_, i) => ({ id: 's' + i, peer: { id: 's' + i } }));
    const committee = new Committee({ store, network, signers, assetRecoveryVersion: 2 });
    const proposal = { network, kind: 'mint', version: 'bulk-v1', orderId: '12'.repeat(32), index: 63 };
    const id = bulkMemberId(proposal.orderId, proposal.index), digest = '34'.repeat(32), key = 'mint/' + id;
    const permit = { digest, payload: { p: 'tap', op: 'dmt-mint', dta: id }, address: 'receiver', salt: '56'.repeat(32) };
    const details = { id: wrongMember ? bulkMemberId(proposal.orderId, 62) : id, orderId: proposal.orderId, index: proposal.index,
      request: { asset: 'p0', block: '163', amount: '3' }, receiver: 'receiver', permit,
      deployment: { id: '78'.repeat(32) + 'i0', kind: 'dmt', tick: 'bulk', privilegePublicKey: '02' + '90'.repeat(32) } };
    const signature = { r: '1', s: '2', v: 0 }, result = { permit, details, attestation: {} }, recovered = [];
    await store.put('ceremonies', key, { id: 'ab'.repeat(32), proposal, digest, peers: ['s0', 's1', 's2'], stage: 'running', started: Date.now() });
    committee.request = async (signer, path, body) => {
      if (path === '/recover-result') { recovered.push(signer.id); assert.equal(body.id, id); return { status: 'complete', signature, result }; }
      assert.equal(path, '/status'); return { digest, status: signer.id === 's0' ? 'complete' : 'running', ...(signer.id === 's0' ? { signature, result } : {}) };
    };
    if (wrongMember) { await assert.rejects(committee.signature(key, proposal), /signature_disagreement/); assert.deepEqual(recovered, []); }
    else {
      const signed = await committee.signature(key, proposal); assert.equal(signed.payload.prv.hash, digest);
      assert.equal(signed.authorization.id, id); assert.deepEqual(recovered, ['s1', 's2']);
      const reopened = new Committee({ store, network, signers, assetRecoveryVersion: 2 });
      reopened.request = () => assert.fail('completed result must be durable');
      assert.deepEqual(await reopened.signature(key, proposal), signed);
    }
  } finally { await store.close(); }
});

test('a permit waits while a batch is pending, unless it is already running', async () => {
  const store = await Store.open(await temp('committee-permit-yield-'));
  try {
    const signers = Array.from({ length: 5 }, (_, i) => ({ id: 's' + i, peer: { id: 's' + i } }));
    const committee = new Committee({ store, network, signers, assetRecoveryVersion: 2 });
    const proposal = { network, kind: 'mint', version: 'public-v1', id: '12'.repeat(32), receiver: 'receiver' }, key = 'mint/' + proposal.id;
    const asked = []; committee.request = async (signer, path) => { asked.push(path); throw Error('committee_signer_busy'); };
    await store.put('meta', 'draft', { proposal: { batch: { n: '1' } } });
    assert.equal(await committee.signature(key, proposal), null); assert.deepEqual(asked, [], 'no signer is asked while the batch is pending');
    await store.put('ceremonies', key, { id: 'ab'.repeat(32), proposal, digest: '34'.repeat(32), peers: ['s0', 's1', 's2'], stage: 'running', started: Date.now() });
    committee.request = async (signer, path) => { asked.push(path); return { digest: '34'.repeat(32), status: 'running' }; };
    assert.equal(await committee.signature(key, proposal), null);
    assert.ok(asked.length === 3 && asked.every(p => p === '/status'), 'a running permit keeps polling its signers');
  } finally { await store.close(); }
});
test('one permit at a time asks the signers; the next goes when it finishes or is abandoned', async () => {
  const store = await Store.open(await temp('committee-permit-turns-'));
  try {
    const signers = Array.from({ length: 5 }, (_, i) => ({ id: 's' + i, peer: { id: 's' + i } }));
    const committee = new Committee({ store, network, signers, assetRecoveryVersion: 2 });
    const permit = id => ({ network, kind: 'mint', version: 'public-v1', id: id.repeat(32), receiver: 'receiver' });
    const a = permit('12'), b = permit('34'), keyA = 'mint/' + a.id, keyB = 'mint/' + b.id;
    // The older permit prepared two signers; the third was busy, so it retries.
    const held = { id: 'ab'.repeat(32), proposal: a, digest: '56'.repeat(32), peers: ['s0', 's1', 's2'], stage: 'blocked', reason: 'prepare_incomplete',
      retryPrepare: true, unreserved: ['s2'], failures: ['committee_signer_busy'], started: Date.now() - 1000 };
    await store.put('ceremonies', keyA, held);
    const asked = []; committee.request = async (signer, path) => { asked.push(signer.id + path); throw Error('committee_signer_busy'); };
    assert.equal(await committee.signature(keyA, a), null); const askedByA = asked.length; assert.ok(askedByA > 0, 'the oldest permit asks its signers');
    assert.equal(await committee.signature(keyB, b), null); assert.equal(asked.length, askedByA, 'a newer permit does not touch the signers the older one holds');
    await store.put('ceremonies', keyA, { ...held, stage: 'complete', result: {} });
    await assert.rejects(committee.signature(keyB, b), /committee_quorum_unavailable/); assert.ok(asked.length > askedByA, 'the next permit goes once the older finished');
    // A permit whose caller stopped asking no longer holds up the others.
    const turns = new Committee({ store, network, signers, assetRecoveryVersion: 2 }), t0 = Date.now();
    await store.put('ceremonies', keyA, held);
    assert.equal(turns.permitTurn(keyA, held, t0), true); assert.equal(turns.permitTurn(keyB, undefined, t0 + 1), false);
    assert.equal(turns.permitTurn(keyB, undefined, t0 + 300001), true);
    // Long-unfinished permits yield to newer ones, then still take turns among themselves.
    const late = new Committee({ store, network, signers, assetRecoveryVersion: 2 }), old = { ...held, started: t0 - 1000000 };
    const keyC = 'mint/' + '56'.repeat(32), oldC = { ...old, started: t0 - 900500 };
    await store.put('ceremonies', keyA, old); await store.put('ceremonies', keyC, oldC);
    assert.equal(late.permitTurn(keyA, old, t0), true); assert.equal(late.permitTurn(keyC, oldC, t0), false, 'the older stuck permit goes first');
    assert.equal(late.permitTurn(keyB, undefined, t0), true, 'a newer permit is not held up by stuck ones');
    assert.equal(late.permitTurn(keyA, old, t0), false);
  } finally { await store.close(); }
});
// Fake signers keyed by ceremony ID: absent sessions answer ceremony_id, as the signer does.
function permitSigners(digest, initial) {
  const sessions = new Map(Object.entries(initial)), asked = [];
  const request = async (signer, path, body) => {
    const id = body.id ?? body.ceremony?.id, k = signer.id + '/' + id; asked.push(signer.id + path);
    if (sessions.get(signer.id) === 'timeout' && path === '/status') throw Error('committee_timeout');
    if (path === '/prepare') { sessions.set(k, 'prepared'); asked.push(signer.id + ':retry=' + body.ceremony.retry); return { id, digest }; }
    if (path === '/go') { sessions.set(k, 'running'); return { ok: true }; }
    if (path === '/abort') { if (sessions.get(k) !== 'prepared') throw Error('committee_ceremony_id'); sessions.set(k, 'aborted'); return { ok: true }; }
    if (path === '/retire-unprepared') { if (sessions.has(k)) throw Error('committee_ceremony_reserved'); sessions.set(k + '/fenced', true); return { id, status: 'retired-unprepared' }; }
    if (path === '/status') { if (!sessions.has(k)) throw Error('committee_ceremony_id'); return { status: sessions.get(k), id, digest }; }
    throw Error('route');
  };
  return { sessions, asked, request };
}
test('a waiting permit gives back the signers it partly prepared and later restarts for the same digest', async () => {
  const store = await Store.open(await temp('committee-permit-release-'));
  try {
    const signers = Array.from({ length: 5 }, (_, i) => ({ id: 's' + i, peer: { id: 's' + i } }));
    const committee = new Committee({ store, network, signers, assetRecoveryVersion: 2 });
    const proposal = { network, kind: 'mint', version: 'public-v1', id: '12'.repeat(32), receiver: 'receiver' }, key = 'mint/' + proposal.id;
    const id = 'ab'.repeat(32), digest = '56'.repeat(32);
    // Two signers prepared the permit; the third was busy, so a batch now finds only two free signers.
    const held = { id, proposal, digest, peers: ['s0', 's1', 's2'], stage: 'blocked', reason: 'prepare_incomplete',
      retryPrepare: true, unreserved: ['s2'], failures: ['committee_signer_busy'], started: Date.now() };
    await store.put('ceremonies', key, held);
    const fake = permitSigners(digest, { ['s0/' + id]: 'prepared', ['s1/' + id]: 'prepared' }); committee.request = fake.request;
    await store.put('meta', 'draft', { proposal: { batch: { n: '1' } } });
    assert.equal(await committee.signature(key, proposal), null);
    assert.equal(fake.sessions.get('s0/' + id), 'aborted'); assert.equal(fake.sessions.get('s1/' + id), 'aborted');
    assert.equal(fake.sessions.get('s2/' + id + '/fenced'), true, 'the signer that never prepared is fenced against a late preparation');
    const renewed = store.get('ceremonies', key);
    assert.notEqual(renewed.id, id); assert.equal(renewed.retry, 'same-mint-v2'); assert.equal(renewed.retryOf, id); assert.equal(renewed.digest, digest);
    assert.deepEqual(renewed.unreserved, ['s0', 's1', 's2']); assert.equal(renewed.retryPrepare, true);
    assert.deepEqual(store.get('mintCeremonyAttempts', key + '/' + id), held);
    const count = fake.asked.length;
    assert.equal(await committee.signature(key, proposal), null); assert.equal(fake.asked.length, count, 'a permit that holds nothing asks no signer while it waits');
    // After the batch, the permit prepares all three signers afresh for the same digest and starts.
    await store.transact([{ space: 'meta', id: 'draft' }]);
    assert.equal(await committee.signature(key, proposal), null);
    assert.deepEqual(fake.asked.slice(count).filter(a => a.includes(':retry=')), ['s0:retry=same-mint-v2', 's1:retry=same-mint-v2', 's2:retry=same-mint-v2']);
    assert.equal(store.get('ceremonies', key).stage, 'running'); assert.equal(fake.asked.filter(a => a.endsWith('/go')).length, 3);
  } finally { await store.close(); }
});
test('a permit stuck on a failure that proves nothing restarts on its turn', async () => {
  const store = await Store.open(await temp('committee-permit-stuck-'));
  try {
    const signers = Array.from({ length: 5 }, (_, i) => ({ id: 's' + i, peer: { id: 's' + i } }));
    const committee = new Committee({ store, network, signers, assetRecoveryVersion: 2 });
    const proposal = { network, kind: 'mint', version: 'public-v1', id: '12'.repeat(32), receiver: 'receiver' }, key = 'mint/' + proposal.id;
    const id = 'ab'.repeat(32), digest = '56'.repeat(32);
    const stuck = { id, proposal, digest, peers: ['s0', 's1', 's2'], stage: 'blocked', reason: 'prepare_incomplete', retryPrepare: false,
      unreserved: ['s0', 's2'], failures: ['committee_http_status', 'committee_http_status', 'committee_http_status'], started: Date.now() - 36000000 };
    await store.put('ceremonies', key, stuck);
    const fake = permitSigners(digest, { ['s1/' + id]: 'aborted' }); committee.request = fake.request;
    assert.equal(await committee.signature(key, proposal), null);
    const renewed = store.get('ceremonies', key);
    assert.notEqual(renewed.id, id); assert.equal(renewed.retry, 'same-mint-v2'); assert.deepEqual(renewed.unreserved, ['s0', 's1', 's2']);
    assert.equal(fake.sessions.get('s0/' + id + '/fenced'), true); assert.equal(fake.sessions.get('s2/' + id + '/fenced'), true);
    assert.equal(await committee.signature(key, proposal), null); assert.equal(store.get('ceremonies', key).stage, 'running');
  } finally { await store.close(); }
});
test('a waiting permit is left unchanged while a reply proves nothing or a batch is signing', async () => {
  const store = await Store.open(await temp('committee-permit-unproven-'));
  try {
    const signers = Array.from({ length: 5 }, (_, i) => ({ id: 's' + i, peer: { id: 's' + i } }));
    const proposal = { network, kind: 'mint', version: 'public-v1', id: '12'.repeat(32), receiver: 'receiver' }, key = 'mint/' + proposal.id;
    const id = 'ab'.repeat(32), digest = '56'.repeat(32);
    const held = { id, proposal, digest, peers: ['s0', 's1', 's2'], stage: 'blocked', reason: 'prepare_incomplete',
      retryPrepare: true, unreserved: ['s2'], failures: ['committee_signer_busy'], started: Date.now() };
    await store.put('ceremonies', key, held); await store.put('meta', 'draft', { proposal: { batch: { n: '1' } } });
    for (const s1 of ['timeout', 'running']) {
      const committee = new Committee({ store, network, signers, assetRecoveryVersion: 2 });
      const fake = permitSigners(digest, { ['s0/' + id]: 'prepared', ...(s1 === 'timeout' ? { s1: 'timeout', ['s1/' + id]: 'prepared' } : { ['s1/' + id]: 'running' }) }); committee.request = fake.request;
      assert.equal(await committee.signature(key, proposal), null);
      assert.deepEqual(store.get('ceremonies', key), held, s1 + ': the permit keeps its session');
      assert.deepEqual(fake.asked.filter(a => !a.endsWith('/status')), [], s1 + ': no signer is stopped or fenced');
    }
    const committee = new Committee({ store, network, signers, assetRecoveryVersion: 2 });
    const fake = permitSigners(digest, { ['s0/' + id]: 'prepared', ['s1/' + id]: 'prepared' }); committee.request = fake.request;
    committee.activeSigning = new Set(['batch/0/1']); await store.put('ceremonies', 'batch/0/1', { id: 'cd'.repeat(32), stage: 'running' });
    assert.equal(await committee.signature(key, proposal), null); assert.deepEqual(fake.asked, [], 'no signer is asked while a batch is signing on them');
    assert.deepEqual(store.get('ceremonies', key), held);
  } finally { await store.close(); }
});
