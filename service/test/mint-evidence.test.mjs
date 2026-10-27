import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, network } from '../../committee/test/fixture.mjs';
import { admittedMint, winningMint } from '../src/mint-evidence.mjs';
const id = 'ab'.repeat(32)+'i0', receiver='fixture-receiver';
test('compound watcher pages past the indexer cap and finds the latest player inscription', async()=>{
  const permit={p:'tap',op:'token-mint',tick:'compound',amt:'1',dta:'bound-request',prv:{address:receiver,hash:'digest',sig:{}}};
  const deployment={kind:'compound',id:'cd'.repeat(32)+'i0',tick:'compound',privilegePublicKey:'committee'};
  const row={permit,receiver,request:{amount:'1'},context:{deployment}}, offsets=[];
  const minted={ins:id,fail:false,tick:'compound',addr:receiver,amt:'1',dta:permit.dta};
  const reads={tap:async path=>{
    if(path.startsWith('getAccountMintListLength/'))return 1200;
    if(path.startsWith('getAccountMintList/')){
      const query=new URL('http://fixture.invalid/'+path).searchParams,offset=Number(query.get('offset'));offsets.push(offset);
      return Array.from({length:Math.min(500,1200-offset)},(_,i)=>offset+i===1199?minted:{fail:false,dta:'other',amt:'1'});
    }
    if(path.startsWith('getMintedList/'))return [minted];
    throw Error('unexpected_read');
  },included:async()=>({confirmations:1}),content:async()=>permit};
  const result=await winningMint(reads,row,null,()=> 'committee');
  assert.deepEqual(offsets,[200,700]);assert.equal(result.inscription,id);assert.equal(result.receiver,receiver);
});

test('accepted reservation freezes Bitmap ownership and rejects missing or rejected audit evidence', async()=>{
  const f=fixture(), original={agent:f.proposal.request.owner,address:'original-holder'};
  const input={op:'rq',request:f.proposal.request,sig:f.proposal.signature,evidence:{context:{deployment:f.data.context.deployment,link:{block:10,linkHeight:90}},bitmap:original}};
  const file={mintOperations:[input],mintOutcomes:[{reason:'accepted'}]};
  const store={list:()=>[{id:'1',value:{batch:{n:1,to:100}}}]}, reads={pendingAcceptance:async()=>f.data.acceptance};
  const snapshot=await admittedMint({store,reads,audits:async()=>[file],network,id:f.id});
  assert.deepEqual(snapshot.bitmap,original);
  f.data.context.link=snapshot.context.link;f.data.context.bitmapHolder=snapshot.bitmap;f.data.bitmap=original;f.reprice();
  f.reads.bitmap=async()=>{throw Error('current_holder_must_not_redirect_paid_quote');};
  assert.ok(await f.policy.approve(f.proposal));
  file.mintOutcomes[0].reason='rejected';
  await assert.rejects(admittedMint({store,reads,audits:async()=>[file],network,id:f.id}),/mint_admission_evidence_missing/);
  await assert.rejects(admittedMint({store,reads,audits:async()=>{throw Error('accepted_audit_root');},network,id:f.id}),/accepted_audit_root/);
});
