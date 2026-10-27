import { wireIdentities } from '../rules/src/trac-address.js';
import { bindTestPayoutWallets } from './payout-wallets.mjs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TracClient } from '../kit/lib/trac.mjs';
import { loadRegtestHistory } from '../kit/lib/headers.mjs';
import { localReads } from '../service/local/reads.mjs';
import { jsonRequest } from '../service/src/http-client.mjs';
import { publicAddress, publicKey } from '../kit/lib/keyring.mjs';
import { serviceError, safeCode } from '../kit/lib/errors.mjs';
import { check } from '../kit/lib/check.mjs';
import { regtestSource } from '../kit/lib/regtest-source.mjs';
import { regtestBitcoinSource } from './bitcoin-source.mjs';

export function kitRPC(endpoint, token) {
  return async (method, args = []) => {
    let response;
    try {
      response = await jsonRequest(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ method, args }), timeout: 45000 });
    } catch (error) {
      throw serviceError({ service: 'Trac adapter', origin: endpoint, route: `/ (RPC ${method})`, method: 'POST', code: safeCode(error.cause?.code ?? error.code ?? error.message), reason: 'local RPC unavailable', submission: method === 'kitSubmit' });
    }
    if (!response.ok || response.value.error) throw serviceError({ service: 'Trac adapter', origin: endpoint, route: `/ (RPC ${method})`, method: 'POST', status: response.status, code: safeCode(response.value.error, 'rpc_error'), reason: 'local RPC refused the request' });
    return response.value.result;
  };
}

export function remoteTrac(network, rpc) {
  const map={dmwAuthority:'authority',dmwHead:'head',dmwHashAt:'hashAt',dmwBalance:'balance',dmwSettings:'settings',dmwMint:'pending',dmwBatchLast:'batchLast',dmwBatchRoot:'root',dmwRecord:'record'};
  return new TracClient({network,api:Object.fromEntries(Object.entries(map).map(([a,b])=>[a,(...args)=>rpc(b,args)])),context:()=>rpc('kitContext'),submit:p=>rpc('kitSubmit',[p]),status:tx=>rpc('kitStatus',[tx])});
}
export async function historySnapshot(reads,directory) {
  const info=await reads.client.tip();
  const view=await reads.views.view(info.height,info.hash);
  const chunks=[]; for(let h=0;h<view.length;h++)chunks.push(Buffer.from(view.raw(h),'hex'));
  const filename=join(directory,'headers-'+randomUUID()+'.bin');
  // The kit verifies regtest genesis, every PoW/link and median-time rule.
  await writeFile(filename,Buffer.concat(chunks),{mode:0o600});
  const history=await loadRegtestHistory(filename);
  await rename(filename,join(directory,'headers.bin'));
  return history;
}
export async function candidate(reads,asset,block,kind='tap',history) {
  const context=await reads.assetContext(asset,block,kind),registry=await reads.registry(),registered=registry.assets[asset];
  const link=context.link,currentHolder=link ? (await reads.bitmap(block)).agent : null;
  const minted=registered ? await reads.isMinted(registered.id,registered.tick,block) : false;
  return {found:!!context.find?.finder,void:false,minted,pending:await reads.blockHold(asset,block),find:context.find,link,currentHolder,time:history?.get(block)?.time};
}
export async function candidates(service,owner,asset,{block}={}) {
  const out=[],seen=new Set();let cursor;
  do {
    const page=await service.mintRights(owner,{asset,...(block===undefined?{}:{block}),limit:200,sort:'block',order:'asc',cursor});
    check(Array.isArray(page.mintRights)&&(page.next===null||typeof page.next==='string'&&page.next.length>0&&!seen.has(page.next)), 'Invalid mint rights page');
    for(const row of page.mintRights) if(row.block!==null&&row.block!==undefined) {
      check(row.find?.asset===asset&&row.find.block===row.block&&row.find.finder,'Gateway mint rights lack candidate context');out.push(wireIdentities(row));
    }
    cursor=page.next;seen.add(cursor);
  }while(cursor!==null);
  return out;
}
export async function create({wallet,network,localOnly,config,service,dryRun=true}) {
  if(localOnly!==true)throw Error('local_only');
  const c=JSON.parse(await readFile(join(config.playground.directory,'gateway.json'),'utf8'));
  c.local.readerId='kit-cli-'+publicKey(wallet);
  const reads=await localReads(c),rpc=kitRPC(config.playground.endpoint,(await readFile(config.playground.tokenFile,'utf8')).trim());
  try {
    if(!dryRun)await bindTestPayoutWallets({directory:join(config.playground.directory,'payout-wallets',publicKey(wallet)),wallet,service});
    const history=await historySnapshot(reads,config.playground.directory);
    return {trac:remoteTrac(network,rpc),history,source:regtestSource({origin:config.headerSource,cookiePath:config.headerCookie,fetchImpl:service.fetchImpl}),
      bitcoinSource:regtestBitcoinSource({manifest:JSON.parse(await readFile(c.local.manifest,'utf8')),funding:config.bitcoin?.funding}),
      candidates:async(asset,options)=>candidates(service,publicAddress(wallet),asset,options),
      compounds:async()=>reads.store.list('types',{limit:10000}).map(r=>r.value),close:()=>reads.close()};
  }catch(e){reads.close();throw e;}
}
