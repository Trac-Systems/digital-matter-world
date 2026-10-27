import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from './test-target.mjs';
import { argumentsFor, validate, loopback, elementPlan, verifyRuntime } from './safety.mjs';
test('mandatory rehearsal flags and unknown arguments fail closed', () => {
  for (const args of [[], ['--regtest'], ['--dry-run'], ['--config', 'x', '--regtest', '--dry-run', '--live']]) assert.throws(() => argumentsFor(args));
  assert.equal(argumentsFor(['--target', 'x', '--regtest', '--dry-run']).through, 'kit');
  assert.throws(() => argumentsFor(['--config', 'x', '--regtest', '--dry-run']));
});
test('endpoint credentials, aliases, paths and remote networks are refused', () => {
  for (const url of ['https://127.0.0.1', 'http://localhost', 'http://127.0.0.2', 'http://127.0.0.1/path', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/?redirect=1']) assert.throws(() => loopback(url));
  assert.equal(loopback('http://127.0.0.1:18443'), 'http://127.0.0.1:18443');
});
test('chain, quorum, path, fee and overlapping-port mutations are refused', () => {
  validate(config);
  for (const change of [c => c.mode = 'mainnet', c => c.ethereum.chainId = 1, c => c.committee.threshold = 2, c => c.output += '/../elsewhere', c => c.bitcoin.feeRate = 0, c => c.gateway.port = c.trac.port]) {
    const c = structuredClone(config); change(c); assert.throws(() => validate(c));
  }
});
test('element pair reuse ignores deploy data type and prevents duplicate inscriptions', () => {
  const p = { name: 'dmwexample', pat: 'a', fld: 11, dt: 'h' }, e = { tick: 'existing', pat: 'a', fld: 11, ins: 'aa'.repeat(32) + 'i0' };
  assert.equal(elementPlan([p], [e], [])[0].element, e.ins);
  assert.equal(elementPlan([{ ...p, dt: 'n' }], [e], [])[0].reuse, true);
});
test('occupied labels use independent fallbacks; ambiguous pairs wait', () => {
  const p = { name: 'dmwexample', pat: 'a', fld: 11 }, e = { tick: p.name, pat: 'b', fld: 11 };
  assert.notEqual(elementPlan([p], [], [{ tick: 'dmt-dmwexample' }])[0].tick, p.name);
  assert.notEqual(elementPlan([p], [e], [])[0].elementName, p.name);
  assert.throws(() => elementPlan([p], [{ ...e, pat: 'a' }, { ...e, pat: 'a' }], []));
});
test('runtime verification rejects changed executable bytes and permits declared immutable slots', () => {
  const expected = Buffer.alloc(200, 1), actual = Buffer.from(expected); actual[50] = 2;
  assert.throws(() => verifyRuntime(expected.toString('hex'), actual.toString('hex'), {}));
  verifyRuntime(expected.toString('hex'), actual.toString('hex'), { token: [{ start: 50, length: 1 }] });
  actual[100] = 3; assert.throws(() => verifyRuntime(expected.toString('hex'), actual.toString('hex'), { token: [{ start: 50, length: 1 }] }));
});
