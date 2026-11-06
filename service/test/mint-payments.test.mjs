import { TapLookupIndex, installTapLookups } from '../prod/tap-index.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { installMintPayments } from '../src/mint-payments.mjs';
import { expectedEscrowSplit } from '../../committee/signer/escrow.mjs';
import { rules } from '../src/rules.mjs';
import { fixture, network } from '../../committee/test/fixture.mjs';
const address=n=>'0x'+n.repeat(40);
function setup(kind='tap', bitcoinNetwork='mainnet'){
  const f=fixture('dmt',undefined,'100',bitcoinNetwork),id=f.id,txid=rules.hash('redeem'),ins=txid+'i0';
  if(kind==='ethereum'){Object.assign(f.data.context,{treasury:address('1'),finderAddress:address('2')});f.data.payer=address('3');f.data.payment.payer=f.data.payer;f.data.payment.kind=kind;f.reprice();}
  const split=rules.splitFee('100'),destinations={treasury:f.data.context.treasury,finder:f.data.context.finderAddress};
  const row={id,request:f.proposal.request,signature:f.proposal.signature,payer:f.data.payer,kind,context:f.data.context,quote:{fees:f.data.payment.fees,split,destinations,price:'100',payableAmount:'100'},paymentIds:[ins],creditIds:[]};
  const transfers=[],items=[],escrow={chainId:'31337',address:address('4'),token:address('5')};let confirmations=1,used=null,raw={s:0},status=1;
  for(const fee of row.quote.fees){items.push({tick:fee.ticker,amt:rules.formatTapAmount(fee.amount),address:fee.to??'burn-looking-address',tt:fee.tt,dta:fee.dta});transfers.push({ins,fail:false,int:true,addr:row.payer,taddr:fee.to??'burn-looking-address',tick:fee.ticker,amt:fee.amount,dta:fee.dta});}
  const reads={paymentTransfers: async () => transfers.map((value,index)=>({index,value})),pending:async()=>raw,paymentUsed:async()=>used,included:async()=>({confirmations}),content:async()=>({p:'tap',op:'token-auth',redeem:{items}}),
    tap:async path=>path.startsWith('getAccountRedeemListLength/')?0:path.startsWith('getTransferredListLength/')?transfers.length:path.startsWith('getTransferredList/')?transfers:[],
    escrowDeposit:async()=>({...escrow,payer:row.payer,confirmations,deposit:{payer:row.payer,status,amount:'100',split:expectedEscrowSplit(split,destinations)}}),
    escrowSettled:async()=>({kind:'claim',confirmations})};
  installMintPayments(reads,{request:()=>row,escrow,network});
  return {reads,row,transfers,items,setConfirmations:n=>confirmations=n,setUsed:v=>used=v,setRaw:v=>raw=v,setStatus:n=>status=n};
}
test('TAP reader accepts exact items including burn address, and rejects redirected burn',async()=>{
  const f=setup(),p=await f.reads.mintPayment(f.row.id);
  assert.equal(p.receipts.length,3);assert.equal(p.receipts.find(r=>r.role==='burn').to,rules.TAP_BURN);
  assert.equal(rules.paymentProgress(p.fees,p.receipts).final,true);
  const burn=f.transfers.find(t=>t.taddr===rules.TAP_BURN);burn.taddr='other-address';
  assert.deepEqual(rules.paymentProgress(p.fees,(await f.reads.mintPayment(f.row.id)).receipts).missing.map(f=>f.role),['burn']);
  burn.taddr=rules.TAP_BURN;
  f.transfers[0].fail=true;assert.equal((await f.reads.mintPayment(f.row.id)).receipts.length,2);
  f.transfers[0].fail=false;f.transfers[0].addr='other-payer';assert.equal((await f.reads.mintPayment(f.row.id)).receipts.length,2);
  f.transfers[0].addr=f.row.payer;f.transfers[0].dta='another-request';assert.equal((await f.reads.mintPayment(f.row.id)).receipts.length,2);
});
test('Ethereum deposit only holds; confirmed permissionless release makes every split item final',async()=>{
  const f=setup('ethereum');let p=await f.reads.mintPayment(f.row.id);
  assert.equal(p.depositFinal,true);assert.equal(rules.paymentProgress(p.fees,p.receipts).final,false);
  f.setStatus(2);f.setConfirmations(0);p=await f.reads.mintPayment(f.row.id);assert.equal(rules.paymentProgress(p.fees,p.receipts).final,false);
  f.setConfirmations(1);p=await f.reads.mintPayment(f.row.id);assert.equal(rules.paymentProgress(p.fees,p.receipts).final,true);
  f.setStatus(3);assert.equal((await f.reads.mintPayment(f.row.id)).receipts.length,0);
});
test('spent receipt amounts cannot be credited twice and consumed permits reconstruct their original allocation',async()=>{
  const f=setup('ethereum');f.setStatus(2);const p=await f.reads.mintPayment(f.row.id),allocations=rules.paymentProgress(p.fees,p.receipts).allocations;
  f.setUsed({used:'1'});const partial=await f.reads.mintPayment(f.row.id);assert.equal(rules.paymentProgress(partial.fees,partial.receipts).final,false);
  f.setUsed({used:'100'});f.setRaw({s:1,payments:allocations});
  const own=await f.reads.mintPayment(f.row.id);assert.deepEqual(rules.paymentProgress(own.fees,own.receipts).allocations,allocations);
});
test('credit references require the original signed owner, not a gateway-supplied owner field',async()=>{
  const f=setup();f.row.creditIds=[rules.hash('another')];f.setRaw({s:2,o:1});
  await assert.rejects(f.reads.mintPayment(f.row.id),/payment_credit_owner/);
});

test('expired Ethereum credit reduces only the matching new deposit and is spent once', async()=>{
  const f=fixture(), old=setup('ethereum').row, request={...old.request,nonce:rules.hash('next-credit-quote')}, id=rules.pendingId(network,request);
  const row={...old,id,request,signature:rules.signRequest('rq',network,request,f.secret),creditIds:[old.id],quote:{...old.quote,fees:rules.mintFeeItems(old.quote.split,old.quote.destinations,id,null,'ethereum')}};
  const escrow={chainId:'31337',address:address('4'),token:address('5')}, spent=new Map();let current={s:0}, hasDeposit=false;
  const oldKey=role=>rules.paymentItemKey('ethereum',[escrow.chainId,escrow.address,old.payer,old.id,role].join('/'));
  // Only the burn was left unused by an earlier quote. It covers the next burn.
  for(const fee of old.quote.fees)if(fee.role!=='burn')spent.set(oldKey(fee.role),{used:fee.amount});
  const remaining=row.quote.fees.filter(f=>f.role!=='burn'), partialSplit=expectedEscrowSplit({...old.quote.split,burn:'0'},old.quote.destinations);
  const reads={paymentTransfers: async () => transfers.map((value,index)=>({index,value})),pending:async key=>key===old.id?{s:2,o:1}:current,agentAddress:async()=>old.request.owner,paymentUsed:async key=>spent.get(key),
    escrowDeposit:async(payer,key)=>{
      if(key===id&&!hasDeposit)throw Error('escrow_payer');
      return {...escrow,payer,confirmations:1,deposit:{payer,status:2,amount:key===id?'65':'100',split:key===id?partialSplit:expectedEscrowSplit(old.quote.split,old.quote.destinations)}};
    },escrowSettled:async()=>({kind:'claim',confirmations:1})};
  installMintPayments(reads,{request:key=>key===id?row:old,escrow,network});
  let payment=await reads.mintPayment(id);assert.equal(payment.depositAmount,'65');assert.deepEqual(payment.depositFees,remaining);
  hasDeposit=true;payment=await reads.mintPayment(id);const progress=rules.paymentProgress(payment.fees,payment.receipts);assert.equal(progress.final,true);
  current={s:1,payments:progress.allocations};for(const p of progress.allocations)spent.set(p.key,{used:p.total});
  payment=await reads.mintPayment(id);assert.deepEqual(rules.paymentProgress(payment.fees,payment.receipts).allocations,progress.allocations);
  current={s:0};await assert.rejects(reads.mintPayment(id),/escrow_split/,'used credit cannot authorize an underfunded new deposit');
});

test('captured ord-tap transfer records bind real per-item amounts and leave the unexecuted regtest burn missing', async () => {
  const { default: captured } = await import('../prod/test/fixtures/ord-payment.mjs');
  const id = captured.fees[0].dta.split('|')[1], inscription = captured.transfers[0].ins, payer = captured.transfers[0].addr;
  const row = { id, payer, kind: 'tap', quote: { fees: captured.fees }, paymentIds: [inscription] };
  const paths = [], reads = { pending: async () => ({ s: 0 }), paymentUsed: async () => null, included: async () => ({ confirmations: 1 }), content: async () => captured.payload,
    tap: async path => { paths.push(path); if (path.startsWith('getAccountRedeemListLength/')) return captured.redeems.length; if (path.startsWith('getAccountRedeemList/')) return captured.redeems;
      if (path.startsWith('getTransferredListLength/')) return captured.transfers.length; if (path.startsWith('getTransferredList/')) return captured.transfers; throw Error('unexpected_route'); } };
  reads.paymentTransfers = async () => captured.transfers.map((value,index)=>({index,value}));
  installMintPayments(reads, { request: () => row, network });
  const result = await reads.mintPayment(id);
  assert.equal(result.receipts.length, 2); assert.ok(result.receipts.every(r => r.confirmations === 1));
  assert.deepEqual(rules.paymentProgress(result.fees, result.receipts).missing.map(f => f.role), ['burn']);
  assert.ok(paths.filter(p => p.includes('?')).every(p => p.includes('max=500')));
});

test('named transfers beyond 1,000 rows retain their original allocation positions across restart', async () => {
  const f = setup(), transfers = Array.from({ length: 1501 }, () => ({ ins: 'unrelated' })).concat(f.transfers), offsets = [];
  const indexer = { bitcoin: { blockHash: async () => 'aa' }, stamp: async () => ({ height: 1, hash: 'aa' }), at: async (_at, fn) => fn(), tap: async path => {
    assert.ok(!path.includes('AccountRedeem'), 'explicit payment must not read payer history');
    if (path.startsWith('getTransferredListLength/')) return transfers.length;
    if (path.startsWith('getTransferredList/')) { const query = new URL('http://fixture.invalid/' + path).searchParams, offset = Number(query.get('offset')), size = Number(query.get('max')); offsets.push(offset); return transfers.slice(offset, offset + size); }
    throw Error('unexpected_route');
  } };
  const index = new TapLookupIndex({ indexer }); installTapLookups(f.reads, index);
  try {
    const payment = await f.reads.mintPayment(f.row.id);
    assert.equal(rules.paymentProgress(payment.fees, payment.receipts).final, true);
    assert.ok(offsets.includes(1500));
    assert.deepEqual(payment.receipts.map(r=>r.key).sort(), f.transfers.map((_,i)=>rules.paymentItemKey('tap', f.row.paymentIds[0] + '/' + (1501+i))).sort());
    offsets.length = 0; await f.reads.mintPayment(f.row.id);
    assert.deepEqual(offsets, [1501,1502,1503], 'warm verification fetches only the nominated inscription items');
  } finally { index.close(); }
});

test('regtest reader requires an executed transfer to the network-correct burn address', async () => {
  const f = setup('tap', 'regtest'), burn = rules.tapBurnAddress('regtest');
  const paid = await f.reads.mintPayment(f.row.id);
  assert.equal(paid.receipts.find(r => r.role === 'burn').to, burn);
  assert.equal(rules.paymentProgress(paid.fees, paid.receipts).final, true);
  f.transfers.find(t => t.taddr === burn).taddr = rules.TAP_BURN;
  const missing = await f.reads.mintPayment(f.row.id);
  assert.deepEqual(rules.paymentProgress(missing.fees, missing.receipts).missing.map(f => f.role), ['burn']);
});
test('block transactions with a bare input (pay-to-anchor spend) still parse with the exact txid',async()=>{
  const { inscriptionContents, transactionId } = await import('../src/mint-payments.mjs');
  const { createHash } = await import('node:crypto'), { createRequire } = await import('node:module');
  const { Transaction } = createRequire(new URL('../../rules/package.json', import.meta.url))('@scure/btc-signer');
  const sha=b=>createHash('sha256').update(b).digest(), varint=n=>Buffer.from([n]), push=b=>Buffer.concat([varint(b.length),b]);
  const body=Buffer.from(JSON.stringify({p:'tap',op:'token-auth',redeem:{items:[]}}));
  const script=Buffer.concat([Buffer.from([0x00,0x63]),push(Buffer.from('ord')),Buffer.from([0x01,0x01]),push(Buffer.from('text/plain')),Buffer.from([0x00]),push(body),Buffer.from([0x68])]);
  const control=Buffer.concat([Buffer.from([0xc0]),Buffer.alloc(32,7)]);
  const input=(fill,vout,seq)=>Buffer.concat([Buffer.alloc(32,fill),Buffer.from([vout,0,0,0]),Buffer.from([0]),Buffer.from(seq,'hex')]);
  const legacy=w=>Buffer.concat([Buffer.from('03000000','hex'),...(w?[Buffer.from('0001','hex')]:[]),Buffer.from([2]),input(0xaa,0,'ffffffff'),input(0xbb,1,'fdffffff'),
    Buffer.from([1]),Buffer.alloc(8),Buffer.from([1,0x6a]),...(w?[Buffer.from([0]),Buffer.from([2]),push(script),push(control)]:[]),Buffer.alloc(4)]);
  const raw=legacy(true).toString('hex'), expected=Buffer.from(sha(sha(legacy(false)))).reverse().toString('hex');
  const tx=Transaction.fromRaw(Buffer.from(raw,'hex'),{allowUnknownInputs:true,allowUnknownOutputs:true,disableScriptCheck:true});
  assert.throws(()=>tx.id,/not finalized/);
  assert.equal(transactionId(tx),expected);
  for(const scan of [true,false]){const parsed=inscriptionContents(raw,undefined,{scan});assert.equal(parsed.txid,expected);assert.deepEqual(parsed.contents,[JSON.parse(body)]);}
  const signed=Transaction.fromRaw(Buffer.from(raw,'hex'),{allowUnknownInputs:true,allowUnknownOutputs:true,disableScriptCheck:true});
  signed.updateInput(0,{finalScriptWitness:[Uint8Array.of(1)]},true);
  assert.equal(transactionId(signed),signed.id);
});
test('block transactions with any version number still parse with the exact txid',async()=>{
  const { inscriptionContents } = await import('../src/mint-payments.mjs');
  const { createHash } = await import('node:crypto');
  const sha=b=>createHash('sha256').update(b).digest();
  const legacy=Buffer.from('78e1fa51'+'01'+'aa'.repeat(32)+'00000000'+'00'+'ffffffff'+'01'+'0000000000000000'+'016a'+'00000000','hex');
  const parsed=inscriptionContents(legacy.toString('hex'),undefined,{scan:true});
  assert.equal(parsed.txid,Buffer.from(sha(sha(legacy))).reverse().toString('hex'));
  assert.deepEqual(parsed.contents,[]);
});
