import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BUILD,save,json } from '../common.mjs';
import { restoreOrders } from '../wallet-gateway.mjs';

test('wallet orders survive restart and interrupted inscription broadcasts are never retried',async t=>{
  await mkdir(join(BUILD,'playground-tests'),{recursive:true});const root=await mkdtemp(join(BUILD,'playground-tests/orders-'));t.after(()=>rm(root,{recursive:true}));await mkdir(join(root,'orders'));
  for(const [n,status]of ['pending','inscribed','inscribing'].entries()){
    const id='00000000-0000-0000-0000-00000000000'+n;await save(join(root,'orders',id+'.json'),{id,status,entries:[],connectedAddress:'local-test'});
  }
  const orders=await restoreOrders({root});assert.equal(orders.orders.size,3);
  assert.deepEqual([...orders.orders.values()].map(o=>o.status),['pending','inscribed','failed']);
  const interrupted=[...orders.orders.values()][2];assert.match(interrupted.error,/Interrupted/);
  await assert.rejects(orders.paid(interrupted.id),/current state/);
  assert.equal((await json(join(root,'orders',interrupted.id+'.json'))).status,'failed');
});
