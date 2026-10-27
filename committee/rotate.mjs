import { readFile } from 'node:fs/promises';
import { rotateRoster } from './rosters.mjs';
import { rotateLocalSigner } from './local-rotation.mjs';
const [config, replace, replacementFile, mode = '--dry-run'] = process.argv.slice(2);
if (!config || !replace || !replacementFile || !['--dry-run', '--execute'].includes(mode)) throw Error('usage_rotate_config_old_id_replacement_json_dry_run_or_execute');
const replacement = JSON.parse(await readFile(replacementFile, 'utf8'));
console.log(JSON.stringify(await (replacement.sharePlan ? rotateLocalSigner : rotateRoster)(config, { replace, replacement, dryRun: mode !== '--execute' }), null, 2));
