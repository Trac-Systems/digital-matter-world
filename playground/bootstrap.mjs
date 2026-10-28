import { localRuntime, saveRuntime } from '../deploy/runtime.mjs';
import { committeePhase, activationPhase, authorityPhase, escrowPhase, checkpointPhase } from '../deploy/phases.mjs';
import { testWalletOwner } from './kit-player.mjs';
import { decodeTracAddress } from '../rules/src/trac-address.js';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { ROOT, DATA, PORTS, PROFILE, TARGET, json, maybe, save, privateDir, randomHex, until, check } from './common.mjs';
import { startSidecar, descriptor, rpc as signerRPC } from '../committee/tss.mjs';
import { BUILD, bitcoin, mine, receiveAddress, ordJson } from '../local/common.mjs';
import { CancellableInscriber } from '../local/cancellable-inscriber.mjs';
import { sendInscription } from '../local/inscriber.mjs';
import { authority, testKey } from '../local/protocol.mjs';
import { rules } from '../service/src/rules.mjs';
import { createFeePolicy, LAUNCH_FEE_SETTINGS } from '../service/src/fees.mjs';
import { tracClient } from '../service/local/trac.mjs';
import { init } from '../kit/lib/keyring.mjs';
import { localOrigin } from '../deploy/target.mjs';

export async function playgroundRuntime(target, options) {
  check(target.mode === 'regtest', 'local_runtime_target');
  const tapSourceFile = join(options.directory, 'tap-source.url');
  await writeFile(tapSourceFile, localOrigin(options.manifest.ord.url) + '\n', { mode: 0o600, flag: 'wx' });
  return localRuntime(target, { ...options, tapSourceFile });
}

export async function makeIdentity(name) {
  const directory=join(DATA,'players',name); await privateDir(directory);
  const existing=await maybe(join(directory,'keystore.json')); if(existing)return {name,directory,address:existing.address};
  const password=randomHex(); await writeFile(join(directory,'password'),password,{mode:0o600,flag:'wx'});
  const {address}=await init({directory,password}); return {name,directory,address:decodeTracAddress(address)};
}
export async function boot(directory,base,processes,progress) {
  const {manifest,evm}=base, network=TARGET.network, filename=join(directory,'gateway.json');
  let state=await maybe(join(directory,'state.json'));
  const fresh=!state;
  if(fresh)check(!await maybe(join(directory,'bootstrap-started.json')),'incomplete_bootstrap_inspect_logs_then_wipe');
  if(fresh)await save(join(directory,'bootstrap-started.json'),{at:Date.now()});
  await progress('committee');
  if (state) check(state.network === network, 'saved_deployment_target_mismatch');
  const {group,publicKey}=await committeePhase({directory:join(directory,'committee'),network,epoch:TARGET.committee.epoch,port:PORTS.tss[0],prefix:'playground',existing:state?.publicKey,start:async(member,i)=>{
    const child=await startSidecar(member,(pid)=>processes.remember(pid,'tss-'+i));
    processes.children.push({name:'tss-'+i,child});
    child.on('exit',(code,signal)=>{if(!processes.stopping && !child.expected)processes.failure=`tss-${i} exited (${code ?? signal}); inspect sidecar.log`;});
  }});
  const bootstrap=await CancellableInscriber.open({manifest,directory:join(directory,'bootstrap'),countedHeight:()=>bitcoin(manifest,'getblockcount'),quoteSats:'100000'});
  const write=async(text,receiver)=>{
    const created=await bitcoin(manifest,'getblockcount'),p=await bootstrap.prepare([{text,receiver}],{created,expiry:created+432});
    await bootstrap.broadcast(p); await mine(manifest); return p.inscriptions[0].id;
  };
  const activate=(text,receiver)=>activationPhase({label:'authority',payload:text,receiver,write:(_label,payload,to)=>write(payload,to),transfer:(_label,id,to)=>sendInscription(manifest,id,to),confirm:()=>mine(manifest)});
  if(fresh) {
    await progress('wallets-and-deployments');
    const player=await makeIdentity('owner'), addresses={};
    for(const role of ['payer','finder','treasury','release','receiver'])addresses[role]=await receiveAddress(manifest);
    await bitcoin(manifest,'sendtoaddress',[addresses.payer,25],'faucet');
    await bitcoin(manifest,'sendtoaddress',[await bootstrap.receiveAddress(),100],'faucet'); await mine(manifest);
    const privilege=await authorityPhase({group,network,epoch:TARGET.committee.epoch,name:'dmw',receiver:addresses.payer,activate:(_label,payload,to)=>activate(payload,to)});
    await write({p:'tap',op:'token-deploy',tick:'tap',max:'1000000000',dec:'18'},addresses.payer);
    await write({p:'tap',op:'token-mint',tick:'tap',amt:'1000000000'},addresses.payer);
    const payerKey=Buffer.from(testKey()).toString('hex'),releaseKey=Buffer.from(testKey()).toString('hex');
    const payerAuthority=await activate(authority(Buffer.from(payerKey,'hex'),{auth:['tap']}),addresses.payer);
    const releaseAuthority=await activate(authority(Buffer.from(releaseKey,'hex'),{auth:['tap']}),addresses.release);
    await writeFile(join(directory,'relay.key'),releaseKey,{mode:0o600});
    await writeFile(join(directory,'gateway.key'),randomHex(),{mode:0o600});
    const [admin,ethPayer,ethTreasury,,ethRelayer]=manifest.ethereum.accounts;
    const artifact=await json(join(BUILD,'target/eth-out/DmwEscrow.sol/DmwEscrow.json'));
    const {escrow}=await escrowPhase({artifact,token:manifest.ethereum.token,publicKey,admin,chainId:TARGET.ethereum.chainId,authorityEpoch:TARGET.policy.authorityEpoch,rpc:(...args)=>evm.rpc(...args),send:async(_label,from,to,data)=>{
      check((await bitcoin(manifest,'getblockchaininfo')).chain==='regtest','local_deployment_chain');
      const tx=await evm.rpc('eth_sendTransaction',[{from,...(to?{to}:{}),data,gas:'0x7a1200'}]);
      return until(()=>evm.rpc('eth_getTransactionReceipt',[tx]),'escrow deployment');
    }});
    const table = [];
    const registry = { feePolicy:createFeePolicy(TARGET.policy.baseFeeAtoms, 0, LAUNCH_FEE_SETTINGS), link:{treasury:addresses.treasury}, assets:{} };
    const registryPath=join(directory,'registry.json'); await save(registryPath,registry);
    await progress('history');
    const historyHeight=TARGET.local.playground.historyHeight;
    const height=await bitcoin(manifest,'getblockcount'); if(height<historyHeight)await mine(manifest,historyHeight-height);
    const genesisHash=await bitcoin(manifest,'getblockhash',[0]),genesis=await bitcoin(manifest,'getblockheader',[genesisHash,false]),info=await bitcoin(manifest,'getblockheader',[genesisHash,true]);
    const boundary = await checkpointPhase({ height: 2016, primary: (m,p) => bitcoin(manifest,m,p), witness: (m,p) => bitcoin(manifest,m,p), confirmations: TARGET.policy.confirmations });
    const tracToken=randomHex();
    await save(join(directory,'trac.json'),{directory:join(directory,'trac'),players:join(DATA,'players'),network,committee:publicKey,checkpoint:boundary.checkpoint,genesis,genesisWork:BigInt('0x'+info.chainwork).toString(),listen:{host:'127.0.0.1',port:PORTS.trac},token:tracToken,status:join(directory,'trac-status.json')});
    const gatewaySecret=Buffer.from(await readFile(join(directory,'gateway.key'),'utf8'),'hex');
    const gatewayKey=rules.sealReceipts([],{network,tip:0,hash:genesisHash},gatewaySecret).gateway;
    const clients=[],signerConfigs=[];
    for(let i=0;i<group.length;i++) {
      const m=group[i],s=await json(join(m.directory,'credentials.json'));
      const secrets={identity:s.identity,encryption:s.encryption,apiToken:randomHex(),sidecarToken:m.token,passphrase:randomHex(),journalKey:randomHex()};
      const credentials=join(m.directory,'signer-credentials.json'),configPath=join(m.directory,'signer.json'); await save(credentials,secrets);
      await save(configPath,{id:m.id,network,epoch:TARGET.committee.epoch,gateway:gatewayKey,listen:`127.0.0.1:${PORTS.signers[i]}`,directory:m.directory,secrets:credentials,sidecar:m.url,members:group.map(descriptor),escrow,readModule:join(ROOT,'service/local/reads.mjs'),readOptions:{config:filename,readerId:m.id}});
      signerConfigs.push(configPath);clients.push({id:m.id,url:`http://127.0.0.1:${PORTS.signers[i]}`,token:secrets.apiToken,peer:descriptor(m)});
    }
    const config=await playgroundRuntime(TARGET,{directory,manifest,committee:clients,gatewayKey:join(directory,'gateway.key'),adapter:join(ROOT,'playground/adapter.mjs'),patterns:table,ports:PORTS,tracToken,registryFile:registryPath,startTip:historyHeight+1,escrow});
    await saveRuntime(filename,config); await save(config.local.registry,registry);
    state={version:1,network,publicKey,player,addresses,privilege,payerKey,releaseKey,payerAuthority,releaseAuthority,ethPayer,ethTreasury,ethRelayer,escrow,signerConfigs,gatewayKey,seedBlocks:historyHeight};
    await evm.checkpoint(); await save(join(directory,'state.json'),state);
  }
  const config=await json(filename),trac=tracClient(config.endpoints.trac,config.local.tracToken);
  // Durable local operator configuration is populated on the normal planned
  // restart. The service uses the same allocator and payout runner on both rails.
  const registry = await json(config.local.registry);
  if (fresh && !registry.operator) {
    registry.operator = {
      provisioning: { confirmations: 1, privilege: state.privilege, authorityKey: state.publicKey,
        tapTreasury: state.addresses.treasury, ethereumTreasury: state.ethTreasury }
    };
    await save(config.local.registry, registry);
  }

  check(registry.operator, 'deployment_operator_missing');
  await progress('trac'); await processes.start('trac',process.execPath,['--require',join(ROOT,'playground/loopback.cjs'),join(ROOT,'playground/trac.mjs'),join(directory,'trac.json')]);
  await until(()=>trac('head'),'Trac',{checkAlive:()=>processes.alive()}); await trac('fund');
  await progress('signers');
  for(let i=0;i<state.signerConfigs.length;i++) {
    await processes.start('signer-'+i,process.execPath,[join(ROOT,'service/local/signer.mjs'),state.signerConfigs[i]]);
    await until(()=>signerRPC(config.committee[i].url,config.committee[i].token,'/health',{},1000),'signer '+i,{checkAlive:()=>processes.alive()});
  }
  await progress('gateway');
  const gateway=await processes.start('gateway',process.execPath,[join(ROOT,'service/run.mjs'),filename]);
  const kitConfig={localOnly:true,bitcoinNetwork:'regtest',owner:testWalletOwner(state),network:state.network,gateway:`http://127.0.0.1:${PORTS.gateway}`,gatewayKey:state.gatewayKey,receiptSigners:config.committee.map(s=>({id:s.id,identity:s.peer.identity})),adapter:join(ROOT,'playground/kit-adapter.mjs'),puzzleBits:0,powLimitBits:0x207fffff,headerSource:manifest.bitcoin.rpc,headerCookie:join(manifest.root,'bitcoin/regtest/.cookie'),playground:{directory,endpoint:config.endpoints.trac,tokenFile:join(DATA,'trac.token')},paymentOrigin:`http://127.0.0.1:${PORTS.gateway}`};
  await writeFile(join(DATA,'trac.token'),config.local.tracToken,{mode:0o600}); await save(join(DATA,'kit.json'),kitConfig);
  return {state,config,filename,trac,bootstrap,write,gateway,group,kitConfig};
}
