import { readFile } from 'node:fs/promises';
import { CancellableInscriber } from '../../cancellable-inscriber.mjs';
import { bitcoin } from '../../common.mjs';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const manifest = JSON.parse(await readFile(config.manifest, 'utf8'));
const adapter = await CancellableInscriber.open({ manifest, directory: config.directory, countedHeight: () => bitcoin(manifest, 'getblockcount') });
const prepared = await adapter.prepareBatch(config.id, config.requests);
process.stdout.write(JSON.stringify({ ready: true, digest: prepared.digest, pid: process.pid }) + '\n');
// The parent deliberately kills this process after the durable prepare completes.
setInterval(() => {}, 1000);
