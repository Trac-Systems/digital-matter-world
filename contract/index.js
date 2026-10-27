import fs from 'fs';
import process from 'process';
import { runPeer } from './runtime/peer.js';

const file = process.argv.at(-1);
if (!file?.endsWith('.json')) throw new Error('Pass a disposable local peer configuration JSON file');
await runPeer(JSON.parse(fs.readFileSync(file, 'utf8')));
