import { readFile, open, realpath, access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
export const REGTEST_TEMPLATE = resolve(ROOT, 'deploy/targets/regtest.json');
export const DEFAULT_TARGET = resolve(ROOT, 'deploy/targets/regtest.local.json');
export const need = (ok, message) => { if (!ok) throw Error(message); };
export const sha256 = async bytes => (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
const schema = JSON.parse(await readFile(new URL('./targets/schema.json', import.meta.url), 'utf8'));

// Errors contain schema-owned slot names only, never supplied values or unknown keys.
export function validateTarget(value, shape = schema, slot = 'target') {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  need(shape.type === type || shape.type === 'integer' && Number.isSafeInteger(value), `${slot}: wrong type`);
  if (shape.const !== undefined) need(value === shape.const, `${slot}: wrong version`);
  if (shape.enum) need(shape.enum.includes(value), `${slot}: unsupported choice`);
  if (type === 'object') {
    need(Object.keys(value).length === shape.required.length && shape.required.every(k => Object.hasOwn(value, k)), `${slot}: missing or unknown slots`);
    for (const key of shape.required) validateTarget(value[key], shape.properties[key], `${slot}.${key}`);
  } else if (type === 'array') {
    need(value.length === shape.minItems, `${slot}: wrong number of members`);
    value.forEach((v, i) => validateTarget(v, shape.items, `${slot}[${i}]`));
  }
  return value;
}
export async function loadTarget(filename = DEFAULT_TARGET) {
  let value; try { value = JSON.parse(await readFile(filename, 'utf8')); } catch { throw Error('Target file is missing or is not valid JSON'); }
  // The annotated owner worksheet is also a launch input. Only its strict
  // target projection reaches readers or the durable launch binding.
  if (value?.format === 'dmw-mainnet-inputs-v1') {
    need(Object.keys(value).sort().join(',') === 'files,format,notes,operations,target', 'Input worksheet: missing or unknown sections');
    need(value.target?.mode === 'mainnet', 'Input worksheet: mainnet target required');
    // Worksheet nulls denote generated outputs or unused legacy slots, never
    // invented addresses/pins. Execution still receives the strict schema and
    // fails its normal readiness gates until preparation resolves them.
    value = worksheetTarget(value.target);
  }
  return validateTarget(value);
}
export function worksheetTarget(value, shape = schema) {
  if (value === null && shape.type === 'string') return '';
  if (Array.isArray(value) && shape.type === 'array') return value.map(v => worksheetTarget(v, shape.items));
  if (value && typeof value === 'object' && shape.type === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape.properties[k] ? worksheetTarget(v, shape.properties[k]) : v]));
  return value;
}

export async function privateDirectory(directory) {
  try {
    need(isAbsolute(directory) && resolve(directory) === directory && await realpath(directory) === directory, 'path');
    need(!directory.startsWith(ROOT + sep) && directory !== ROOT, 'repository');
    for (let dir = directory; ; dir = dirname(dir)) {
      let repo = false; try { await access(dir + '/.git'); repo = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      need(!repo, 'repository'); if (dirname(dir) === dir) break;
    }
    const s = await stat(directory); need(s.isDirectory() && s.uid === process.getuid(), 'ownership');
    return directory;
  } catch { throw Error('Use an owned directory outside repositories, without symlinks'); }
}

// Refuse symlinks, non-owner files and credentials under ANY checkout. No error
// from the filesystem or JSON parser is allowed to carry a secret into a report.
export async function privateBytes(filename, limit = 2_000_000) {
  let fd;
  try {
    need(typeof filename === 'string' && isAbsolute(filename) && resolve(filename) === filename, 'path');
    need(!filename.startsWith(ROOT + sep) && await realpath(filename) === filename, 'path');
    for (let dir = dirname(filename); ; dir = dirname(dir)) {
      let repo = false; try { await access(dir + '/.git'); repo = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      need(!repo, 'repository'); if (dirname(dir) === dir) break;
    }
    fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const s = await fd.stat();
    need(s.isFile() && (s.mode & 0o777) === 0o600 && s.uid === process.getuid() && s.size > 0 && s.size <= limit, 'permissions');
    const bytes = Buffer.alloc(limit + 1), { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    need(bytesRead > 0 && bytesRead <= limit, 'size'); return bytes.subarray(0, bytesRead);
  } catch { throw Error('Supply an owned, nonempty 0600 file outside repositories, without symlinks'); }
  finally { await fd?.close(); }
}
export const secret = async filename => (await privateBytes(filename)).toString('utf8').trim();
export async function privateJSON(filename) {
  const bytes = await privateBytes(filename);
  try { return JSON.parse(bytes); } catch { throw Error('Private file must contain valid JSON'); }
}
export function localOrigin(value) {
  let u; try { u = new URL(value); } catch { throw Error('Endpoint file must contain a loopback HTTP origin'); }
  need(u.protocol === 'http:' && u.hostname === '127.0.0.1' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash,
    'Endpoint file must contain a credential-free loopback HTTP origin');
  return u.origin;
}
export async function endpoint(spec) {
  const url = localOrigin(await secret(spec.urlFile)), headers = {};
  need(!(spec.authFile && spec.tokenFile), 'Choose one endpoint authentication file');
  if (spec.authFile) {
    const text = await secret(spec.authFile); need(text.includes(':') && !/[\r\n]/.test(text), 'Invalid authentication file');
    headers.authorization = 'Basic ' + Buffer.from(text).toString('base64');
  }
  if (spec.tokenFile) {
    const text = await secret(spec.tokenFile); need(text && !/[\r\n]/.test(text), 'Invalid token file');
    headers.authorization = 'Bearer ' + text;
  }
  return { url, headers };
}
export async function request(ep, { path = '', body } = {}) {
  try {
    const response = await fetch(ep.url + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { ...ep.headers, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    need(response.ok, 'HTTP');
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; need(size <= 2_000_000, 'size'); chunks.push(value); } }
    finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw Error('Read failed: check the service, authentication and response size (no redirects are followed)'); }
}
export async function rpc(ep, method, params = [], path = '') {
  const body = await request(ep, { path, body: { jsonrpc: '2.0', id: 1, method, params } });
  need(!body.error && Object.hasOwn(body, 'result'), 'RPC read failed; inspect the private service log'); return body.result;
}
export async function tracRead(ep, method, args = []) {
  const body = await request(ep, { body: { method, args } });
  need(!body.error && Object.hasOwn(body, 'result'), 'Trac read failed; inspect the private service log'); return body.result;
}

// The existing launcher still owns isolated process lifecycle. This projection
// is the only translation from the shared target into its historical format.
export function launchConfig(t, urls) {
  need(t.mode === 'regtest', 'Mainnet execution is disabled');
  return { version: 1, mode: t.mode, network: t.network, output: t.paths.output,
    bitcoin: { rpc: urls.bitcoin, witnessRpc: urls.witness, checkpointHeight: t.bitcoin.checkpointHeight,
      feeRate: t.bitcoin.feeRate, estimateFeeRate: t.bitcoin.estimateFeeRate, postage: t.bitcoin.postage },
    indexer: urls.indexer, walletGatewayPort: t.local.walletGatewayPort,
    ethereum: { rpc: urls.ethereum, chainId: Number(t.ethereum.chainId), referenceToken: t.ethereum.referenceToken, estimateGasPriceGwei: t.ethereum.estimateGasPriceGwei },
    committee: { members: 5, threshold: t.committee.threshold, sidecarPort: t.local.sidecarPort, signerPort: t.local.signerPort },
    trac: { port: Number(new URL(urls.trac).port) }, gateway: { port: Number(new URL(urls.gateway).port) }, smoke: t.local.smoke };
}
export async function loadLaunchTarget(filename) {
  const target = await loadTarget(filename); need(target.mode === 'regtest', 'Mainnet execution is disabled');
  const urls = {};
  for (const [name, spec] of Object.entries({ bitcoin: target.bitcoin.rpc, witness: target.bitcoin.witnessRpc, indexer: target.indexer.endpoint,
    ethereum: target.ethereum.rpc, trac: target.trac.endpoint, gateway: target.gateway.endpoint })) urls[name] = (await endpoint(spec)).url;
  return { target, config: launchConfig(target, urls) };
}
