import assert from 'node:assert/strict';
import { runDevnet } from './devnet.mjs';
const result = await runDevnet({ pear: true });
assert.equal(new Set(result.peerPids).size, 2);
assert.ok(result.peerPids.every(pid => pid !== process.pid));
console.log('DMW_PEAR_TEST ' + JSON.stringify(result));
