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
