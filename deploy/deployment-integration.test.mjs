import { signEvidence } from '../service/prod/evidence.mjs';
import { rosterHash } from '../committee/provision.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,chmod,realpath,mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {sharedTarget} from './test-target.mjs';import {playgroundTarget} from './playground-target.mjs';import {targetReads,msbFunding} from './reads.mjs';import {publicTarget,validatePublicTarget} from './public-target.mjs';import {renderTargetRuntime} from './runtime.mjs';
import {configFixture} from '../service/prod/test/helpers.mjs';import {ServiceClient} from '../kit/lib/service-client.mjs';import {edPublic} from '../service/src/util.mjs';import {encodeTracAddress} from '../rules/src/trac-address.js';import {provisionOperator,operatorAttestation,verifyOperatorAttestation} from '../committee/provision.mjs';
const recorded=JSON.parse(await readFile(new URL('./fixtures/production-reads.json',import.meta.url)));
async function fixture(t){
 const {config:c,file,root,deployment}=await configFixture(t),target=structuredClone(sharedTarget);target.mode='mainnet';target.network=c.network;target.bitcoin.chain='main';target.ethereum.chainId='1';target.ethereum.signing='files';
 target.policy.baseFeeAtoms='100';target.committee.publicKey=deployment.committee;target.trac.adminPublicKey=deployment.admin;target.bitcoin.checkpointHeight=deployment.beacon.checkpoint.height;
 Object.assign(target.runtime,{data:c.data,contexts:c.prod.contexts,readerData:c.prod.readerData,deploymentFile:c.prod.deployment,listenHost:c.listen.host,listenPort:c.listen.port,startTip:c.prod.startTip});
 Object.assign(target.gateway,{keyFile:c.gatewayKey,registryFile:c.prod.registry,configFile:join(root,'rendered.json')});
 target.bitcoin.rpc=c.prod.bitcoin;delete target.bitcoin.rpc.kind;target.bitcoin.rpc={authFile:'',tokenFile:'',...target.bitcoin.rpc};
 target.indexer.endpoint={authFile:'',tokenFile:'',...c.prod.tap.endpoints[0]};target.indexer.independentEndpoint={urlFile:'',authFile:'',tokenFile:''};
 Object.assign(target.ethereum,{rpc:{urlFile:c.prod.ethereum.urlFile,authFile:'',tokenFile:''},escrowAddress:c.prod.ethereum.address,tokenAddress:c.prod.ethereum.token});
 Object.assign(target.trac,{bootstrap:c.prod.trac.bootstrap,msbBootstrap:c.prod.trac.msbBootstrap,networkId:String(c.prod.trac.networkId),runtimeConfigFile:c.prod.trac.runtimeConfig});
 for(const [i,m]of target.committee.members.entries()){m.id='member-'+(i+1);m.identity=edPublic(Buffer.alloc(32,i+3));m.encryption=String(i+1).padStart(64,'0');m.signer={urlFile:await file('signer-url-'+i,`https://member-${i+1}.invalid`),tokenFile:await file('signer-token-'+i,'fixture-token-'+i),authFile:''};}
 Object.assign(target.public,{gateway:'https://dmtworld.much.fun',headerSource:'https://dmtworld.much.fun',paymentOrigin:'https://dmtworld.much.fun',gatewayKey:edPublic(Buffer.alloc(32,1))});
 return{target,c,file,root};
}

test('target drives lifecycle topology before startup and refuses production spawning',async t=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'deployment-target-')));t.after(()=>rm(dir,{recursive:true,force:true}));const target=structuredClone(sharedTarget);target.local.playground.ports.control=61000;target.local.playground.dataDirectory=join(dir,'state');const file=join(dir,'target.json');await writeFile(file,JSON.stringify(target));
 const loaded=await playgroundTarget({filename:file});assert.equal(loaded.ports.control,61000);assert.equal(loaded.data,target.local.playground.dataDirectory);
 const urlFile=join(dir,'bitcoin.url');await writeFile(urlFile,'http://127.0.0.1:61100',{mode:0o600});target.bitcoin.rpc={urlFile,authFile:join(dir,'cookie-absent-while-stopped'),tokenFile:''};await writeFile(file,JSON.stringify(target));assert.equal((await playgroundTarget({filename:file})).ports.bitcoin,61100);
 target.mode='mainnet';await writeFile(file,JSON.stringify(target));await assert.rejects(playgroundTarget({filename:file}),/local_target/);
});
test('private runtime renders target policies and uses explicit production dispatch',async t=>{
 const {target,root}=await fixture(t);const config=await renderTargetRuntime(target);assert.equal(config.mode,'prod');assert.equal(config.adapter,fileURLToPath(new URL('../service/prod/adapter.mjs',import.meta.url)));assert.equal(config.prod.ethereum.signerKeyFile,undefined);assert.equal(config.prod.ethereum.confirmations,target.policy.ethereumConfirmations);assert.equal(config.epoch,target.committee.epoch);assert.equal(config.committee[0].peer.identity,target.committee.members[0].identity);
 assert.equal((await import('../service/src/config.mjs')).loadConfig instanceof Function,true);assert.equal((await (await import('../service/src/config.mjs')).loadConfig(target.gateway.configFile)).mode,'prod');
 target.indexer.independentEndpoint={urlFile:'',authFile:'',tokenFile:''};const single=await renderTargetRuntime(target,{persist:false});assert.equal(single.prod.tap.agreement,1);
 await chmod(target.gateway.keyFile,0o644);await assert.rejects(renderTargetRuntime(target),/0600|private_permissions/);
});
test('public projection excludes every private target slot and keeps independent identity pins',async t=>{
 const {target}=await fixture(t);const result=publicTarget(target);validatePublicTarget(result);const text=JSON.stringify(result);for(const value of [target.gateway.keyFile,target.ethereum.rpc.urlFile,target.indexer.endpoint.urlFile,'tokenFile','runtimeConfigFile'])assert.ok(!text.includes(value));assert.ok(result.receiptSigners.every(s=>s.address.startsWith('trac1')));assert.throws(()=>validatePublicTarget({...result,privateEndpoint:'secret'}));assert.throws(()=>publicTarget({...target,public:{...target.public,gateway:'http://gateway.invalid'}}));
 const client=new ServiceClient({mode:'mainnet',origin:result.gateway,network:result.network,gateway:result.gatewayKey,receiptSigners:result.receiptSigners,fetchImpl:async()=>Response.json({ok:true})});assert.ok((await client.health()).ok);assert.match(client.paymentLink('11'.repeat(32)),/^https:/);
});
test('Core/indexer agreement uses production-shaped records and refuses divergence without write RPCs',async t=>{
 const {target}=await fixture(t);let divergent=false,tls=0;const called=[];
 const adapter=await targetReads(target,{resolveEndpoint:async spec=>({url:(await readFile(spec.urlFile,'utf8')).trim(),headers:{}}),tlsProbe:async()=>{tls++;return{valid:true};},sourceFactory:(name)=>({request:async(path,{body}={})=>{
  if(body){called.push(body.method);let result;if(body.method==='getblockchaininfo')result=recorded.bitcoin;else if(body.method==='getblockhash')result=body.params[0]===0?recorded.genesis:recorded.bitcoin.bestblockhash;else if(body.method==='eth_chainId')result=recorded.ethereum.chainId;else throw Error('unexpected RPC');return{id:body.id,result};}
  if(path==='/r/tap/getCurrentBlock')return{result:recorded.bitcoin.blocks};if(path==='/r/blockhash/0')return recorded.genesis;return divergent&&name==='indexer'?'00'.repeat(32):recorded.bitcoin.bestblockhash;
 }})});assert.equal((await adapter.chainAgreement()).height,recorded.bitcoin.blocks);assert.ok(tls>=2);divergent=true;await assert.rejects(adapter.chainAgreement(),/disagreement/);assert.throws(()=>adapter.core('sendrawtransaction',[]),/read_only/);assert.ok(called.every(m=>!m.includes('send')));
});
test('MSB reads bind network, own trac1 funding accounts and current runtime fees',async()=>{
 const target=structuredClone(sharedTarget);target.trac.msbBootstrap=recorded.msb.bootstrap;target.trac.networkId=recorded.msb.networkId;target.trac.balance.hostAddress=encodeTracAddress('01'.repeat(32));target.trac.balance.writerAddress=encodeTracAddress('02'.repeat(32));let wrong=false;
 const bytes=n=>Buffer.from(BigInt(n).toString(16).padStart(32,'0'),'hex');const runtime={bus:{config:{get bootstrap(){return Buffer.from(wrong?'00'.repeat(32):target.trac.msbBootstrap,'hex');},networkId:918},state:{getNodeEntry:async()=>({balance:bytes(recorded.msb.balanceAtoms)}),getFee:()=>bytes(recorded.msb.feeAtoms)},network:{validatorConnectionManager:{connectedValidators:()=>['a','b','c']}}}};
 const funds=await msbFunding(target,runtime);assert.equal(funds.feeAtoms,recorded.msb.feeAtoms);assert.equal(Object.keys(funds.balances).length,2);wrong=true;await assert.rejects(msbFunding(target,runtime),/msb_network/);
});
test('operator attestation rejects target epoch, roster and identity substitutions',async t=>{
 const {target,root}=await fixture(t);const directory=join(root,'operator'),member=await provisionOperator({directory,id:'operator-1',url:'http://127.0.0.1:61234',network:target.network});target.committee.members[0]={...target.committee.members[0],...member};target.committee.publicKey='02'+'01'.repeat(32);const secret=JSON.parse(await readFile(join(directory,'credentials.json'))),challenge='11'.repeat(32),config={id:member.id,network:target.network,epoch:target.committee.epoch,members:target.committee.members};
 const answer=operatorAttestation(config,secret.identity,target.committee.publicKey,challenge);verifyOperatorAttestation(answer,{target,member,challenge});assert.throws(()=>verifyOperatorAttestation({...answer,epoch:2},{target,member,challenge}));assert.throws(()=>verifyOperatorAttestation(answer,{target,member,challenge:'22'.repeat(32)}));
});
test('client retries one pre-response read reset, never repeats a submission',async()=>{
 let calls=0;const client=new ServiceClient({origin:'http://127.0.0.1:12345',fetchImpl:async()=>{if(++calls===1)throw Object.assign(Error('reset'),{cause:{code:'ECONNRESET'}});return Response.json({ok:true});}});assert.ok((await client.health()).ok);assert.equal(calls,2);calls=0;await assert.rejects(client.request('/moves',{value:{}}));assert.equal(calls,1);
});

test('historical boundary read agrees independently and rejects a substituted witness',async()=>{
 const {checkpointPhase}=await import('./phases.mjs');let corrupt=false;
 const rpc=witness=>async(method,args=[])=>{if(method==='getblockcount')return recorded.bitcoin.blocks;if(method==='getblockhash')return recorded.headers[String(args[0])].hash;if(method==='getblockheader'){const row=Object.values(recorded.headers).find(r=>r.hash===args[0]);return args[1]===false?(witness&&corrupt?recorded.headers['2022'].raw:row.raw):row;}throw Error('unexpected RPC');};
 assert.deepEqual(await checkpointPhase({height:2016,primary:rpc(false),witness:rpc(true)}),recorded.checkpoint);corrupt=true;await assert.rejects(checkpointPhase({height:2016,primary:rpc(false),witness:rpc(true)}),/checkpoint/);
});

test('production kit checks the agent writer and every independent Trac pin without localOnly',async t=>{
 const {target}=await fixture(t),{create}=await import('../kit/lib/production-adapter.mjs'),{MAINNET_PARAMS}=await import('../contract/beacon/bitcoin.js'),{agent}=await import('../service/test/helpers.mjs');
 const config=publicTarget(target),who=agent(41);let closed=0;
 const runtime=()=>({
   peer:{
     wallet:{publicKey:Buffer.from(who.address,'hex')},
     config:{dmw:{network:target.network,admin:target.trac.adminPublicKey,committee:target.committee.publicKey,beacon:{params:MAINNET_PARAMS}}},
     base:{key:Buffer.from(target.trac.bootstrap,'hex')},
     protocol:{instance:{api:{dmwHead:async()=>({counted:2016,tip:{height:2022,hash:recorded.bitcoin.bestblockhash}}),dmwAuthority:async()=>({network:target.network,paused:false})}}}
   },
   bus:{config:{bootstrap:Buffer.from(target.trac.msbBootstrap,'hex'),networkId:Number(target.trac.networkId)},network:{validatorConnectionManager:{connectedValidators:()=>['a','b','c'],pickRandomValidator:pool=>pool[0],pickRandomConnectedValidator:()=> 'a'},validatorMessageOrchestrator:{send:async()=>true}}},
   close:async()=>{closed++;}
 });
 const own={publicKey:who.address};const adapter=await create({wallet:own,network:target.network,config,runtime:runtime()});assert.equal((await adapter.trac.head()).tip.height,2022);await adapter.close();
 const wrong=runtime();wrong.bus.config.bootstrap=Buffer.alloc(32);await assert.rejects(create({wallet:own,network:target.network,config,runtime:wrong}),/Pinned Trac/);const other=runtime();other.peer.wallet.publicKey=Buffer.alloc(32);await assert.rejects(create({wallet:own,network:target.network,config,runtime:other}),/writer/);assert.equal(closed,3);
});

test('production preparation never grants post-deploy admission',async t=>{
 const {target,file}=await fixture(t),{productionPreflight}=await import('./production-preflight.mjs'),{createRequire}=await import('node:module');
 const require=createRequire(new URL('../local/package.json',import.meta.url)),{secp256k1}=require('@noble/curves/secp256k1'),btc=require('@scure/btc-signer'),{committeeAddress}=await import('../committee/signer/escrow.mjs');
 for(const role of ['funding','treasury','authorityHolder'])target.bitcoin[role+'Address']=btc.p2tr(secp256k1.getPublicKey(Buffer.alloc(32,7),true).slice(1)).address;
 for(const [i,role]of ['admin'].entries()){const key=Buffer.alloc(32,i+8);target.ethereum[role+'KeyFile']=await file(role+'-private',key.toString('hex'));target.ethereum[role+'Address']=committeeAddress(Buffer.from(secp256k1.getPublicKey(key)).toString('hex'));}target.ethereum.treasuryAddress=target.ethereum.adminAddress;
 target.trac.hostAdminPublicKey='11'.repeat(32);target.trac.writerPublicKey='22'.repeat(32);for(const [role,key]of [['host','hostAdminPublicKey'],['writer','writerPublicKey']])target.trac.balance[role+'Address']=encodeTracAddress(target.trac[key]);
 const costs={bitcoin:['privilege-authority','privilege-authority-activation'].map(label=>({label,vbytes:100,postageSats:'10000'})),ethereum:['escrow-deploy','smoke-release','smoke-approve','smoke-deposit'].map(label=>({label,gas:100})),trac:{registrationAtomic:'1'}};
 target.paths.costsFile=await file('costs',costs);target.paths.costsSHA256=(await import('../service/src/util.mjs')).hash(await readFile(target.paths.costsFile));
 for(const key of Object.keys(target.funding))target.funding[key]='1000000000000000000';target.funding.bitcoinSats='1000000';target.funding.bitcoinReserveSats='10000';target.bitcoin.estimateFeeRate=2;target.ethereum.estimateGasPriceGwei='1';target.bitcoin.checkpointHeight=2016;target.bitcoin.checkpointFile=await file('checkpoint',recorded.checkpoint);
 const core=async(method,args=[])=>method==='getblockcount'?2022:method==='getblockhash'?recorded.headers[String(args[0])].hash:args[1]===false?Object.values(recorded.headers).find(r=>r.hash===args[0]).raw:Object.values(recorded.headers).find(r=>r.hash===args[0]);
 const reads={endpoints:{bitcoin:{url:'https://primary.invalid'},witness:{url:'https://witness.invalid'}},core,witness:core,chainAgreement:async()=>({height:2022}),wallet:async method=>method==='getaddressinfo'?{ismine:true}:[{amount:1,spendable:true,safe:true,confirmations:6}],ethereum:async()=> '0x'+(10n**20n).toString(16),funding:async()=>({source:'pinned-msb-runtime',observedAt:Date.now(),feeAtoms:'1',validators:['a','b','c'],balances:Object.fromEntries(['host','writer'].map(r=>[target.trac.balance[r+'Address'],'1000000000000000000']))}),sidecar:async(m,path,{challenge})=>{const body={domain:'dmw-bootstrap-attestation-v1',challenge,network:target.network,epoch:target.committee.epoch,id:m.id,publicKey:target.committee.publicKey,roster:rosterHash(target.committee.members)};return{...body,signature:signEvidence(body,Buffer.alloc(32,target.committee.members.findIndex(v=>v.id===m.id)+3))};},signer:async(m,path,{challenge})=>operatorAttestation({id:m.id,network:target.network,epoch:target.committee.epoch,members:target.committee.members},Buffer.alloc(32,target.committee.members.findIndex(v=>v.id===m.id)+3).toString('hex'),target.committee.publicKey,challenge)};
 const prep=await productionPreflight(target,{reads});assert.equal(prep.ok,true,JSON.stringify(prep.checks.filter(c=>!c.ok)));assert.equal(prep.admitted,false);assert.ok(!prep.checks.some(c=>c.name.includes('Escrow code')));
 const one=structuredClone(target);one.bitcoin.witnessRpc={urlFile:'',authFile:'',tokenFile:''};one.indexer.independentEndpoint={urlFile:'',authFile:'',tokenFile:''};one.trac.adminPublicKey=one.trac.hostAdminPublicKey;
 const single=await productionPreflight(one,{reads:{...reads,witness:undefined}});assert.equal(single.ok,true,JSON.stringify(single.checks.filter(c=>!c.ok)));assert.equal(single.admitted,false);
 one.trac.writerPublicKey=one.trac.hostAdminPublicKey;one.trac.balance.writerAddress=one.trac.balance.hostAddress;
 assert.equal((await productionPreflight(one,{reads:{...reads,witness:undefined}})).ok,false,'writer role remains separate');
 const fundedEthereum=reads.ethereum;
 reads.ethereum=async(method,args)=>method==='eth_call'?'0x0':fundedEthereum(method,args);
 const unfunded=await productionPreflight(target,{reads});
 assert.deepEqual(unfunded.checks.filter(c=>!c.ok).map(c=>c.name),[]);
 assert.equal(unfunded.admitted,false);reads.ethereum=fundedEthereum;
 const admission=await productionPreflight(target,{reads,stage:'admission'});assert.equal(admission.ok,false);assert.equal(admission.admitted,false);assert.ok(admission.checks.some(c=>c.name==='Escrow code and authorities'&&!c.ok));
});

test('production-shaped estimates retain signed bytes, cancellation, paid fallback and provenance',async()=>{
 const {productionEstimate}=await import('./costs.mjs'),{createRequire}=await import('node:module'),require=createRequire(new URL('../local/package.json',import.meta.url)),btc=require('@scure/btc-signer'),{secp256k1}=require('@noble/curves/secp256k1');const key=Buffer.alloc(32,17),payment=btc.p2wpkh(secp256k1.getPublicKey(key)),tx=new btc.Transaction();tx.addInput({txid:'aa'.repeat(32),index:0,witnessUtxo:{script:payment.script,amount:100000n}});tx.addOutput({script:payment.script,amount:90000n});tx.sign(key);tx.finalize();const signed=tx.hex;const target=structuredClone(sharedTarget);target.mode='mainnet';target.ethereum.chainId='1';
 const input={target,signedBitcoin:[{label:'fixture-only',transactions:[signed],cancellations:[signed],postageSats:'10000'}],ethereum:[{label:'fixture',chainId:'1',gas:21000,gasPriceWei:'1000000000'}],msb:{feeAtoms:'100',registrationOperations:2,paidFallbackOperations:3},localBaseline:{artifact:'measured-regtest'},provenance:{chain:'main',chainId:'1',observedAt:100000,confirmations:6,tipHash:recorded.bitcoin.bestblockhash},now:100001};
 const estimate=productionEstimate(input);assert.equal(estimate.kind,'production-estimate');assert.equal(estimate.trac.paidFallbackAtoms,'300');assert.equal(estimate.bitcoin[0].cancellationReserveSats,'0');assert.equal(estimate.localBaseline.artifact,'measured-regtest');assert.throws(()=>productionEstimate({...input,now:160001}),/stale/);
});

test('operator rendering uses its own readers and never opens other operators credentials',async t=>{
 const {target,root,file}=await fixture(t),ownDir=async name=>{const p=join(root,name);await mkdir(p,{mode:0o700});return p;};
 for(const member of target.committee.members)member.signer.tokenFile=join(root,'not-on-this-host');
 const ep=async name=>({urlFile:await file(name+'-url','https://'+name+'.invalid'),authFile:'',tokenFile:''});
 const own={readerId:target.committee.members[0].id,network:target.network,epoch:target.committee.epoch,evidenceDirectory:await ownDir('own-evidence'),contexts:await ownDir('own-contexts'),readerData:await ownDir('own-cache'),bitcoin:await ep('own-bitcoin'),ethereum:await ep('own-ethereum'),tap:{endpoints:[await ep('own-tap-a')]},trac:{runtimeConfig:await file('own-trac',{})}};
 await writeFile(own.tap.endpoints[0].urlFile,await readFile(own.bitcoin.urlFile));
 target.runtime.signerReads[0]=await file('own-reads',own);await assert.rejects(renderTargetRuntime(target,{signer:0,persist:false}),/signer_evidence_endpoint/);
 own.evidence=await ep('evidence');await file('own-reads',own);
 const config=await renderTargetRuntime(target,{signer:0,persist:false});assert.equal(config.data,own.evidenceDirectory);assert.equal(config.prod.bitcoin.urlFile,own.bitcoin.urlFile);assert.equal(config.prod.ethereum.chainId,target.ethereum.chainId);assert.ok(!config.gatewayKey&&!config.prod.ethereum.signerKeyFile&&!config.prod.tapRelayer);assert.ok(config.committee.every(m=>m.token===''));
 target.indexer.independentEndpoint={urlFile:'',authFile:'',tokenFile:''};own.tap.endpoints.length=1;
 for(const [ownFile,gatewayFile]of [[own.bitcoin.urlFile,target.bitcoin.rpc.urlFile],[own.ethereum.urlFile,target.ethereum.rpc.urlFile],[own.tap.endpoints[0].urlFile,target.indexer.endpoint.urlFile]])await writeFile(ownFile,await readFile(gatewayFile),{mode:0o600});
 await file('own-reads',own);const single=await renderTargetRuntime(target,{signer:0,persist:false});assert.equal(single.prod.tap.agreement,1);assert.equal(single.prod.tap.endpoints.length,1);
 own.bitcoin.urlFile=target.bitcoin.rpc.urlFile;await file('own-reads',own);await assert.rejects(renderTargetRuntime(target,{signer:0,persist:false}),/independent_reads/);
});

test('operator sidecar configuration is independent of post-deployment outputs and repeatable',async t=>{
 const {target,root,file}=await fixture(t),{configureOperator}=await import('../committee/provision.mjs'),directory=join(root,'bootstrap-operator');
 const descriptor=await provisionOperator({directory,id:target.committee.members[0].id,url:'https://operator.invalid',network:target.network});Object.assign(target.committee.members[0],descriptor);
 for(const [i,m]of target.committee.members.entries())m.sidecar={urlFile:await file('sidecar-url-'+i,'https://sidecar-'+i+'.invalid'),tokenFile:join(root,'other-host-token'),authFile:''};
 target.committee.publicKey='';target.gateway.registryFile='';target.runtime.deploymentFile='';
 target.runtime.signerReads[0]=await file('bootstrap-reads',{readerId:descriptor.id,network:target.network,epoch:target.committee.epoch,listen:'127.0.0.1:58800',sidecarListen:'127.0.0.1:58700'});
 await configureOperator(target,descriptor.id,directory);const before=await readFile(join(directory,'sidecar.json'));
 await configureOperator(target,descriptor.id,directory);assert.deepEqual(await readFile(join(directory,'sidecar.json')),before);
 target.committee.epoch++;await assert.rejects(configureOperator(target,descriptor.id,directory),/existing_config_mismatch/);
});


test('launch registry accepts an empty table and still checks the active authority', async t => {
 const {target}=await fixture(t); let active=true;
 const reads=await targetReads(target,{resolveEndpoint:async()=>({url:'https://fixture.invalid',headers:{}}),tlsProbe:async()=>({valid:true}),sourceFactory:()=>({request:async path=>{
  assert.equal(path,'/r/tap/getPrivilegeAuthList');return {result:active?[{ins:target.bitcoin.authorityInscription}]:[]};
 }})});
 await reads.registry({assets:{}});active=false;await assert.rejects(reads.registry({assets:{}}),/authority_inactive/);
});
