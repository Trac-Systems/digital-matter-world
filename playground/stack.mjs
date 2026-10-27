import { join } from 'node:path';
import { readFile, writeFile, open, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { ROOT, BUILD, PORTS, TARGET, check, maybe, json, save, diskFloor, recorded, identity, stopRecorded, until, privateDir } from './common.mjs';
import { ORD, bitcoin, rpc, mine, waitIndexed, ordArgs, ordWallet, receiveAddress } from '../local/common.mjs';
import { startWalletGateway } from './wallet-gateway.mjs';

export class Processes {
  constructor(directory) { this.directory=directory; this.rows=[]; this.children=[]; this.stopping=false; }
  async remember(pid,name) { const row=await recorded(pid,name); this.rows.push(row); await save(join(this.directory,'pids.json'),this.rows); return row; }
  async start(name,command,args) {
    const log=await open(join(this.directory,name+'.log'),'a',0o600);
    const child=spawn(command,args,{stdio:['ignore',log.fd,log.fd]});
    this.children.push({name,child});
    try { await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);}); }
    finally { await log.close(); }
    await this.remember(child.pid,name);
    child.on('exit',(code,signal)=>{ if(!this.stopping && !child.expected) this.failure=`${name} exited (${code ?? signal}); inspect ${name}.log before restarting`; });
    return child;
  }
  alive() { if(this.failure)throw Error(this.failure); }
  async stop(child) { child.expected=true; const row=this.rows.find(r=>r.pid===child.pid); if(row&&await identity(row.pid)===row.identity)await stopRecorded(row,20000); }
  async close() { this.stopping=true; const errors=[]; for(const row of this.rows.toReversed())if(row.pid!==process.pid)try{if(await identity(row.pid)===row.identity)await stopRecorded(row,20000);}catch(e){errors.push(e.message);} if(errors.length)throw Error(errors.join('; ')); }
}

export class EvmJournal {
  constructor(manifest,directory) { this.manifest=manifest; this.path=join(directory,'ethereum-blocks.json'); this.blocks=[]; this.busy=Promise.resolve(); }
  rpc(method,params=[]) { return rpc(this.manifest.ethereum.rpc,method,params); }
  async restore() {
    const saved=await maybe(this.path); if(!saved)return;
    await this.rpc('evm_setAutomine',[false]);
    for(const b of saved.blocks) {
      await this.rpc('evm_setNextBlockTimestamp',[Number(BigInt(b.timestamp))]);
      await this.rpc('anvil_setNextBlockBaseFeePerGas',[b.baseFeePerGas]);
      for(const raw of b.transactions)await this.rpc('eth_sendRawTransaction',[raw]);
      await this.rpc('evm_mine');
      const got=await this.rpc('eth_getBlockByNumber',[b.number,false]);
      check(got.stateRoot===b.stateRoot && (!b.hash || got.hash===b.hash) && got.transactions.length===b.transactions.length,'ethereum_replay_mismatch');
    }
    await this.rpc('evm_setAutomine',[true]); this.blocks=saved.blocks;
  }
  checkpoint() { const work=this.busy.then(async()=>{
    const height=Number(BigInt(await this.rpc('eth_blockNumber')));
    for(let n=this.blocks.length+1;n<=height;n++) {
      const b=await this.rpc('eth_getBlockByNumber',['0x'+n.toString(16),false]);
      const transactions=[]; for(const hash of b.transactions)transactions.push(await this.rpc('eth_getRawTransactionByHash',[hash]));
      check(transactions.every(t=>typeof t==='string' && t.startsWith('0x')),'ethereum_raw_transaction_missing');
      this.blocks.push({number:b.number,hash:b.hash,timestamp:b.timestamp,baseFeePerGas:b.baseFeePerGas,stateRoot:b.stateRoot,transactions});
    }
    await save(this.path,{version:1,blocks:this.blocks});
  }); this.busy=work.catch(()=>{}); return work; }
}

export async function startBase(directory,processes) {
  check(TARGET.mode === 'regtest', 'local_stack_only');
  await diskFloor(); const root=join(directory,'stack'); await privateDir(root);
  let manifest=await maybe(join(root,'manifest.json')); const fresh=!manifest;
  manifest ??= {version:1,root,ports:PORTS,bitcoin:{rpc:`http://127.0.0.1:${PORTS.bitcoin}`,network:'regtest',wallet:'faucet'},ord:{url:`http://127.0.0.1:${PORTS.ord}`},gateway:{url:`http://127.0.0.1:${PORTS.wallet}`},ethereum:{rpc:`http://127.0.0.1:${PORTS.ethereum}`,chainId:31337},trac:{mode:'separate-real-devnet'},prices:{mode:'local',usd:'0'}};
  check(manifest.bitcoin.rpc === `http://127.0.0.1:${PORTS.bitcoin}` && manifest.ord.url === `http://127.0.0.1:${PORTS.ord}` && manifest.ethereum.rpc === `http://127.0.0.1:${PORTS.ethereum}`, 'saved_stack_target_mismatch');
  await privateDir(join(root,'bitcoin')); await privateDir(join(root,'ord'));
  await processes.start('bitcoind','bitcoind',['-regtest',`-datadir=${root}/bitcoin`,'-server=1','-txindex=1','-listen=0','-discover=0','-dnsseed=0','-connect=0','-rpcbind=127.0.0.1','-rpcallowip=127.0.0.1',`-rpcport=${PORTS.bitcoin}`,'-fallbackfee=0.00001','-printtoconsole=1']);
  await until(()=>bitcoin(manifest,'getblockchaininfo'),'Bitcoin',{checkAlive:()=>processes.alive()});
  check((await bitcoin(manifest,'getblockchaininfo')).chain==='regtest','bitcoin_must_be_regtest');
  if(fresh) {
    await bitcoin(manifest,'createwallet',['faucet']);
    manifest.bitcoin.miningAddress=await bitcoin(manifest,'getnewaddress',['','bech32m'],'faucet');
    await bitcoin(manifest,'generatetoaddress',[110,manifest.bitcoin.miningAddress]);
  } else {
    const loaded=await bitcoin(manifest,'listwallets');
    for(const name of ['faucet','ord'])if(!loaded.includes(name))await bitcoin(manifest,'loadwallet',[name]);
  }
  await processes.start('ord',ORD,[...ordArgs(manifest),'--index-addresses','--index-sats','server','--http','--address','127.0.0.1','--http-port',String(PORTS.ord),'--polling-interval','100ms']);
  await waitIndexed(manifest);
  if(fresh) {
    await save(join(root,'ord-wallet-recovery.json'),await ordWallet(manifest,['create']));
    manifest.bitcoin.inscriberAddress=await receiveAddress(manifest);
    await bitcoin(manifest,'sendtoaddress',[manifest.bitcoin.inscriberAddress,100],'faucet'); await mine(manifest);
  }
  await processes.start('anvil','anvil',['--host','127.0.0.1','--port',String(PORTS.ethereum),'--chain-id','31337','--timestamp','1792800000','--silent']);
  await until(()=>rpc(manifest.ethereum.rpc,'eth_chainId'),'Anvil',{checkAlive:()=>processes.alive()});
  check(await rpc(manifest.ethereum.rpc,'eth_chainId')==='0x7a69','ethereum_chain');
  const evm=new EvmJournal(manifest,directory); await evm.restore();
  if(fresh) {
    manifest.ethereum.accounts=await evm.rpc('eth_accounts');
    const artifact=await json(`${BUILD}/target/eth-out/LocalTap.sol/LocalTap.json`), accounts=manifest.ethereum.accounts;
    const hash=await evm.rpc('eth_sendTransaction',[{from:accounts[0],data:artifact.bytecode.object+accounts[0].slice(2).padStart(64,'0'),gas:'0x4c4b40'}]);
    const receipt=await until(()=>evm.rpc('eth_getTransactionReceipt',[hash]),'token deployment'); check(receipt.status==='0x1','token_deployment'); manifest.ethereum.token=receipt.contractAddress;
    for(const account of accounts.slice(0,2)) {
      const data='0x40c10f19'+account.slice(2).padStart(64,'0')+(1000000n*10n**18n).toString(16).padStart(64,'0');
      const hash=await evm.rpc('eth_sendTransaction',[{from:accounts[0],to:receipt.contractAddress,data,gas:'0x30d40'}]);
      check((await evm.rpc('eth_getTransactionReceipt',[hash])).status==='0x1','test_token_funding');
    }
    await evm.checkpoint(); await save(join(root,'manifest.json'),manifest);
  }
  const walletGateway=await startWalletGateway(manifest);
  return {manifest,evm,walletGateway};
}
