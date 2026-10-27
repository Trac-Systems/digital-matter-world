import test from 'node:test';
import assert from 'node:assert/strict';
import { rules } from '../src/rules.mjs';
import { hotState, hydrateState } from '../src/replay-state.mjs';
import { agent, secret as gatewaySecret, gateway } from './helpers.mjs';
import { attest, receiptSigners } from '../../rules/test/witness-fixture.mjs';

test('a later craft rehydrates its existing output type and keeps the original maker',()=>{
 const network='local',a=agent(1),b=agent(2),hashAt=h=>rules.hash(String(h));
 const history={length:2001,get:height=>({height,nonce:height,bits:1,hash:hashAt(height)}),field:height=>String(height)};
 const patterns=[0,1].map(number=>({number,name:'dmwtest'+(number?'b':'a'),pat:'[0-9]',fld:4,dt:'n',rarity:101,historyHeight:100}));
 const output=rules.compound('fusion',patterns.map(p=>({asset:'p'+p.number,amount:'1',properties:rules.patternProperties(p)})),96);
 const make=(who,tip)=>{const request={owner:who.address,in:[['p0','1'],['p1','1']],out:[[output.id,'1']],nonce:rules.hash('craft'+tip),until:200};return rules.solveMove({v:1,network,a:who.address,t:'craft',b:tip,h:hashAt(tip),p:{recipe:'fusion',request,sig:rules.signRequest('xc',network,request,who.secret)}},who.secret,0);};
 const step=(state,tip,move)=>{const receipt=rules.signReceipt(move,{tip,hash:hashAt(tip),sequence:(state.lastSequence??-1)+1},gatewaySecret),receiptRoot=rules.sealReceipts([receipt],{network,tip,hash:hashAt(tip)},gatewaySecret);return rules.processBlock({height:tip-5,blockHash:hashAt(tip-5),tip,tipHash:hashAt(tip),network,gateway,history,patterns,entries:[{move,receipt}],receiptRoot,rootAttestations:attest(receiptRoot),state,hashAt,settings:{puzzleBits:0,receiptSigners}});};
 const first=step({lastTip:99,balances:{[a.address]:{p0:'1',p1:'1'}}},100,make(a,100));
 assert.equal(first.file.moves[0].reason,'accepted');const original=rules.recordGet(first.state.types,output.id),secondMove=make(b,101);
 const store={get:(space,id)=>space==='types'&&id===output.id?original:null,list:space=>space==='intake/next'?[{value:{move:secondMove}}]:[]};
 const cold=hotState(first.state);cold.balances={[b.address]:{p0:'1',p1:'1'}};
 const loaded=hydrateState(store,cold,[{id:'next',tip:101,hash:hashAt(101)}]);
 const second=step(loaded,101,secondMove);
 assert.equal(second.file.moves[0].reason,'accepted');assert.equal(second.file.crafts[0].firstMaker,a.address);
 assert.deepEqual(rules.recordGet(second.state.types,output.id),original);assert.equal(rules.recordGet(second.state.balances,b.address)[output.id],'1');
});
