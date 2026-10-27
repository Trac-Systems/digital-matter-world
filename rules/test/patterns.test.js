import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ordMatchCount, countWith, validatePattern, fieldValue, analyzePattern, evaluateDiscovery, tierFor, markMainnetPatterns } from '../src/index.js';
const vectors = [['','',1],['','1',2],['','123',4],['a*','',1],['a*','1',2],['a*','123',4],['a*','a',2],['a?','123',4],['^','123',1],['$','123',1],['\\b','',null],['\\b','1',2],['\\b','123',2],['\\b','abc',2],['[0-9]','123',3]];
test('all 15 ord-tap Node 20 V8 truth vectors including empty matches', () => {
  for (const [p, h, n] of vectors) { assert.equal(ordMatchCount(p, h), n); assert.equal(countWith(new RegExp(p, 'g'), h), n ?? 0); }
});
test('safe grammar accepts bounded forms and rejects JS/RE2 incompatibilities', () => {
  for (const p of ['[0-9]', '^1{0,3}$', 'a?b', '1|2', '[a-f]{2}', '0{0}', 'f{10}']) validatePattern(p);
  for (const p of ['', '^', '$', '()', '(1+)+', '1*', '1+', '\\d', '\\1', '(?=1)', '(?i)1', '[^0]', '.', '1{11}', '1{2,1}', '1??', '[a-0]', '1234567', '1|', '^$']) assert.throws(() => validatePattern(p), p);
  assert.throws(()=>validatePattern('1',{maxLength:1.5}),/limits/);
  assert.throws(()=>validatePattern('1',{minMatchingBlocks:0}),/limits/);
});
test('grammar-generated patterns have V8 global-count parity on numeric haystacks', () => {
  for (const atom of ['0', '1', 'a', '[0-9]', '[a-f]']) for (const quant of ['', '?', '{0}', '{1,3}', '{10}']) {
    for (const p of [atom + quant, '^' + atom + quant, atom + quant + '$', atom + quant + '|2']) {
      validatePattern(p);
      for (const h of ['', '0', '111', '972850', '4294967295', '1d00ffff']) assert.equal(countWith(new RegExp(p, 'g'), h), h.match(new RegExp(p, 'g'))?.length ?? 0);
    }
  }
});
test('safe grammar is accepted by the installed native RE2 oracle', { skip: !process.env.DMW_RE2_ORACLE }, () => {
  const patterns = [];
  for (const atom of ['0','a','[0-9]','[a-f]']) for (const quant of ['','?','{0}','{0,10}']) for (const anchor of ['','^']) {
    patterns.push(`${anchor}${atom}${quant}$`, `${atom}${quant}|1`);
  }
  patterns.forEach(p => validatePattern(p));
  assert.equal(execFileSync(process.env.DMW_RE2_ORACLE, { input: patterns.join('\n') + '\n', encoding: 'utf8' }).trim(), `accepted ${patterns.length}`);
});
test('field values exactly match decimal and lowercase unpadded bits hex', () => {
  const h = { height: 817798, nonce: 4294967295, bits: 0x1d00ffff };
  assert.equal(fieldValue(h, 4), '817798'); assert.equal(fieldValue(h, 10), '4294967295');
  assert.equal(fieldValue(h, 11), '486604799'); assert.equal(fieldValue(h, 11, 'h'), '1d00ffff');
  assert.throws(() => fieldValue(h, 10, 'h')); assert.throws(() => fieldValue({ ...h, nonce: 1.5 }, 10));
});
test('discovery compares complete count vectors across fields, not rarity alone', () => {
  const history = { length: 100, field: n => String(n), get: () => ({ hash: '12'.repeat(32) }) };
  const p = { number: 0, name: 'dmwzero', pat: '0', fld: 4, dt: 'n' };
  assert.equal(analyzePattern(p, history).rarity, 10);
  const args = { proposal: { ...p, name: 'dmwother', pat: '[0]' }, history, discoverer: 'ab'.repeat(32), existing: [p], number: 1, limits: { minMatchingBlocks: 1 } };
  assert.throws(() => evaluateDiscovery(args), /duplicate/);
  const accepted = evaluateDiscovery({ ...args, proposal: { ...args.proposal, pat: '1' } });
  assert.equal(accepted.record.rarity, 19); assert.equal(accepted.record.discoverer, args.discoverer);
  assert.throws(() => evaluateDiscovery({ ...args, existing: [], limits: { minMatchingBlocks: 11 } }), /too_rare/);
  assert.deepEqual([1,100,101,1001,10001,100001].map(n => tierFor(n)), [5,5,4,3,2,1]);
  assert.equal(markMainnetPatterns([p], [{ fld: 4, pat: '0', tick: 'existing', ins: 'abc' }])[0].mainnet[0].name, 'existing');
});
