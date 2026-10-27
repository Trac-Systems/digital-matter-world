#!/usr/bin/env node
import { publicIdentities, encodeTracAddress } from '../rules/src/trac-address.js';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { open, readFile, rm, unlink, lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ROOT, DATA, BUILD, PORTS, TARGET, TARGET_FILE, origin, json, maybe, save, secretFile, privateDir, diskFloor, freePorts, recorded, identity, stopRecorded, until, check } from './common.mjs';

export async function down() {
  const manifest=await maybe(join(DATA,'manifest.json')); if(!manifest)return;
  if(manifest.supervisor && await identity(manifest.supervisor.pid)===manifest.supervisor.identity)await stopRecorded(manifest.supervisor,45000);
  const rows=await maybe(join(manifest.directory,'pids.json'))??[];
  for(const row of rows.toReversed())if(row.pid!==manifest.supervisor?.pid&&await identity(row.pid)===row.identity)await stopRecorded(row,20000);
  const updated=await maybe(join(DATA,'manifest.json'))??manifest;
  await save(join(DATA,'manifest.json'),{...updated,state:updated.state==='failed'?'failed':'stopped'});
}
async function printLogin() {
  const token=(await readFile(join(DATA,'control.token'),'utf8')).trim();
  console.log(`http://127.0.0.1:${PORTS.control}/?t=${encodeURIComponent(token)}`);
}
async function main() {
  check(process.version==='v23.11.0','Use Node 23.11.0');
  const [action]=process.argv.slice(2);
  if(action==='link'){const m=await maybe(join(DATA,'manifest.json'));check(m?.supervisor&&await identity(m.supervisor.pid)===m.supervisor.identity&&m.state==='ready','Playground is not ready; run node playground/run.mjs up');await printLogin();return;}
  if(action==='status') { const m=await maybe(join(DATA,'manifest.json')); if(!m){console.log(JSON.stringify({state:'absent'}));return;} const live=m.supervisor && await identity(m.supervisor.pid)===m.supervisor.identity; console.log(JSON.stringify(publicIdentities({...m,state:live?m.state:m.state==='failed'?'failed':'stopped'}),null,2));return; }
  if(action==='down'){await down();console.log('Playground stopped; game retained.');return;}
  if(action==='wipe') {
    await down(); const owner=await maybe(join(DATA,'owner.json')); if(!owner){console.log('No playground data.');return;}
    check(owner.project===ROOT && owner.data===DATA && owner.directory.startsWith(BUILD+'/playground/') && /^game-[a-f0-9-]{36}$/.test(owner.directory.split('/').at(-1)),'ownership_mismatch');
    for(const path of [DATA,owner.directory])check(!(await lstat(path)).isSymbolicLink() && await realpath(path)===path,'wipe_symlink');
    const marker=await json(join(owner.directory,'owner.json'));check(marker.data===DATA && marker.project===ROOT,'runtime_ownership_mismatch');
    await rm(owner.directory,{recursive:true});await rm(DATA,{recursive:true});console.log('Playground game and test wallets wiped.');return;
  }
  check(action==='up','Usage: node playground/run.mjs up|link|down|wipe|status'); await diskFloor();
  check(TARGET.mode === 'regtest', 'playground_requires_local_target');
  await privateDir(DATA); let old=await maybe(join(DATA,'manifest.json'));
  if(old?.supervisor && await identity(old.supervisor.pid)===old.supervisor.identity){check(old.state==='ready','Playground is still starting; inspect status');await printLogin();return;}
  await freePorts();
  let owner=await maybe(join(DATA,'owner.json'));
  if(!owner){const directory=join(BUILD,'playground','game-'+randomUUID());await privateDir(directory);owner={project:ROOT,data:DATA,directory};await save(join(DATA,'owner.json'),owner);await save(join(directory,'owner.json'),owner);}
  await secretFile(join(DATA,'control.token'));
  const log=await open(join(owner.directory,'supervisor.log'),'a',0o600);
  const child=spawn(process.execPath,[join(ROOT,'playground/server.mjs'),owner.directory],{env:{...process.env,DMW_TARGET:TARGET_FILE,DMW_PLAYGROUND_DATA:DATA},detached:true,stdio:['ignore',log.fd,log.fd]});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});await log.close();
  const supervisor=await recorded(child.pid,'playground');await save(join(DATA,'supervisor.json'),supervisor);child.unref();
  let phase='';
  const manifest=await until(async()=>{const m=await maybe(join(DATA,'manifest.json'));if(m?.supervisor?.pid!==child.pid)return false;if(m.phase!==phase){phase=m.phase;console.log('Starting: '+phase);}if(m.state==='failed')throw Object.assign(Error(m.error),{fatal:true});return m.state==='ready'?m:false;},'playground startup',{timeout:old?300000:1200000,checkAlive:()=>{if(child.exitCode!==null)throw Error('Playground exited; inspect '+join(owner.directory,'supervisor.log'));}});
  console.log(`Playground ready. Open this local login link:`);await printLogin();
  console.log(`Player: ${publicIdentities(manifest.player).address}\nKit: node playground/kit.mjs status\nPause/mining and all actions: playground/API.md`);
}
async function launch(){
  if(['status','link'].includes(process.argv[2]))return main();
  await privateDir(DATA);const path=join(DATA,'launch.lock');
  let lock;try{lock=await open(path,'wx',0o600);}catch(error){
    if(error.code!=='EEXIST')throw error;
    const old=await maybe(path);check(old&&await identity(old.pid)!==old.identity,'another_lifecycle_command_is_running');
    await unlink(path);lock=await open(path,'wx',0o600);
  }
  try{await lock.writeFile(JSON.stringify(await recorded(process.pid,'lifecycle')));await lock.sync();await main();}
  finally{await lock.close();await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
launch().catch(e=>{console.error(e.message);process.exitCode=1;});
