import { indexedAuthority } from '../service/prod/tap-index.mjs';
import { join } from 'node:path';
import { validateTarget, privateDirectory, privateJSON, secret, need } from './target.mjs';
import { validateRuntimePolicy, renderTargetRuntime, targetTapConfig } from './runtime.mjs';
import { targetReads } from './reads.mjs';
import { checkpointPhase, authorityPhase, activationPhase, escrowPhase } from './phases.mjs';
import { tracBootstrap } from './trac-bootstrap.mjs';
import { productionPreflight } from './production-preflight.mjs';
import { publicVerification } from './public-verification.mjs';
import { AdmittedWrites, operationHash } from './admission.mjs';
import { Store } from '../service/src/store.mjs';
import { atomicWrite, edPublic, hash } from '../service/src/util.mjs';
import { createBitcoin, BitcoinViews } from '../service/prod/bitcoin.mjs';
import { createTap } from '../service/prod/tap.mjs';
import { endpoint, privatePath } from '../service/prod/config.mjs';
import { HttpSource, jsonRpc } from '../service/prod/http.mjs';
import { signLegacy } from './ethereum-signing.mjs';
import { keccak, committeeAddress } from '../committee/signer/escrow.mjs';
import { rpc as sidecarRPC } from '../committee/tss.mjs';
import { connectRuntime } from '../service/prod/runtime.mjs';
import { msbIdentity } from '../service/prod/mainnet.mjs';
import { MAINNET_PARAMS, GENESIS } from '../contract/beacon/bitcoin.js';
import { createFeePolicy, LAUNCH_FEE_SETTINGS } from '../service/src/fees.mjs';
import { publicTarget } from './public-target.mjs';
import { rules } from '../service/src/rules.mjs';
import { createRequire } from 'node:module';
const { secp256k1 } = createRequire(new URL('../local/package.json', import.meta.url))('@noble/curves/secp256k1');
const q = value => '0x'+BigInt(value).toString(16);
const wait = async (fn,label) => { const end=Date.now()+120000; do { const result=await fn(); if(result)return result; await new Promise(r=>setTimeout(r,1000)); } while(Date.now()<end); throw Error(label+'_pending_resume'); };

export async function launchConfirmed(read, ids, confirmations) {
  for (const id of ids) {
    let tx;
    try { tx = await read('getrawtransaction', [id, true]); }
    catch (error) { if (error.rpcCode === -5) return false; throw error; }
    // Core omits this field for a mempool transaction. Undefined must never
    // satisfy the confirmation gate (undefined < 1 is false in JavaScript).
    if (!Number.isSafeInteger(tx.confirmations) || tx.confirmations < confirmations) return false;
  }
  return true;
}

export function initialProductionRegistry(target) {
  return { feePolicy: createFeePolicy(target.policy.baseFeeAtoms, 0, LAUNCH_FEE_SETTINGS),
    link: { treasury: target.bitcoin.treasuryAddress },
    assets: {},
    operator: { provisioning: { confirmations: target.policy.confirmations,
      privilege: target.bitcoin.authorityInscription, authorityKey: target.committee.publicKey,
      tapTreasury: target.bitcoin.treasuryAddress, ethereumTreasury: target.ethereum.treasuryAddress } } };
}

// This runner never spawns or installs a server. The operator supplies existing
// services and file-backed roles. Tests inject local adapters at this boundary.
export async function productionLaunch(input, { adapters, factory = productionAdapters } = {}) {
  const target=structuredClone(validateTarget(input)); validateRuntimePolicy(target);
  need(target.mode==='mainnet' && target.bitcoin.chain==='main' && target.ethereum.chainId==='1' && target.ethereum.signing==='files','production_launch_target');
  await privateDirectory(target.paths.output); await privatePath(target.paths.output,{directory:true});
  const store=await Store.open(join(target.paths.output,'launch-journal'));
  let active;
  try {
    const binding=operationHash(input), saved=store.get('launch','input'); need(!saved || saved===binding,'launch_target_changed');
    if(!saved)await store.put('launch','input',binding);
    const patch=store.get('launch','outputs'); if(patch)for(const [section,values] of Object.entries(patch))Object.assign(target[section],values);
    const saveOutputs=async values=>{const all={...(store.get('launch','outputs')??{})};for(const [k,v]of Object.entries(values)){all[k]={...all[k],...v};Object.assign(target[k],v);}await store.put('launch','outputs',all);await atomicWrite(join(target.paths.output,'deployed-target.json'),JSON.stringify(target,null,2));};
    active=adapters ?? await factory({target,store});
    const once=async(name,fn)=>{let row=store.get('launchPhases',name);if(!row){const result=await fn();row={result};await store.put('launchPhases',name,row);}return row.result;};
    await active.boundary();
    const group=await active.committee();
    const checkpoint=await checkpointPhase({height:target.bitcoin.checkpointHeight,primary:active.reads.core,witness:active.reads.witness,confirmations:target.policy.confirmations});
    await atomicWrite(target.bitcoin.checkpointFile,JSON.stringify(checkpoint));
    const preparation=await once('preparation',async()=>{const checked=await active.preflight('preparation');need(checked.ok&&!checked.admitted,'launch_preparation');return checked;});
    need(preparation.ok && !preparation.admitted,'launch_preparation');
    const privilege=await once('authority',()=>authorityPhase({group,network:target.network,epoch:target.committee.epoch,name:'dmw',receiver:target.bitcoin.authorityHolderAddress,prepare:fn=>once('authority-payload',fn),sign:active.signAuthority,
      activate:(label,payload,receiver)=>activationPhase({label,payload,receiver,write:active.write,transfer:active.transfer,confirm:active.confirm})}));
    await saveOutputs({bitcoin:{authorityInscription:privilege}});
    await active.registry();
    const deployment={network:target.network,admin:target.trac.adminPublicKey,committee:target.committee.publicKey,beacon:{checkpoint:checkpoint.checkpoint,params:MAINNET_PARAMS}};
    const trac=await once('trac',async()=>({registration:(await active.trac(deployment)).registration}));
    await saveOutputs({trac:{bootstrap:trac.registration.subnet}});
    await atomicWrite(target.runtime.deploymentFile,JSON.stringify(deployment));
    const artifact=await active.artifact(), sourceArtifactHash=operationHash(artifact);
    need(await once('escrow-artifact-hash',async()=>sourceArtifactHash)===sourceArtifactHash,'launch_artifact_changed');
    const escrow=await once('escrow',()=>escrowPhase({artifact,token:target.ethereum.tokenAddress,publicKey:target.committee.publicKey,admin:target.ethereum.adminAddress,chainId:target.ethereum.chainId,authorityEpoch:target.policy.authorityEpoch,send:active.send,rpc:active.ethereum}));
    await saveOutputs({ethereum:{escrowAddress:escrow.escrow.address}});
    await active.verify({sourceArtifactHash});
    await active.render();
    const admission=await active.preflight('admission');need(admission.admitted,'launch_admission');
    const result={complete:true,targetHash:binding,sourceArtifactHash,privilege,trac:trac.registration,escrow:escrow.escrow,admission};
    await atomicWrite(join(target.paths.output,'production-result.json'),JSON.stringify(result,null,2));return result;
  } finally {try{await active?.close?.();}finally{await store.close();}}
}

export async function productionAdapters({target:t,store}) {
  const bitcoin=await createBitcoin({...t.indexer.endpoint,kind:'ord'}), eth=jsonRpc(new HttpSource({...await endpoint(t.ethereum.rpc),requestsPerSecond:10,retries:0}));
  const indexer=await createTap(targetTapConfig(t),bitcoin,{requestsPerSecond:10});
  const runtimeConfig=await privateJSON(t.trac.runtimeConfigFile);
  const adminSecret=Buffer.from(await secret(t.trac.adminKeyFile),'hex');try{need(edPublic(adminSecret)===t.trac.adminPublicKey,'trac_admin_key');}finally{adminSecret.fill(0);}
  const views=new BitcoinViews(bitcoin,join(t.paths.output,'launch-headers.sqlite'),{maxHeadersPerView:t.policy.maxHeadersPerView});
  const resources=[views];
  const close=async()=>{const errors=[];for(const runtime of resources.reverse())try{await runtime.close();}catch(e){errors.push(e);}if(errors.length)throw Error('launch_cleanup');};
  try {
  if(t.runtime.headersFile)await views.seed(t.runtime.headersFile);
  const boundary=async()=>{await bitcoin.verifyNetwork();need(await bitcoin.blockHash(0)===GENESIS.hash && BigInt(await eth('eth_chainId'))===1n,'launch_write_chain');const tip=await bitcoin.tip();await views.view(tip.height,tip.hash);};
  // A read-only MSB connection is sufficient for preparation. The peer is
  // created only with the pinned deployment and role wallet below.
  let host,writer,reads;
  const ensureHost=async deployment=>{
    if(host)return host;
    await privatePath(runtimeConfig.hostDirectory,{directory:true});
    host=await connectRuntime({...runtimeConfig,directory:runtimeConfig.hostDirectory,peerWallet:t.trac.hostKeyFile,dmw:deployment},{create:true});resources.push(host);
    need(host.peer.wallet.publicKey.toString('hex')===t.trac.hostAdminPublicKey && msbIdentity(host.bus).bootstrapHex===t.trac.msbBootstrap && String(msbIdentity(host.bus).networkId)===t.trac.networkId,'trac_host_pin');return host;
  };
  await boundary();
  reads=await targetReads(t);
  const checkpoint=await privateJSON(t.bitcoin.checkpointFile);
  const fresh=await checkpointPhase({height:t.bitcoin.checkpointHeight,primary:reads.core,witness:reads.witness,confirmations:t.policy.confirmations});
  need(operationHash(checkpoint)===operationHash(fresh),'launch_checkpoint_pin');
  const writes=new AdmittedWrites({target:t,store,reads,boundary});
  const confirm=async()=>true; // Every supplied receipt is independently confirmed below.
  const write=async(label,payload,receiver)=>{
    const text=typeof payload==='string'?payload:rules.stableJSON(payload);
    const previous=store.get('launchInscriptions',label);
    need(!previous || previous.text===text && previous.receiver===receiver,'launch_inscription_changed');
    await store.put('launchInscriptions',label,{text,receiver});
    const bundle=store.list('launchInscriptions',{limit:4096}).map(({id,value})=>({label:id,...value}));
    await atomicWrite(join(t.paths.output,'owner-inscriptions.json'),JSON.stringify(bundle,null,2)+'\n');
    let receipts={};
    try { receipts=await privateJSON(t.runtime.ownerInscriptionsFile); } catch { /* No receipt yet: retain exact text for owner. */ }
    const id=receipts[label];
    need(typeof id==='string' && /^[0-9a-f]{64}i[0-9]+$/.test(id),'owner_inscription_required');
    const tip=await bitcoin.tip(),view=await views.view(tip.height,tip.hash);
    const content=await indexer.content(id), inclusion=await bitcoin.included(id,{tip:tip.height,tipHash:tip.hash},view);
    need((typeof content==='string'?content:rules.stableJSON(content))===text && inclusion?.confirmations>=t.policy.confirmations,'owner_inscription_unconfirmed');
    const location=await indexer.inscription(id);
    need(location.address===receiver,'owner_inscription_receiver');
    return id;
  };
  const transfer=async(_label,id,receiver)=>{
    const active=await indexedAuthority(indexer,join(t.paths.output,'launch-tap-lookups.sqlite'),id);
    need(active?.ins===id && (active.addr===undefined || active.addr===receiver),'owner_authority_activation_required');
  };
  const send=async(label,from,to,data)=>{
    let p=store.get('launchEthereum',label);
    if(!p){const key=Buffer.from(await secret(t.ethereum.adminKeyFile),'hex');try{
      need(committeeAddress(Buffer.from(secp256k1.getPublicKey(key)).toString('hex'))===from.toLowerCase(),'deployment_sender');
      const gas=BigInt(await eth('eth_estimateGas',[{from,...(to?{to}:{}),data}]))*12n/10n;
      const params={nonce:await eth('eth_getTransactionCount',[from,'pending']),gasPrice:await eth('eth_gasPrice'),gas:q(gas),to:to??'0x',data,chainId:q(t.ethereum.chainId)};
      const raw=signLegacy(params,key);p={raw,from,to,data,hash:'0x'+Buffer.from(keccak(Buffer.from(raw.slice(2),'hex'))).toString('hex')};await store.put('launchEthereum',label,p);
    }finally{key.fill(0);}}
    need(p.from===from&&p.to===to&&p.data===data,'deployment_transaction_changed');
    const observed=async()=>{const r=await eth('eth_getTransactionReceipt',[p.hash]);if(!r)return null;need(r.status==='0x1'&&(await eth('eth_getBlockByNumber',[r.blockNumber,false])).hash===r.blockHash,'deployment_receipt');const tip=await eth('eth_getBlockByNumber',['latest',false]);return BigInt(tip.number)-BigInt(r.blockNumber)+1n>=BigInt(t.policy.ethereumConfirmations)?r:null;};
    await writes.execute(label,{rail:'ethereum',role:'admin',raw:p.raw},async()=>{if(!await eth('eth_getTransactionByHash',[p.hash]))need(await eth('eth_sendRawTransaction',[p.raw])===p.hash,'deployment_hash');return p.hash;},observed);
    return wait(observed,'ethereum_confirmation');
  };
  return {reads,boundary,write,transfer,confirm,send,ethereum:eth,
    committee:async()=>{const group=[];for(const m of t.committee.members){const ep=await endpoint(m.sidecar),token=await secret(m.sidecar.tokenFile),status=await sidecarRPC(ep.url,token,'/status');need(status.public===t.committee.publicKey&&status.epoch===t.committee.epoch&&!status.retired,'launch_committee');group.push({...m,url:ep.url,token});}return group;},
    preflight:stage=>productionPreflight(t,{stage,reads}),
    registry:async()=>{try{await privateJSON(t.gateway.registryFile);}catch(e){if(e.message!=='Supply an owned, nonempty 0600 file outside repositories, without symlinks')throw e; const {stat}=await import('node:fs/promises');try{await stat(t.gateway.registryFile);throw Error('registry_existing_invalid');}catch(err){if(err.code!=='ENOENT')throw err;}await atomicWrite(t.gateway.registryFile,JSON.stringify(initialProductionRegistry(t)));}},
    trac:async deployment=>{
      await ensureHost(deployment);
      need(operationHash(host.peer.config.dmw)===operationHash(deployment),'trac_checkpoint_changed');
      const subnet=host.peer.base.key.toString('hex');need(!t.trac.bootstrap||t.trac.bootstrap===subnet,'trac_bootstrap_pin');
      writer=await connectRuntime({...runtimeConfig,peerWallet:t.trac.writerKeyFile,dmw:deployment,subnetBootstrap:subnet});resources.push(writer);
      const result=await tracBootstrap({indexer:host.peer,writer:writer.peer,bus:host.bus,deployment,mode:'mainnet',roles:{host:t.trac.hostAdminPublicKey,writer:t.trac.writerPublicKey,admin:t.trac.adminPublicKey},boundary,
        register:async prepare=>{
          let packet=store.get('launch','trac-registration');
          if(!packet){packet=await prepare();await store.put('launch','trac-registration',packet);}
          return writes.execute('trac-registration',{rail:'trac',role:'host',packet,count:1},async()=>{
            need(await host.bus.network.validatorMessageOrchestrator.send(packet),'trac_registration_rejected');return true;
          },()=>host.bus.state.getRegisteredBootstrapEntry(subnet));
        }});
      await atomicWrite(join(runtimeConfig.hostDirectory,'runtime.json'),JSON.stringify({...runtimeConfig,directory:runtimeConfig.hostDirectory,peerWallet:t.trac.hostKeyFile,dmw:deployment,subnetBootstrap:subnet}));
      await atomicWrite(t.trac.runtimeConfigFile,JSON.stringify({...runtimeConfig,peerWallet:t.trac.writerKeyFile,dmw:deployment,subnetBootstrap:subnet}));return result;
    },
    artifact:()=>privateJSON(join(t.paths.output,'verification','escrow-artifact.json')),
    verify:options=>publicVerification(t,reads,options),
    render:async()=>{await renderTargetRuntime(t);await atomicWrite(join(t.paths.output,'kit-public.json'),JSON.stringify(publicTarget(t),null,2));},
    close
  };
  } catch(error) { await close(); throw error; }
}
