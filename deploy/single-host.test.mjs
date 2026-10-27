import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { TRAC_MAINNET } from '../service/prod/mainnet.mjs';
import { fundingRuntimeConfig, waitForValidators, installValidatorFanout } from '../service/prod/runtime.mjs';
import { loadTarget, worksheetTarget } from './target.mjs';
import { ownerInputReport } from './owner-inputs.mjs';
import { collectSingleHostInputs } from './single-host-inputs.mjs';
import { targetTapConfig } from './runtime.mjs';
import { targetReads, tlsHealth } from './reads.mjs';
import { checkpointPhase } from './phases.mjs';
import { headerHandler } from './header-source.mjs';
import { mockServer, temporary } from '../service/prod/test/helpers.mjs';
import { prepareVerificationReceipt } from './verification-receipt.mjs';
import { tokenSourceArtifacts, TAP_IMPLEMENTATION } from './token-source.mjs';
import { metadataMultihash } from './public-verification.mjs';
import { edPublic } from '../service/src/util.mjs';
import { committeeAddress, keccak } from '../committee/signer/escrow.mjs';
const require = createRequire(new URL('../local/package.json', import.meta.url));
const { secp256k1 } = require('@noble/curves/secp256k1'), btc = require('@scure/btc-signer');
const path = new URL('./inputs/mainnet-inputs.template.json', import.meta.url);
const worksheet = JSON.parse(await readFile(path));
const recorded = JSON.parse(await readFile(new URL('./fixtures/production-reads.json', import.meta.url)));

test('example layout has one host, one source, normal mainnet and ten distinct local signer ports', async () => {
  const t = await loadTarget(path);
  assert.equal(t.trac.networkId, '918'); assert.equal(t.trac.msbBootstrap, TRAC_MAINNET.msbBootstrap);
  assert.deepEqual(worksheet.files.tracRuntime.dhtBootstrap, TRAC_MAINNET.dhtBootstrap);
  assert.equal(worksheet.files.tracRuntime.validators, 'auto');
  assert.equal(worksheet.operations.hosts.indexers, 1); assert.equal(worksheet.operations.hosts.indexerIsAdmin, true);
  assert.deepEqual(targetTapConfig(t), { endpoints: [t.indexer.endpoint], agreement: 1 });
  assert.equal(t.bitcoin.witnessRpc.urlFile, '');
  assert.equal(new Set(t.committee.members.map(m => m.server)).size, 1);
  assert.equal(new Set(worksheet.operations.hosts.operators.map(h => h.unixUser)).size, 5);
  assert.equal(new Set(worksheet.operations.hosts.operators.flatMap(h => [h.signerURL, h.sidecarURL])).size, 10);
  const empty = [];
  const walk = (v, p = '') => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p + '/' + k); else if (v === '') empty.push(p); };
  walk(worksheet); assert.deepEqual(empty.sort(), ['/operations/owner/serverIP', '/operations/owner/sshAccess']);
  const filled = structuredClone(worksheet);
  Object.assign(filled.operations.owner, { serverIP:'203.0.113.1', sshAccess:'owner-managed', dnsPointed:true, bitcoinTapFilesInstalled:true, ethereumFilesInstalled:true, roleFilesInstalled:true });
  const report = ownerInputReport(filled); assert.equal(report.inventoryComplete, true); assert.equal(report.ok, false); assert.equal(report.admitted, false);
  filled.files.tracRuntime.msbChannel = 'unknown'; assert.throws(() => ownerInputReport(filled), /single_host_defaults/);
});

test('public input collector binds indexer/admin and keeps writer, signers and ports distinct', () => {
  const pk = secp256k1.getPublicKey(Buffer.alloc(32, 7));
  const roles = { bitcoin: Object.fromEntries(['funding','treasury','release','authorityHolder','payer','receiver'].map(r => [r+'Address', btc.p2tr(pk.slice(1)).address])),
    ethereum: Object.fromEntries(['admin','treasury','payer'].map(r => [r+'Address', committeeAddress(Buffer.from(pk).toString('hex'))])),
    trac:{hostPublicKey:edPublic(Buffer.alloc(32, 8)),writerPublicKey:edPublic(Buffer.alloc(32, 9))}, gatewayKey:edPublic(Buffer.alloc(32, 10)) };
  const members = worksheet.target.committee.members.map((m, i) => ({id:m.id,network:worksheet.target.network,url:worksheet.operations.hosts.operators[i].sidecarURL,identity:edPublic(Buffer.alloc(32,i+11)),encryption:edPublic(Buffer.alloc(32,i+16))}));
  const inputs = structuredClone(worksheet);
  Object.assign(inputs.target.bitcoin, { feeRate: 2, estimateFeeRate: 10 });
  const w = collectSingleHostInputs(inputs, roles, members);
  assert.equal(w.target.trac.adminPublicKey, w.target.trac.hostAdminPublicKey);
  assert.notEqual(w.target.trac.writerPublicKey, w.target.trac.hostAdminPublicKey);
  const same = structuredClone(roles);same.trac.writerPublicKey=same.trac.hostPublicKey;
  assert.throws(() => collectSingleHostInputs(inputs, same, members), /single_host_writer/);
  const changed = structuredClone(members); changed[0].identity=changed[1].identity;
  assert.throws(() => collectSingleHostInputs(inputs, roles, changed), /target_roster/);
  assert.throws(() => collectSingleHostInputs(w, roles, changed), /identity_changed/);
  const bad = structuredClone(inputs);bad.operations.hosts.operators[1].signerURL=bad.operations.hosts.operators[0].signerURL;
  assert.throws(() => collectSingleHostInputs(bad, roles, members), /single_host_ports/);
});

test('normal mainnet discovers validators and refuses a partial pool or wrong network', async () => {
  const c = worksheet.files.tracRuntime; assert.equal(fundingRuntimeConfig(c), c);
  let time = 0, count = 1;
  const bus = { config:{bootstrap:Buffer.from(TRAC_MAINNET.msbBootstrap,'hex'),networkId:918},network:{validatorConnectionManager:{connectedValidators:()=>Array.from({length:count},(_,i)=>String(i).padStart(64,'0'))},tryConnect:()=>{throw Error('must use observer');}} };
  const clock = {timeoutMs:3,intervalMs:1,now:()=>time,pause:async()=>{time++;count++;}};
  assert.equal((await waitForValidators(bus,c,clock)).length,3);
  count=2;time=0;await assert.rejects(waitForValidators(bus,c,{...clock,pause:async()=>{time++;}}),/three_validators/);
  bus.config.networkId=919;await assert.rejects(waitForValidators(bus,c,clock),/mainnet_binding/);
  assert.throws(() => fundingRuntimeConfig({...c,msbBootstrap:'01'.repeat(32)}),/mainnet_discovery/);
});

test('one chain source still verifies genesis, indexer progress, canonical hash and confirmed checkpoint', async () => {
  const t=worksheetTarget(worksheet.target);let corrupt=false,lag=false;const requested=[];
  const reads=await targetReads(t,{resolveEndpoint:async()=>({url:'http://127.0.0.1:62000',headers:{}}),tlsProbe:tlsHealth,sourceFactory:name=>{
    requested.push(name);return {request:async(path,{body}={})=>{
      if(body){const result=body.method==='getblockchaininfo'?recorded.bitcoin:body.method==='eth_chainId'?'0x1':body.params[0]===0?recorded.genesis:recorded.bitcoin.bestblockhash;return{id:body.id,result};}
      if(path==='/r/tap/getCurrentBlock')return{result:lag?1900:2022};
      if(path==='/r/blockhash/0')return recorded.genesis;
      return corrupt?'00'.repeat(32):recorded.bitcoin.bestblockhash;
    }};
  }});
  assert.deepEqual(requested.sort(),['bitcoin','ethereum','gateway','indexer']);assert.equal(reads.witness,undefined);
  assert.equal((await reads.chainAgreement()).indexers.length,1);
  corrupt=true;await assert.rejects(reads.chainAgreement(),/disagreement/);corrupt=false;lag=true;await assert.rejects(reads.chainAgreement(),/lag/);
  assert.throws(()=>reads.core('sendrawtransaction'),/read_only/);
  let tip=2022;
  const core=async(method,args=[])=>method==='getblockcount'?tip:method==='getblockhash'?recorded.headers[String(args[0])].hash:args[1]===false?Object.values(recorded.headers).find(h=>h.hash===args[0]).raw:Object.values(recorded.headers).find(h=>h.hash===args[0]);
  assert.deepEqual(await checkpointPhase({height:2016,primary:core}),recorded.checkpoint);
  tip=2015;await assert.rejects(checkpointPhase({height:2016,primary:core}),/freshness/);
});

test('host sends fan out once to three validators and stop if the connected pool shrinks', async () => {
  let pool=['a','b','c'];const delivered=[];
  const manager={connectedValidators:()=>pool,pickRandomValidator:keys=>keys[0],pickRandomConnectedValidator:()=>pool[0]};
  const network={validatorConnectionManager:manager,validatorMessageOrchestrator:{send:async()=>{delivered.push(manager.pickRandomConnectedValidator());return true;}}};
  installValidatorFanout(network);installValidatorFanout(network);
  assert.equal(await network.validatorMessageOrchestrator.send({tx:'fixture'}),true);
  assert.deepEqual(delivered.sort(),['a','b','c']);
  pool=['a','b'];assert.throws(()=>network.validatorMessageOrchestrator.send({tx:'fixture'}),/three_validators/);
  assert.equal(delivered.length,3);
});

test('public header reader exposes only bounded header methods and redacts provider failures', async t => {
  const calls=[];let fail=false;
  const hash=recorded.headers['2016'].hash;
  const url=await mockServer(t,headerHandler(async(method,args=[])=>{
    calls.push(method);if(fail)throw Error('private-provider-credential');
    if(method==='getblockcount')return 2022;
    if(method==='getblockhash')return hash;
    if(method==='getblockheader')return args[1]===false?recorded.headers['2016'].raw:{time:123};
    throw Error('unexpected method');
  }));
  assert.equal(await (await fetch(url+'/api/blocks/tip/height')).text(),'2022');
  assert.equal(await (await fetch(url+'/api/block/'+hash+'/header')).text(),recorded.headers['2016'].raw);
  assert.equal((await (await fetch(url+'/api/blocks/2022')).json()).length,10);
  const before=calls.length;
  for(const path of ['/wallet','/api/block-height/-1','/api/block-height/1?method=sendrawtransaction','/api/blocks/10000000']) assert.equal((await fetch(url+path)).status,404);
  assert.equal((await fetch(url+'/api/blocks/tip/height',{method:'POST'})).status,405);assert.equal(calls.length,before);
  fail=true;const response=await fetch(url+'/api/blocks/tip/height');assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private-provider/);
});

test('verification receipts measure pinned bytes and implementation code without claiming verification', async t => {
  const root=await temporary(t),target=worksheetTarget(worksheet.target);target.paths.output=root;
  await mkdir(join(root,'verification'),{mode:0o700});
  for(const file of ['token-artifact.json','token-input.json'])await writeFile(join(root,'verification',file),'{}',{mode:0o600});
  const implementation='0x'+'11'.repeat(20),proxy='0x363d3d373d3d3d363d73'+implementation.slice(2)+'5af43d82803e903d91602b57fd5bf3';
  const calls=[];let reorg=false;
  const ethereum=async(method,args=[])=>{calls.push(method);
    if(method==='eth_chainId')return'0x1';
    if(method==='eth_getBlockByNumber')return{number:'0x10',hash:'0x'+(reorg&&args[0]!=='latest'?'bb':'aa').repeat(32)};
    if(method==='eth_getCode')return args[0]===implementation?'0x60006000':proxy;
    throw Error('unexpected method');
  };
  const receipt=await prepareVerificationReceipt(target,'token',{ethereum});
  assert.equal(receipt.proxyKind,'eip1167');assert.equal(receipt.implementation,implementation);assert.equal(receipt.verified,undefined);
  assert.match(receipt.artifactSHA256,/^[0-9a-f]{64}$/);assert.match(receipt.artifactURL,/^https:\/\/gateway\.example\.invalid\/verification\//);
  assert.ok(calls.every(method=>!method.includes('send')));
  reorg=true;await assert.rejects(prepareVerificationReceipt(target,'token',{ethereum}),/verification_reorg/);
});

test('public token source reconstructs only committed metadata and refuses source or runtime substitutions', () => {
  const content='contract Fixture {}',source='bridge-final/TapToken.sol';
  const metadata={compiler:{version:'0.8.26+commit.8a97fa7a'},settings:{metadata:{bytecodeHash:'ipfs'}},sources:{[source]:{keccak256:'0x'+Buffer.from(keccak(Buffer.from(content))).toString('hex')}},output:{devdoc:{notice:'A caller’s token'}}};
  const decoded=JSON.stringify(metadata),raw=decoded.replace('’','\\u2019');
  const trailer='a164697066735822'+metadataMultihash(raw),code='0x'+'6000'.repeat(64)+trailer+(trailer.length/2).toString(16).padStart(4,'0');
  const c={metadata:decoded,abi:[],evm:{bytecode:{object:'0x6000'},deployedBytecode:{object:code,immutableReferences:{}}}};
  const record={chainId:'1',address:TAP_IMPLEMENTATION,runtimeMatch:'exact_match',runtimeBytecode:{onchainBytecode:code},stdJsonInput:{language:'Solidity',sources:{[source]:{content}},settings:{}},stdJsonOutput:{contracts:{[source]:{TapToken:c}}}};
  assert.equal(tokenSourceArtifacts(record).artifact.rawMetadata,raw);
  const wrongSource=structuredClone(record);wrongSource.stdJsonInput.sources[source].content+='x';assert.throws(()=>tokenSourceArtifacts(wrongSource),/token_source_hash/);
  const wrongCode=structuredClone(record);wrongCode.runtimeBytecode.onchainBytecode='0x6001';assert.throws(()=>tokenSourceArtifacts(wrongCode));
  const wrongMeta=structuredClone(record);wrongMeta.stdJsonOutput.contracts[source].TapToken.metadata=decoded.replace('caller','spender');assert.throws(()=>tokenSourceArtifacts(wrongMeta),/token_source_metadata/);
});
