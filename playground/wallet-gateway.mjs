import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Orders } from '../local/inscriber.mjs';
import { startGateway } from '../local/gateway.mjs';
import { json,check,PORTS } from './common.mjs';

export async function restoreOrders(manifest) {
  const orders=new Orders(manifest),directory=join(manifest.root,'orders');
  const files=await readdir(directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  for(const name of files){
    check(/^[0-9a-f-]{36}\.json$/.test(name),'wallet_order_filename');
    const order=await json(join(directory,name));check(name===order.id+'.json'&&Array.isArray(order.entries),'wallet_order_record');
    if(order.status==='inscribing'){
      order.status='failed';order.error='Interrupted inscription; inspect saved Bitcoin evidence before recovery';
      await orders.persist(order);
    }
    orders.orders.set(order.id,order);
  }
  return orders;
}
export async function startWalletGateway(manifest) {
  return startGateway(manifest,{port:PORTS.wallet,orders:await restoreOrders(manifest)});
}
