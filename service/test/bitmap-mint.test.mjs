import test from 'node:test';
import assert from 'node:assert/strict';
import { bitmapMintFixture } from './bitmap-mint-fixture.mjs';

for (const height of ['109', '110']) test(`linked nonholder reservation follows the counted activation boundary ${height}`, async t => {
  const f = await bitmapMintFixture(t, { height });
  if (height === '109') await assert.rejects(f.prepare(), /financial_mint_right/);
  else {
    const { evidence } = await f.prepare();
    assert.notEqual(evidence.owner, evidence.holder.agent);
    assert.equal(evidence.feeItems.find(f => f.role === 'landowner').to, 'regtest-current-holder');
    assert.equal(evidence.feeItems.find(f => f.role === 'landowner').amount, '15');
  }
});
for (const finder of [false, true]) for (const linked of [false, true]) test(`mint fee split stays intact: finder=${finder}, linked=${linked}`, async t => {
  const f = await bitmapMintFixture(t, { finder, linked });
  const { evidence } = await f.prepare();
  assert.equal(evidence.feeItems.find(f => f.role === 'landowner')?.amount ?? '0', linked ? '15' : '0');
  assert.equal(evidence.feeItems.find(f => f.role === 'burn').amount, linked ? '20' : '35');
  assert.equal(evidence.feeItems.find(f => f.role === 'finder').amount, '30');
});
test('open linked minting cannot turn missing holder evidence into a burned share', async t => {
  const f = await bitmapMintFixture(t); f.setHolder(null);
  await assert.rejects(f.prepare(), /bitmap_missing/);
});
test('open minting preserves finder exclusivity and the unit requirement', async t => {
  const f = await bitmapMintFixture(t); f.context.find.finderUntil = '111';
  await assert.rejects(f.prepare(), /financial_mint_right/);
  const poor = await bitmapMintFixture(t, { balance: '2' });
  await assert.rejects(poor.prepare(), /account_insufficient/);
  const historical = await bitmapMintFixture(t, { activation: null, height: '9999' });
  await assert.rejects(historical.prepare(), /financial_mint_right/);
});

for (const [finder, expected] of [[true, '6ebb42e9ad0a84181904acc277aa8f63b11daa4a6e39a42aa72d3f78a842cc0d'],
  [false, 'de0a3d3c6ba644083284b77493b6dba9fbcd4482e93446c3347ce339f1c8cdd4']]) test(`historical linked mint execution retains accepted bytes: finder=${finder}`, async t => {
  const f = await bitmapMintFixture(t, { activation: null, finder });
  if (!finder) f.setHolder({ agent: f.owner, address: 'regtest-current-holder' });
  const { evidence, result } = await f.prepare(), { hashObject } = await import('../../rules/src/index.js');
  // Captured from the pre-amendment financial source and contract execution.
  assert.equal(hashObject({ evidence, inputs: result.inputs, operations: result.operations, writes: result.writes }), expected);
});
