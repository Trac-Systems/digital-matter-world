import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { changeFeePolicy, currentFee } from '../src/fees.mjs';
import { check } from '../src/util.mjs';
import { rules } from '../src/rules.mjs';
import { readRegistry, updateRegistryFees } from '../src/registry.mjs';

export async function reloadBaseFee(filename, decimalTap) {
  return reloadFees(filename, { baseFee: rules.parseTapAmount(decimalTap) });
}
export async function reloadFees(filename, changes, { registryFile = false, at = Date.now(), dryRun = false, executionHeight = '0' } = {}) {
  const config = registryFile ? null : await loadConfig(filename), path = registryFile ? filename : config.prod?.registry ?? config.local?.registry;
  check(typeof path === 'string' && path.startsWith('/'), 'fee_registry_path');
  // Serialize operator changes; readers see one complete document via rename.
  // Preview only the named current revision, including for keyed registries.
  // No history enumeration, lock directory or write is needed for review.
  const previous = dryRun ? currentFee(await readRegistry(path)) : null;
  const updated = dryRun ? changeFeePolicy({ feePolicy: { current: previous.id, revisions: [previous] } }, changes, at, executionHeight) :
    await updateRegistryFees(path, changes, at, {}, executionHeight), fee = currentFee(updated);
  return { baseFee: fee.baseFee, feeSettings: fee.feeSettings ?? rules.FEE_DEFAULTS, unit: rules.TAP_UNIT, revision: fee.id };
}
export function feeArguments(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'base-fee': { type: 'string' }, link: { type: 'string' }, 'tier-multipliers': { type: 'string' }, 'compound-minimum': { type: 'string' },
    'execution-height': { type: 'string' }, registry: { type: 'boolean' }, at: { type: 'string' }, 'dry-run': { type: 'boolean' }
  } });
  check(positionals.length === 1 || positionals.length === 2 && !Object.keys(values).length, 'fee_usage');
  const number = s => { check(typeof s === 'string' && /^[1-9][0-9]*$/.test(s) && Number.isSafeInteger(Number(s)), 'fee_integer'); return Number(s); };
  const base = positionals[1] ?? values['base-fee'], changes = {};
  if (base !== undefined) changes.baseFee = rules.parseTapAmount(base);
  const executionHeight = values['execution-height'] === undefined ? '0' : rules.uintV2(values['execution-height']);
  if (values.link !== undefined) changes.link = values.link === '0' && rules.freeLinkActive(executionHeight) ? 0 : number(values.link);
  if (values['compound-minimum'] !== undefined) changes.compoundMinimum = number(values['compound-minimum']);
  if (values['tier-multipliers'] !== undefined) changes.tierMultipliers = values['tier-multipliers'].split(',').map(number);
  check(Object.keys(changes).length > 0, 'fee_changes');
  check(!values['dry-run'] || values.at, 'fee_preview_timestamp');
  return [positionals[0], changes, { registryFile: values.registry, ...(values['execution-height'] === undefined ? {} : { executionHeight }), ...(values.at ? { at: number(values.at) } : {}),
    ...(values['dry-run'] ? { dryRun: true } : {}) }];
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await reloadFees(...feeArguments(process.argv.slice(2)))));
  } catch { console.error('Fee update failed. Usage: node service/scripts/base-fee.mjs /absolute/config.json [--base-fee TAP] [--link N --execution-height HEIGHT] [--tier-multipliers N,N,N,N,N] [--compound-minimum N]. Use --registry for a registry file; --at fixes the shared revision time. --dry-run --at TIME previews without writing.'); process.exitCode = 1; }
}
