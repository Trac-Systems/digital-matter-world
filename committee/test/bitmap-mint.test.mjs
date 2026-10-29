import test from 'node:test';
import assert from 'node:assert/strict';
import { bitmapMintFixture } from '../../service/test/bitmap-mint-fixture.mjs';
import { verifyFinancialExecution } from '../signer/financial-execution.mjs';

for (const height of ['109', '110']) test(`independent signer mint policy follows Bitmap activation at ${height}`, async t => {
  const f = await bitmapMintFixture(t, { height });
  if (height === '109') {
    await assert.rejects(f.independent.financialReservation(f.row, await f.stamp()), /financial_mint_right/);
    return;
  }
  const { files } = await f.prepare();
  const input = { files, reads: f.independent, document: f.document, network: f.network, height, at: await f.stamp() };
  await verifyFinancialExecution(input);
  f.context.find.finderUntil = '111';
  await assert.rejects(verifyFinancialExecution(input), /financial_mint_right/);
  f.context.find.finderUntil = '105';
  f.setHolder({ agent: 'ab'.repeat(32), address: 'regtest-transferred-holder' });
  await assert.rejects(verifyFinancialExecution(input), /financial_fee_destinations/);
});
