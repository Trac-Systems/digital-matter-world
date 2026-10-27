import { createAdapters as baseAdapters } from '../service/local/adapter.mjs';
import { bitcoin } from '../service/src/http-client.mjs';
import { check } from '../service/src/util.mjs';

// Bulk relay is only used for an empty intake on a straight extension. Every
// intermediate tip is still published and replayed by the normal rule engine.
export async function createAdapters(context) {
  return bulkAdapter(context,await baseAdapters(context));
}
export function bulkAdapter({store,history},base,readBitcoin=bitcoin) {
  const {manifest,trac}=base.reads;let bulk=false;
  return {...base,async observations(previous) {
    bulk=false;
    // A bulk header jump can otherwise expire a threshold batch before the
    // next poll retrieves its signature. Give that existing ceremony time to
    // finish; its own timeout still restores header progress after a failure.
    const draft=store.get('meta','draft'), batch=draft?.proposal?.batch;
    const signing=batch&&store.get('ceremonies',`batch/${batch.epoch}/${batch.n}`);
    if(signing?.stage==='running' && Date.now()-signing.started<180000)return [];
    const info=await readBitcoin(manifest,'getblockchaininfo');check(info.chain==='regtest','local_chain_required');
    const recover=async intent=>{
      const {raws,rows}=intent,last=rows.at(-1);
      if(last.tip>info.blocks || await readBitcoin(manifest,'getblockhash',[last.tip])!==last.hash) {
        // The ordinary relay reconciles forks, including headers whose previous
        // submission succeeded but whose acknowledgement was lost. Preserve the
        // abandoned bulk intent without repeatedly trying its stale branch.
        await store.transact([{space:'relayForks',id:last.hash,value:intent},{space:'meta',id:'bulkRelayIntent'}]);
        return base.observations(previous);
      }
      const accepted=await trac('headers',[raws]);
      check(accepted.tip.hash===last.hash&&accepted.counted===last.counted,'bulk_relay_acknowledgement');
      await store.transact([{space:'meta',id:'bulkRelayIntent'},{space:'meta',id:'relayCursor',value:{height:last.tip,hash:last.hash}},
        ...rows.map(value=>({space:'relayObservations',id:String(value.tip).padStart(16,'0')+'/'+value.hash,value}))]);
      bulk=true;return rows;
    };
    const saved=store.get('meta','bulkRelayIntent');if(saved)return recover(saved);
    const cursor=store.get('meta','relayCursor');
    if(!cursor || store.get('meta','relayIntent') || store.count('relayObservations') || store.count('dedupe') ||
      info.blocks-cursor.height<2 || history.hashAt(cursor.height)!==cursor.hash ||
      await readBitcoin(manifest,'getblockhash',[cursor.height])!==cursor.hash)return base.observations(previous);
    const head=await trac('head');
    if(head.tip.hash!==cursor.hash)return base.observations(previous);
    const revision=previous?.revision??0,raws=[],rows=[];
    for(let height=cursor.height+1;height<=Math.min(info.blocks,cursor.height+20);height++){
      const hash=await readBitcoin(manifest,'getblockhash',[height]),raw=await readBitcoin(manifest,'getblockheader',[hash,false]);
      await history.append(height,raw);raws.push(raw);
      const counted=Math.max(head.counted,height);
      rows.push({chain:'regtest',tip:height,hash,counted,confirmed:Math.min(counted,Math.max(0,height)),headers:[],revision});
    }
    await store.put('meta','bulkRelayIntent',{raws,rows});
    return recover({raws,rows});
  },async afterObserve(intake){if(bulk&&intake.head)await intake.seal();else await base.afterObserve(intake);}};
}
