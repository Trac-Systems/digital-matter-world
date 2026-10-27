import '../loopback.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const load=createRequire(new URL('../../contract/package.json',import.meta.url));
const Hyperswarm=load('hyperswarm'),createTestnet=load('hyperdht/testnet.js');
test('Trac transport sockets bind to loopback and refuse nonlocal bootstrap configuration',async()=>{
  assert.throws(()=>new Hyperswarm(),/explicit loopback/);
  assert.throws(()=>new Hyperswarm({bootstrap:['192.0.2.1:58920']}),/explicit loopback/);
  assert.equal((await import('hyperswarm')).default,Hyperswarm);
  const net=await createTestnet(3),swarm=new Hyperswarm({bootstrap:net.bootstrap});
  try{await swarm.dht.fullyBootstrapped();assert.equal(swarm.dht.address().host,'127.0.0.1');assert.equal(swarm.dht._socketPool._host,'127.0.0.1');}
  finally{await swarm.destroy();await net.destroy();}
});
