import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletJournal, tapAccount, ethAccount, receipt, orderResult } from '../public/web/wallets.js';
import { WebCheckout, linkWalletMessage } from '../src/web-checkout.mjs';
import { agent, signEd } from './helpers.mjs';
import { signTestPayout, testPayoutAddress } from './payout-wallets.mjs';
import { rules } from '../src/rules.mjs';
import { createRecordHighlights } from '../src/web-records.mjs';
const config={mode:'regtest',network:'dmw-regtest',endpoints:{ethereum:'http://127.0.0.1:58545'},local:{escrow:{chainId:'31337'}}};
const target={bitcoinNetwork:'regtest',ethereum:{chainId:'0x7a69',localRpc:config.endpoints.ethereum}};
function store() { const rows=new Map();return { get:(s,id)=>rows.get(s+'/'+id)??null,put:async(s,id,v)=>rows.set(s+'/'+id,v),transact:async ops=>{for(const o of ops)if(o.value===undefined)rows.delete(o.space+'/'+o.id);else rows.set(o.space+'/'+o.id,o.value);},list:(s,{after='',limit=200}={})=>[...rows].filter(([k])=>k.startsWith(s+'/')&&k.slice(s.length+1)>after).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit).map(([k,value])=>({id:k.slice(s.length+1),value})) }; }
test('wallet journal resumes once, permits explicit rejection retries, and stops uncertain sends', async () => {
  const rows=new Map();globalThis.localStorage={getItem:k=>rows.get(k),setItem:(k,v)=>rows.set(k,v)};
  const j=new WalletJournal('test');let sent=0;
  assert.equal(await j.step('deposit',async()=>{sent++;return 'tx';}),'tx');
  assert.equal(await new WalletJournal('test').step('deposit',async()=>{sent++;}),'tx');assert.equal(sent,1);
  await assert.rejects(j.step('cancel',async()=>{throw Object.assign(Error('cancelled'),{code:4001});}),/cancelled/);
  assert.equal(await j.step('cancel',async()=>'retry'),'retry');
  await assert.rejects(j.step('uncertain',async()=>{throw Error('network_disconnected');}),/network_disconnected/);
  await assert.rejects(j.step('uncertain',async()=>{sent++;}),/interrupted/);assert.equal(sent,1);
});
test('wallet network and payer checks fail before spending and add only configured local Anvil', async () => {
  let network='mainnet';globalThis.window={tapprotocol:{getNetwork:async()=>network,switchNetwork:async n=>{network=n;},requestAccounts:async()=>['bcrt1ptest']}};
  await tapAccount(target,'bcrt1ptest');assert.equal(network,'regtest');await assert.rejects(tapAccount(target,'bcrt1pother'),/payer/);
  let chain='0x1',added=false;const calls=[];
  window.ethereum={request:async({method,params})=>{calls.push(method);if(method==='eth_chainId')return chain;if(method==='wallet_switchEthereumChain'){if(!added)throw Object.assign(Error(),{code:4902});chain=params[0].chainId;}if(method==='wallet_addEthereumChain'){assert.deepEqual(params[0].rpcUrls,[config.endpoints.ethereum]);added=true;}if(method==='eth_requestAccounts')return ['0x'+'12'.repeat(20)];}};
  await ethAccount(target,'0x'+'12'.repeat(20));assert.equal(chain,'0x7a69');assert.ok(calls.includes('wallet_addEthereumChain'));assert.ok(!calls.includes('eth_sendTransaction'));
  await assert.rejects(ethAccount(target,'0x'+'34'.repeat(20)),/payer/);
});
test('reverted Ethereum receipts and malformed TAP orders never count as success', async () => {
  await assert.rejects(receipt({request:async()=>({status:'0x0'})},'0x'+'ab'.repeat(32)),/reverted/);
  await assert.rejects(orderResult({}, {txid:'a'.repeat(64)}),/inscription order/);
});
test('Bitmap checkout binds its browser-chosen hash to the real payer proof and cannot be replaced', async () => {
  const s=store(),who=agent(919),secret='33'.repeat(32),payer=testPayoutAddress(secret,'tap'),sent=[];
  const c=new WebCheckout({store:s,config,reads:{counted:async()=>20,bitmap:async()=>({agent:who.address,address:payer}),link:async()=>null},post:async(path,body)=>{sent.push(body);return {id:rules.linkId(config.network,body.request)};}});
  const r={owner:who.address,height:5,nonce:'44'.repeat(32),until:100};
  const body={request:r,sig:signEd(rules.paymentDigest(config.network,r,'link'),who.secret),payer};
  const pending=await c.enrollLink(body);assert.equal(pending.state,'awaiting_wallet');assert.equal((await c.plan('link',pending.id)).walletPreparation,true);
  const hash='55'.repeat(32),message=linkWalletMessage(config.network,pending.id,hash);
  await assert.rejects(c.prepareLink(pending.id,{paymentHash:hash,walletSignature:signTestPayout(message,'66'.repeat(32),'tap')}),/signature/);assert.equal(sent.length,0);
  const proof=signTestPayout(message,secret,'tap');await c.prepareLink(pending.id,{paymentHash:hash,walletSignature:proof});
  assert.equal(sent[0].paymentHash,hash);assert.doesNotMatch(JSON.stringify(s.get('webLinkIntents',pending.id)),/walletSignature|preimage/);
  const other='77'.repeat(32);await assert.rejects(c.prepareLink(pending.id,{paymentHash:other,walletSignature:signTestPayout(linkWalletMessage(config.network,pending.id,other),secret,'tap')}),/conflict/);
});
test('records use exact rarity fractions, counted-header dates, bounded batches and compound mass', async () => {
  const s=store(),who=agent(918),now=Date.UTC(2026,9,25,12),raw=Buffer.alloc(80);raw.writeUInt32LE(now/1000-60,68);
  await s.put('meta','patterns',[{number:0,name:'common',rarity:1,historyHeight:1,fld:4},{number:1,name:'rare',rarity:1,historyHeight:9,fld:4}]);
  await s.put('headers','0000000000000001',{raw:raw.toString('hex')});
  for(let i=0;i<205;i++)await s.put('finds',String(i).padStart(4,'0'),{asset:i===204?'p1':'p0',block:i,count:1,finder:who.address,findHeight:1});
  await s.put('types','c1',{properties:{mass:'900719925474099300000',generation:2},firstMaker:who.address,created:1});
  await s.put('types','c2',{properties:{mass:'900719925474099300001',generation:2},firstMaker:who.address,created:2});
  const list=s.list;s.list=(space,opts)=>{assert.ok(opts.limit<=200);return list(space,opts);};
  const highlights=await createRecordHighlights(s,()=>now)();
  assert.equal(highlights.rarestFinds.today.asset,'p1');assert.equal(highlights.rarestFinds.week.asset,'p1');assert.equal(highlights.rarestFinds.ever.asset,'p1');assert.match(highlights.rarestFinds.ever.finder,/^trac1/);assert.equal(highlights.biggestCompound.asset,'c2');
});

test('production wallets switch only to Bitcoin mainnet and Ethereum 1', async () => {
  const prod = { bitcoinNetwork: 'mainnet', ethereum: { chainId: '0x1' } };
  let network = 'regtest', chain = '0x7a69'; const requests = [];
  globalThis.window = {
    tapprotocol: {
      getNetwork: async () => network,
      switchNetwork: async n => { requests.push(n); network = n; },
      requestAccounts: async () => ['bc1ptest'],
    },
    ethereum: { request: async ({ method, params }) => {
      requests.push(method);
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') { assert.equal(params[0].chainId, '0x1'); chain = params[0].chainId; }
      if (method === 'eth_requestAccounts') return ['0x' + '12'.repeat(20)];
    } },
  };
  await tapAccount(prod); await ethAccount(prod);
  assert.equal(network, 'mainnet'); assert.equal(chain, '0x1');
  assert.ok(!requests.includes('wallet_addEthereumChain'));
  assert.ok(!requests.includes('eth_sendTransaction'));
  window.tapprotocol.requestAccounts = async () => ['bcrt1ptest'];
  await assert.rejects(tapAccount(prod), /Taproot/);
  const before = requests.length;
  for (const ethereum of [{ chainId: '0x7a69' }, { chainId: '0x1', localRpc: 'http://127.0.0.1:58545' }]) {
    await assert.rejects(tapAccount({ ...prod, ethereum }), /unavailable/);
    await assert.rejects(ethAccount({ ...prod, ethereum }), /unavailable/);
  }
  assert.equal(requests.length, before, 'invalid targets fail before any wallet prompt');
  window.ethereum.request = async ({ method }) => {
    if (method === 'eth_chainId') return '0x7a69';
    assert.equal(method, 'wallet_switchEthereumChain');
    throw Object.assign(Error('missing chain'), { code: 4902 });
  };
  await assert.rejects(ethAccount(prod), /missing chain/);
});
