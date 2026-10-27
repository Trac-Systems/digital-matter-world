import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { productionLaunch } from './launch.mjs';
import { sharedTarget } from './test-target.mjs';
import { temporary } from '../service/prod/test/helpers.mjs';
import { createFeePolicy } from '../service/src/fees.mjs';
import { hash, edPublic } from '../service/src/util.mjs';
import { committeeAddress, calldata, abiWord } from '../committee/signer/escrow.mjs';
import { signLegacy } from './ethereum-signing.mjs';
import { AdmittedWrites } from './admission.mjs';
import { encodeTracAddress } from '../rules/src/trac-address.js';
const require=createRequire(new URL('../local/package.json',import.meta.url)),{secp256k1}=require('@noble/curves/secp256k1'),btc=require('@scure/btc-signer');
const recorded=JSON.parse(await readFile(new URL('./fixtures/production-reads.json',import.meta.url)));

test('complete production orchestration uses all shared phases, exact signed admission and recovers a lost deployment acknowledgement',async t=>{
  const root=await temporary(t),target=structuredClone(sharedTarget),key=Buffer.alloc(32,21),publicKey=Buffer.from(secp256k1.getPublicKey(key)).toString('hex');
  Object.assign(target,{mode:'mainnet',network:'rehearsal-orchestration'});Object.assign(target.paths,{output:root});
  Object.assign(target.bitcoin,{chain:'main',checkpointFile:join(root,'checkpoint.json'),authorityHolderAddress:btc.p2wpkh(secp256k1.getPublicKey(key)).address});
  Object.assign(target.ethereum,{chainId:'1',signing:'files',adminAddress:committeeAddress(publicKey),tokenAddress:'0x'+'22'.repeat(20)});
  target.committee.publicKey=publicKey;target.committee.members.forEach((m,i)=>Object.assign(m,{id:'m'+i,identity:edPublic(Buffer.alloc(32,i+1)),encryption:String(i+1).padStart(64,'0')}));
  Object.assign(target.trac,{adminPublicKey:edPublic(Buffer.alloc(32,30)),hostAdminPublicKey:edPublic(Buffer.alloc(32,31)),writerPublicKey:edPublic(Buffer.alloc(32,32))});
  target.trac.balance.hostAddress=encodeTracAddress(target.trac.hostAdminPublicKey);target.trac.balance.writerAddress=encodeTracAddress(target.trac.writerPublicKey);
  target.runtime.deploymentFile=join(root,'deployment.json');target.gateway.registryFile=join(root,'registry.json');
  const contents=new Map(),included=new Set(),queue=new Set(),elements=[],deployments=new Map(),packages=new Map(),sent=new Set();let writesCount=0,transfers=0,rendered=0,registered=0,fail=true,boundaries=0,confirmationWindows=0;
  const escrow='0x'+'33'.repeat(20),runtime='0x'+'60006000'.repeat(40),artifact={bytecode:{object:'0x6000'},deployedBytecode:{object:runtime,immutableReferences:{}}};
  const receipt={status:'0x1',contractAddress:escrow},policy={confirmations:1,authorityKey:publicKey,tapTreasury:'bc1-fixture',ethereumTreasury:target.ethereum.adminAddress};
  const core=async(method,args=[])=>{if(method==='getblockcount')return 2022;if(method==='getblockhash')return recorded.headers[String(args[0])].hash;if(method==='getblockheader'){const r=Object.values(recorded.headers).find(r=>r.hash===args[0]);return args[1]===false?r.raw:r;}if(method==='estimatesmartfee')return{feerate:0.00001};if(method==='getrawtransaction')return{confirmations:1,vout:[{value:0.001,scriptPubKey:{address:target.bitcoin.authorityHolderAddress}}]};throw Error('unexpected_'+method);};
  const ethereum=async(method,args)=>{
    if(method==='eth_chainId')return'0x1';if(method==='eth_getCode')return runtime;if(method==='eth_gasPrice')return'0x3b9aca00';if(method==='eth_estimateGas')return'0x5208';if(method==='eth_getBalance')return'0xde0b6b3a7640000';
    if(method==='eth_call'){for(const [name,value] of [['token',target.ethereum.tokenAddress],['committee',committeeAddress(publicKey)],['admin',target.ethereum.adminAddress]])if(args[0].data===calldata(name+'()',[]))return'0x'+abiWord('address',value).toString('hex');return args[0].data===calldata('decimals()',[])?'0x12':'0x0';}throw Error('unexpected_'+method);
  };
  const readRegistry=()=>readFile(target.gateway.registryFile,'utf8').then(JSON.parse);
  const reads={core,witness:core,ethereum,chainAgreement:async()=>({height:2022,hash:recorded.bitcoin.bestblockhash}),wallet:async method=>method==='getaddressinfo'?{ismine:true}:[{amount:1,confirmations:1,spendable:true,safe:true}],funding:async()=>({source:'pinned-msb-runtime',observedAt:Date.now(),feeAtoms:'100',validators:['a','b','c'],balances:{[target.trac.balance.hostAddress]:'1000000'}})};
  const factory=async({target:live,store})=>{
    const boundary=async()=>{assert.equal(live.bitcoin.chain,'main');boundaries++;},admitted=new AdmittedWrites({target:live,store,reads,boundary});
    const confirm=async()=>{confirmationWindows++;for(const id of queue){included.add(id);const text=contents.get(id);if(typeof text==='string'){const [tick,pat,fld]=text.split('.');elements.push({ins:id,tick,pat,fld:Number(fld)});}else if(text.op==='dmt-deploy')deployments.set('dmt-'+text.tick,{...text,ins:id,tick:'dmt-'+text.tick,dec:'0'});}queue.clear();};
    const provisionReads={registry:readRegistry,counted:async()=>2022,tip:async()=>({tip:2022,tipHash:recorded.bitcoin.bestblockhash}),content:async id=>contents.get(id),included:async id=>included.has(id)?{confirmations:1,height:2016,blockHash:recorded.checkpoint.checkpoint.hash}:null,
      tap:async path=>path==='getCurrentBlock'?2022:path==='getDmtElementsListLength'?elements.length:path.startsWith('getDmtElementsList?')?elements:path==='getPrivilegeAuthList'?[{ins:live.bitcoin.authorityInscription}]:path.startsWith('getPrivilegeAuthCancelled/')?false:path.startsWith('getDeployment/')?deployments.get(decodeURIComponent(path.slice(14)))??null:null};
    return{reads,boundary,committee:async()=>[],signAuthority:async digest=>{const s=secp256k1.sign(digest,key);return{r:String(s.r),s:String(s.s),v:s.recovery};},
      preflight:async stage=>({ok:true,admitted:stage==='admission'}),
      write:async(label,payload)=>{const id=hash(label)+'i0';contents.set(id,payload);included.add(id);writesCount++;if(typeof payload==='string'){const [tick,pat,fld]=payload.split('.');elements.push({ins:id,tick,pat,fld:Number(fld)});}else if(payload.op==='dmt-deploy')deployments.set('dmt-'+payload.tick,{...payload,ins:id,tick:'dmt-'+payload.tick,dec:'0'});return id;},transfer:async()=>{transfers++;},confirm,
      registry:async()=>{try{await readRegistry();}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(live.gateway.registryFile,JSON.stringify({feePolicy:createFeePolicy(live.policy.baseFeeAtoms),assets:{}}),{mode:0o600});}},
      provisioning:async privilege=>({store,network:live.network,registryPath:live.gateway.registryFile,reads:provisionReads,policy:{...policy,privilege}}),
      trac:async deployment=>{assert.equal(deployment.admin,live.trac.adminPublicKey);assert.equal(deployment.beacon.checkpoint.height,2016);await admitted.execute('registration',{rail:'trac',role:'host',count:1,packet:{subnet:'44'.repeat(32),writer:live.trac.writerPublicKey}},async()=>{registered++;return true;},async()=>registered?true:null);return{registration:{subnet:'44'.repeat(32),writable:true}};},
      artifact:async()=>artifact,ethereum,
      send:async(label,from,to,data)=>{const raw=signLegacy({nonce:'0x0',gasPrice:'0x3b9aca00',gas:'0x7530',to:to??'0x',data,chainId:'0x1'},key);return admitted.execute(label,{rail:'ethereum',role:'admin',raw},async()=>{sent.add(label);if(fail){fail=false;throw Error('injected_lost_ack');}return receipt;},async()=>sent.has(label)?receipt:null);},
      verify:async()=>{assert.equal(live.ethereum.escrowAddress,escrow);},render:async()=>{rendered++;assert.equal(Object.keys((await readRegistry()).assets).length,0);},close:async()=>{}
    };
  };
  await assert.rejects(productionLaunch(target,{factory}),/injected_lost_ack/);
  const before=writesCount,result=await productionLaunch(target,{factory});
  assert.equal(result.complete,true);assert.equal(writesCount,before);assert.equal(writesCount,1);assert.equal(transfers,1);assert.equal(registered,1);assert.equal(rendered,1);assert.ok(boundaries>=4);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(join(root,'deployed-target.json'))).runtime,'releaseAuthority'),false);
  assert.equal(Object.keys((await readRegistry()).assets).length,0);assert.equal(new Set(Object.values((await readRegistry()).assets).map(a=>a.id)).size,0);
  assert.equal(confirmationWindows,1,'owner authority is confirmed');
  // A post-deployment resume must not reopen provisioning or the Trac writer that
  // the running gateway now owns. It still checks boundaries and admission.
  const configured=await productionLaunch(target,{factory:async options=>{
    const active=await factory(options);
    for(const name of ['provisioning','trac','send','write','transfer'])active[name]=async()=>{throw Error('completed_phase_reopened_'+name);};
    return active;
  }});
  assert.equal(configured.complete,true);assert.equal(writesCount,before);assert.equal(registered,1);
  const changed=structuredClone(target);changed.ethereum.adminAddress='0x'+'ff'.repeat(20);await assert.rejects(productionLaunch(changed,{factory}),/target_changed/);
});
