import { verifyBootstrapAttestation } from '../committee/provision.mjs';
import { rpc as signerRPC } from '../committee/tss.mjs';
// Bounded local-only integration. Every remote source is an explicitly labelled
// injected fixture behind a normally verified TLS proxy; no public chain writes.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
import http from 'node:http';
import { createRequire } from 'node:module';
import { BUILD } from './safety.mjs';
import { sharedTarget } from './test-target.mjs';
import { renderTargetRuntime } from './runtime.mjs';
import { publicTarget } from './public-target.mjs';
import { productionReads } from '../service/prod/reads.mjs';
import { evidencePublisher } from '../service/prod/evidence.mjs';
import { createSigner } from '../committee/signer/service.mjs';
import { createGroup, startSidecar, stopChild, ceremony, randomHex } from '../committee/tss.mjs';
import { Store } from '../service/src/store.mjs';
import { Files } from '../service/src/files.mjs';
import { serve } from '../service/src/http.mjs';
import { rules } from '../service/src/rules.mjs';
import { edPublic } from '../service/src/util.mjs';
import { createFeePolicy } from '../service/src/fees.mjs';
import { GENESIS, MAINNET_PARAMS } from '../contract/beacon/bitcoin.js';
import { ServiceClient } from '../kit/lib/service-client.mjs';
import { create as createKit } from '../kit/lib/production-adapter.mjs';
const exec=promisify(execFile),root=await mkdtemp(join(BUILD,'rehearsal-tls-')),children=[],closers=[],originalFetch=globalThis.fetch;
const file=async(name,value)=>{const path=join(root,name);await mkdir(join(path,'..'),{recursive:true,mode:0o700});await writeFile(path,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value),{mode:0o600});return path;};
const dir=async name=>{const path=join(root,name);await mkdir(path,{recursive:true,mode:0o700});return path;};
const start=async server=>{await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});closers.push(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});return server.address().port;};
const json=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
const body=async req=>{let size=0;const parts=[];for await(const p of req){size+=p.length;assert.ok(size<=4096);parts.push(p);}return JSON.parse(Buffer.concat(parts));};
let result;
try {
  const keygenTimeout=Number(process.env.DMW_TLS_KEYGEN_TIMEOUT ?? 300);
  assert.ok(Number.isSafeInteger(keygenTimeout)&&keygenTimeout>=90&&keygenTimeout<=900,'bounded_keygen_timeout');
  const target=structuredClone(sharedTarget);target.mode='mainnet';target.network='rehearsal-tls-production-shaped';target.bitcoin.chain='main';target.ethereum.chainId='1';target.ethereum.signing='files';target.policy.baseFeeAtoms='100';
  const group=await createGroup(await dir('committee'),{prefix:'rehearsal',port:62400,network:target.network});
  for(const m of group)children.push(await startSidecar(m));
  const generated=await ceremony(group,'keygen',{network:target.network,timeout:keygenTimeout});target.committee.publicKey=generated.publicKey;
  const gatewaySecret=Buffer.from(randomHex(),'hex'),gateway=edPublic(gatewaySecret),hash='aa'.repeat(32);
  const stamp={counted:2017,tip:2022,tipHash:hash,revision:0,last:{n:0,to:2016}},deployment={network:target.network,admin:'99'.repeat(32),committee:generated.publicKey,beacon:{checkpoint:GENESIS,params:MAINNET_PARAMS}};
  Object.assign(target.trac,{bootstrap:'44'.repeat(32),msbBootstrap:'55'.repeat(32),networkId:'918',adminPublicKey:deployment.admin});target.bitcoin.checkpointHeight=0;
  const runtime=(key='66'.repeat(32))=>{
    const manager={connectedValidators:()=>['a','b','c'],pickRandomValidator:pool=>pool[0],pickRandomConnectedValidator:()=> 'a'};
    const bus={config:{bootstrap:Buffer.from(target.trac.msbBootstrap,'hex'),networkId:918},network:{validatorConnectionManager:manager,validatorMessageOrchestrator:{send:async()=>true}}};
    const api={dmwAuthority:async()=>({network:target.network,committee:generated.publicKey,admin:deployment.admin,epoch:0}),dmwHead:async()=>({counted:stamp.counted,tip:{height:stamp.tip,hash:stamp.tipHash}}),dmwBatchLast:async()=>stamp.last};
    return{peer:{wallet:{publicKey:Buffer.from(key,'hex')},config:{dmw:deployment},base:{key:Buffer.from(target.trac.bootstrap,'hex'),update:async()=>{},view:{version:0,get:async()=>null}},protocol:{instance:{api}}},bus,close:async()=>{}};
  };
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'ca.key'),'-out',join(root,'ca.pem'),'-days','1','-subj','/CN=DMW disposable root'],{maxBuffer:10000});
  await exec('openssl',['req','-newkey','rsa:2048','-nodes','-keyout',join(root,'tls.key'),'-out',join(root,'tls.csr'),'-subj','/CN=*.rehearsal.invalid'],{maxBuffer:10000});
  await file('tls.ext','subjectAltName=DNS:*.rehearsal.invalid\nextendedKeyUsage=serverAuth\n');
  await exec('openssl',['x509','-req','-in',join(root,'tls.csr'),'-CA',join(root,'ca.pem'),'-CAkey',join(root,'ca.key'),'-CAcreateserial','-out',join(root,'tls.pem'),'-days','1','-extfile',join(root,'tls.ext')],{maxBuffer:10000});
  const ca=await readFile(join(root,'ca.pem')),routes=new Map(),requests=[];let fork=false,evidenceMissing=false;
  const sourceServer=http.createServer(async(req,res)=>{try{
    const host=req.headers.host;
    if(req.url.startsWith('/r/blockhash/'))return json(res,req.url.endsWith('/0')?GENESIS.hash:hash);
    if(req.url==='/r/tap/getCurrentBlock')return json(res,{result:2022});
    const r=await body(req);requests.push({host,method:r.method});
    const value=r.method==='getblockhash'?(r.params[0]===0?GENESIS.hash:hash):r.method==='getblockchaininfo'?{chain:'main',blocks:2022,bestblockhash:fork&&host.startsWith('operator-')?'ff'.repeat(32):hash}:r.method==='eth_chainId'?'0x1':null;
    assert.ok(value!==null,'Unexpected injected RPC');json(res,{id:r.id,result:value});
  }catch{json(res,{error:'fixture_unhandled'},500);}});
  const sourcePort=await start(sourceServer);
  const proxy=https.createServer({key:await readFile(join(root,'tls.key')),cert:await readFile(join(root,'tls.pem')),minVersion:'TLSv1.2'},(req,res)=>{
    const host=req.headers.host.split(':')[0],port=routes.get(host)??sourcePort;
    if(evidenceMissing&&req.url==='/operator-evidence'){json(res,{error:'missing_evidence'},503);return;}
    const upstream=http.request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:req.headers},answer=>{res.writeHead(answer.statusCode,answer.headers);answer.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
  });
  const proxyPort=await start(proxy),origin=name=>`https://${name}.rehearsal.invalid:${proxyPort}`;
  globalThis.fetch=(input,options={})=>{
    const u=new URL(input);if(!u.hostname.endsWith('.rehearsal.invalid'))return originalFetch(input,options);
    return new Promise((resolve,reject)=>{
      const req=https.request(u,{method:options.method??'GET',headers:options.headers,ca,rejectUnauthorized:true,servername:u.hostname,lookup:(_host,opts,cb)=>opts.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4),signal:options.signal},res=>{
        const parts=[];let size=0;res.on('data',p=>{size+=p.length;if(size>8_000_000)req.destroy(Error('response_limit'));else parts.push(p);});res.on('end',()=>resolve(new Response(Buffer.concat(parts),{status:res.statusCode,headers:res.headers})));res.on('error',reject);
      });req.on('error',reject);if(options.body)req.write(options.body);req.end();
    });
  };
  const ep=async name=>({urlFile:await file(name+'.url',origin(name)),authFile:'',tokenFile:''});
  target.bitcoin.rpc={...await ep('bitcoin'),authFile:await file('bitcoin.auth','fixture:fixture')};
  target.indexer.endpoint=await ep('tap-a');target.indexer.independentEndpoint=await ep('tap-b');target.ethereum.rpc=await ep('ethereum');
  Object.assign(target.ethereum,{escrowAddress:'0x'+'22'.repeat(20),tokenAddress:'0x'+'33'.repeat(20)});
  target.trac.runtimeConfigFile=await file('trac-runtime.json',{mode:'prod'});
  Object.assign(target.runtime,{data:await dir('gateway-data'),contexts:await dir('gateway-contexts'),readerData:await dir('gateway-reader'),deploymentFile:await file('deployment.json',deployment),listenHost:'127.0.0.1',listenPort:62510,startTip:2023});
  Object.assign(target.gateway,{keyFile:await file('gateway.key',gatewaySecret.toString('hex')),registryFile:await file('registry.json',{feePolicy:createFeePolicy('100'),assets:{}}),configFile:join(root,'gateway.json')});
  Object.assign(target.public,{gateway:origin('gateway'),headerSource:origin('headers'),paymentOrigin:origin('gateway'),gatewayKey:gateway});
  for(let i=0;i<5;i++){Object.assign(target.committee.members[i],{id:group[i].id,identity:group[i].identity,encryption:group[i].encryption,signer:{...await ep('signer-'+i),tokenFile:await file('signer-'+i+'.token',randomHex())}});}
  for(const [i,m] of group.entries()){const challenge=randomHex();verifyBootstrapAttestation(await signerRPC(m.url,m.token,'/attest-bootstrap',{challenge}),{target,member:target.committee.members[i],challenge});}
  const config=await renderTargetRuntime(target),store=await Store.open(config.data);closers.push(()=>store.close());
  const reads=await productionReads(config,store,{runtime:runtime()});closers.push(()=>reads.close());
  const seal=rules.sealReceipts([],{network:target.network,tip:stamp.tip,hash},gatewaySecret);
  await store.put('receiptObservations',stamp.tip+'/'+hash,{seal,receipts:[]});await store.put('meta','gatewaySecret',gatewaySecret.toString('hex'));
  const publisher=evidencePublisher({config,store,reads,secret:gatewaySecret});
  const gatewayServer=await serve({port:0,intake:{store,head:{tip:stamp.tip}},files:new Files(join(config.data,'static')),evidence:publisher,web:{handle:async()=>false}});closers.push(()=>gatewayServer.close());routes.set('gateway.rehearsal.invalid',gatewayServer.server.address().port);
  const attestations=[];
  for(let i=0;i<5;i++){
    const m=group[i],prefix='operator-'+i,own={readerId:m.id,network:target.network,epoch:1,evidenceDirectory:await dir(prefix+'/evidence'),contexts:await dir(prefix+'/contexts'),readerData:await dir(prefix+'/reader'),
      bitcoin:{...await ep(prefix+'-bitcoin'),authFile:await file(prefix+'/bitcoin.auth','fixture:fixture')},ethereum:await ep(prefix+'-ethereum'),tap:{endpoints:[await ep(prefix+'-tap-a'),await ep(prefix+'-tap-b')]},trac:{runtimeConfig:await file(prefix+'/trac-runtime.json',{mode:'prod'})},evidence:await ep('gateway')};
    target.runtime.signerReads[i]=await file(prefix+'/reads.json',own);
    const rendered=await renderTargetRuntime(target,{signer:i,filename:join(root,prefix,'runtime.json')});
    const credentials=JSON.parse(await readFile(join(m.directory,'credentials.json'))),identity=Buffer.from(credentials.identity,'hex');
    const operatorReads=await productionReads(rendered,undefined,{runtime:runtime(),identity,gateway});closers.push(()=>operatorReads.close());
    const secrets={identity:credentials.identity,encryption:credentials.encryption,apiToken:await readFile(target.committee.members[i].signer.tokenFile,'utf8'),sidecarToken:m.token,passphrase:randomHex(),journalKey:randomHex()};
    const signer=await createSigner({id:m.id,network:target.network,epoch:1,gateway,publicKey:generated.publicKey,directory:await dir(prefix+'/signer'),sidecar:m.url,members:config.committee.map(s=>s.peer),escrow:{address:target.ethereum.escrowAddress,token:target.ethereum.tokenAddress,chainId:'1'}},secrets,operatorReads);closers.push(()=>signer.close());
    const server=http.createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer '+secrets.apiToken);json(res,await signer.handle(req.url,await body(req)));}catch(e){json(res,{error:e.message},409);}});
    routes.set('signer-'+i+'.rehearsal.invalid',await start(server));
    const reply=await fetch(origin('signer-'+i)+'/attest-root',{method:'POST',headers:{authorization:'Bearer '+secrets.apiToken,'content-type':'application/json'},body:JSON.stringify({tip:stamp.tip,hash})});const answer=await reply.json();assert.equal(reply.status,200,JSON.stringify(answer));attestations.push(answer);
    const disk=await readFile(join(own.evidenceDirectory,'evidence.json'),'utf8');assert.ok(!disk.includes(gatewaySecret.toString('hex')));
  }
  assert.ok(rules.verifyRootAttestations(seal,attestations,publicTarget(target).receiptSigners));
  const client=new ServiceClient({mode:'mainnet',origin:target.public.gateway,network:target.network,gateway,receiptSigners:publicTarget(target).receiptSigners});assert.equal((await client.health()).ok,true);
  const ownKey='66'.repeat(32),kit=await createKit({wallet:{publicKey:ownKey},network:target.network,config:publicTarget(target),runtime:runtime(ownKey)});assert.equal((await kit.trac.head()).tip.height,2022);await kit.close();
  const signerCall=()=>fetch(origin('signer-0')+'/attest-root',{method:'POST',headers:{authorization:'Bearer '+config.committee[0].token,'content-type':'application/json'},body:JSON.stringify({tip:stamp.tip,hash})});
  fork=true;let refused=await signerCall();assert.equal(refused.status,409);assert.match((await refused.json()).error,/evidence_reorg/);fork=false;
  evidenceMissing=true;refused=await signerCall();assert.equal(refused.status,409);evidenceMissing=false;
  evidenceMissing=true;refused=await fetch(origin('signer-0')+'/attest-deployment',{method:'POST',headers:{authorization:'Bearer '+config.committee[0].token,'content-type':'application/json'},body:JSON.stringify({challenge:randomHex()})});assert.equal(refused.status,409);evidenceMissing=false;
  const digest=randomHex(),signature=await ceremony(group.slice(0,3),'sign',{network:target.network,digest,timeout:60});
  const {secp256k1}=createRequire(new URL('../local/package.json',import.meta.url))('@noble/curves/secp256k1');assert.ok(secp256k1.verify(signature.compact,digest,generated.publicKey,{prehash:false,lowS:true}));
  result={ok:true,directory:root,realTLS:true,certificateValidation:true,renderer:true,productionReaders:6,operatorStores:5,signerServices:5,thresholdSignature:'3-of-5',rootAttestations:attestations.length,kit:true,reorgRefused:true,missingEvidenceRefused:true,gatewaySecretAbsent:true,sourceKind:'injected historical-height Bitcoin and synthetic Ethereum/Trac fixtures',requests:requests.length};
} finally {
  for(const close of closers.reverse())await close();
  await Promise.all(children.map(stopChild));globalThis.fetch=originalFetch;
  await writeFile(join(root,'result.json'),JSON.stringify(result??{ok:false}),{mode:0o600});console.log('Evidence: '+root);
}
console.log(JSON.stringify(result));
