import { constants } from 'node:fs';
import { open, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { atomicWrite, check, privateDirectory, privateRead } from './check.mjs';
import { signBytes } from './signing.mjs';
import { explainError } from './errors.mjs';

const fileName = 'dashboard-control.json';
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const hash = value => createHash('sha256').update(value).digest();
const fail = (ok, message, status = 400) => { if (!ok) throw Object.assign(Error(message), { status }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
async function readRecord(path) {
  let bytes;
  try { bytes = await privateRead(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value; try { value = JSON.parse(bytes); } catch { /* fail closed during startup or corruption */ }
  check(object(value) && Number.isSafeInteger(value.pid) && value.pid > 0,
    'The dashboard control file is incomplete or invalid. Wait for startup, or stop the dashboard and check its control file.');
  if (!alive(value.pid)) return null;
  check(value.v === 1 && hex(value.token) && hex(value.owner) && typeof value.scope === 'string' &&
    typeof value.directory === 'string' && hex(value.profile) && (value.port === null || Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535),
  'The running dashboard has an incompatible control file. Stop it and restart it with this kit.');
  return value;
}

// A different launch profile must never silently use another gateway, owner
// default, strategy or header source just because its signer is the same.
export function dashboardProfile(config, opts = {}) {
  const { directory, ...settings } = config;
  const sorted = value => Array.isArray(value) ? value.map(sorted) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, sorted(value[k])])) : value;
  const path = value => typeof value === 'string' && value ? resolve(value) : value;
  return hash(JSON.stringify(sorted({ ...settings, headers: path(opts.headers ?? config.headers),
    headerSource: opts.source ?? config.headerSource, strategy: path(opts.strategy ?? config.strategy) }))).toString('hex');
}

export async function findDashboardControl({ directory, scope, profile }) {
  const dir = await realpath(await privateDirectory(directory, false));
  const record = await readRecord(join(dir, fileName));
  if (!record) return null;
  check(record.directory === dir && record.scope === scope,
    'Your dashboard is running for a different signer journal. Stop it before using this journal.');
  check(record.profile === profile,
    'Your dashboard is running with different settings. Use its config, header source and strategy, or restart it with the desired settings.');
  check(record.port !== null, 'Your dashboard is starting. Wait for its login link, then retry this command.');
  return record;
}

// Reserve before opening the adapter, then publish the port after listening.
// Exclusive creation prevents a second dashboard from claiming a live record.
export async function reserveDashboardControl({ directory, scope, owner, profile }) {
  const dir = await realpath(await privateDirectory(directory, false)), path = join(dir, fileName);
  check(!await readRecord(path), 'Your dashboard is already running. Use its existing login session, or stop it before starting another.');
  const record = { v: 1, pid: process.pid, directory: dir, scope, owner, profile, port: null, token: randomBytes(32).toString('hex') };
  let fd;
  try { fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    check(!await readRecord(path), 'Your dashboard is already running. Stop it before starting another.');
    await unlink(path); // Only a dead process's private record; never its stores.
    fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  }
  try { await fd.writeFile(JSON.stringify(record) + '\n'); await fd.sync(); } finally { await fd.close(); }
  return { record,
    async publish(port) {
      check((await readRecord(path))?.token === record.token, 'The dashboard control reservation changed. Stop this dashboard and retry.');
      record.port = port; await atomicWrite(path, JSON.stringify(record) + '\n');
    },
    async release() {
      const current = await readRecord(path);
      if (current?.token === record.token && current.pid === record.pid) await unlink(path);
    }
  };
}

// This is a local control proof, never a game/payment signature. Bind every
// byte of the call and a short-lived nonce to this dashboard's fresh token.
function proof(record, at, nonce, body) {
  return hash(JSON.stringify(['dmw-dashboard-control-v1', record.scope, record.token, at, nonce, body]));
}
export function controlRequest(record, wallet, call) {
  const body = JSON.stringify(call), at = String(Date.now()), nonce = randomBytes(32).toString('hex');
  return { body, headers: { 'content-type': 'application/json', 'x-dmw-control-token': record.token,
    'x-dmw-control-time': at, 'x-dmw-control-nonce': nonce, 'x-dmw-control-proof': signBytes(wallet, proof(record, at, nonce, body)) } };
}

export function dashboardControlHandler(lease, invoke) {
  const record = lease.record, expected = hash(record.token), used = new Map();
  let tail = Promise.resolve(), closing = false;
  return {
    async handle(req, res) {
      const json = (value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
      try {
        fail(!closing, 'Your dashboard is stopping. Restart it before sending another command.', 503);
        fail(req.method === 'POST' && req.url === '/control/tool', 'Use POST for a dashboard tool call.', 405);
        fail(req.socket.remoteAddress === '127.0.0.1' && req.headers.host === `127.0.0.1:${record.port}`, 'Dashboard commands are local only.', 403);
        fail(!Object.keys(req.headers).some(k => k === 'origin' || k === 'cookie' || k.startsWith('sec-fetch-')),
          'Browser requests cannot use dashboard commands. Use the local CLI or MCP.', 403);
        const token = req.headers['x-dmw-control-token'];
        fail(typeof token === 'string' && token.length <= 128 && timingSafeEqual(hash(token), expected), 'Dashboard command authentication failed.', 401);
        fail(req.headers['content-type'] === 'application/json', 'Dashboard commands require JSON.', 415);
        const chunks = []; let size = 0;
        for await (const part of req) { size += part.length; fail(size <= 1500000, 'Dashboard command is too large.', 413); chunks.push(part); }
        const body = Buffer.concat(chunks).toString('utf8');
        const at = req.headers['x-dmw-control-time'], nonce = req.headers['x-dmw-control-nonce'], signature = req.headers['x-dmw-control-proof'];
        const now = Date.now();
        fail(typeof at === 'string' && /^[0-9]{13}$/.test(at) && Math.abs(now - Number(at)) <= 60000 && hex(nonce) &&
          typeof signature === 'string' && /^[0-9a-f]{128}$/.test(signature) &&
          ed25519.verify(signature, proof(record, at, nonce, body), record.owner, { zip215: false }),
        'Unlock your signer with its password before using dashboard commands.', 401);
        for (const [key, expiry] of used) if (expiry < now) used.delete(key);
        fail(!used.has(nonce), 'This dashboard command was already received. Retry with the same action ID through the CLI.', 409);
        fail(used.size < 4096, 'Too many dashboard commands. Wait a minute and retry.', 429);
        used.set(nonce, Number(at) + 60000);
        let call; try { call = JSON.parse(body); } catch { /* validated below */ }
        fail(object(call) && Object.keys(call).every(k => ['name', 'input', 'readOnly', 'live', 'waitForHistory'].includes(k)) &&
          typeof call.name === 'string' && object(call.input) && typeof call.readOnly === 'boolean' && typeof call.live === 'boolean' &&
          (call.waitForHistory === undefined || typeof call.waitForHistory === 'boolean'),
        'Pass a tool name, object input, and boolean readOnly/live settings.');
        // close() may have started while an authenticated client uploaded its
        // body. Never enqueue new work after shutdown has drained the queue.
        fail(!closing, 'Your dashboard is stopping. Restart it before sending another command.', 503);
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', abort);
        const task = tail.then(() => { controller.signal.throwIfAborted(); return invoke(call, { signal: controller.signal }); });
        tail = task.catch(() => {});
        try { json({ result: await task }); } finally { res.off('close', abort); }
      } catch (error) { if (!res.destroyed) json({ error: explainError(error) }, Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 400); }
    },
    async close() { closing = true; await tail; }
  };
}

export async function forwardDashboardTool(record, wallet, call, { signal } = {}) {
  const { body, headers } = controlRequest(record, wallet, call);
  let reply;
  try {
    reply = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: record.port, path: '/control/tool', method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(body) }, signal, agent: false }, res => {
        const chunks = [];
        res.on('data', part => chunks.push(part)); res.on('error', reject);
        res.on('end', () => { try { resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.end(body);
    });
  } catch {
    throw Error('Your dashboard connection was interrupted. The command may have run inside it. Check status and retry with the same action ID; no direct retry was made.');
  }
  if (reply.status !== 200) throw Error(reply.value?.error ?? 'Your dashboard refused this command. Restart it with the current kit and retry.');
  check(object(reply.value) && Object.hasOwn(reply.value, 'result'), 'Your dashboard returned an invalid tool result. Check status before retrying the same action ID.');
  return reply.value.result;
}
