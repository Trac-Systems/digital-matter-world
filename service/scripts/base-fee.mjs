import { readFile, mkdir, rmdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { changeBaseFee } from '../src/fees.mjs';
import { atomicWrite, check } from '../src/util.mjs';
import { rules } from '../src/rules.mjs';
import { updateRegistry } from '../src/registry.mjs';

export async function reloadBaseFee(filename, decimalTap) {
  const baseFee = rules.parseTapAmount(decimalTap);
  check(baseFee !== '0', 'base_fee');
  const config = await loadConfig(filename), path = config.local?.registry;
  check(typeof path === 'string' && path.startsWith('/'), 'fee_registry_path');
  // Serialize operator changes; readers see one complete document via rename.
  const updated = await updateRegistry(path, registry => changeBaseFee(registry, baseFee));
  return { baseFee, unit: rules.TAP_UNIT, revision: updated.feePolicy.current };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.length === 4, 'usage_base_fee_config_absolute_path_decimal_tap');
    console.log(JSON.stringify(await reloadBaseFee(process.argv[2], process.argv[3])));
  } catch { console.error('Base-fee update failed; verify the local configuration, amount and update lock.'); process.exitCode = 1; }
}
