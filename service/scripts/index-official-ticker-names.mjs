#!/usr/bin/env node
import { rebuildRegistryOfficialNames } from '../src/registry.mjs';
import { Store } from '../src/store.mjs';
import { rebuildOfficialNames } from '../src/official-ticker-names.mjs';
import { isAbsolute } from 'node:path';
const directory = process.argv[2], registry = process.argv[3];
if (registry && !isAbsolute(registry)) throw Error('Pass the absolute keyed registry path');
if (!directory || !isAbsolute(directory)) throw Error('Pass the absolute offline service store directory');
const store = await Store.open(directory);
try { await rebuildOfficialNames(store); process.stdout.write('Official ticker name index ready.\n'); }
finally { await store.close(); }
if (registry) { await rebuildRegistryOfficialNames(registry); process.stdout.write('Registry official ticker name index ready.\n'); }
