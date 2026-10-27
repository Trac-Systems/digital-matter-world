import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
import {createGroup,startSidecar,stopChild,rpc,descriptor,randomHex,ceremony,recoverCommit,delay,buildRoot} from '../tss.mjs';
const dir=await mkdtemp(join(buildRoot,'swap-recovery-')),network='dmw-regtest-recovery',group=await createGroup(dir,{prefix:'independent',port:60800,network}),children=[];
const started=Date.now();let result;
try{
 const inventory=JSON.parse(await readFile(join(dir,'group.json')));assert.ok(inventory.group.every(m=>!m.token&&!m.secret));assert.equal(new Set(group.map(m=>m.directory)).size,5);
 for(const m of group)children.push(await startSidecar(m));
 const start={id:randomHex(),kind:'keygen',network,epoch:1,digest:'',peers:group.map(descriptor),newPeers:[],timeout:180};
 await Promise.all(group.map(m=>rpc(m.url,m.token,'/prepare',start)));await Promise.all(group.map(m=>rpc(m.url,m.token,'/go')));
 const deadline=Date.now()+180000;let states;
 for(;;){states=await Promise.all(group.map(m=>rpc(m.url,m.token,'/status')));assert.ok(!states.some(s=>s.session.status==='aborted'),JSON.stringify(states));if(states.every(s=>s.session.status==='ready'))break;assert.ok(Date.now()<deadline);await delay(200);}
 const decision={start,publicKey:states[0].session.public,certificates:states.map(s=>s.session.ready)};
 await Promise.all(group.slice(0,2).map(m=>rpc(m.url,m.token,'/commit',decision.certificates)));
 await Promise.all(children.map(stopChild));children.length=0;
 for(const m of group)children.push(await startSidecar(m));
 await recoverCommit(group,decision);await recoverCommit(group,decision);
 assert.ok((await Promise.all(group.map(m=>rpc(m.url,m.token,'/status')))).every(s=>s.public===decision.publicKey&&s.epoch===1));
 await Promise.all(children.slice(3).map(stopChild));
 const digest=randomHex(),signature=await ceremony(group.slice(0,3),'sign',{network,digest,timeout:60});assert.ok(secp256k1.verify(signature.compact,digest,decision.publicKey,{prehash:false,lowS:true}));
 await assert.rejects(ceremony(group.slice(0,2),'sign',{network,digest:randomHex(),timeout:2}));
 await assert.rejects(rpc(group[0].url,'wrong-token','/status'));
 result={ok:true,separateProcesses:5,separateDirectories:5,sharedCredentialFile:false,partialCommit:2,restarted:5,idempotentRecovery:true,threshold:'3-of-5',twoRefused:true,milliseconds:Date.now()-started};console.log(JSON.stringify(result));
}finally{await Promise.all(children.map(stopChild));await writeFile(join(dir,'result.json'),JSON.stringify(result??{ok:false},{},2),{mode:0o600});console.log('Evidence:',dir);}
