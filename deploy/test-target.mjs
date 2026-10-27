// Pure local fixture: no private endpoint files or running playground required.
import { readFile } from 'node:fs/promises';
import { launchConfig } from './target.mjs';
import { BUILD } from './safety.mjs';
import { join } from 'node:path';
export const sharedTarget = JSON.parse(await readFile(new URL('./targets/regtest.json', import.meta.url), 'utf8'));
export const config = launchConfig({ ...sharedTarget, paths: { ...sharedTarget.paths, output: join(BUILD, 'deploy') } }, { bitcoin: 'http://127.0.0.1:19443', witness: 'http://127.0.0.1:19444',
  indexer: 'http://127.0.0.1:56888', ethereum: 'http://127.0.0.1:59545', trac: 'http://127.0.0.1:59900', gateway: 'http://127.0.0.1:59910' });
