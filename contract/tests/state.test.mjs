import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { harness, alice, bob, carol, signedRequest, signedBatch, nonce, deployment, invariants, committeeSecret } from './helpers/harness.mjs';
import { chain, parseHeader } from './helpers/chain.mjs';
import { bytesToHex, sha256, hexToBytes, batchDigest, requestDigest } from '../signing.js';
import { DEFAULT_SETTINGS, SETTING_BOUNDS, ADMIN_DELAY, PAUSE_MAX, PAUSE_COOLDOWN } from '../settings.js';
const preimage = '42'.repeat(32), hash = bytesToHex(sha256(hexToBytes(preimage)));
const xc = (input = [['a','100']], output = [['d','10']], n = 1, until = 10000, owner = alice) => signedRequest('xc', { owner: owner.address, in: input, out: output, nonce: nonce(n), until }, owner);
export const rq = (asset = 'a', n = 1, quantity = '100', owner = alice, extra = {}) => signedRequest('rq', { owner: owner.address, asset, amount: quantity, receive: nonce(999), nonce: nonce(n), until: 10000, expires: 434, ...extra }, owner);
const id = op => bytesToHex(requestDigest(deployment.network, 'rq', op.request));
const lockId = h => [...h.db.keys()].find(k => /^l\/[0-9a-f]{64}$/.test(k))?.slice(2);
const bal = async (h, asset = 'a', who = alice) => h.state().balance(await h.state().agent(who.address), asset);
const check = h => invariants(h.db, 0, h.supply);
async function locked(h, asset = 'a', refund = 7) {
  assert.equal(await h.run('hl', { to: bob.address, assets: [[asset,'100']], hash, refund }), null); return lockId(h);
}
async function refused(h, type, value, error, sender) {
  const before = structuredClone(h.db);
  assert.equal(await h.run(type, value, sender), error); assert.deepEqual(h.db, before);
}
test('credits accumulate exact BigInt balances, compact owners and no tombstones', async () => {
  const h = harness(); await h.mint(); assert.equal(await h.state().agent(alice.address), 1);
  const huge = '9'.repeat(78);
  assert.equal(await h.tickBatch([{ op:'mk', to:alice.address, asset:'a', amount:huge }]), null);
  assert.equal(await bal(h), (BigInt(huge)+100n).toString());
  assert.equal(await h.tickBatch([xc([['a',huge]])]), null); assert.equal(await bal(h), '100');
  assert.equal(await h.tickBatch([{ op:'mk', to:bob.address, asset:'a', amount:'3' }]), null);
  assert.equal(await bal(h,'a',bob), '3'); check(h);
});
test('xc exact owner signature, network, quantities and shared single-use nonce', async () => {
  const h = harness(); await h.mint(); await h.advance(1); const good = xc();
  for (const bad of [{...good,sig:'00'.repeat(64)}, {...good,request:{...good.request,out:[['e','10']]}}, signedRequest('xc',good.request,bob), signedRequest('xc',good.request,alice,'foreign')]) assert.equal(await h.batch([bad]), 'request_signature');
  assert.equal(await h.batch([good]), null);
  assert.equal(await h.tickBatch([xc([['b','1']],[['d','1']])]), 'request_replay');
  assert.equal(await h.batch([rq('b')]), 'request_replay');
  assert.equal(await h.batch([xc([['b','1']],[['d','1']],2,0)]), 'request_expired'); check(h);
});
test('request validity includes until; duplicate assets refuse; same-asset xc is allowed', async () => {
  const h = harness(); await h.mint(); await h.advance(1);
  assert.equal(await h.batch([xc([['a','1'],['a','1']])]), 'request_assets');
  assert.equal(await h.batch([xc([['a','10']],[['a','5']],1,2)]), null); assert.equal(await bal(h),'95');
  assert.equal(await h.tickBatch([xc([['a','1']],[['d','1']],2,2)]), 'request_expired'); check(h);
});
test('mint requires owner consent, optional block, request digest identity and amount escrow', async () => {
  const h = harness(); await h.mint(); await h.advance(1);
  assert.equal(await h.batch([{op:'rq',id:'a'}]), 'rq');
  const first = rq('a',1,'30',alice,{block:42}), second = rq('a',2,'20');
  assert.notEqual(id(first),id(second)); assert.equal(await h.batch([first,second]),null);
  assert.equal(await bal(h),'50'); assert.equal((await h.state().mint(id(first))).block,42);
  assert.equal(Object.hasOwn(await h.state().mint(id(second)),'block'),false);
  assert.equal(await h.run('rx',{id:id(first)},carol.address),'mint_live');
  assert.equal(await h.tickBatch([{op:'rx',id:id(first)}]),'mint_live');
  assert.equal(await h.batch([{op:'mp',id:id(second)}]),null);
  await h.advance(DEFAULT_SETTINGS.pending_blocks+1);
  assert.equal(await h.batch([{op:'rx',id:id(first)}]),null); assert.equal(await bal(h),'80');
  assert.equal(await h.tickBatch([{op:'mc',id:id(second),permitHash:nonce(44),payments:[{key:nonce(45),amount:'100',total:'100'}]}]),null);
  assert.equal(await h.tickBatch([{op:'rl',id:id(second),inscription:nonce(55)+'i0'}]),null);
  assert.equal((await h.state().mint(id(second))).s,1);
  assert.equal((await h.state().mint(id(second))).inscription,nonce(55)+'i0');
  assert.equal(await h.tickBatch([{op:'rx',id:id(second)}]),'mint_unknown'); check(h);
});
for (const op of ['tf','hl','xc','rq']) test('mint expiry is spendable through '+op+' without committee cleanup', async () => {
  const h = harness(); await h.mint(); const request = rq(); assert.equal(await h.tickBatch([request]),null);
  const e = (await h.state().mint(id(request))).e; await h.advance(DEFAULT_SETTINGS.pending_blocks);
  assert.equal((await h.state().head()).counted,e); assert.equal(await bal(h),'0');
  await h.advance(1); assert.equal(await bal(h),'100'); assert.equal((await h.state().mint(id(request))).s,2);
  if(op==='tf') assert.equal(await h.run('tf',{to:bob.address,assets:[['a','100']]}),null);
  if(op==='hl') await locked(h,'a',e+10);
  if(op==='xc') assert.equal(await h.batch([xc()]),'request_replay');
  if(op==='xc') assert.equal(await h.batch([xc(undefined,undefined,2)]),null);
  if(op==='rq') assert.equal(await h.batch([rq('a',2,'100',alice,{expires:e+433})]),null);
  assert.equal(await h.run('rx',{id:id(request)},carol.address),null);
  assert.equal(await h.run('rx',{id:id(request)},carol.address),'mint_unknown'); check(h);
});
test('expiry aggregation releases once across requests and cleanup cannot release a newer request',async()=>{
  const h=harness(); await h.mint(); const a=rq('a',1,'20'),b=rq('a',2,'30');
  assert.equal(await h.tickBatch([a,b]),null); assert.equal(h.db.get('e/1/a').length,1);
  await h.advance(DEFAULT_SETTINGS.pending_blocks+1); assert.equal(await bal(h),'100');
  const c=rq('a',3,'60',alice,{expires:(await h.state().head()).counted+432}); assert.equal(await h.batch([c]),null); assert.equal(await bal(h),'40');
  assert.equal(await h.run('rx',{id:id(a)}),null); assert.equal(await h.run('rx',{id:id(b)}),null);
  assert.equal(await bal(h),'40'); assert.equal((await h.state().mint(id(c))).s,0);
  assert.equal(await h.tickBatch([{op:'rl',id:id(a),inscription:nonce(1)+'i0'}]),'mint_not_consumed'); check(h);
});
for (const late of [false,true]) test('an inscription alone never consumes units at expiry + '+Number(late),async()=>{
  const h=harness(); await h.mint(); const r=rq(); await h.tickBatch([r]); await h.advance(DEFAULT_SETTINGS.pending_blocks+Number(late));
  assert.equal(await h.batch([{op:'rl',id:id(r),inscription:nonce(5)+'i12'}]),'mint_not_consumed');
  if(late) { assert.equal(await h.batch([{op:'rx',id:id(r)}]),null); assert.equal(await bal(h),'100'); } check(h);
});
test('transfer list validates canonical amounts, maximum 16 assets and rolls back overdraw',async()=>{
  const h=harness(); await h.mint();
  for(const assets of [[],[['a','0']],[['a','01']],[['a',1]],[['a','-1']],[['a','1e3']],[['a','9'.repeat(79)]],[['A','1']],[['a','1'],['a','2']],Array.from({length:17},(_,i)=>['x'+i,'1'])]) await refused(h,'tf',{to:bob.address,assets},'tf');
  await refused(h,'tf',{to:bob.address,assets:[['a','1'],['b','101']]},'balance');
  await refused(h,'tf',{to:bob.address,assets:[['a','1']]},'balance',carol.address);
  assert.equal(await h.run('tf',{to:bob.address,assets:[['a','25'],['b','100']]}),null);
  assert.equal(await bal(h),'75'); assert.equal(await bal(h,'a',bob),'25'); assert.equal(h.db.has('v/1/b'),false); check(h);
});
for(const atRefund of [false,true]) test('lock claim/refund exclusive at boundary '+atRefund,async()=>{
  const h=harness(); await h.mint(); const lock=await locked(h); assert.equal(await bal(h),'0');
  await h.advance(atRefund?6:5);
  if(atRefund) { await refused(h,'hc',{lock,preimage},'claim'); assert.equal(await h.run('hr',{lock},carol.address),null); assert.equal(await bal(h),'100'); }
  else { await refused(h,'hr',{lock},'refund_early'); await refused(h,'hc',{lock,preimage:nonce(0)},'claim'); assert.equal(await h.run('hc',{lock,preimage},carol.address),null); assert.equal(await bal(h,'a',bob),'100'); }
  await refused(h,'hr',{lock},'lock_unknown'); check(h);
});
test('lock horizons inclusive and repeated locks have independent identities',async()=>{
  const h=harness(); await h.mint();
  for(const refund of [6,2018,-1,2.5]) await refused(h,'hl',{to:bob.address,assets:[['a','1']],hash,refund},refund===2.5?'encoding':'refund_range');
  await locked(h,'a',7); await locked(h,'b',2017); assert.equal([...h.db.keys()].filter(k=>/^l\/[0-9a-f]{64}$/.test(k)).length,2); check(h);
});
test('combined header/batch is signed, atomic, accepts known headers and advances clock before requests',async()=>{
  const h=harness(), hx=chain(1), base={n:1,from:1,to:1,hx,ops:[{op:'mk',to:alice.address,asset:'a',amount:'1'}]};
  await refused(h,'bt',signedBatch({...base,ops:[...base.ops,{op:'bad'}]}),'operation');
  await refused(h,'bt',{...signedBatch(base),hx:chain(1,undefined,601)},'batch_signature');
  assert.equal(await h.run('bt',signedBatch(base),alice.address,true),null); assert.equal((await h.state().head()).counted,1);
  await h.advance(1); assert.equal(await h.batch([],{hx:hx.slice(-1)}),null); check(h);
});
test('batch refusal checks signatures, high-S, sequence, sizes and rolls back nonces',async()=>{
  const h=harness(); await h.mint(); await h.advance(1); const base={n:2,from:2,to:2,deadline:2,ops:[]};
  for(const change of [{n:0},{n:3},{from:1},{from:3},{to:1},{to:3}]) await refused(h,'bt',signedBatch({...base,...change}),'batch_sequence');
  await refused(h,'bt',signedBatch(base,{...deployment,network:'foreign'}),'batch_signature');
  await refused(h,'bt',signedBatch(base,deployment,'02'.repeat(32)),'batch_signature');
  const sig=secp256k1.sign(batchDigest(deployment.network,signedBatch(base)),committeeSecret);
  await refused(h,'bt',{...signedBatch(base),sig:new secp256k1.Signature(sig.r,secp256k1.CURVE.n-sig.s).toCompactHex()},'batch_signature');
  await refused(h,'bt',signedBatch({...base,ops:Array(513).fill({op:'rx',id:nonce(0)})}),'batch_size');
  await refused(h,'bt',signedBatch({...base,ops:[{op:'kv',key:'a',value:'a'.repeat(99000)}]}),'batch_size');
  const before=structuredClone(h.db); assert.equal(await h.batch([xc(),{op:'mk',to:bob.address,asset:'z',amount:'1'},{op:'bad'}]),'operation'); assert.deepEqual(h.db,before);
  assert.equal(await h.batch([xc()]),null); check(h);
});
test('kv namespacing, UTF8 bound and count',async()=>{
  const h=harness(); await h.advance(6); assert.equal(await h.batch([{op:'kv',key:'../admin',value:'é'.repeat(128)}]),null);
  assert.equal(h.db.has('admin'),false); assert.equal(await h.tickBatch([{op:'kv',key:'x',value:'é'.repeat(129)}]),'kv');
  assert.equal(await h.batch(Array.from({length:17},(_,i)=>({op:'kv',key:'a'+i,value:'v'}))),'batch_kv');
  assert.equal(await h.batch([{op:'kv',key:'../admin',value:null}]),null);
});
test('fixed 432 delay, permissionless key apply and old-key rejection',async()=>{
  assert.equal(ADMIN_DELAY,432); const h=harness(); await h.advance(6); const key=bytesToHex(secp256k1.getPublicKey('02'.repeat(32)));
  await refused(h,'ad_key',{key},'admin',bob.address); assert.equal(await h.run('ad_key',{key}),null);
  await h.advance(431); await refused(h,'ad_apply',{id:'key'},'admin_delay',bob.address);
  await h.advance(1); assert.equal(await h.run('ad_apply',{id:'key'},bob.address),null); assert.equal(await h.batch([]),'batch_signature');
  assert.equal(await h.run('bt',signedBatch({epoch:1,n:1,from:1,to:(await h.state().head()).counted,ops:[]},deployment,'02'.repeat(32))),null);
});
test('settings bounds, replacement delay and new admin must accept after maturity',async()=>{
  const h=harness(); await h.advance(6);
  for(const [key,[min,max]] of Object.entries(SETTING_BOUNDS)) { for(const value of [min-1,max+1]) await refused(h,'ad_set',{key,value},'admin_proposal'); assert.equal(await h.run('ad_set',{key,value:max}),null); }
  for(const key of ['admin_delay','__proto__']) await refused(h,'ad_set',{key,value:1},'admin_proposal');
  await h.advance(431); assert.equal(await h.run('ad_set',{key:'lock_min',value:1}),null); await h.advance(1);
  await refused(h,'ad_apply',{id:'set/lock_min'},'admin_delay'); assert.equal(await h.run('ad_apply',{id:'set/lock_max'},carol.address),null);
  assert.equal(await h.run('ad_admin',{address:bob.address}),null); await refused(h,'ad_accept',{id:'admin'},'admin_delay',bob.address);
  await h.advance(432); assert.equal(await h.run('ad_apply',{id:'admin'},carol.address),'admin_accept_required'); assert.equal(await h.state().admin(),alice.address);
  await refused(h,'ad_accept',{id:'admin'},'admin_acceptor',alice.address); assert.equal(await h.run('ad_accept',{id:'admin'},bob.address),null);
  assert.equal(await h.state().admin(),bob.address); assert.deepEqual(await h.state().pending(),[]); await refused(h,'ad_pause',{on:true},'admin');
});
test('pause is bounded, cannot chain or reset cooldown, transfers and headers stay live',async()=>{
  const h=harness(); await h.mint(); await locked(h); assert.equal(await h.run('ad_pause',{on:true}),null);
  await refused(h,'ad_pause',{on:true},'pause_active'); assert.equal(await h.tickBatch([]),'paused');
  assert.equal(await h.run('tf',{to:bob.address,assets:[['b','1']]}),null); assert.equal(await h.run('hc',{lock:lockId(h),preimage}),null);
  await h.advance(PAUSE_MAX-1); assert.equal(await h.state().paused(),false); assert.equal(await h.batch([]),null);
  await refused(h,'ad_pause',{on:true},'pause_cooldown'); await h.run('ad_pause',{on:false}); await h.advance(PAUSE_COOLDOWN-1);
  await refused(h,'ad_pause',{on:true},'pause_cooldown'); await h.advance(1); assert.equal(await h.run('ad_pause',{on:true}),null);
  await h.advance(1); assert.equal(await h.run('ad_pause',{on:false}),null); await h.advance(143); await refused(h,'ad_pause',{on:true},'pause_cooldown');
  await h.advance(1); assert.equal(await h.run('ad_pause',{on:true}),null);
});
test('msg/tx combined routes agree and unsigned normal operations cannot use free messages',async()=>{
  const one=harness(),two=harness(); const b=signedBatch({n:1,from:1,to:1,hx:chain(1),ops:[{op:'mk',to:alice.address,asset:'a',amount:'1'}]});
  assert.equal(await one.run('bt',b),null); assert.equal(await two.run('bt',b,alice.address,true),null); assert.deepEqual(one.db,two.db);
  assert.equal(await one.run('tf',{to:bob.address,assets:[['a','1']]},alice.address,true),'message');
});
test('combined header at pause expiry resumes batch; failed combined dispatch cannot move clock',async()=>{
  const h=harness();await h.mint();await h.run('ad_pause',{on:true});await h.advance(142);
  const before=structuredClone(h.db),head=await h.state().head(),parent=await h.state().beacon().raw(head.tip.hash),hx=chain(2,parent);
  assert.equal(await h.run('bt',signedBatch({n:2,from:2,to:144,hx:hx.slice(0,1),ops:[]})),'paused');assert.deepEqual(h.db,before);
  assert.equal(await h.run('bt',signedBatch({n:2,from:2,to:145,hx,ops:[]})),null);assert.equal(await h.state().paused(),false);
});
test('admin handover retains pause cooldown; replacing proposed admin invalidates old acceptance',async()=>{
  const h=harness();await h.advance(6);await h.run('ad_admin',{address:bob.address});await h.advance(432);
  await h.run('ad_admin',{address:carol.address});await refused(h,'ad_accept',{id:'admin'},'admin_delay',bob.address);await h.advance(432);
  await h.run('ad_pause',{on:true});await h.run('ad_pause',{on:false});
  await refused(h,'ad_accept',{id:'admin'},'admin_acceptor',bob.address);assert.equal(await h.run('ad_accept',{id:'admin'},carol.address),null);
  await refused(h,'ad_pause',{on:true},'pause_cooldown',carol.address);
});
