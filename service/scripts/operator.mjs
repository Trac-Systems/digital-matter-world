import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWrite, check } from '../src/util.mjs';

export async function operatorCommand(config, request, { timeout = 120000 } = {}) {
  check(['status', 'provision', 'payouts'].includes(request.action), 'operator_action');
  const id = randomUUID() + '.json', inbox = join(config.data, 'operator-inbox'), output = join(config.data, 'operator-results', id);
  await mkdir(inbox, { recursive: true, mode: 0o700 }); await atomicWrite(join(inbox, id), JSON.stringify(request));
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const result = JSON.parse(await readFile(output, 'utf8')); check(!result.error, result.error); return result; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await new Promise(r => setTimeout(r, 200));
  }
  throw Error('operator_command_pending');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [filename, action, ...args] = process.argv.slice(2), config = JSON.parse(await readFile(filename, 'utf8'));
  const request = { action, ...(action === 'provision' && args[0] ? { asset: args[0] } : {}),
    ...(action === 'payouts' ? { dryRun: !args.includes('--execute'), ...(args.includes('--plan') ? { planId: args[args.indexOf('--plan') + 1] } : {}) } : {}) };
  console.log(JSON.stringify(await operatorCommand(config, request), null, 2));
}
