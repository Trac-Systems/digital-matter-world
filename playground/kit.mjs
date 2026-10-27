#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ROOT, DATA } from './common.mjs';
import { preparePlayer, playerConfig } from './kit-player.mjs';
try {
  const player=await preparePlayer(process.argv.slice(2),{root:join(DATA,'players/agents')});
  if(player.name)process.stderr.write(`Playground signer: ${player.name}; reuse with --player ${player.name}\n`);
  const customConfig=player.args.some(a=>a==='--config'||a.startsWith('--config='));
  let config=[];
  if(!customConfig){
    const base=JSON.parse(await readFile(join(DATA,'kit.json'),'utf8'));
    const path=await playerConfig(base,player,{readState:async()=>JSON.parse(await readFile(join(base.playground.directory,'state.json'),'utf8'))});
    config=['--config',path];
  }
  const child=spawn(process.execPath,[join(ROOT,'kit/bin/dmw.mjs'),...player.args,'--directory',player.directory,...config],{stdio:'inherit',env:{...process.env,DMW_SIGNER_PASSWORD:player.password}});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
  child.on('exit',code=>{process.exitCode=code??1;});child.on('error',()=>{console.error('Could not start the local kit CLI');process.exitCode=1;});
} catch(error) { console.error(error.code?'Could not prepare the local playground signer':error.message);process.exitCode=1; }
