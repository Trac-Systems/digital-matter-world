import { ownerAddress } from './owner-address.mjs';
import { join } from 'node:path';
import { maybe, save } from './common.mjs';
import { heightKey } from '../service/src/util.mjs';
import { patternName } from '../kit/lib/pattern-names.mjs';

export async function botsOnce(e,{force=false}={}) {
  if((e.settings.bots.paused&&!force)||!e.settings.bots.count)return;
  const path=join(e.directory,'bots.json'),states=await maybe(path)??{};
  const tip=(await e.trac('head')).tip.height,actors=[];
  // Put all competitors into the same draw before an economic action mines.
  for(let i=0;i<e.settings.bots.count;i++){
    const a=await e.actor('bot-'+i),s=states[a.name]??={};actors.push({a,s,i});
    if(s.tip===tip)continue;s.tip=tip;
    try{if(!a.journal.get('claim/'+tip))await e.claim(a);a.lastAction={action:'claim',tip,at:Date.now()};if(!s.halted)a.error=null;}
    catch(error){a.error=error.message;e.emit('bot',{name:a.name,action:'claim',error:error.message});}
  }
  await save(path,states);
  const start=states.cursor??0;
  for(let offset=0;offset<actors.length;offset++){
    const {a,s,i}=actors[(start+offset)%actors.length];if(s.halted)continue;
    const balance=async asset=>BigInt(await e.trac('balance',[a.address,asset]));
    const act=(action,args)=>e.action(action,{actionId:'bot-'+i+'-'+action.replaceAll('/','-'),...args},a.name);
    let action=null;
    try{
      if(a.strategy==='discoverer'&&!s.reveal){
        if(!s.commit){
          const used=e.patterns(),digits=Array.from({length:10},(_,n)=>String((i+n)%10));
          const pat=digits.find(p=>!used.some(v=>v.pat===p&&v.fld===4));
          if(pat){s.commit=await act('discovery/commit',{actionId:'bot-pattern-'+i,proposal:{name:patternName({pat,fld:4,dt:'n'},used),pat,fld:4,dt:'n'}});action='discovery/commit';}
        }else if(tip>=s.commit.revealFrom){await act('discovery/reveal',{actionId:'bot-pattern-'+i});s.reveal=true;action='discovery/reveal';}
      }else if(a.strategy==='crafter'){
        if(!s.crafted&&await balance('p0')>0n&&await balance('p1')>0n){const r=await act('craft',{inputs:[['p0','1'],['p1','1']]});s.crafted=r.compound.id;action='craft';}
        else if(s.crafted&&!s.minted&&await balance(s.crafted)>0n){
          if(!s.mint){const r=await act('compound/mint',{asset:s.crafted,amount:'1'});if(r.deploymentNeeded){a.lastAction={action:'deployment_needed',asset:r.asset,tip,at:Date.now()};states.cursor=(i+1)%actors.length;await save(path,states);continue;}s.mint=r.request.id;await save(path,states);}
          await e.pay({id:s.mint});s.minted=true;action='compound/mint';
        }
      }else if(a.strategy==='prospector'){
        if(!s.transfer&&await balance('p0')>0n){await act('transfer',{to:ownerAddress(e.state.player.address),assets:[['p0','1']]});s.transfer=true;action='transfer';}
        else if(!s.minted){
          const finds=e.rows('finds',100000).filter(f=>f.finder===a.address&&f.asset==='p0'&&!e.store.get('minted','p0/'+f.block));
          const find=finds.at(-1);
          if(find&&await balance('p0')>=BigInt(find.count)){
            if(!s.mint){const r=await act('mint',{asset:'p0',block:find.block,amount:String(find.count),kind:i%8===0?'tap':'ethereum'});if(r.deploymentNeeded){a.lastAction={action:'deployment_needed',asset:r.asset,tip,at:Date.now()};states.cursor=(i+1)%actors.length;await save(path,states);continue;}s.mint=r.request.id;await save(path,states);}
            await e.pay({id:s.mint});s.minted=true;action='mint';
          }
        }else if(!s.linked){
          if(s.plot===undefined){for(let h=2;h<tip;h++)if(!e.store.get('links',heightKey(h))&&!await e.reads.tap('getBitmap/'+h)){s.plot=h;break;}await save(path,states);}
          if(s.plot!==undefined){
            await act('bitmap',{height:s.plot});
            if(!s.link){s.link=(await act('link',{height:s.plot})).request.id;await save(path,states);}
            await e.pay({id:s.link,type:'link'});s.linked=true;action='link';
          }
        }
      }
      if(action){a.error=null;a.lastAction={action,tip,at:Date.now()};states.cursor=(i+1)%actors.length;await save(path,states);e.emit('bot',{name:a.name,address:a.address,strategy:a.strategy,...a.lastAction});return;}
    }catch(error){s.halted=true;s.error=error.message;a.error=error.message;await save(path,states);e.emit('bot',{name:a.name,strategy:a.strategy,state:'halted',error:error.message});return;}
  }
}
