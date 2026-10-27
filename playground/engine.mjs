import { operatorCommand } from '../service/scripts/operator.mjs';
import { bindTestPayoutWallets, bindSavedTestPayoutWallets } from './payout-wallets.mjs';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DATA, ROOT, PORTS, TARGET, origin, check, integer, json, maybe, save, randomHex, until, diskFloor } from './common.mjs';
import { bitcoin, mine, ordJson } from '../local/common.mjs';
import { localReads } from '../service/local/reads.mjs';
import { jsonRequest } from '../service/src/http-client.mjs';
import { rules } from '../service/src/rules.mjs';
import { hash, heightKey } from '../service/src/util.mjs';
import { reloadBaseFee } from '../service/scripts/base-fee.mjs';
import { currentFee } from '../service/src/fees.mjs';
import { redeem } from '../local/protocol.mjs';
import { escrowSplitForItems } from '../committee/signer/escrow.mjs';
import { calldata, TYPES } from '../committee/signer/escrow.mjs';
import { Agent } from '../kit/lib/agent.mjs';
import { ServiceClient } from '../kit/lib/service-client.mjs';
import { Journal } from '../kit/lib/journal.mjs';
import { unlock, wipeWallet } from '../kit/lib/keyring.mjs';
import { signPlotRequest } from '../kit/lib/signing.mjs';
import { remoteTrac, historySnapshot, candidate } from './kit-adapter.mjs';
import { makeIdentity } from './bootstrap.mjs';
import { chooseClaims } from '../kit/strategies/default.mjs';
import { findPatterns } from '../kit/lib/search.mjs';

export class Engine {
  constructor(ctx) {Object.assign(this,ctx);this.operatorCommand ??= operatorCommand;this.actors=new Map();this.url=`http://127.0.0.1:${PORTS.gateway}`;this.history=null;this.botTick=0;}
  async init() {
    await until(()=>this.get('/health'),'gateway HTTP',{checkAlive:()=>this.processes.alive()});
    this.reads=await localReads({...this.config,local:{...this.config.local,readerId:'playground'}});this.store=this.reads.store;
    const inscribe=this.write;this.write=async(...args)=>{const id=await inscribe(...args);await this.drain();await this.observeEvents();return id;};
    this.settings=await maybe(join(this.directory,'settings.json'))??{mining:{enabled:TARGET.local.playground.automine===1,intervalMs:30000},bots:{count:TARGET.local.playground.bots,intervalMs:60000,paused:false}};
    await this.drain({timeout:600000});const owner=await this.actor('owner');await this.configureBots(this.settings.bots);
    await bindSavedTestPayoutWallets({playersDirectory:join(DATA,'players'),payoutDirectory:join(this.directory,'payout-wallets'),service:owner.agent.service,active:new Set([...this.actors.values()].map(a=>a.address))});
    return this;
  }
  async close() {for(const a of this.actors.values()){a.journal.close();wipeWallet(a.wallet);}this.reads?.close();}
  async get(path) {check(typeof path==='string'&&path.startsWith('/')&&!path.startsWith('//')&&!path.includes('..'),'gateway_read_path');const r=await jsonRequest(this.url+path,{publicQuery:true,timeout:20000});const b=r.value;if(!r.ok)throw Object.assign(Error(b.error??'gateway_read'),{status:r.status});return b;}
  async post(path,body) {const r=await fetch(this.url+path,{method:'POST',headers:{'content-type':'application/json'},body:rules.stableJSON(body),signal:AbortSignal.timeout(60000)});const b=await r.json();if(!r.ok)throw Error(b.error??'gateway_write');return b;}
  async drain({timeout=180000}={}) {await until(async()=>{const h=await this.get('/health'),head=await this.trac('head');return h.tip===await bitcoin(this.manifest,'getblockcount') && h.observations===0 && (await this.trac('batchLast')).to===head.counted;},'gateway drain',{timeout,checkAlive:()=>this.processes.alive()});}
  async snapshot() {const tip=await bitcoin(this.manifest,'getbestblockhash');if(this.history?.get(this.history.length-1).hash!==tip)this.history=await historySnapshot(this.reads,this.directory);return this.history;}
  patterns() {return this.store.get('meta','patterns')??this.config.patterns;}
  compounds() {return this.store.list('types',{limit:10000}).map(r=>r.value);}
  rows(space,limit=500) {return this.store.list(space,{limit}).map(({id,value})=>value&&typeof value==='object'?{id,...value}:{id,value});}
  async actor(name) {
    if(this.actors.has(name))return this.actors.get(name);
    const identity=await makeIdentity(name),password=await readFile(join(identity.directory,'password'),'utf8'),wallet=await unlock({directory:identity.directory,password});
    const journal=await Journal.open(identity.directory,`${this.state.network}/${identity.address}`,{intervalMs:0,perTip:24});
    const service=new ServiceClient({origin:this.url,network:this.state.network,gateway:this.state.gatewayKey,receiptSigners:this.kitConfig.receiptSigners});
    const trac=remoteTrac(this.state.network,this.trac),agent=new Agent({wallet,service,trac,journal,network:this.state.network,dryRun:false,puzzleBits:0,powLimitBits:0x207fffff,paymentOrigin:this.url});
    const payouts=await bindTestPayoutWallets({directory:identity.directory,wallet,service});
    const actor={...identity,wallet,journal,agent,payouts,strategy:name==='owner'?'player':['prospector','discoverer','crafter'][Number(name.split('-')[1])%3]};this.actors.set(name,actor);return actor;
  }
  async configureBots(args) {
    if(args.resetErrors===true){const path=join(this.directory,'bots.json'),states=await maybe(path)??{};for(const [name,s]of Object.entries(states))if(s&&typeof s==='object'){delete s.halted;delete s.error;if(this.actors.has(name))this.actors.get(name).error=null;}await save(path,states);}
    const b={...this.settings.bots,...Object.fromEntries(Object.entries(args).filter(([k])=>['count','intervalMs','paused'].includes(k)))};integer(b.count,0,100);integer(b.intervalMs,1000,3600000);check(typeof b.paused==='boolean','bots_paused_boolean');
    for(let i=0;i<b.count;i++)await this.actor('bot-'+i);
    const states=await maybe(join(this.directory,'bots.json'))??{};for(const a of this.actors.values())if(states[a.name]?.halted)a.error=states[a.name].error;
    await this.trac('fund');this.settings.bots=b;await this.saveSettings();return this.botState();
  }
  async newAddress(){const {receiveAddress}=await import('../local/common.mjs');return receiveAddress(this.manifest);}
  async saveSettings(){await save(join(this.directory,'settings.json'),this.settings);}
  botState(){return {...this.settings.bots,agents:[...this.actors.values()].filter(a=>a.name!=='owner').slice(0,this.settings.bots.count).map(({name,address,strategy,lastAction,error})=>({name,address,strategy,lastAction,error}))};}
  async blocks(count,{fast=false}={}) {
    integer(count,1,10000);await diskFloor();const before=await bitcoin(this.manifest,'getblockcount');
    for(let left=count;left>0;) {const pending=(await this.get('/health')).pending;const n=fast&&!pending?Math.min(left,100):1;await mine(this.manifest,n);await this.drain();await this.observeEvents();left-=n;this.emit('block',{tip:await bitcoin(this.manifest,'getblockcount'),counted:(await this.trac('head')).counted});}
    return {before,tip:await bitcoin(this.manifest,'getblockcount'),counted:(await this.trac('head')).counted,mined:count};
  }
  async seedDiscoveries(count = 2) {
    const actor = await this.actor('owner');
    while (this.patterns().length < count) {
      const number = this.patterns().length, actionId = 'playground-pattern-' + number;
      const saved = actor.journal.get('discovery/' + actionId);
      let proposal = saved?.body.proposal;
      if (!proposal) {
        const history = await this.snapshot(), tip = (await this.trac('head')).tip;
        const found = await findPatterns({ history, tip, existing: this.patterns(), owner: actor.agent.address, maxCandidates: 200 });
        check(found.accepted.length, 'playground_discovery_unavailable');
        const record = found.accepted[0].record;
        proposal = Object.fromEntries(['name','pat','fld','dt'].map(k => [k, record[k]]));
      }
      const commit = await this.action('discovery/commit', { actionId, proposal });
      const height = (await this.trac('head')).tip.height;
      if (height < commit.revealFrom) await this.blocks(commit.revealFrom - height);
      await this.action('discovery/reveal', { actionId });
      await this.blocks(1);
      check(this.patterns().length > number, 'playground_discovery_not_accepted');
    }
  }
  async claim(actor,args={}) {
    const history=await this.snapshot(),head=await this.trac('head'),round=this.store.get('meta','ruleState')?.rounds.find(r=>r.window===head.tip.height);
    check(round,'claim_round_not_ready');
    const patterns=this.patterns().filter(p=>!args.patterns||args.patterns.includes(p.number));
    const saved=actor.journal.get('claim/'+round.window),settings=await this.trac('settings');
    const plots=args.plots??saved?.body.p.plots??chooseClaims({history,patterns,taken:await actor.agent.takenSlots(patterns),window:round.window,claimableHeight:round.claimableHeight,claimsPerWindow:settings.claimsPerWindow??rules.CLAIM_DEFAULTS.claimsPerWindow});
    if(!plots.length)return actor.agent.headers({height:round.window,raw:Buffer.from(history.raw(round.window)).toString('hex'),history});
    return actor.agent.claim({event:{window:round.window,claimableHeight:round.claimableHeight,hash:round.windowHash},plots,history,patterns:this.patterns(),header:{height:round.window,raw:Buffer.from(history.raw(round.window)).toString('hex')}});
  }
  async publicationFor(actor,actionId) {
    const saved=actor.journal.get('discovery/'+actionId+'/commit');check(saved,'discovery_missing');
    for(const {value:b} of this.store.list('batches',{limit:100000}))for(const p of b.publications??[]){const raw=await readFile(join(this.config.data,'static',p.audit.path.slice(1)));const f=rules.decodeBinary(raw);if(f.receipts?.some(r=>r.move===saved.result?.move))return p;}
    throw Error('discovery_publication_not_ready');
  }
  async paid(actor,op,value,actionId) {
    const result=await actor.agent.transaction({actionId,op,value});
    await until(async()=>{const s=await this.trac('kitStatus',[result.tx]);check(s.state!=='rejected','transaction_rejected');return s.state==='accepted';},'paid transaction',{timeout:30000});
    return {...result,state:'accepted'};
  }
  async registerPatterns() { return this.operatorCommand(this.config, { action: 'provision' }); }
  async ensureAsset(asset) {
    return this.operatorCommand(this.config, { action: 'provision', asset });
  }
  async action(path,args={},name='owner') {
    const a=await this.actor(name),actionId=args.actionId??randomUUID(),head=await this.trac('head');check(typeof actionId==='string'&&/^[A-Za-z0-9._-]{1,64}$/.test(actionId),'action_id');let result;
    if(path==='header')result=await a.agent.headers({height:head.tip.height,raw:await bitcoin(this.manifest,'getblockheader',[head.tip.hash,false]),history:await this.snapshot()});
    else if(path==='claim')result=await this.claim(a,args);
    else if(path==='discovery/commit')result=await a.agent.propose({actionId,proposal:args.proposal,history:await this.snapshot(),patterns:this.patterns()});
    else if(path==='discovery/reveal')result=await a.agent.reveal({actionId,publication:await this.publicationFor(a,actionId),history:await this.snapshot(),patterns:this.patterns()});
    else if(path==='craft'){result=await a.agent.craft({actionId,recipe:args.recipe??'fusion',inputs:args.inputs,patterns:this.patterns(),compounds:this.compounds()});await this.blocks(1);}
    else if(path==='transfer')result=await this.paid(a,'tf',{to:args.to,assets:args.assets},actionId);
    else if(path==='mint/quote'){result=await this.post('/mint/quote',{asset:args.asset,...(args.block===undefined?{}:{block:args.block}),...(args.amount===undefined?{}:{amount:args.amount}),kind:args.kind??'tap'});}
    else if(path==='mint'||path==='compound/mint') {
      const deployment=await this.ensureAsset(args.asset),isCompound=path==='compound/mint',kind=args.kind??'tap';
      if(deployment.state!=='registered')return this.post('/mint/quote',{asset:args.asset,...(args.block===undefined?{}:{block:args.block}),...(args.amount===undefined?{}:{amount:args.amount}),kind});
      const c=isCompound?undefined:await candidate(this.reads,args.asset,args.block,kind);
      result=await a.agent.makeReal({actionId,asset:args.asset,amount:args.amount??String(c.find.count),...(isCompound?{}:{block:args.block}),receiver:args.receiver??this.state.addresses.receiver,payer:args.payer??(kind==='tap'?this.state.addresses.payer:this.state.ethPayer),kind,candidate:c,compound:isCompound});
      result.request=await this.waitMintReady(result.request.id);
    }
    else if(path==='bitmap'){integer(args.height,1,head.tip.height);const savedPath=join(this.directory,'bitmap-'+a.address+'-'+args.height+'.json'),saved=await maybe(savedPath);if(saved)return saved;const id=await this.write(args.height+'.bitmap',this.reads.bindings.current(a.address,'tap').request.address);result={height:args.height,inscription:id,bitmap:await this.reads.tap('getBitmap/'+args.height)};await save(savedPath,result);}
    else if(path==='link') {
      integer(args.height,0,head.tip.height);const secretPath=join(this.directory,'link-'+actionId+'.json');let saved=await maybe(secretPath);
      if(!saved){const preimage=randomHex(),request={owner:a.address,height:args.height,nonce:randomHex(),until:head.counted+80};saved={preimage,body:{request,sig:signPlotRequest(a.wallet,'link',this.state.network,request,head.counted),payer:this.state.addresses.payer,paymentHash:hash(Buffer.from(preimage,'hex'))}};await save(secretPath,saved);}
      const request=await this.post('/link/request',saved.body);await save(join(this.directory,'link-secret-'+request.id+'.json'),saved);result={state:'submitted',request};
    }
    else if(path==='pay')result=await this.pay(args);
    else if(path==='payment')result=await this.submitPayment(args);
    else throw Error('unknown_player_action');
    this.emit(name==='owner'?'player':'bot',{actor:a.address,name,strategy:a.strategy,action:path,result});return result;
  }
  async observeEvents() {
    const cursor=this.eventCursor??={batches:0,patterns:new Set(),mints:new Map()};
    const last=await this.trac('batchLast');
    if(last.n>cursor.batches){
      const start=Math.max(cursor.batches+1,last.n-20);
      for(let n=start;n<=last.n;n++){
        const batch=this.store.get('batches',heightKey(n));if(!batch)continue;
        for(const p of batch.publications??[]){
          const file=rules.decodeBinary(await readFile(join(this.config.data,'static',p.audit.path.slice(1))));
          this.emit('block',{tip:file.tip,counted:file.height,windows:(file.settlements??[]).map(s=>s.window),found:(file.settlements??[]).flatMap(s=>(s.winners??[]).map(w=>w.block))});
          if(file.settlements?.length)this.emit('draw',{height:file.height,settlements:file.settlements});
          if(file.discoveries?.length)this.emit('discovery',{height:file.height,discoveries:file.discoveries});
          if(file.receipts?.length)this.emit('receipts',{tip:file.tip,count:file.receipts.length,publication:p});
        }
      }
      cursor.batches=last.n;
    }
    for(const {id,value:r} of this.store.list('mints'))if(cursor.mints.get(id)!==r.state){cursor.mints.set(id,r.state);this.emit('payment',{id,state:r.state,asset:r.request.asset,block:r.request.block,kind:r.kind,inscription:r.observation?.inscription??null});}
  }
  async evmSend(from,to,data){const tx=await this.evm.rpc('eth_sendTransaction',[{from,...(to?{to}:{}),data,gas:'0x7a1200'}]);const receipt=await until(()=>this.evm.rpc('eth_getTransactionReceipt',[tx]),'Ethereum transaction');check(receipt.status==='0x1','ethereum_transaction_reverted');await this.evm.checkpoint();return receipt;}
  async submitPayment({id,paymentId,inscription}) {
    check(/^[0-9a-f]{64}$/.test(id),'payment_request');
    return this.post('/mint/payment',{id,...(inscription?{inscription}:{paymentId})});
  }
  async waitMintReady(id) {
    let row=await this.get('/mint/'+id);
    if(this.store.get('mints',id)?.state==='reserving'){
      await until(()=>this.store.get('mintInputs','rq/'+id)||this.store.get('mints',id)?.state!=='reserving','request queued',{checkAlive:()=>this.processes.alive()});
      if(this.store.get('mints',id)?.state==='reserving')await this.blocks(1);
    }
    return until(async()=>{
      row=await this.get('/mint/'+id);
      if(['rejected','failed','expired','cancelled','returning','refund_wait','quarantined','recovery'].includes(row.state))throw Object.assign(Error(row.reason??row.state),{fatal:true});
      return ['reserving','enrolling'].includes(row.state)?false:row;
    },'mint enrollment',{checkAlive:()=>this.processes.alive()});
  }
  async pay({id,type='mint'}) {
    check(/^[0-9a-f]{64}$/.test(id)&&['mint','link'].includes(type),'payment_request');
    const savedPath=join(this.directory,'payment-'+id+'.json');let saved=await maybe(savedPath);
    if(saved?.state==='complete')return saved.result;
    const s=this.state,payerKey=Buffer.from(s.payerKey,'hex'),releaseKey=Buffer.from(s.releaseKey,'hex');
    const checkpoint=async patch=>{saved={...saved,...patch};await save(savedPath,saved);};
    if(type==='mint') {
      let row=await this.waitMintReady(id);const full=this.store.get('mints',id);
      check(full.payer===(full.kind==='tap'?s.addresses.payer:s.ethPayer),'external_payer_use_payment_submission');
      if(row.state==='minted')return {id,request:row};
      if(!saved){
        check(['awaiting_payment','partly_paid'].includes(row.state)&&row.payable,'mint_not_payable');
        await checkpoint({state:'started',id,type,at:Date.now()});
        let paymentId;
        if(full.kind==='tap'){
          paymentId=await this.write(redeem(s.payerAuthority,[],payerKey,{items:rules.walletFeeItems(row.missing??row.fees, 'regtest'),data:id}),s.addresses.payer);
        }else{
          const split=escrowSplitForItems(row.missing??row.fees),expiry=(BigInt((await this.evm.rpc('eth_getBlockByNumber',['latest',false])).timestamp)+864000n).toString();
          await this.evmSend(s.ethPayer,s.escrow.token,calldata('approve(address,uint256)',[['address',s.escrow.address],['uint256',row.payableAmount]]));
          await this.evmSend(s.ethPayer,s.escrow.address,calldata('deposit(bytes32,uint256,(address,uint256,address,uint256,address,uint256,address,uint256,uint256),uint256)',[['bytes32',id],['uint256',row.payableAmount],...TYPES.Split.map(({name,type})=>[type,split[name]]),['uint256',expiry]]));paymentId=id;
        }
        await checkpoint({state:'funded',paymentId});
      }
      check(saved.paymentId,'uncertain_payment_inspect_saved_evidence');
      if(!['permit_issued','minted'].includes(row.state))await this.post('/mint/payment',{id,paymentId:saved.paymentId});
      for(let i=0;i<8;i++){
        row=await this.get('/mint/'+id);if(['permit_issued','minted'].includes(row.state))break;
        await this.blocks(1);
        await new Promise(r=>setTimeout(r,300));
        if(row.ethereumRelease&&!saved.release){const r=row.ethereumRelease;await this.evmSend(s.ethPayer,r.to,r.data);await checkpoint({release:true});}
      }
      check(row.state==='permit_issued'||row.state==='minted','mint_permit_pending_retry');
      if(row.state!=='minted'){
        if(!saved.inscription){check(!saved.inscriptionStarted,'uncertain_inscription_inspect_saved_evidence');await checkpoint({inscriptionStarted:true});const inscription=await this.write(row.mintContent,row.receiver);await checkpoint({inscription});}
        await this.post('/mint/payment',{id,inscription:saved.inscription});
        row=await until(async()=>{const r=await this.get('/mint/'+id);return r.state==='minted'?r:false;},'player mint indexing');
      }
      const result={id,paymentId:saved.paymentId,request:row};await checkpoint({state:'complete',result});this.emit('payment',result);return result;
    }
    const row=this.store.get('linkIntents',id);check(row,'payment_missing');
    row.split=rules.splitFee(rules.feeFor(type,row.terms.baseFee,1),{kind:type});
    if(!saved){
      check((await this.trac('head')).counted+1<=row.request.until,'payment_window_too_short');
      check((await this.reads.bitmap(row.request.height)).agent===row.request.owner,'bitmap_holder_changed');
      await checkpoint({state:'started',id,type,at:Date.now()});
      const lock=await this.write(redeem(s.payerAuthority,[rules.tapPaymentLock({split:row.split,destinations:{treasury:s.addresses.treasury},kind:type,payer:s.addresses.payer,hash:row.terms.hash,expiry:row.refundAfter??row.request.until+144})],payerKey,{data:id}),s.addresses.payer);
      await checkpoint({state:'funded',paymentId:lock+':0'});
    }
    check(saved.paymentId,'uncertain_payment_inspect_saved_evidence');const paymentId=saved.paymentId;
    if(type==='link'){
      if(!await this.reads.tap('getLockConsume/'+paymentId)){
        check(!saved.releaseStarted,'uncertain_release_inspect_saved_evidence');
        const secret=await json(join(this.directory,'link-secret-'+id+'.json'));await checkpoint({releaseStarted:true});
        const release=await this.write(redeem(s.releaseAuthority,[{op:'claim',lock:paymentId,preimage:secret.preimage}],releaseKey,{data:id}),s.addresses.release);await checkpoint({release});
      }
      await this.post('/link/payment',{id,paymentId});await this.blocks(1);await until(()=>this.store.get('linkStatus',id)?.state==='accepted','Bitmap link');
    }
    const result={id,paymentId,type,state:'complete',height:row.request.height};await checkpoint({state:'complete',result});this.emit('payment',result);return result;
  }
}
