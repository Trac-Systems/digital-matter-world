import { discoverFixture } from '../scripts/discover-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HeaderHistory, verifyHistory, analyzePattern, sameCounts } from '../src/index.js';
const path = process.env.DMW_HEADERS;
test('real mainnet complete chain, retargets, MTP and corruption detection', {skip:!path}, async () => {
  const history=new HeaderHistory(await readFile(path)); const result=verifyHistory(history);
  assert.ok(result.count>=920000); assert.equal(history.get(0).height,0);
  const broken=new HeaderHistory(history.bytes.subarray(0,160)); broken.bytes[80+76]^=1;
  assert.throws(()=>verifyHistory(broken),/pow|link/);
});
test('scripted discoveries meet history minimum with distinct count vectors', {skip:!path}, async () => {
  const history=new HeaderHistory(await readFile(path)), seen=[];
  for(const p of discoverFixture(history)) {
    const a=analyzePattern(p,history); assert.ok(a.rarity>=12,`${p.name}: ${a.rarity}`);
    assert.equal(seen.some(b=>sameCounts(a.counts,b)),false,`${p.name} duplicate`); seen.push(a.counts);
  }
});
