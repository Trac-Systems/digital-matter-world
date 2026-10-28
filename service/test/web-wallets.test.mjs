import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletJournal, tapAccount, ethAccount, receipt, orderResult } from '../public/web/wallets.js';
import { WebCheckout, linkWalletMessage } from '../src/web-checkout.mjs';
import { agent, signEd } from './helpers.mjs';
import { signTestPayout, testPayoutAddress } from './payout-wallets.mjs';
import { rules } from '../src/rules.mjs';
import { createRecordHighlights } from '../src/web-records.mjs';
import { signTapWalletMessage } from '../../rules/test/tap-wallet-signing.mjs';
import { walletError } from '../../playground/console/js/wallet-errors.js';
const config={mode:'regtest',network:'dmw-regtest',endpoints:{ethereum:'http://127.0.0.1:58545'},local:{escrow:{chainId:'31337'}}};
const target={bitcoinNetwork:'regtest',ethereum:{chainId:'0x7a69',localRpc:config.endpoints.ethereum}};
function store() { const rows=new Map();return { get:(s,id)=>rows.get(s+'/'+id)??null,put:async(s,id,v)=>rows.set(s+'/'+id,v),transact:async ops=>{for(const o of ops)if(o.value===undefined)rows.delete(o.space+'/'+o.id);else rows.set(o.space+'/'+o.id,o.value);},list:(s,{after='',limit=200}={})=>[...rows].filter(([k])=>k.startsWith(s+'/')&&k.slice(s.length+1)>after).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit).map(([k,value])=>({id:k.slice(s.length+1),value})) }; }
test('wallet journal resumes once and retains uncertain sends including 4001 after funding', async () => {
  const rows=new Map();globalThis.localStorage={getItem:k=>rows.get(k),setItem:(k,v)=>rows.set(k,v)};
  const j=new WalletJournal('test');let sent=0;
  assert.equal(await j.step('deposit',async()=>{sent++;return 'tx';}),'tx');
  assert.equal(await new WalletJournal('test').step('deposit',async()=>{sent++;}),'tx');assert.equal(sent,1);
  await assert.rejects(j.step('cancel',async()=>{throw Object.assign(Error('cancelled'),{code:4001});}),/cancelled/);
  await assert.rejects(new WalletJournal('test').step('cancel',async()=>{sent++;}),/interrupted/);
  await assert.rejects(j.step('uncertain',async()=>{throw Error('network_disconnected');}),/network_disconnected/);
  await assert.rejects(j.step('uncertain',async()=>{sent++;}),/interrupted/);assert.equal(sent,1);
});
test('wallet network and payer checks fail before spending and add only configured local Anvil', async () => {
  let network='mainnet';globalThis.window={tapprotocol:{getNetwork:async()=>network,switchNetwork:async n=>network=n,requestAccounts:async()=>['bcrt1ptest']}};
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
for (const format of ['bip322', 'legacy']) test(`Bitmap checkout binds its browser-chosen hash to the real payer proof and cannot be replaced (${format})`, async () => {
  const s=store(),who=agent(919),secret='33'.repeat(32),payer=testPayoutAddress(secret,'tap'),sent=[];
  const c=new WebCheckout({store:s,config,reads:{counted:async()=>20,bitmap:async()=>({agent:who.address,address:payer}),link:async()=>null},post:async(path,body)=>{sent.push(body);return {id:rules.linkId(config.network,body.request)};}});
  const r={owner:who.address,height:5,nonce:'44'.repeat(32),until:100};
  const body={request:r,sig:signEd(rules.paymentDigest(config.network,r,'link'),who.secret),payer};
  const pending=await c.enrollLink(body);assert.equal(pending.state,'awaiting_wallet');assert.equal((await c.plan('link',pending.id)).walletPreparation,true);
  const hash='55'.repeat(32),message=linkWalletMessage(config.network,pending.id,hash);
  await assert.rejects(c.prepareLink(pending.id,{paymentHash:hash,walletSignature:signTestPayout(message,'66'.repeat(32),'tap')}),/signature/);assert.equal(sent.length,0);
  const proof=format==='legacy'?signTapWalletMessage(message,Buffer.from(secret,'hex')):signTestPayout(message,secret,'tap');await c.prepareLink(pending.id,{paymentHash:hash,walletSignature:proof});
  assert.equal(sent[0].paymentHash,hash);assert.doesNotMatch(JSON.stringify(s.get('webLinkIntents',pending.id)),/walletSignature|preimage/);
  const other='77'.repeat(32);await assert.rejects(c.prepareLink(pending.id,{paymentHash:other,walletSignature:signTestPayout(linkWalletMessage(config.network,pending.id,other),secret,'tap')}),/conflict/);
});
test('wallet pages explain protocol errors and preserve existing plain guidance', () => {
  assert.equal(walletError(Error('binding_wallet_signature')), "Your wallet's signature was not accepted. Make sure the wallet shown above is the active account and try again.");
  for (const code of ['binding_expired', 'binding_conflict', 'binding_nonce', 'binding_request_missing', 'link_owner', 'link_deadline', 'mint_expired', 'unknown_code']) {
    assert.doesNotMatch(walletError(Error(code)), /^[a-z][a-z0-9_]*$/);
  }
  assert.equal(walletError(Error('Select the TAP payer wallet shown in this request.')), 'Select the TAP payer wallet shown in this request.');
  assert.match(walletError({ code: 4001 }), /cancelled/);
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
      switchNetwork: async n => { requests.push(n); return network = n; },
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

test('a legacy TAP provider fails clearly before any Bitmap action or authority journal entry', async () => {
  const { requireTapActions, authority } = await import('../public/web/wallets.js');
  // Older bridge lacking the action API; this is not TAP Wallet 1.0.48.
  let sent = 0, journaled = 0;
  const provider = { requestAccounts: async () => ['bc1ptest'], getAccounts: async () => ['bc1ptest'],
    getNetwork: async () => 'mainnet', hasActiveAuthority: async () => true,
    singleTxTransfer: async () => { sent++; return { txid: 'ab'.repeat(32) }; } };
  assert.throws(() => requireTapActions(provider), /cannot pay Bitmap links/);
  await assert.rejects(authority(provider, 'bc1ptest', { step: () => { journaled++; } }, () => {}), /No payment was sent/);
  assert.equal(sent, 0); assert.equal(journaled, 0);
});

test('1.0.48 capability guard accepts all action methods and network/account refusal stays before payment', async () => {
  const { tapWallet1048 } = await import('../../kit/test/tap-wallet-1048-fixture.mjs');
  const { requireTapActions } = await import('../public/web/wallets.js');
  const f = tapWallet1048({ address: 'bcrt1ptest', network: 'regtest' });
  assert.doesNotThrow(() => requireTapActions(f.provider));
  for (const method of ['sendInscription', 'createGlobalTapAuthority']) {
    assert.throws(() => requireTapActions({ ...f.provider, [method]: undefined }), /cannot set up/);
  }
  globalThis.window = { tapprotocol: f.provider };
  f.provider.requestAccounts = async () => null;
  await assert.rejects(tapAccount(target), /Taproot/);
  f.state.network = 'mainnet'; f.provider.switchNetwork = async () => { throw { code: 4001, message: 'User rejected the request.' }; };
  await assert.rejects(tapAccount(target), error => error.code === 4001);
  assert.equal(f.state.calls.length, 0);
});

test('regtest checkout uses the ord-tap native burn marker and gates release on matching confirmed lock evidence', async () => {
  const s = store(), who = agent(930), id = 'ac'.repeat(32), paymentId = 'bd'.repeat(32) + 'i0:0';
  const row = { id, request: { owner: who.address, height: 2, until: 100 }, terms: { payer: 'bcrt1ppayer', treasury: 'bcrt1ptreasury', baseFee: '100', hash: 'ce'.repeat(32) } };
  await s.put('linkIntents', id, row);
  const split = rules.splitFee(rules.feeFor('link', '100'), { kind: 'link' });
  let payment = { id: paymentId, requestId: id, payer: row.terms.payer, kind: 'tap', tick: 'tap', lockKind: 'htlc', conditionType: 'hashlock', hash: row.terms.hash, refund: row.terms.payer, claim: row.terms.treasury, total: rules.feeFor('link', '100'), base: split.treasury, allocations: rules.tapPaymentAllocations(split, {}, 'link', 'regtest'), refundAfter: 244, confirmations: 1, verifiedHeight: 19, eventIndex: 0, consumed: false };
  let error;
  const checkout = new WebCheckout({ store: s, config, reads: { counted: async () => 20, linkLockPayment: async () => { if (error) throw Error(error); return payment; } } });
  assert.equal((await checkout.plan('link', id)).redeem.actions[0].al[0].to, rules.TAP_BURN);
  error = 'payment_unconfirmed'; assert.deepEqual(await checkout.linkLock(id, paymentId), { ready: false });
  error = undefined; assert.equal((await checkout.linkLock(id, paymentId)).ready, true);
  for (const [key, value] of [['payer', 'wrong'], ['hash', 'ef'.repeat(32)], ['claim', 'wrong'], ['total', '1'], ['refundAfter', 1], ['allocations', []], ['verifiedHeight', 101], ['eventIndex', -1], ['confirmations', 0]]) {
    const old = payment; payment = { ...payment, [key]: value }; await assert.rejects(checkout.linkLock(id, paymentId), /link_/); payment = old;
  }
  payment.consumed = true; assert.equal((await checkout.linkLock(id, paymentId)).ready, false);
});
