import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from '../service/src/util.mjs';
import { rules } from '../service/src/rules.mjs';
import { heightKey } from '../service/src/util.mjs';
import { bitcoin } from '../local/common.mjs';
import { currentFee } from '../service/src/fees.mjs';
import { calldata } from '../committee/signer/escrow.mjs';
import { json, integer, PORTS, origin, check } from './common.mjs';

export { bitmapHistoryPage, walletBitmaps } from '../service/local/bitmaps.mjs';
import { walletBitmaps } from '../service/local/bitmaps.mjs';

// Read the complete local index; HTTP pagination is applied after filtering/sorting.
export function viewRows(e, space) {
  if (!e.store?.database) return e.rows(space, Number.MAX_SAFE_INTEGER);
  return e.store.database().prepare('SELECT id,value FROM records WHERE space=? ORDER BY id').all(space)
    .map(({id,value})=>{const v=JSON.parse(value);return v&&typeof v==='object'?{id,...v}:{id,value:v};});
}
const viewCompounds = e => e.store?.database ? viewRows(e,'types') : e.compounds();

export function createViews(e) {
  const plots=async(from,to)=>{
    const head=await e.trac('head');integer(from,0,head.tip.height);integer(to,from,head.tip.height);
    const history=await e.snapshot(),finds=viewRows(e,'finds'),byBlock=new Map();for(const f of finds){if(!byBlock.has(f.block))byBlock.set(f.block,[]);byBlock.get(f.block).push({...f,minted:!!e.store.get('minted',`${f.asset}/${f.block}`)});}const rounds=e.store.get('meta','ruleState')?.rounds??[];
    const mintedBlocks=new Set(viewRows(e,'minted').map(r=>Number(r.id.split('/').at(-1))));
    return {tip:head.tip.height,counted:head.counted,from,to,plots:Array.from({length:to-from+1},(_,i)=>{
      const height=from+i,round=rounds.find(r=>r.window===head.tip.height),claims=(round?.claims??[]).filter(c=>c.block===height).length;
      return {height,...rules.plotRegion(height),hash:history.get(height).hash,found:!!byBlock.get(height)?.length,claims,claimWindow:round?.window??null,linked:!!e.store.get('links',heightKey(height)),minted:mintedBlocks.has(height),finds:byBlock.get(height)??[]};
    })};
  };
  const rights=async(owner,onlyBlock)=>{
    const head=await e.trac('head'),registry=await e.reads.registry(),patterns=e.patterns(),history=await e.snapshot(),finds=viewRows(e,'finds'),out=[];
    const records=finds.filter(f=>f.finder&&f.findHeight<=head.counted&&(onlyBlock===undefined||f.block===onlyBlock));
    for(const find of records){
      const link=await e.reads.link(find.block);let currentHolder=null;
      if(link)currentHolder=await e.reads.bitmap(find.block).then(b=>b.agent).catch(()=>null);
      const r=rules.mintRight({find,owner,counted:head.counted,link,currentHolder}),minted=e.store.get('minted',`${find.asset}/${find.block}`),pending=await e.trac('hold',[find.asset,find.block]);
      const balance=await e.trac('balance',[owner,find.asset]),deploymentRegistered=!!registry.assets[find.asset];
      out.push({asset:find.asset,block:find.block,amount:String(find.count),deploymentRegistered,allowed:deploymentRegistered&&r.allowed&&!minted&&!pending&&BigInt(balance)>=BigInt(find.count),rightAllowed:r.allowed,whoMayMint:r.role,reason:minted?'minted':pending?'pending':!deploymentRegistered?'asset_unregistered':BigInt(balance)<BigInt(find.count)?'insufficient_balance':r.role,finderUntil:find.findHeight===null?null:find.findHeight+1008,minted,pending,finder:find.finder,link,currentHolder});
    }return out;
  };
  const playerList=async kind=>{
    const actor=await e.actor('owner');
    if(kind==='items')return [];
    if(kind==='balances'){
      const assets=[...e.patterns().map(rules.patternAsset),...viewCompounds(e).map(c=>c.id)],balances=[];
      for(const asset of assets)balances.push({asset,amount:await e.trac('balance',[actor.address,asset])});
      return balances;
    }
    if(kind==='bitmaps')return walletBitmaps(e,actor.address);
    if(kind==='mintRights')return rights(actor.address);
    if(kind==='history')return actor.journal.db.prepare('SELECT rowid AS sequence,id,state FROM actions WHERE scope=? ORDER BY rowid').all(actor.journal.scope).map(r=>({...r,type:r.id.split('/')[0]}));
    if(kind==='discoveries'){
      const head=await e.trac('head');
      return actor.journal.db.prepare("SELECT id FROM actions WHERE scope=? AND id LIKE 'discovery/%'").all(actor.journal.scope).filter(r=>r.id.split('/').length===2).map(r=>{const entry=actor.journal.get(r.id),commit=actor.journal.get(r.id+'/commit'),reveal=actor.journal.get(r.id+'/reveal'),p=entry.body.proposal,accepted=e.patterns().find(v=>v.name===p.name&&v.discoverer===actor.address);const until=(commit?.result?.tip??0)+rules.DISCOVERY_LIMITS.lifetime;return {actionId:r.id.slice(10),...p,revealFrom:(commit?.result?.tip??0)+2,revealUntil:until,state:accepted?'accepted':reveal?.state==='received'?'revealed':head.tip.height>until?'rejected':'committed',reason:!accepted&&!reveal&&head.tip.height>until?'reveal_window_expired':null,asset:accepted?rules.patternAsset(accepted):null};});
    }
    if(kind==='pendingPayments'){
      const pendingPayments=[];
      for(const r of viewRows(e,'mints'))if(r.request.owner===actor.address&&!['minted','cancelled','failed','rejected'].includes(r.state))pendingPayments.push({...await e.get('/mint/'+r.id),type:'mint',kind:r.kind,asset:r.request.asset,block:r.request.block,amount:r.request.amount});
      for(const r of viewRows(e,'linkIntents'))if(r.request.owner===actor.address&&e.store.get('linkStatus',r.id)?.state!=='accepted')pendingPayments.push({id:r.id,type:'link',height:r.request.height,expiry:r.request.until,state:e.store.get('linkStatus',r.id)?.state??'waiting_payment',unit:rules.TAP_UNIT,price:rules.feeFor('link',r.terms.baseFee)});
      return pendingPayments;
    }
    throw Error('unknown_player_collection');
  };
  const player=async()=>{
    const actor=await e.actor('owner'),collections={};
    for(const kind of ['balances','items','bitmaps','discoveries','pendingPayments','mintRights','history'])collections[kind]=await playerList(kind);
    return {address:actor.address,...collections,wallets:{bitcoin:{address:e.state.addresses.payer,bitmapAddress:e.state.addresses.finder,receiver:e.state.addresses.receiver,btc:await bitcoin(e.manifest,'getbalance',[],'ord'),tap:await e.reads.tap('getBalance/'+e.state.addresses.payer+'/tap')},ethereum:{address:e.state.ethPayer,rpc:e.manifest.ethereum.rpc,chainId:31337,token:e.state.escrow.token,escrow:e.state.escrow.address,balance:BigInt(await e.evm.rpc('eth_getBalance',[e.state.ethPayer,'latest'])).toString()}}};
  };
  const localPlayer=async()=>{
    const actor=await e.actor('owner'),collections={};
    for(const kind of ['items','discoveries','pendingPayments','history'])collections[kind]=await playerList(kind);
    return {localData:{label:"your agent's local data",fields:{discoveries:true,pendingPayments:true,history:true,wallets:true}},address:actor.address,...collections,wallets:{bitcoin:{address:e.state.addresses.payer,bitmapAddress:e.state.addresses.finder,receiver:e.state.addresses.receiver,btc:await bitcoin(e.manifest,'getbalance',[],'ord'),tap:await e.reads.tap('getBalance/'+e.state.addresses.payer+'/tap')},ethereum:{address:e.state.ethPayer,rpc:e.manifest.ethereum.rpc,chainId:31337,token:e.state.escrow.token,escrow:e.state.escrow.address,balance:BigInt(await e.evm.rpc('eth_getBalance',[e.state.ethPayer,'latest'])).toString()}}};
  };
  const resultList=async kind=>{
    if(kind==='mints'){
      const out=[];for(const r of viewRows(e,'mints'))out.push({...await e.get('/mint/'+r.id),asset:r.request.asset,block:r.request.block,amount:r.request.amount,kind:r.kind,owner:r.request.owner});return out;
    }
    if(kind==='ethereum'){
      const out=[];for(const r of viewRows(e,'mints').filter(r=>r.kind==='ethereum'&&r.paymentId))out.push({id:r.id,...await e.reads.escrow.deposit(r.payer,r.id)});return out;
    }
    if(kind==='payments'){
      const out=[],ids=new Set([...viewRows(e,'mints').filter(r=>r.kind==='tap').map(r=>r.paymentId),...viewRows(e,'linkRequests').map(r=>r.paymentId)].filter(Boolean));
      for(const id of ids){const consumed=await e.reads.tap('getLockConsume/'+id).catch(()=>null);if(consumed)out.push({id,consumed});}return out;
    }
    if(kind==='payouts')return viewRows(e,'payoutTotals').map(r=>({...r,owed:(BigInt(r.accrued)-BigInt(r.paid)).toString()}));
    if(kind==='owed')return viewRows(e,'commissionOwed');
    if(kind==='paid')return viewRows(e,'payoutPaid');
    if(kind==='links')return viewRows(e,'links');
    throw Error('unknown_result_collection');
  };
  return {
    player,localPlayer,playerList,resultList,rights,plots,
    async status(){const h=await e.trac('head'),health=await e.get('/health'),fee=currentFee(await json(e.config.local.registry)),batch=await e.trac('batchLast'),bitcoinTip=await bitcoin(e.manifest,'getblockcount'),catchingUp=health.tip!==bitcoinTip||h.tip.height!==bitcoinTip||health.observations>0||batch.to!==h.counted;return {version:1,units:{tap:18,bridgedTap:18,bitcoin:8,ethereum:18,matter:0},state:e.processes.failure?'failed':'ready',network:e.state.network,tip:h.tip.height,counted:h.counted,batch,bitcoinTip,catchingUp,mining:e.settings.mining,bots:e.settings.bots,feePolicy:{baseFee:fee.baseFee,feeSettings:fee.feeSettings??rules.FEE_DEFAULTS,unit:rules.TAP_UNIT,revision:fee.id},components:[...[...new Map(e.processes.rows.map(r=>[r.name,r])).values()].map(r=>({name:r.name,pid:r.pid,state:e.processes.children.find(c=>c.child.pid===r.pid)?.child.exitCode===null?'ready':r.pid===process.pid?'ready':'stopped'})),{name:'wallet-gateway',state:'ready',url:e.manifest.gateway.url},{name:'payout-ledger',state:'ready'}],history:{kind:'regtest',seedBlocks:e.state.seedBlocks},player:{address:e.state.player.address},consoleOrigin:origin,worker:catchingUp?health.worker:null,lastWorkerError:health.worker,settings:await e.trac('settings')};},
    async block(height){return e.get('/blocks/'+height);},
    async patterns(){const registry=await e.reads.registry(),supply=await e.trac('assetSupply'),mints=viewRows(e,'mints').filter(r=>r.state==='minted');const names=new Map(e.patterns().map(p=>[rules.patternAsset(p),p.name]));const label=c=>`${c.recipe==='resonance'?'Resonance':'Fusion'}: ${c.inputs.map(([asset,amount])=>`${amount} ${names.get(asset)??('Compound '+asset.slice(0,8))}`).join(' + ')}`;const patterns=e.patterns().map(p=>{const asset=rules.patternAsset(p);return {...p,asset,supply:supply[asset]??'0',minted:mints.filter(r=>r.request.asset===asset).length,madeReal:mints.filter(r=>r.request.asset===asset).reduce((n,r)=>n+BigInt(r.request.amount),0n).toString()};});return {patterns,compounds:viewCompounds(e).map(({amount,...c})=>({...c,name:label(c),tier:c.tier??null,token:registry.assets[c.id]?.tick??null,supply:supply[c.id]??'0',madeReal:mints.filter(r=>r.request.asset===c.id).reduce((n,r)=>n+BigInt(r.request.amount),0n).toString()}))};},
    finds(){return {finds:viewRows(e,'finds').map(f=>({...f,minted:!!e.store.get('minted',`${f.asset}/${f.block}`)}))};},
    receipts(){return {receipts:viewRows(e,'receiptObservations').map(r=>({id:r.id,height:Number(r.id.split('/')[0]),seal:r.seal,archive:r.archive}))};},
    async results(){
      const collections={};for(const kind of ['mints','payments','ethereum','payouts','owed','paid','links'])collections[kind]=await resultList(kind);
      const tapBurn=collections.payments.filter(r=>r.consumed.action==='claim').reduce((sum,r)=>sum+(r.consumed.al??[]).filter(a=>a.tt==='b').reduce((n,a)=>n+BigInt(a.amt),0n),0n);
      return {unit:rules.TAP_UNIT,...collections,treasury:{bitcoin:e.state.addresses.treasury,tap:await e.reads.tap('getBalance/'+e.state.addresses.treasury+'/tap'),ethereum:e.state.ethTreasury,erc20:BigInt(await e.evm.rpc('eth_call',[{to:e.state.escrow.token,data:calldata('balanceOf(address)',[['address',e.state.ethTreasury]])},'latest'])).toString()},burn:{tap:tapBurn.toString(),ethereum:collections.ethereum.filter(r=>r.deposit.status===2).reduce((n,r)=>n+BigInt(r.deposit.split?.burnAmount??0),0n).toString()},outstandingSupply:{ethereum:BigInt(await e.evm.rpc('eth_call',[{to:e.state.escrow.token,data:calldata('totalSupply()',[])},'latest'])).toString()}};
    }
  };
}
