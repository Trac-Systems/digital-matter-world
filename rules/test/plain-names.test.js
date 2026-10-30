import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as r from '../src/index.js';
import { amountReplay } from './field-value-replay-fixture.mjs';

const height = r.PLAIN_NAMES_HEIGHT, before = String(BigInt(height) - 1n);
test('plain names activate at execution height with a 3–32 lowercase alphanumeric grammar', () => {
  for (const name of ['abc', '123', 'florite', 'dmw', 'dmwa', 'x'.repeat(32)]) {
    assert.equal(r.validPatternName(name, before), false);
    assert.equal(r.validPatternName(name, height), true);
  }
  for (const name of ['dmwab', 'dmwflorite', 'dmw' + 'x'.repeat(29)]) {
    assert.equal(r.validPatternName(name, before), true);
    assert.equal(r.validPatternName(name, height), true);
  }
  for (const name of ['', 'a', 'ab', 'x'.repeat(33), 'Florite', 'dmt-florite', 'flor.ite', 'flor ite', 'flor_ite', 'ééé', 123, null]) {
    assert.equal(r.validPatternName(name, before), false);
    assert.equal(r.validPatternName(name, height), false);
  }
  assert.throws(() => r.plainNamesActive('01'), /integer_v2/);
});

// Captured with this signed-batch fixture against git archive 0d18dd1.
const frozen = {
  dmwreplay: { auditHash: '81c493366ff81e919bde6784827d2a14408366da1de95e3533d6552edd4f4ec5', catalogRoot: '22a4a32e9357d086ed245788b991d655aa75c0497924650a513c3122f0d6a427', claimRoot: '00771fc4057e847047b808eb01b281824d59e600145dda59f660894d21219f7f', outcome: 'accepted', amount: '6' },
  florite: { auditHash: '965b74ecc2bc605b25f137a3534f20d1381d76e47a299e891cf8fdbaa92c0603', catalogRoot: '066b4d34f2ba23584b275a366626b227430cbb99a303f6c9e36edc8cdcdfe92c', claimRoot: '161e5f21dff99e78b779628b1342f3a9b8c475c6cc99d779087bdb1e9c1a0a5e', outcome: 'pattern_name', amount: null }
};
test('signed old batches retain frozen release audit and roots; old receipts cannot choose the name rule', () => {
  for (const [name, expected] of Object.entries(frozen)) assert.deepEqual(amountReplay(r, { name, executionHeight: before }), expected);
  for (const executionHeight of [height, String(BigInt(height) + 1n)]) {
    assert.deepEqual(amountReplay(r, { executionHeight }), frozen.dmwreplay);
    assert.equal(amountReplay(r, { name: 'florite', executionHeight }).outcome, 'accepted');
  }
});

test('changing the single activation declaration gates signed batches at a realistic release height', () => {
  const source = `
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      const out = next(url, context);
      if (url.endsWith('/rules/src/pattern-names.js')) return { ...out, source: String(out.source).replace(/(export const PLAIN_NAMES_HEIGHT = )'[^']+';/, "$1'973900';") };
      return out;
    } });
    const r = await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)});
    const { amountReplay } = await import(${JSON.stringify(new URL('./field-value-replay-fixture.mjs', import.meta.url).href)});
    console.log(JSON.stringify(['973899','973900','973901'].map(executionHeight => amountReplay(r, { name: 'florite', executionHeight }))));
  `;
  const rows = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }));
  assert.deepEqual(rows[0], frozen.florite);
  assert.equal(rows[1].outcome, 'accepted'); assert.deepEqual(rows[2], rows[1]);
});
