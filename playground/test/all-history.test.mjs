import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine } from '../engine.mjs';
import { history, temp } from '../../kit/test/helpers.mjs';
import { loadHistory } from '../../kit/lib/headers.mjs';
import { evaluateDiscovery, CLAIM_DEFAULTS } from '../../rules/src/index.js';
import { encodeTracAddress } from '../../rules/src/trac-address.js';

const owner = '11'.repeat(32);
test('playground default claims reach old plots and preserve a saved round selection', async () => {
  const h=history(150), patterns=[{number:0,pat:'[0-9]',fld:4,dt:'n'}], round={window:150,windowHash:h.get(150).hash,claimableHeight:150};
  let saved, sent, reads=0;
  const actor={journal:{get:()=>saved},agent:{takenSlots:async()=>{reads++;return {0:new Set([0,1])};},claim:async args=>(sent=args)}};
  const e={snapshot:async()=>h,trac:async method=>method==='head'?{tip:{height:150}}:CLAIM_DEFAULTS,store:{get:()=>({rounds:[round]})},patterns:()=>patterns};
  await Engine.prototype.claim.call(e,actor);
  assert.equal(sent.event.window,150);assert.equal(sent.plots[0].block,2);assert.equal(sent.plots.length,CLAIM_DEFAULTS.claimsPerWindow);
  saved={body:{p:{plots:sent.plots}}};await Engine.prototype.claim.call(e,actor);
  assert.equal(reads,1);assert.deepEqual(sent.plots,saved.body.p.plots);
});

test('fresh playground seeds measured discoveries through commit and reveal, once', async t => {
  const dir=await temp(t), path=join(dir,'headers.bin');
  await writeFile(path,Buffer.from((await readFile(new URL('../../kit/test/fixtures/mainnet-64.hex',import.meta.url),'utf8')).trim(),'hex'));
  const h=await loadHistory(path), patterns=[], calls=[];let tip=h.length-1, proposal;
  const actor={journal:{get:()=>null},agent:{address:encodeTracAddress(owner)}};
  const e={actor:async()=>actor,patterns:()=>patterns,snapshot:async()=>h,trac:async()=>({tip:h.get(h.length-1)}),
    blocks:async n=>{calls.push(['blocks',n]);tip+=n;},action:async(type,args)=>{
      calls.push([type]);if(type==='discovery/commit'){proposal=args.proposal;return {revealFrom:tip+2};}
      patterns.push(evaluateDiscovery({proposal,discoverer:owner,history:h,existing:patterns,number:patterns.length}).record);
    }};
  await Engine.prototype.seedDiscoveries.call(e,1);
  assert.deepEqual(calls,[['discovery/commit'],['blocks',2],['discovery/reveal'],['blocks',1]]);
  assert.ok(patterns[0].rarity>=3);await Engine.prototype.seedDiscoveries.call(e,1);assert.equal(calls.length,4);
});

test('local TAP payment uses direct items and the permanent player permit without depth waits', async t => {
  const directory=await temp(t), id='ab'.repeat(32), paymentId='cd'.repeat(32)+'i0', inscription='ef'.repeat(32)+'i0';
  const fees=[{role:'treasury',to:'local-treasury',ticker:'tap',amount:'1000000000000000000',tt:'a',dta:'dmw-pay-v2|'+id+'|treasury'}];
  let state='awaiting_payment';const writes=[],posts=[];
  const row=()=>({requestId:id,state,payable:true,missing:state==='awaiting_payment'?fees:[],fees,payableAmount:'1000000000000000000',receiver:'local-receiver',mintContent:{p:'tap',op:'dmt-mint'},inscription:state==='minted'?inscription:null});
  const e={directory,state:{payerKey:Buffer.alloc(32,1).toString('hex'),releaseKey:Buffer.alloc(32,2).toString('hex'),payerAuthority:'test-authority',addresses:{payer:'local-payer'}},
    store:{get:()=>({payer:'local-payer',kind:'tap'})},waitMintReady:async()=>row(),get:async()=>row(),emit(){},
    write:async(content,receiver)=>{writes.push({content,receiver});return writes.length===1?paymentId:inscription;},
    blocks:async()=>{throw Error('No confirmation-depth block may be mined');},
    post:async(path,body)=>{posts.push({path,body});state=body.inscription?'minted':'permit_issued';return row();}};
  const result=await Engine.prototype.pay.call(e,{id});assert.equal(result.request.state,'minted');
  assert.equal(writes.length,2);assert.equal(writes[0].content.redeem.items[0].amt,'1');assert.deepEqual(writes[0].content.redeem.actions,[]);
  assert.equal(writes[1].receiver,'local-receiver');assert.deepEqual(posts.map(p=>p.body),[{id,paymentId},{id,inscription}]);
  await Engine.prototype.pay.call(e,{id});assert.equal(writes.length,2);
});


test('Ethereum payment plan deposits only the remaining fee items with the current split ABI', async () => {
  const {paymentPlan}=await import('../wallets.mjs'),id='ab'.repeat(32),address=n=>'0x'+n.repeat(40);
  const fees=[{role:'treasury',to:address('2'),amount:'30'},{role:'discoverer',to:address('3'),amount:'5'},{role:'burn',amount:'35'}];
  const e={state:{player:{address:owner},escrow:{token:address('4'),address:address('5')}},manifest:{ethereum:{rpc:'http://127.0.0.1:59809'}},
    store:{get:()=>({kind:'ethereum',payer:address('1'),request:{owner}})},get:async()=>({state:'awaiting_payment',price:'100',payableAmount:'70',fees,missing:fees}),
    evm:{rpc:async()=>({timestamp:'0x1'})}};
  const plan=await paymentPlan(e,id),[approval,deposit]=plan.transactions;
  const words=deposit.data.slice(10).match(/.{64}/g);
  assert.equal(words.length,12,'request, amount, nine split fields, expiry');
  assert.equal(words[0],id);assert.equal(BigInt('0x'+words[1]),70n);assert.equal(BigInt('0x'+approval.data.slice(-64)),70n);
  assert.equal(BigInt('0x'+words[5]),0n,'payer finder share stays omitted');
  assert.equal('0x'+words[8].slice(-40),address('3'));assert.equal(BigInt('0x'+words[9]),5n);assert.equal(BigInt('0x'+words[10]),35n);
  assert.deepEqual(plan.networkFee,{payer:'player_wallet'});
});

test('a bot awaiting player deployment leaves the next strategy free to work', async t => {
  const {botsOnce}=await import('../bots.mjs'),directory=await temp(t),actions=[];
  await writeFile(join(directory,'bots.json'),JSON.stringify({'bot-0':{transfer:true}}));
  const actors=[{name:'bot-0',address:owner,strategy:'prospector'},{name:'bot-1',address:'22'.repeat(32),strategy:'discoverer'}];
  for(const a of actors)a.journal={get:()=>null};
  const e={directory,settings:{bots:{paused:false,count:2}},trac:async name=>name==='head'?{tip:{height:100}}:'10',actor:async name=>actors.find(a=>a.name===name),
    claim:async()=>{},store:{get:()=>null},rows:()=>[{finder:owner,asset:'p0',block:1,count:1}],patterns:()=>[],emit(){},
    action:async(name,args)=>{actions.push(name);return name==='mint'?{deploymentNeeded:true,asset:'p0'}:{revealFrom:102};}};
  await botsOnce(e);
  assert.deepEqual(actions,['mint','discovery/commit']);assert.equal(actors[0].lastAction.action,'deployment_needed');assert.equal(actors[1].lastAction.action,'discovery/commit');
  const saved=JSON.parse(await readFile(join(directory,'bots.json')));assert.equal(saved['bot-0'].halted,undefined);assert.equal(saved['bot-0'].mint,undefined);
});
