import fs from 'node:fs/promises';
import { PORTS } from './common.mjs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../contract/package.json', import.meta.url));
const { default: createTestnet } = await import(require.resolve('hyperdht/testnet.js'));
const { MainSettlementBus } = await import(require.resolve('trac-msb/src/index.js'));
const { createConfig: createMsbConfig, ENV: MSB_ENV } = await import(require.resolve('trac-msb/src/config/env.js'));
const { Config: MsbConfig } = await import(require.resolve('trac-msb/src/config/config.js'));
const { applyStateMessageFactory } = await import(require.resolve('trac-msb/src/messages/state/applyStateMessageFactory.js'));
const { safeEncodeApplyOperation } = await import(require.resolve('trac-msb/src/utils/protobuf/operationHelpers.js'));
const { bigIntTo16ByteBuffer } = await import(require.resolve('trac-msb/src/utils/amountSerialization.js'));
const { Peer, Wallet, createConfig, ENV } = await import(require.resolve('trac-peer'));
const { default: PeerWallet } = await import(require.resolve('trac-wallet'));
import CoinProtocol from '../contract/protocol.js';
import CoinContract from '../contract/contract.js';
import { deployment } from '../contract/tests/helpers/harness.mjs';
import { fanOutValidatorSends } from '../contract/runtime/fanout.js';

export const sleep = ms => new Promise(r=>setTimeout(r,ms));
export async function until(fn, label, timeout=15000) {
  const end=Date.now()+timeout;
  do { const result=await fn(); if(result)return result; await sleep(20); } while(Date.now()<end);
  throw new Error(`Timed out: ${label}`);
}
export async function localNetwork({ directory } = {}) {
  await fs.mkdir(directory, {recursive:true, mode:0o700});
  const root=directory;
  const net=await createTestnet(3, { port: PORTS.dht }); const peers=[]; const buses=[];
  const dhtBootstrap=net.bootstrap.map(x=>`${x.host}:${x.port}`);
  const close=async()=>{
    let failure;
    for(const p of peers.reverse()) {
      try { await p.close(); } catch(e) { failure ??= e; }
      try { await p.store.close(); } catch(e) { failure ??= e; }
    }
    for(const b of buses.reverse()) try { await b.close(); } catch(e) { failure ??= e; }
    await net.destroy();
    if (failure) throw failure;
  };
  async function wallet(name, raw = false) {
    const w=raw ? new PeerWallet() : new Wallet(); await w.ready;
    const filename=path.join(root,name,'db/keypair.json'); await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});
    try { await fs.access(filename); w.importFromFile(filename,Buffer.alloc(0)); }
    catch(e) { if(e.code !== 'ENOENT') throw e; await w.generateKeyPair(); w.exportToFile(filename,Buffer.alloc(0)); await fs.chmod(filename,0o600); }
    return w;
  }
  async function msb() {
    const w=await wallet('msb-admin', true);
    const options={storeName:'msb-admin',storesDirectory:path.join(root,'bus-admin'),bootstrap:'aa'.repeat(32),channel:'dmw-local-msb',dhtBootstrap,
      enableInteractiveMode:false,enableWallet:true,enableValidatorObserver:false,enableRoleRequester:false,enableErrorApplyLogs:true,enableTxApplyLogs:false};
    const config = () => new MsbConfig(options, createMsbConfig(MSB_ENV.DEVELOPMENT));
    const saved = await fs.readFile(path.join(root,'msb-bootstrap.json'),'utf8').then(JSON.parse).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
    if(saved) { options.bootstrap=saved.key; const b=new MainSettlementBus(config(),w); buses.push(b); await b.ready(); await until(()=>b.state.getAdminEntry(),'MSB restored'); return b; }
    let b=new MainSettlementBus(config(),w);buses.push(b);await b.ready();
    options.bootstrap=b.state.writingKey.toString('hex');await b.close();buses.pop();
    b=new MainSettlementBus(config(),w);buses.push(b);await b.ready();
    await b.state.append(null);
    const msg=await applyStateMessageFactory(w,b.config).buildCompleteAddAdminMessage(w.address,b.state.writingKey,await b.state.getIndexerSequenceState());
    await b.state.append(safeEncodeApplyOperation(msg));
    await until(()=>b.state.getAdminEntry(),'MSB admin');
    await fs.writeFile(path.join(root,'msb-bootstrap.json'),JSON.stringify({key:options.bootstrap}),{mode:0o600});
    return b;
  }
  async function fund(b,w,units=1000000000000000000000n) {
    if(await b.state.getNodeEntry(w.address)) return;
    const msg=await applyStateMessageFactory(b.wallet,b.config).buildCompleteBalanceInitializationMessage(b.wallet.address,w.address,bigIntTo16ByteBuffer(units),await b.state.getIndexerSequenceState());
    await b.state.append(safeEncodeApplyOperation(msg));
    return until(()=>b.state.getNodeEntry(w.address),'MSB funded account');
  }
  async function client(b) {
    const w=await wallet('msb-client',true);
    const config=new MsbConfig({storeName:'msb-client',storesDirectory:path.join(root,'bus-client'),bootstrap:b.config.bootstrap,
      channel:'dmw-local-msb',dhtBootstrap,enableInteractiveMode:false,enableWallet:true,enableValidatorObserver:false,enableRoleRequester:false}, createMsbConfig(MSB_ENV.DEVELOPMENT));
    const c=new MainSettlementBus(config,w);buses.push(c);await c.ready();fanOutValidatorSends(c.network);
    await c.network.tryConnect(b.wallet.publicKey.toString('hex'),'validator');
    await until(()=>c.state.getAdminEntry(),'MSB client sync');
    await until(()=>c.network.validatorConnectionManager.connectionCount()>0,'MSB validator connection');
    return c;
  }
  async function peer(name,b,bootstrap=null, options={}) {
    const w=await wallet(name);
    const config=createConfig(ENV.DEVELOPMENT,{txContentHash:'utf8-strict',storeName:name,storesDirectory:root,bootstrap,channel:'dmw-local-subnet',dhtBootstrap,
      replicate:true,enableUpdater:true,enableBackgroundTasks:true,apiMsgExposed:true,apiTxExposed:true,enableTxlogs:false,...options});
    config.dmw={...deployment,...options.dmw};
    const p=new Peer({config,msb:b,wallet:w,protocol:CoinProtocol,contract:CoinContract});peers.push(p);await p.ready();return p;
  }
  return {root,net,dhtBootstrap,peers,buses,close,wallet,msb,client,fund,peer};
}
