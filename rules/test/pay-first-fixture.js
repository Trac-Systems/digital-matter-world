import * as rules from '../src/index.js';
export function paidInput(rq, { op='mc', created=90, confirmations=1, held=op==='mc' }={}) {
  const id=rules.pendingId('dmw-regtest',rq.request), fees=[{role:'treasury',to:'treasury',ticker:'tap',amount:'100',tt:'a'}];
  const receipts=fees.map(f=>({...f,key:rules.hash('receipt/'+id),accepted:true,confirmations,used:'0'}));
  const payment={kind:'tap',requestId:id,payer:'payer',fees,receipts};
  const progress=rules.paymentProgress(fees,receipts);
  return {...rq,op,evidence:{pending:{id,created,expiry:rq.request.expires},
    reservation:{s:0,o:1,asset:rq.request.asset,amount:rq.request.amount,receive:rq.request.receive,e:rq.request.expires,block:rq.request.block,...(held?{h:true}:{})},
    payment,authorization:{id,request:rq.request,receiver:rq.receiver,deployment:rq.evidence.context.deployment,
      permit:{hash:rules.hash('permit/'+id),dta:'bound-data'},fees,paymentHash:rules.paymentCommitment(progress.allocations),commissions:[]},balance:'27'}};
}
