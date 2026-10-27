import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile, mkdir, lstat, realpath, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { playgroundTarget } from '../deploy/playground-target.mjs';
export { save, append, diskFloor, identity, recorded, stopRecorded, sleep, exec } from '../service/scripts/soak/common.mjs';
export { BUILD } from '../local/common.mjs';
export const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
export const PROFILE = process.env.DMW_PLAYGROUND_PROFILE ?? 'default';
const selected = await playgroundTarget({ profile: PROFILE, filename: process.env.DMW_TARGET, dataDirectory: process.env.DMW_PLAYGROUND_DATA });
export const TARGET = selected.target, TARGET_FILE = selected.filename, DATA = selected.data, PORTS = selected.ports;
export const origin = `http://127.0.0.1:${PORTS.control}`;
export const randomHex = () => randomBytes(32).toString('hex');
export const json = path => readFile(path,'utf8').then(JSON.parse);
export const maybe = path => json(path).catch(e=>{if(e.code !== 'ENOENT')throw e;return null;});
export function check(value, message) { if (!value) throw Error(message); }
export function integer(value, min, max) { check(Number.isSafeInteger(value) && value >= min && value <= max, `integer_${min}_${max}`); return value; }
export async function privateDir(path) { await mkdir(path,{recursive:true,mode:0o700}); check(!(await lstat(path)).isSymbolicLink() && await realpath(path)===path,'private_directory_symlink'); }
export async function secretFile(path) { try { return await readFile(path,'utf8'); } catch(e) { if(e.code!=='ENOENT')throw e; } const value=randomHex(); const fd=await open(path,'wx',0o600); try{await fd.writeFile(value);await fd.sync();}finally{await fd.close();}return value; }
export async function freePorts() { for(const port of [PORTS.control,PORTS.bitcoin,PORTS.ord,PORTS.wallet,PORTS.ethereum,PORTS.trac,PORTS.gateway,...PORTS.tss,...PORTS.signers]) { const s=createServer(); await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(port,'127.0.0.1',resolve);}); await new Promise(resolve=>s.close(resolve)); } const udp=createSocket('udp4');try{await new Promise((resolve,reject)=>{udp.once('error',reject);udp.bind(PORTS.dht,'127.0.0.1',resolve);});}finally{try{udp.close();}catch{}} }
export async function until(fn,label,{timeout=120000,checkAlive=()=>{}}={}) { const end=Date.now()+timeout; let error; while(Date.now()<end) { checkAlive(); try { const v=await fn(); if(v)return v; } catch(e) {if(e.fatal)throw e;error=e;} await new Promise(r=>setTimeout(r,150)); } throw Error(`timeout: ${label}${error ? ' ('+error.message+')' : ''}`); }
