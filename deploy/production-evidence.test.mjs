import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { EvidenceStore, evidencePublisher, signEvidence, projectEvidence } from '../service/prod/evidence.mjs';
import { Store } from '../service/src/store.mjs';
import { edPublic, hash } from '../service/src/util.mjs';
import { temporary, MemoryStore } from '../service/prod/test/helpers.mjs';
import { sharedTarget } from './test-target.mjs';
import { admitOperation, AdmittedWrites, decodeSignedEthereum, operationHash } from './admission.mjs';
import { signLegacy } from './ethereum-signing.mjs';
import { committeeAddress, keccak } from '../committee/signer/escrow.mjs';
import { publicVerification, metadataMultihash } from './public-verification.mjs';
const ethBlock={number:'0x10',hash:'0x'+'ab'.repeat(32)};
const require=createRequire(new URL('../local/package.json',import.meta.url));
const {secp256k1}=require('@noble/curves/secp256k1'),btc=require('@scure/btc-signer');

async function evidenceFixture(t) {
  let store,publisher; const root=await temporary(t,()=>{publisher?.close();return store?.close();}),directory=join(root,'gateway'),contexts=join(root,'contexts');await mkdir(contexts,{mode:0o700});
  store=await Store.open(directory);
  const secret=randomBytes(32),identities=Array.from({length:5},()=>randomBytes(32));
  const config={data:directory,prod:{contexts},network:'rehearsal-production-shaped',epoch:1,committee:identities.map((key,i)=>({id:'operator-'+i,peer:{identity:edPublic(key)}}))};
  const stamp={tip:2022,tipHash:'aa'.repeat(32),counted:2017,last:{n:0,to:2016},revision:1};
  let time=Date.now(),fork=false,down=false,request;
  publisher=evidencePublisher({config,store,reads:{trac:async()=>stamp},secret,now:()=>time});
  await store.put('meta','patterns',[]);await store.put('meta','gatewaySecret',secret.toString('hex'));
  await store.put('mints','mint',{id:'mint',request:{owner:'bb'.repeat(32)},receiver:'bc1-fixture',secret:secret.toString('hex'),preimage:'private-preimage'});
  const context=JSON.stringify({last:stamp.last,inputs:[]}),contextHash=hash(context);
  await writeFile(join(contexts,contextHash+'.json'),context,{mode:0o600});
  await store.put('evidenceContexts','1',{path:contextHash+'.json',hash:contextHash});
  const operators=[];
  for(let i=0;i<5;i++) {
    const dir=join(root,'operator-'+i);await mkdir(dir,{mode:0o700});
    operators.push(await EvidenceStore.open({config:{directory:dir,member:'operator-'+i,network:config.network,epoch:1},identity:identities[i],gateway:edPublic(secret),
      now:()=>time,clock:async()=>({tip:stamp.tip,tipHash:fork?'ff'.repeat(32):stamp.tipHash}),stamp:async()=>stamp,
      source:{request:async(_path,{body})=>{if(down)throw Error('missing_evidence');request=body;return publisher(body);}}}));
  }
  t.after(()=>Promise.all(operators.map(o=>o.close())));
  return {root,store,operators,publisher,stamp,secret,identities,request:()=>request,advance:n=>{time+=n;},fork:()=>{fork=true;},down:()=>{down=true;}};
}
test('five isolated operator stores receive authenticated evidence without gateway credentials',async t=>{
  const f=await evidenceFixture(t);
  for(const operator of f.operators){await operator.refresh();const row=await operator.get('mints','mint');assert.equal(row.id,'mint');assert.equal(await operator.get('meta','gatewaySecret'),null);assert.equal((await operator.context(1)).last.n,0);const disk=await readFile(join(operator.config.directory,'evidence-checkpoint.json'),'utf8');assert.ok(!JSON.stringify(row).includes(f.secret.toString('hex')));assert.ok(!JSON.stringify(row).includes('private-preimage'));assert.ok(!disk.includes(f.secret.toString('hex')));assert.ok(!disk.includes('private-preimage'));}
  assert.equal(new Set(f.operators.map(o=>o.config.directory)).size,5);
});
test('evidence rejects unauthenticated operators, replay, wrong network and malformed scopes',async t=>{
  const f=await evidenceFixture(t);await f.operators[0].refresh();const request=f.request();
  await assert.rejects(f.publisher(request),/replay/);
  await assert.rejects(f.publisher({...request,signature:'00'.repeat(64)}),/authentication/);
  await assert.rejects(f.publisher({...request,network:'other'}),/version/);
  assert.throws(()=>projectEvidence('gatewayKeys','key',{}),/space/);
});
test('missing evidence, stale snapshots and same-height reorgs fail closed and clear old evidence',async t=>{
  const f=await evidenceFixture(t),o=f.operators[0];await assert.rejects(o.get('meta','patterns'),/missing/);await o.refresh();f.advance(30001);await assert.rejects(o.get('meta','patterns'),/stale/);
  await o.refresh();f.fork();await assert.rejects(o.refresh(),/reorg/);await assert.rejects(o.get('meta','patterns'),/missing/);f.down();await assert.rejects(o.refresh(),/missing_evidence/);
});
test('evidence rejects secret-bearing requested records and oversized response pages',async t=>{
  const f=await evidenceFixture(t);await f.store.put('finds','x',{gatewaySecret:'do-not-export'});await f.operators[0].refresh();await assert.rejects(f.operators[0].get('finds','x'),/secret_field/);await f.store.put('finds','x');
  // Oversized wire envelopes are rejected independently of producer limits.
  const o=f.operators[0];o.source={request:async(_p,{body})=>{const payload={version:2,network:body.network,epoch:body.epoch,member:body.member,nonce:body.nonce,query:body.query,result:{bytes:'x'.repeat(o.settings.pageBytes)}};return{payload,signature:signEvidence(payload,f.secret)};}};
  await assert.rejects(o.refresh(),/page_bytes/);
});

function costFixture() {
  const target=structuredClone(sharedTarget);target.mode='mainnet';target.bitcoin.chain='main';target.ethereum.chainId='1';target.bitcoin.checkpointHeight=2016;
  const key=Buffer.alloc(32,7);target.ethereum.adminAddress=committeeAddress(Buffer.from(secp256k1.getPublicKey(key)).toString('hex'));
  const raw=signLegacy({nonce:'0x0',gasPrice:'0x3b9aca00',gas:'0x7530',to:'0x'+'11'.repeat(20),data:'0xabcdef',chainId:'0x1'},key);
  let funds=10n**18n,price=1000000000n,chain=true;
  const reads={chainAgreement:async()=>{assert.ok(chain,'chain_changed');return{height:2022,hash:'aa'.repeat(32)};},ethereum:async method=>method==='eth_gasPrice'?'0x'+price.toString(16):method==='eth_estimateGas'?'0x5208':'0x'+funds.toString(16)};
  return{target,raw,reads,poor:()=>{funds=1n;},expensive:()=>{price=2_000_000_000n;},wrongChain:()=>{chain=false;}};
}
test('admission decodes exact EIP-155 bytes and refuses sender, chain, gas and live funding substitutions',async()=>{
  const f=costFixture(),op={rail:'ethereum',role:'admin',raw:f.raw};assert.equal(decodeSignedEthereum(f.raw).from,f.target.ethereum.adminAddress);
  const result=await admitOperation(f.target,op,f.reads);assert.equal(result.operationHash,operationHash(op));assert.equal(result.requirements.ethereumAdminWei,'30000000000000');
  await assert.rejects(admitOperation(f.target,{...op,role:'payer'},f.reads),/role/);f.expensive();await assert.rejects(admitOperation(f.target,op,f.reads),/fee/);
  const poor=costFixture();poor.poor();await assert.rejects(admitOperation(poor.target,op,poor.reads),/funds/);
  f.wrongChain();await assert.rejects(admitOperation(f.target,op,f.reads),/chain_changed/);
});
test('interrupted writes reconcile exact operations without double submission and recheck admission before retry',async()=>{
  const f=costFixture(),store=new MemoryStore(),op={rail:'ethereum',role:'admin',raw:f.raw};let sends=0,accepted=false,boundaries=0;
  const make=()=>new AdmittedWrites({target:f.target,reads:f.reads,store,boundary:async()=>{boundaries++;}});
  await assert.rejects(make().execute('escrow',op,async()=>{sends++;accepted=true;throw Error('lost_ack');},async()=>null),/lost_ack/);
  assert.equal(await make().execute('escrow',op,async()=>{sends++;},async()=>accepted?'receipt':null),'receipt');assert.equal(sends,1);assert.equal(boundaries,1);
  await assert.rejects(make().execute('escrow',{...op,raw:op.raw+'00'},async()=>{}),/changed/);
  f.poor();await assert.rejects(make().execute('new',op,async()=>{sends++;}),/funds/);assert.equal(sends,1);
});
test('the launch runner rejects Bitcoin spending plans',async()=>{
  const f=costFixture();await assert.rejects(admitOperation(f.target,{rail:'bitcoin',transactions:[]},f.reads),/trac_plan/);
});
test('cumulative admission preserves spent budgets after confirmation and rejects over-budget retries',async()=>{
  const f=costFixture(),store=new MemoryStore(),op={rail:'ethereum',role:'admin',raw:f.raw};
  f.target.funding.ethereumAdminWei='50000000000000';let sends=0;
  const writes=new AdmittedWrites({target:f.target,reads:f.reads,store,boundary:async()=>{}});
  await writes.execute('first',op,async()=>{sends++;return true;});
  await writes.execute('first',op,async()=>{sends++;},async()=>true);
  assert.equal(store.get('launchWrites','first').admission.requirements.ethereumAdminWei,'30000000000000');
  await assert.rejects(writes.execute('second',op,async()=>{sends++;}),/cumulative_budget/);
  assert.equal(sends,1);
});
test('Trac admission binds paid packet and fresh fee observations to the funded role',async()=>{
  const f=costFixture();f.target.trac.balance.hostAddress='host';
  f.reads.funding=async()=>({source:'pinned-msb-runtime',observedAt:Date.now(),validators:['a','b','c'],feeAtoms:'100',balances:{host:'10000'}});
  const op={rail:'trac',role:'host',packet:{signed:'packet'},count:1},r=await admitOperation(f.target,op,f.reads);assert.equal(r.fees.packetHash,operationHash(op.packet));assert.equal(r.requirements.tnkHostAtoms,'100');
  f.reads.funding=async()=>({source:'supplied-receipt'});await assert.rejects(admitOperation(f.target,op,f.reads),/observation/);
});
test('public verification retrieves pinned compiler artifacts and rejects supplied flags, tampering and wrong implementation',async t=>{
  const root=await temporary(t),target=structuredClone(sharedTarget);target.ethereum.chainId='1';target.ethereum.escrowAddress='0x'+'11'.repeat(20);target.ethereum.tokenAddress='0x'+'22'.repeat(20);
  const content='contract Fixture {}',input={language:'Solidity',sources:{'Fixture.sol':{content}},settings:{optimizer:{enabled:true,runs:200},metadata:{bytecodeHash:'ipfs'}}};
  const artifact={metadata:{compiler:{version:'fixture'},sources:{'Fixture.sol':{keccak256:'0x'+Buffer.from(keccak(Buffer.from(content))).toString('hex')}},settings:input.settings},deployedBytecode:{object:'0x'+'60006000'.repeat(40),immutableReferences:{}}};
  artifact.rawMetadata=JSON.stringify(artifact.metadata);
  const trailer='a164697066735822'+metadataMultihash(artifact.rawMetadata);
  artifact.deployedBytecode.object+=''+trailer+(trailer.length/2).toString(16).padStart(4,'0');
  const code=artifact.deployedBytecode.object;
  const files=new Map();const write=async(name,value)=>{const p=join(root,name),bytes=Buffer.from(JSON.stringify(value));await writeFile(p,bytes,{mode:0o600});files.set('https://verify.invalid/'+name,bytes);return p;};
  const artifactFile=await write('artifact.json',artifact),inputFile=await write('input.json',input);
  for(const role of ['source','token'])target.ethereum[role+'VerificationFile']=await write(role+'.json',{chainId:'1',address:role==='source'?target.ethereum.escrowAddress:target.ethereum.tokenAddress,verified:true,artifactFile,inputFile,artifactURL:'https://verify.invalid/artifact.json',inputURL:'https://verify.invalid/input.json',artifactSHA256:hash(await readFile(artifactFile)),inputSHA256:hash(await readFile(inputFile)),runtimeSHA256:hash(code)});
  const reads={ethereum:async method=> method==='eth_getBlockByNumber'?ethBlock:method==='eth_call'?'0x12':code},options={fetchBytes:async url=>files.get(url)};
  assert.equal((await publicVerification(target,reads,options)).length,2);
  assert.equal((await publicVerification(target,reads,{...options,sourceArtifactHash:operationHash(artifact)})).length,2);
  await assert.rejects(publicVerification(target,reads,{...options,sourceArtifactHash:'00'.repeat(32)}),/launch_artifact/);
  files.set('https://verify.invalid/input.json',Buffer.from('{}'));await assert.rejects(publicVerification(target,reads,options),/publication/);
  files.set('https://verify.invalid/input.json',await readFile(inputFile));reads.ethereum=async method=>method==='eth_getBlockByNumber'?ethBlock:'0x'+'60016000'.repeat(40);await assert.rejects(publicVerification(target,reads,options),/runtime_pin/);
  const implementation='0x'+'33'.repeat(20),proxy='0x363d3d373d3d3d363d73'+implementation.slice(2)+'5af43d82803e903d91602b57fd5bf3';
  const tokenReceipt=JSON.parse(await readFile(target.ethereum.tokenVerificationFile));
  Object.assign(tokenReceipt,{implementation,proxyKind:'eip1167',proxyRuntimeSHA256:hash(proxy)});
  await writeFile(target.ethereum.tokenVerificationFile,JSON.stringify(tokenReceipt),{mode:0o600});
  reads.ethereum=async(method,args)=>method==='eth_getBlockByNumber'?ethBlock:method==='eth_call'?'0x12':args[0]===target.ethereum.tokenAddress?proxy:code;
  assert.equal((await publicVerification(target,reads,options))[1].codeAddress,implementation);
  const stable=reads.ethereum;reads.ethereum=async(method,args)=>method==='eth_getBlockByNumber'&&args[0]!=='latest'?{...ethBlock,hash:'0x'+'cd'.repeat(32)}:stable(method,args);
  await assert.rejects(publicVerification(target,reads,options),/verification_reorg/);reads.ethereum=stable;
  tokenReceipt.implementation='0x'+'44'.repeat(20);await writeFile(target.ethereum.tokenVerificationFile,JSON.stringify(tokenReceipt),{mode:0o600});
  await assert.rejects(publicVerification(target,reads,options),/verification_proxy/);
});
test('actual solc 0.8.26 output verifies its UnixFS metadata and published standard input',async t=>{
  const root=await temporary(t),fixture=JSON.parse(await readFile(new URL('./fixtures/verification-compiler.json',import.meta.url)));
  const target=structuredClone(sharedTarget);target.ethereum.chainId='1';
  target.ethereum.escrowAddress='0x'+'11'.repeat(20);target.ethereum.tokenAddress='0x'+'22'.repeat(20);
  // Foundry emits these explicit defaults; solc omits them from rawMetadata.
  const input=structuredClone(fixture.input);
  Object.assign(input.settings.metadata,{appendCBOR:true,useLiteralContent:false});
  const artifactBytes=Buffer.from(JSON.stringify(fixture.artifact));let inputBytes=Buffer.from(JSON.stringify(input));
  const artifactFile=join(root,'artifact.json'),inputFile=join(root,'input.json');
  await writeFile(artifactFile,artifactBytes,{mode:0o600});await writeFile(inputFile,inputBytes,{mode:0o600});
  const code='0x'+fixture.artifact.deployedBytecode.object;
  for(const role of ['source','token']) {
    const path=join(root,role+'.json');target.ethereum[role+'VerificationFile']=path;
    await writeFile(path,JSON.stringify({chainId:'1',address:target.ethereum[role==='source'?'escrowAddress':'tokenAddress'],artifactFile,inputFile,artifactURL:'https://verify.invalid/artifact',inputURL:'https://verify.invalid/input',artifactSHA256:hash(artifactBytes),inputSHA256:hash(inputBytes),runtimeSHA256:hash(code)}),{mode:0o600});
  }
  const result=await publicVerification(target,{ethereum:async method=>method==='eth_getBlockByNumber'?ethBlock:method==='eth_call'?'0x12':code},{sourceArtifactHash:operationHash(fixture.artifact),fetchBytes:async url=>url.endsWith('/artifact')?artifactBytes:inputBytes});
  assert.equal(result.length,2);assert.equal(JSON.parse(fixture.artifact.rawMetadata).compiler.version,'0.8.26+commit.8a97fa7a');
  assert.notEqual(metadataMultihash(fixture.artifact.rawMetadata),'1220'+hash(fixture.artifact.rawMetadata));
  for(const [key,value] of [['appendCBOR',false],['useLiteralContent',true]]) {
    const changed=structuredClone(input);changed.settings.metadata[key]=value;
    inputBytes=Buffer.from(JSON.stringify(changed));await writeFile(inputFile,inputBytes);
    for(const role of ['source','token']) {
      const path=target.ethereum[role+'VerificationFile'],receipt=JSON.parse(await readFile(path));
      receipt.inputSHA256=hash(inputBytes);await writeFile(path,JSON.stringify(receipt));
    }
    await assert.rejects(publicVerification(target,{ethereum:async method=>method==='eth_getBlockByNumber'?ethBlock:method==='eth_call'?'0x12':code},
      {fetchBytes:async url=>url.endsWith('/artifact')?artifactBytes:inputBytes}),/verification_settings/);
  }
});
