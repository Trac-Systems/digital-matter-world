import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { HeaderHistory } from '../../rules/src/headers.js';
import { validateDefinition, analyzePattern, fieldValue, patternCount, PATTERN_LIMITS } from '../../rules/src/patterns.js';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { patternName, namePatterns } from '../lib/pattern-names.mjs';
import { searchPatterns } from '../strategies/default.mjs';
import { loadHistory } from '../lib/headers.mjs';
import { findPatterns } from '../lib/search.mjs';
import { runTool } from '../lib/tools.mjs';
import { temp } from './helpers.mjs';

const owner = '11'.repeat(32);
const definition = p => `${p.fld}:${p.dt}:${p.pat}`;
const docs = ['llms.txt', 'SKILL.md', 'docs/ACTIONS.md'];
const fixtureBytes = async () => Buffer.from((await readFile(new URL('./fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex');
async function verifiedHistory(t) {
  const file = join(await temp(t), 'headers.bin');
  await writeFile(file, await fixtureBytes());
  return loadHistory(file);
}
const eligible = analysis => analysis.rarity >= PATTERN_LIMITS.minMatchingBlocks && !analysis.counts.every(n => n === analysis.counts[0]);

test('pattern names are pronounceable motifs with deterministic, natural collision fallbacks', () => {
  const seven = { pat: '7{3}', fld: 10, dt: 'n' };
  assert.equal(patternName(seven), 'dmwseptarine');
  assert.equal(patternName({ pat: '0{2}', fld: 4, dt: 'n' }), 'dmwnullith');
  const occupied = [{ name: 'dmwseptarine' }];
  const alternate = patternName(seven, occupied);
  assert.equal(alternate, 'dmwamberseptarine');
  assert.equal(patternName(seven, occupied), alternate);
  assert.notEqual(alternate.slice(3, 5), occupied[0].name.slice(3, 5));
  assert.notEqual(patternName(seven, [{ name: 'dmwseaspar' }]).slice(3, 5), 'se');

  // Many different anchored motifs compete for the same base word and symbol.
  const proposals = Array.from({ length: 100 }, (_, i) => ({ pat: `^[${Math.floor(i / 10)}${i % 10}]$`, fld: 4, dt: 'n' }));
  const named = namePatterns(proposals, [{ name: 'dmwcrownite' }]);
  const reversed = namePatterns([...proposals].reverse(), [{ name: 'dmwcrownite' }]).reverse();
  assert.deepEqual(named, reversed);
  assert.equal(new Set(named.map(p => p.name)).size, proposals.length);
  for (const p of named) {
    assert.match(p.name, /^dmw[a-z]{2,29}$/);
    assert.notEqual(p.name, 'dmwcrownite');
    assert.doesNotThrow(() => validateDefinition(p));
  }
  assert.deepEqual(proposals[0], { pat: '^[00]$', fld: 4, dt: 'n' });
});

test('the modest baseline covers runs, ranges, classes, anchors, alternatives and both bits formats', () => {
  const candidates = [...searchPatterns()];
  assert.ok(candidates.length > 60 && candidates.length <= 80, 'only a small extension of the original 60 motifs');
  assert.equal(new Set(candidates.map(definition)).size, candidates.length);
  assert.equal(new Set(candidates.map(p => p.name)).size, candidates.length);
  assert.ok(new Set(candidates.map(p => p.name.slice(3, 5))).size >= 20, 'prefer distinct readable symbols where possible');
  for (const p of candidates) {
    assert.doesNotThrow(() => validateDefinition(p));
    assert.match(p.name, /^dmw[a-z]{2,29}$/);
    assert.doesNotMatch(p.name, /height|nonce|bits|regex|tour|bot/);
    assert.equal(new RegExp(p.pat).test(''), false);
  }
  for (const [fld, dt] of [[4, 'n'], [10, 'n'], [11, 'n'], [11, 'h']]) {
    const shapes = candidates.filter(p => p.fld === fld && p.dt === dt).map(p => p.pat);
    for (const feature of ['[', '-', '{', '^', '$', '|']) assert.ok(shapes.some(p => p.includes(feature)), `${fld}/${dt} explores ${feature}`);
  }
  assert.deepEqual([...searchPatterns()], candidates);
  candidates[0].name = 'dmwchanged';
  assert.notEqual([...searchPatterns()][0].name, 'dmwchanged', 'callers cannot mutate shared candidates');
});

test('baseline ranks viable rare patterns first without renaming patterns as history or catalog changes', async () => {
  const history = new HeaderHistory(await fixtureBytes());
  const candidates = [...searchPatterns({ history })];
  const scored = candidates.map(p => ({ p, analysis: analyzePattern(p, history) }));
  const valid = scored.filter(p => eligible(p.analysis));
  assert.ok(valid.length > 0);
  assert.deepEqual(scored.slice(0, valid.length), valid);
  assert.deepEqual(valid.map(p => p.analysis.rarity), valid.map(p => p.analysis.rarity).sort((a, b) => a - b));
  const names = new Map([...searchPatterns()].map(p => [definition(p), p.name]));
  const known = valid[0].p;
  const shorter = new HeaderHistory(history.bytes.slice(0, 40 * 80));
  for (const context of [{ history, patterns: [known] }, { history: shorter }]) {
    for (const p of searchPatterns(context)) assert.equal(p.name, names.get(definition(p)));
  }
  const withCatalog = [...searchPatterns({ history, patterns: [known] })];
  assert.ok(withCatalog.findIndex(p => definition(p) === definition(known)) >= valid.length - 1);
  assert.ok(scored.some(({ p, analysis }) => p.fld === 11 && !eligible(analysis)), 'constant difficulty remains subject to discovery checks');
});

test('default names avoid catalog collisions with other ideas while preserving unaffected names', () => {
  const original = [...searchPatterns()];
  const patterns = original.slice(0, 4).map((p, number) => ({ ...p, number, pat: '^123$' }));
  const named = [...searchPatterns({ patterns })];
  assert.equal(new Set(named.map(p => p.name)).size, named.length);
  for (const p of named) {
    assert.match(p.name, /^dmw[a-z]{2,29}$/);
    assert.ok(!patterns.some(existing => existing.name === p.name));
  }
  assert.deepEqual([...searchPatterns({ patterns: [...patterns].reverse() })], named);
  const byDefinition = new Map(named.map(p => [definition(p), p]));
  for (const p of original.slice(4)) assert.equal(byDefinition.get(definition(p)).name, p.name);
});

test('default acceptance stays within the shared search budget and enforces full-history minimum matches', async t => {
  const history = await verifiedHistory(t);
  const candidate = { name: 'dmwgemora', pat: '[12]', fld: 4, dt: 'n' };
  for (const maxCandidates of [1, 10, 60]) {
    const progress = [];
    const result = await findPatterns({ history, tip: history.get(63), existing: [], owner: encodeTracAddress(owner),
      candidates: [candidate], maxCandidates, onProgress: p => progress.push(p) });
    assert.equal(result.accepted.length + result.rejected.length, maxCandidates);
    assert.equal(progress.length, maxCandidates);
    assert.equal(result.accepted[0].record.name, candidate.name);
    assert.ok(result.accepted.every(({ record }) => record.rarity >= PATTERN_LIMITS.minMatchingBlocks && record.historyHeight === 63));
    assert.ok(result.accepted.every(({ record }) => eligible(analyzePattern(record, history))));
    if (maxCandidates === 60) assert.ok(result.rejected.some(r => r.reason === 'pattern_constant' || r.reason === 'pattern_too_rare'));
  }
});

function reasons(source) {
  return [...source.matchAll(/\b(?:assert|check)\([\s\S]*?,\s*(['"])([^'"\n]+)\1\s*\);|throw new Error\((['"])([^'"\n]+)\3\)/g)].map(m => m[2] ?? m[4]);
}

test('all three discovery references cover every canonical validator and search preflight rejection', async () => {
  const read = async path => readFile(new URL(path, import.meta.url), 'utf8');
  const patterns = await read('../../rules/src/patterns.js');
  const search = await read('../lib/search.mjs');
  const headers = await read('../lib/headers.mjs');
  const ruleHeaders = await read('../../rules/src/headers.js');
  const tools = await read('../lib/tools.mjs');
  const addresses = await read('../../rules/src/trac-address.js');
  const codes = new Set([
    ...reasons(patterns), ...reasons(search),
    ...headers.split(/export (?:async )?function /).filter(source => /^(?:historyProof|assertHistoryTip)\(/.test(source)).flatMap(reasons),
    ...reasons(ruleHeaders.slice(ruleHeaders.indexOf('export function parseHeader'), ruleHeaders.indexOf('export function verifyHistory'))),
    ...reasons(tools.split('\n').find(line => line.includes('const needHistory'))),
    addresses.match(/TRAC_ADDRESS_ERROR = '([^']+)'/)[1]
  ]);
  assert.ok(codes.size >= 27, 'enumerate the complete error path, not just common regex mistakes');
  for (const path of docs) {
    const text = await read('../' + path);
    const rows = new Map([...text.matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/gm)].map(m => [m[1], [m[2], m[3]]]));
    for (const code of codes) {
      assert.ok(rows.has(code), `${path} must document ${code}`);
      assert.ok(rows.get(code).every(cell => cell.trim().length >= 15), `${path}: ${code} needs meaning and remedy`);
    }
    assert.match(text.slice(0, 1800), /regular expression/);
    assert.match(text, /FIRST/);
    assert.match(text, /copying the baseline wins nothing/);
  }
});

test('worked field examples and complete search responses match verified Bitcoin headers in every reference', async t => {
  const history = await verifiedHistory(t);
  const agent = { owner, trac: { head: async () => ({ tip: history.get(63) }) }, catalog: async () => [] };
  for (const path of docs) {
    const text = await readFile(new URL('../' + path, import.meta.url), 'utf8');
    const rows = text.split('\n').filter(line => /^\| (4|10|11) \/ [nh] \|/.test(line));
    assert.equal(rows.length, 12);
    for (const line of rows) {
      const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(s => s.trim());
      const [fld, dt] = cells[0].split(' / '), height = Number(cells[1]);
      const value = cells[2].slice(1, -1), pat = cells[3].slice(1, -1).replaceAll('\\|', '|');
      const proposal = { name: 'dmwexample', pat, fld: Number(fld), dt };
      assert.equal(fieldValue(history.get(height), Number(fld), dt), value);
      assert.doesNotThrow(() => validateDefinition(proposal));
      assert.equal(patternCount(proposal, history.get(height)), Number(cells[5]), `${path}: ${pat}`);
      const matches = [...value.matchAll(new RegExp(pat, 'g'))].map(m => m[0]);
      const documented = [...cells[4].matchAll(/`([^`]+)`/g)].map(m => m[1]);
      assert.deepEqual(matches, documented, `${path}: matched substrings for ${pat}`);
    }
    const sample = text.match(/Worked `search_patterns` call:\s*```js\n([\s\S]+?)\n```/)[1];
    const result = await runInNewContext(sample, { search_patterns: args => runTool({ agent, history }, 'search_patterns', JSON.parse(JSON.stringify(args))) });
    const expected = JSON.parse(text.slice(text.indexOf('Exact result for an empty catalog')).match(/```json\n([\s\S]+?)\n```/)[1]);
    assert.deepEqual(result, expected, path);
  }
});
