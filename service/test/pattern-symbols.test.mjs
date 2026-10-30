import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { patternSymbolSchema, patternSymbolCandidates, assignPatternSymbol, patternSymbol } from '../src/pattern-symbols.mjs';

function registry(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close()); patternSymbolSchema(db);
  return { db };
}

test('symbols strip dmw and resolve collisions in letter-position order', t => {
  const store = registry(t);
  assert.deepEqual(['dmwmuffinite', 'dmwmudstone', 'dmwmuddite', 'dmwmusstone'].map((name, i) => assignPatternSymbol(store, 'p2:' + i, name)),
    ['Mu', 'Md', 'Mi', 'Ms']);
  assert.equal(assignPatternSymbol(store, 'p2:4', 'dmwmuffin'), 'Mf');
  assert.equal(assignPatternSymbol(store, 'p2:0', 'dmwrenamed'), 'Mu');
  assert.equal(patternSymbol(store, 'p2:1'), 'Md');
});

test('exhausted pairs extend to three and four letters without rearranging the name', t => {
  const store = registry(t), reserve = store.db.prepare('INSERT INTO publicPatternSymbols VALUES(?,?)');
  for (const symbol of ['Mu', 'Md', 'Mi', 'Mt', 'Me']) reserve.run(symbol, symbol);
  assert.equal(assignPatternSymbol(store, 'p2:0', 'dmwmuddite'), 'Mud');
  assert.equal(assignPatternSymbol(store, 'p2:1', 'dmwmuddites'), 'Ms', 'an available pair wins over every triple');
  for (const symbol of ['Ab', 'Ac', 'Ad', 'Abc', 'Abd', 'Acd']) reserve.run(symbol, symbol);
  assert.equal(assignPatternSymbol(store, 'p2:2', 'dmwabcd'), 'Abcd');
});

const first = (name, n) => { const out = []; for (const s of patternSymbolCandidates(name)) { out.push(s); if (out.length === n) break; } return out; };

test('candidate order is deterministic, short, and repeated letters do not duplicate work', () => {
  assert.deepEqual(first('dmwabbcd', 12), ['Ab', 'Ac', 'Ad', 'Abb', 'Abc', 'Abd', 'Acd', 'Abbc', 'Abbd', 'Abcd', 'Ab2', 'Ab3']);
  assert.deepEqual(first('dmw' + 'm'.repeat(29), 5), ['Mm', 'Mmm', 'Mmmm', 'Mm2', 'Mm3']);
  assert.deepEqual(first('dmwa12', 3), ['A1', 'A2', 'A12']);
});

test('adding patterns preserves every existing assignment and a used-up name gets a numbered symbol', t => {
  const store = registry(t);
  assignPatternSymbol(store, 'p2:0', 'dmwabc');
  const before = patternSymbol(store, 'p2:0');
  assert.equal(assignPatternSymbol(store, 'p2:1', 'dmwab'), 'Ab2');
  assert.equal(assignPatternSymbol(store, 'p2:3', 'dmwab'), 'Ab3');
  assert.equal(assignPatternSymbol(store, 'p2:2', 'dmwabca'), 'Ac');
  assert.equal(patternSymbol(store, 'p2:0'), before);
  assert.match(JSON.stringify(store.db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM publicPatternSymbols WHERE symbol=?').all('Ab')), /SEARCH.*INDEX/);
});
