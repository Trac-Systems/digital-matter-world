import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, DEFAULT_TARGET, privateDirectory } from './target.mjs';
export const BUILD = resolve(process.env.DMW_BUILD_ROOT || resolve(ROOT, '../build'));
export const steps = ['preflight', 'committee', 'bitcoin', 'trac', 'ethereum', 'smoke', 'kit'];
export function loopback(value) {
  const u = new URL(value);
  assert(u.protocol === 'http:' && u.hostname === '127.0.0.1' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash, 'Only credential-free loopback HTTP origins are supported');
  return u.origin;
}
export function validate(c) {
  assert.equal(c.version, 1); assert.equal(c.mode, 'regtest');
  assert(/^[a-zA-Z0-9._:-]{1,96}$/.test(c.network));
  assert.equal(resolve(c.output), BUILD + '/deploy', 'Output is confined to the dedicated build directory');
  loopback(c.bitcoin.rpc); loopback(c.indexer); loopback(c.ethereum.rpc);
  loopback(c.bitcoin.witnessRpc); assert.notEqual(c.bitcoin.witnessRpc, c.bitcoin.rpc);
  assert.equal(c.ethereum.chainId, 31337);
  assert.equal(c.ethereum.referenceToken, '0x5e7f6e008c6d9d7ad4c7eb75bd4ce62864cc7454');
  assert(/^[1-9][0-9]{0,5}$/.test(c.ethereum.estimateGasPriceGwei));
  assert.equal(c.committee.members, 5); assert.equal(c.committee.threshold, 3);
  assert.equal(c.bitcoin.checkpointHeight, 2016, 'This rehearsal pins the first non-genesis retarget boundary');
  for (const n of [c.bitcoin.feeRate, c.bitcoin.estimateFeeRate]) assert(Number.isSafeInteger(n) && n > 0 && n <= 1000);
  assert(Number.isSafeInteger(c.bitcoin.postage) && c.bitcoin.postage >= 330 && c.bitcoin.postage <= 1000000);
  const ports = [Number(new URL(c.bitcoin.rpc).port), Number(new URL(c.indexer).port), c.walletGatewayPort, Number(new URL(c.ethereum.rpc).port), Number(new URL(c.bitcoin.witnessRpc).port), c.trac.port, c.gateway.port,
    ...Array.from({ length: 5 }, (_, i) => c.committee.sidecarPort + i), ...Array.from({ length: 5 }, (_, i) => c.committee.signerPort + i)];
  assert(ports.every(p => Number.isInteger(p) && p >= 1024 && p <= 65535)); assert.equal(new Set(ports).size, ports.length);
  for (const n of [c.smoke.baseFeeAtoms]) assert(/^[1-9][0-9]{0,7}$/.test(n) && BigInt(n) % 100n === 0n);
  return c;
}
export function argumentsFor(argv) {
  assert(argv.includes('--dry-run') && argv.includes('--regtest'), 'Both --dry-run and --regtest are mandatory; no live mode exists');
  const result = { through: 'kit' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '--regtest') continue;
    assert(['--target', '--through'].includes(arg), 'Unknown argument');
    assert(argv[i + 1] && !argv[i + 1].startsWith('--'), 'Missing argument value');
    assert(!Object.hasOwn(result, arg.slice(2)) || arg === '--through', 'Duplicate argument');
    result[arg.slice(2)] = argv[++i];
  }
  assert(steps.includes(result.through), 'Choose a valid phase');
  if (!result.target) result.target = DEFAULT_TARGET;
  return result;
}
export async function load(path) { return validate(JSON.parse(await readFile(path, 'utf8'))); }
export async function diskCheck(directory = BUILD) {
  await privateDirectory(directory);
  const f = await statfs(directory); assert(f.bavail * f.bsize >= 100 * 1024 ** 3, 'Less than 100 GiB free; stopped');
}
export function elementPlan(patterns, elements, deployments) {
  assert(Array.isArray(elements) && Array.isArray(deployments), 'Indexer lists must be complete arrays');
  return patterns.map(p => {
    const matches = elements.filter(e => e.pat === p.pat && Number(e.fld) === p.fld);
    assert(matches.length <= 1, 'Ambiguous pattern/field index');
    const allocate = (domain, occupied) => { let name = p.name.toLowerCase(), attempt = 0; while (occupied(name)) name = 'dmw' + createHash('sha256').update(JSON.stringify([domain, p, ++attempt])).digest('hex').slice(0, 29); return name; };
    const elementName = allocate('preview-element', name => elements.some(e => e.tick?.toLowerCase() === name));
    const tick = allocate('preview-ticker', name => deployments.some(d => d.tick?.toLowerCase() === 'dmt-' + name));
    if (matches.length) assert(/^[0-9a-f]{64}i[0-9]+$/.test(matches[0].ins));
    return { ...p, elementName, tick, element: matches[0]?.ins ?? null, reuse: !!matches.length };
  });
}
export function verifyRuntime(expected, actual, references) {
  const a = Buffer.from(expected.replace(/^0x/, ''), 'hex'), b = Buffer.from(actual.replace(/^0x/, ''), 'hex');
  assert(a.length > 100 && a.length === b.length, 'Runtime length mismatch');
  for (const refs of Object.values(references)) for (const { start, length } of refs) {
    assert(start >= 0 && length > 0 && start + length <= a.length); a.fill(0, start, start + length); b.fill(0, start, start + length);
  }
  assert(a.equals(b), 'Compiled runtime differs outside compiler-declared immutable references');
}
