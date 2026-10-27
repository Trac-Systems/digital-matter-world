import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Engine } from '../engine.mjs';

test('mint reads preserve missing-request status',async t=>{
  const server=createServer((req,res)=>{res.writeHead(404,{'content-type':'application/json'});res.end('{"error":"request_not_found"}');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  await assert.rejects(Engine.prototype.get.call({url:`http://127.0.0.1:${server.address().port}`},'/mint/missing'),{message:'request_not_found',status:404});
});

test('payment readiness waits through reservation and enrollment before allowing a spend',async()=>{
  let state='reserving',reads=0,blocks=0;
  const e={get:async()=>({id:'mint',state:++reads>=3?'waiting_payment':state}),store:{get:s=>s==='mintInputs'?{}:{state}},processes:{alive(){}},blocks:async n=>{blocks+=n;state='enrolling';}};
  assert.equal((await Engine.prototype.waitMintReady.call(e,'mint')).state,'waiting_payment');assert.equal(blocks,1);
  await assert.rejects(Engine.prototype.waitMintReady.call({...e,get:async()=>({state:'expired',reason:'request_not_accepted'})},'mint'),/request_not_accepted/);
});
