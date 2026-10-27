import { operatorCommand } from '../service/scripts/operator.mjs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { DATA, ROOT, PORTS, TARGET, origin, json, maybe, save, append, diskFloor, recorded, until, integer, check } from './common.mjs';
import { Processes,startBase } from './stack.mjs';
import { boot } from './bootstrap.mjs';
import { Engine } from './engine.mjs';
import { createViews } from './views.mjs';
import { Jobs,serveControl } from './http.mjs';
import { createReadAPI,projectJob } from './api.mjs';
import { botsOnce } from './bots.mjs';
import { forwardDeployment } from './deployment-proxy.mjs';
import { paymentPlan,fundWallet } from './wallets.mjs';
import { bitcoin,mine } from '../local/common.mjs';
import { reloadBaseFee } from '../service/scripts/base-fee.mjs';

const directory=process.argv[2],processes=new Processes(directory);let base,game,engine,views,http,jobs,timer,stopping=false;
const supervisor=await recorded(process.pid,'playground');await processes.remember(process.pid,'playground');
let manifest={version:1,state:'starting',phase:'preflight',directory,supervisor,ports:PORTS,control:origin,console:origin,history:{kind:'regtest',seedBlocks:TARGET.local.playground.historyHeight}};
const events=(await maybe(join(directory,'events.json'))??[]).slice(-2000);let sequence=events.at(-1)?.sequence??0;
const emit=(type,data)=>{const event={sequence:++sequence,at:Date.now(),type,data};events.push(event);if(events.length>2000)events.shift();http?.publish(event);};
const progress=async phase=>{manifest.phase=phase;await save(join(DATA,'manifest.json'),manifest);emit('component',{phase});};
async function dispatch(type,args){
  check(engine,'playground_starting');processes.alive();
  if(type==='mine')return engine.blocks(integer(args.count??1,1,10000),{fast:(args.count??1)>10});
  if(type==='time-travel')return engine.blocks(integer(args.blocks,1,10000),{fast:true});
  if(type==='mining'){check(typeof args.enabled==='boolean','enabled_boolean');engine.settings.mining={enabled:args.enabled,intervalMs:integer(args.intervalMs??engine.settings.mining.intervalMs,1000,3600000)};await engine.saveSettings();return engine.settings.mining;}
  if(type==='bots')return engine.configureBots(args);
  if(type==='bots/step'){await botsOnce(engine,{force:true});return engine.botState();}
  if(type==='wallets/fund')return fundWallet(engine,args);
  if(type==='operator/payouts')return operatorCommand(game.config,{action:'payouts',...args});
  if(type==='operator/provision')return operatorCommand(game.config,{action:'provision',...args});
  if(type==='fee')return reloadBaseFee(game.filename,args.baseFee);
  if(type==='reorg'){
    const depth=integer(args.depth,1,7),before=await bitcoin(base.manifest,'getblockcount'),oldHash=await bitcoin(base.manifest,'getbestblockhash');
    await processes.stop(game.gateway);
    await bitcoin(base.manifest,'setmocktime',[(await bitcoin(base.manifest,'getblockheader',[oldHash,true])).time+60]);
    await bitcoin(base.manifest,'invalidateblock',[await bitcoin(base.manifest,'getblockhash',[before-depth+1])]);await mine(base.manifest,depth+1);
    game.gateway=await processes.start('gateway',process.execPath,[join(ROOT,'service/run.mjs'),game.filename]);await engine.drain();
    const result={reorg:true,depth,before,tip:await bitcoin(base.manifest,'getblockcount'),oldHash,newHash:await bitcoin(base.manifest,'getbestblockhash'),replacementBlocks:depth+1};emit('block',result);return result;
  }
  if(type.startsWith('player/'))return engine.action(type.slice(7),args);
  if(type==='automation/bots'){await botsOnce(engine);return engine.botState();}
  throw Error('unknown_action');
}
async function route(method,url,args){
  const path=url.pathname.slice(5);
  if(method==='GET'&&path==='status'&&!engine)return manifest;
  if(method==='GET'&&path.startsWith('jobs/'))return createReadAPI({views,engine,jobs,events,paymentPlan})(url);
  check(engine&&manifest.state==='ready','playground_not_ready');
  if(method==='POST'&&path==='gateway/mint/deployment')return forwardDeployment(engine,args);
  if(method==='POST')return projectJob(await jobs.submit(path,args));
  check(method==='GET','method_not_allowed');
  return createReadAPI({views,engine,jobs,events,paymentPlan})(url);
}
async function shutdown(){if(stopping)return;stopping=true;clearInterval(timer);if(jobs){jobs.accepting=false;await jobs.tail.catch(()=>{});}await progress('stopping');
  await http?.close();if(game?.gateway)await processes.stop(game.gateway);await engine?.close();await game?.bootstrap.close();await base?.walletGateway.stop();
  await base?.evm.checkpoint();await save(join(directory,'events.json'),events);await processes.close();
  manifest.state=manifest.error?'failed':'stopped';manifest.phase=manifest.state;await save(join(DATA,'manifest.json'),manifest);
}
process.once('SIGTERM',()=>void shutdown().catch(e=>{console.error(e);process.exitCode=1;}));process.once('SIGINT',()=>void shutdown().catch(e=>{console.error(e);process.exitCode=1;}));
try{
  await diskFloor();await progress('bitcoin-ord-anvil');
  jobs=new Jobs(directory,emit,dispatch);await jobs.init();
  http=await serveControl({port:PORTS.control,token:(await readFile(join(DATA,'control.token'),'utf8')).trim(),events,route,
    publicEvents:params=>{check(engine&&manifest.state==='ready','playground_not_ready');return engine.get('/events?'+new URLSearchParams(params));}});
  base=await startBase(directory,processes);game=await boot(directory,base,processes,progress);
  await progress('catching-up');engine=await new Engine({directory,...base,...game,processes,emit}).init();views=createViews(engine);
  manifest.state='ready';manifest.phase='ready';manifest.player={address:game.state.player.address};await save(join(DATA,'manifest.json'),manifest);emit('component',{state:'ready'});
  let lastMine=Date.now(),lastBots=Date.now(),lastCheckpoint=Date.now();
  timer=setInterval(()=>{
    if(stopping)return;
    if(processes.failure){manifest.error=processes.failure;console.error(processes.failure);void shutdown();return;}
    if(jobs.pending)return;const now=Date.now();
    if(now-lastCheckpoint>10000){lastCheckpoint=now;void base.evm.checkpoint().catch(e=>{manifest.error=e.message;void shutdown();});}
    if(!engine.settings.bots.paused&&now-lastBots>=engine.settings.bots.intervalMs){lastBots=now;void jobs.submit('automation/bots',{});}
    else if(engine.settings.mining.enabled&&now-lastMine>=engine.settings.mining.intervalMs){lastMine=now;void jobs.submit('mine',{count:1});}
  },1000);
}catch(e){console.error(e);manifest.error=e.message;await shutdown().catch(error=>console.error(error));process.exitCode=1;}
