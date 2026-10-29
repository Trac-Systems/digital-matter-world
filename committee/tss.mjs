import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { provisionOperator } from './provision.mjs';
import { lifecycleSignal } from '../service/src/lifecycle.mjs';

export const root = dirname(fileURLToPath(import.meta.url));
export const buildRoot = resolve(process.env.DMW_BUILD_ROOT || resolve(root, '../../build'), 'target/committee');
export const binary = process.env.DMW_TSS_BINARY || resolve(buildRoot, 'dmw-tss');
export const hex = b => Buffer.from(b).toString('hex');
export const randomHex = () => hex(randomBytes(32));
export const delay = ms => new Promise(r => setTimeout(r, ms));
export async function privateJSON(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
}
export async function rpc(url, token, path, body = {}, timeout = 30000, signal = lifecycleSignal()) {
  signal?.throwIfAborted();
  const u = new URL(url);
  const local = u.protocol === 'http:' && u.hostname === '127.0.0.1';
  const remote = u.protocol === 'https:' && /^[a-zA-Z0-9.-]+\.[a-zA-Z]+$/.test(u.hostname) && !/localhost|\.local$/.test(u.hostname);
  if ((!local && !remote) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error('authenticated_transport_required');
  const deadline = AbortSignal.timeout(timeout);
  const response = await fetch(new URL(path, u), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? `http_${response.status}`);
  return result;
}
export async function createGroup(directory, { prefix = 'signer', port = 57500, network = 'dmw-regtest', epoch = 1,
  idSeparator = '-', stateSubdirectory = '' } = {}) {
  const peers = [];
  for (let i = 0; i < 5; i++) {
    const id = `${prefix}${idSeparator}${i+1}`;
    peers.push(await provisionOperator({directory:resolve(directory,id,stateSubdirectory),id,url:`http://127.0.0.1:${port+i}`,network}));
  }
  const group = [];
  for (const member of peers) {
    const dir = resolve(directory, member.id, stateSubdirectory), secrets = resolve(dir, 'credentials.json'), config = resolve(dir, 'sidecar.json');
    await privateJSON(config, { id: member.id, network, epoch, listen: new URL(member.url).host, directory: dir, secrets, peers });
    group.push({ ...member, config, directory: dir });
  }
  // This inventory contains public descriptors and paths, never all credentials.
  await privateJSON(resolve(directory, 'group.json'), { network, group });
  return (await loadGroup(directory)).group;
}
export async function startSidecar(member, onPID = async () => {}) {
  const log = await open(resolve(member.directory, 'sidecar.log'), 'a', 0o600);
  const child = spawn(binary, [member.config], { stdio: ['ignore', log.fd, log.fd] });
  child.on('error', () => {});
  await log.close();
  if (!child.pid) throw Error('sidecar_spawn');
  await onPID(child.pid, member.config);
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error('sidecar_start_failed');
    try { await rpc(member.url, member.token, '/status', {}, 500); return child; } catch { await delay(100); }
  }
  child.kill('SIGTERM'); throw Error('sidecar_start_timeout');
}
export const descriptor = ({ id, url, identity, encryption }) => ({ id, url, identity, encryption });
export async function ceremony(group, kind, { network = 'dmw-regtest', epoch = 1, digest = '', newGroup = [], timeout = 900, id = randomHex(), onStatus = () => {} } = {}) {
  const participants = [...group, ...newGroup];
  const start = { id, kind, network, epoch, digest, peers: group.map(descriptor), newPeers: newGroup.map(descriptor), timeout };
  let decision;
  try {
    const prepared = await Promise.allSettled(participants.map(p => rpc(p.url, p.token, '/prepare', start)));
    const failure = prepared.find(p => p.status === 'rejected'); if (failure) throw failure.reason;
    await Promise.all(participants.map(p => rpc(p.url, p.token, '/go')));
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      const states = await Promise.all(participants.map(p => rpc(p.url, p.token, '/status')));
      for (const state of states) if (state.session?.id !== id || state.session?.status === 'aborted') throw Error(state.session?.error ?? 'ceremony_lost');
      onStatus(states);
      if (kind === 'sign' && states.every(p => p.session.status === 'complete')) {
        const signatures = states.map(p => JSON.stringify(p.session.signature));
        if (new Set(signatures).size !== 1) throw Error('signature_disagreement');
        return states[0].session.signature;
      }
      if (kind !== 'sign' && states.every(p => p.session.status === 'ready')) {
        const certificates = states.map(p => p.session.ready);
        if (new Set(certificates.map(c => c.commitment)).size !== 1) throw Error('ceremony_disagreement');
        // Retain the public decision for recovery. Store every replacement share
        // before erasing any old one; interruption must not destroy the key.
        await privateJSON(resolve(group[0].directory, `decision-${id}.json`), { start, publicKey: states[0].session.public, certificates });
        decision = {start,publicKey:states[0].session.public,certificates};
        const order = kind === 'reshare' ? [newGroup, group] : [group];
        for (const members of order) await Promise.all(members.map(p => rpc(p.url, p.token, '/commit', certificates)));
        return { publicKey: states[0].session.public, epoch, certificate: certificates };
      }
      await delay(100);
    }
    throw Error('ceremony_timeout');
  } catch (error) {
    if (!decision) await Promise.allSettled(participants.map(p => rpc(p.url, p.token, '/abort', {}, 1000)));
    else error.decision = decision;
    throw error;
  }
}
export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(r => child.once('exit', r)), delay(10000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(r => child.once('exit', r)); }
}
export async function loadGroup(directory) {
  const inventory=JSON.parse(await readFile(resolve(directory,'group.json'),'utf8'));
  for(const m of inventory.group)m.token=JSON.parse(await readFile(resolve(m.directory,'credentials.json'),'utf8')).token;
  return inventory;
}

export async function recoverCommit(group, decision, newGroup = []) {
  const {start,certificates,publicKey}=decision;
  if(!start || start.kind==='sign' || JSON.stringify(start.peers)!==JSON.stringify(group.map(descriptor)) || JSON.stringify(start.newPeers)!==JSON.stringify(newGroup.map(descriptor)))throw Error('recovery_roster');
  for(const members of start.kind==='reshare'?[newGroup,group]:[group])for(const member of members)await rpc(member.url,member.token,'/commit',certificates);
  return {publicKey,epoch:start.epoch,certificate:certificates};
}
