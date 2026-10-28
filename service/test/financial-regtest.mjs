// Explicit disposable-stack rehearsal; never part of the default unit suite.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { current, BUILD } from '../../local/common.mjs';
import { financialRehearsal } from './financial-rehearsal.mjs';

assert.ok(/\/(?:mg3b?|mg4|mg5|mg6|mg7|mg8|mg9|mg10|mg11|rh1|ms1|ms2|g4e|ku1|hf1|dr3|dr4|dr5)-l$/.test(process.env.DMW_BUILD_ROOT ?? ''), 'Use an isolated financial disposable build root');
const tssPort = Number(process.env.DMW_FINANCIAL_TEST_PORT ?? 63150);
assert.ok(Number.isSafeInteger(tssPort) && tssPort > 1024 && tssPort + 4 < 65536, 'Invalid disposable threshold port range');
await financialRehearsal({ stack: await current(), directory: join(BUILD, 'mg3b-financial-' + Date.now()), tssPort });
