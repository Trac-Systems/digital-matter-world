import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rules } from '../src/rules.mjs';
test('all fee recipients are paid directly and no service spending adapter is wired',async()=>{
  const split=rules.splitFee('100',{linked:true,discovered:true});
  const fees=rules.mintFeeItems(split,{finder:'f',landowner:'l',discoverer:'d',treasury:'t'});
  assert.deepEqual(fees.map(f=>f.role),['finder','discoverer','landowner','treasury','burn']);
  assert.equal(fees.reduce((n,f)=>n+BigInt(f.amount),0n),100n);
  for(const file of ['../src/operator.mjs','../prod/adapter.mjs','../local/adapter.mjs']){
    const source=await readFile(new URL(file,import.meta.url),'utf8');
    assert.doesNotMatch(source,/PayoutRunner|CancellableInscriber|durableSender|sendRawTransaction|sendrawtransaction/);
  }
});
