import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('playground target selection validates profiles and permits a separate data directory', () => {
  const read = (profile,data) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "import {DATA,PORTS,origin} from './playground/common.mjs';console.log(JSON.stringify({DATA,PORTS,origin}));"],
    { cwd: new URL('../..', import.meta.url), env: { ...process.env, DMW_TARGET:fileURLToPath(new URL('../../deploy/targets/regtest.json',import.meta.url)), DMW_PLAYGROUND_DATA:data, DMW_PLAYGROUND_PROFILE:profile }, encoding:'utf8' }));
  const normal=read('default','/tmp/dmw-profile-default'), rehearsal=read('rehearsal','/tmp/dmw-profile-rehearsal');
  assert.notEqual(normal.DATA,rehearsal.DATA);
  assert.equal(new Set(Object.values(normal.PORTS).flat()).size,Object.values(normal.PORTS).flat().length);
});
