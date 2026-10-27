import test from 'node:test';
import assert from 'node:assert/strict';
import { bulkAdapter } from '../adapter.mjs';
function fixture(){
  const data=new Map(),store={get:(s,k)=>data.get(s+'/'+k),count:s=>[...data.keys()].filter(k=>k.startsWith(s+'/')).length,
    async put(s,k,v){if(v===undefined)data.delete(s+'/'+k);else data.set(s+'/'+k,v);},async transact(rows){for(const r of rows)await this.put(r.space,r.id,r.value);}};
  data.set('meta/relayCursor',{height:100,hash:'h100'});
  let tip=100,counted=100,fallback=0,infoTip=125,fork=false;
  const history={hashAt:h=>'h'+h,append:async()=>{}};
  const trac=async(method,args)=>method==='head'?{tip:{height:tip,hash:'h'+tip},counted}:(tip=Number(args[0].at(-1).slice(1)),counted=Math.max(counted,tip),{tip:{height:tip,hash:'h'+tip},counted});
  const base={reads:{manifest:{},trac},async observations(){fallback++;return ['ordinary'];},async afterObserve(){},observed:async()=>{}};
  const rpc=async(_,method,args)=>method==='getblockchaininfo'?{chain:'regtest',blocks:infoTip}:method==='getblockhash'?(fork?'fork':'h')+args[0]:'r'+args[0].slice(1);
  const api=()=>bulkAdapter({store,history},base,rpc);
  return {store,data,api,setTip:n=>infoTip=n,setCounted:n=>counted=n,fork:()=>fork=true,get fallback(){return fallback;}};
}
test('bulk relay publishes all 20 intermediate canonical observations with real confirmation heights',async()=>{
  const f=fixture(),rows=await f.api().observations({revision:2});assert.equal(rows.length,20);
  assert.deepEqual(rows.map(r=>r.tip),Array.from({length:20},(_,i)=>101+i));
  assert.ok(rows.every(r=>r.counted===r.tip&&r.confirmed===r.counted&&r.revision===2));
  assert.equal(f.store.count('relayObservations'),20);assert.equal(f.store.get('meta','relayCursor').height,120);
});
test('bulk relay keeps counted height monotonic and delegates short extensions or forks',async()=>{
  const f=fixture();f.setCounted(110);const rows=await f.api().observations({revision:0});assert.ok(rows.slice(0,10).every(r=>r.counted===110));
  const short=fixture();short.setTip(101);assert.deepEqual(await short.api().observations(),['ordinary']);
  const fork=fixture();fork.fork();assert.deepEqual(await fork.api().observations(),['ordinary']);
});
test('bulk relay retains all observations across acknowledgement checkpoint interruption',async()=>{
  const f=fixture(),transact=f.store.transact;let fail=true;
  f.store.transact=async rows=>{if(fail){fail=false;throw Error('checkpoint interrupted');}return transact.call(f.store,rows);};
  await assert.rejects(f.api().observations(),/checkpoint interrupted/);
  assert.equal(f.store.get('meta','bulkRelayIntent').rows.length,20);
  const recovered=await f.api().observations();assert.equal(recovered.length,20);assert.equal(f.store.count('relayObservations'),20);assert.equal(f.store.get('meta','bulkRelayIntent'),undefined);
});
test('pending signed receipts always use the witnessed ordinary relay',async()=>{
  const f=fixture();await f.store.put('dedupe','move',true);assert.deepEqual(await f.api().observations(),['ordinary']);assert.equal(f.fallback,1);
});
test('a saved bulk intent on a replaced branch resumes through ordinary fork reconciliation',async()=>{
  const f=fixture(),transact=f.store.transact;let fail=true;
  f.store.transact=async rows=>{if(fail){fail=false;throw Error('checkpoint interrupted');}return transact.call(f.store,rows);};
  await assert.rejects(f.api().observations(),/checkpoint interrupted/);f.fork();
  assert.deepEqual(await f.api().observations(),['ordinary']);
  assert.equal(f.store.get('meta','bulkRelayIntent'),undefined);assert.equal(f.store.count('relayForks'),1);
});
test('bulk relay gives an existing threshold session time to finish without stopping timeout recovery',async()=>{
  const f=fixture();await f.store.put('meta','draft',{proposal:{batch:{epoch:1,n:2}}});
  await f.store.put('ceremonies','batch/1/2',{stage:'running',started:Date.now()});
  assert.deepEqual(await f.api().observations(),[]);assert.equal(f.store.get('meta','relayCursor').height,100);
  await f.store.put('ceremonies','batch/1/2',{stage:'running',started:Date.now()-180001});
  assert.equal((await f.api().observations()).length,20);
});
