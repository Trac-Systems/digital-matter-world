import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export async function pearPeer(config, root, name) {
  const file = join(root, name + '.json'); await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./pear-child.mjs', import.meta.url)), file], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, XDG_CONFIG_HOME: join(root, name, 'config'), XDG_DATA_HOME: join(root, name, 'data') }
  });
  let pending = '', log = '', nextId = 0, finished = false;
  const calls = new Map(); let readyResolve, readyReject, exitResolve;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise(resolve => { exitResolve = resolve; });
  const timeout = setTimeout(() => readyReject(new Error('Pear startup timed out\n' + log)), 45000);
  const fail = error => { readyReject(error); for (const c of calls.values()) { clearTimeout(c.timer); c.reject(error); } calls.clear(); };
  child.once('error', fail);
  child.once('exit', (code, signal) => { finished = true; clearTimeout(timeout); fail(new Error(`Pear exited ${code ?? signal}\n${log}`)); exitResolve({ code, signal }); });
  child.stdin.on('error', fail);
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-20000); });
  child.stdout.on('data', chunk => {
    log = (log + chunk).slice(-20000); pending += chunk.toString();
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (line.startsWith('DMW_READY ')) { clearTimeout(timeout); readyResolve(JSON.parse(line.slice(10))); }
      if (line.startsWith('DMW_REPLY ')) {
        const reply = JSON.parse(line.slice(10)), call = calls.get(reply.id);
        if (!call) continue; calls.delete(reply.id); clearTimeout(call.timer);
        if (reply.error) call.reject(new Error(reply.error)); else call.resolve(reply.value);
      }
    }
  });
  const close = async () => {
    if (finished) return;
    child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  const rpc = (command, args = {}) => new Promise((resolve, reject) => {
    if (finished) { reject(new Error('Peer exited')); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { calls.delete(id); reject(new Error('Pear command timed out: ' + command + '\n' + log)); }, 45000);
    calls.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, command, args }) + '\n');
  });
  try {
    const info = await ready;
    await writeFile(join(root, name + '-pids.json'), JSON.stringify({ runner: child.pid, peer: info.pid }));
    return { info, rpc, close, exited };
  } catch (e) { await close(); throw e; }
}
