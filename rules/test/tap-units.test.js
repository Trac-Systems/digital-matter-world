import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTapAmount, formatTapAmount, tapAtoms, TAP_MAX_ATOMS, feeFor, splitFee, treasuryPayment,
  tapPaymentLock, tapPaymentAllocations, tapTransfer, compoundMintPermit } from '../src/index.js';

const destinations = { treasury: 'treasury', finder: 'finder', firstMaker: 'maker', landowner: 'holder' };
// ord-tap resolve_number_string pads/truncates the fractional part to deployed.dec.
const ordAmount = value => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(18, '0').slice(0, 18)).toString();
};
test('decimal TAP has an exact reversible 18-decimal inscription boundary', () => {
  for (const [decimal, atomic] of [['0', '0'], ['22.6', '22600000000000000000'], ['0.000000000000000001', '1'],
    ['9007199254740993.123456789012345678', '9007199254740993123456789012345678'], ['18446744073709551615', TAP_MAX_ATOMS.toString()]]) {
    assert.equal(parseTapAmount(decimal), atomic);
    assert.equal(formatTapAmount(atomic), decimal);
    assert.equal(ordAmount(formatTapAmount(atomic)), atomic);
  }
  assert.equal(parseTapAmount('22.600000000000000000'), '22600000000000000000');
  for (const invalid of ['1.0000000000000000000', '1e2', '01', '.1', '1.', '-1', ' 1', '1 ', 22.6, '', '18446744073709551616']) {
    assert.throws(() => parseTapAmount(invalid));
  }
  assert.throws(() => tapAtoms((TAP_MAX_ATOMS + 1n).toString()));
  assert.throws(() => feeFor('find', TAP_MAX_ATOMS.toString(), 2));
});

for (const kind of ['find', 'compound', 'link']) for (let tier = 1; tier <= 5; tier++) {
  test(`${kind} tier ${tier}: inscription and Ethereum amounts conserve the identical atomic fee`, () => {
    for (const base of ['22.6', '22.600000000000000001', '0.000000000000000001']) {
      const price = feeFor(kind, parseTapAmount(base), tier);
      for (const linked of [false, true]) {
        const split = splitFee(price, { kind, linked, discovered: true });
        assert.equal(Object.values(split).reduce((sum, n) => sum + BigInt(n), 0n).toString(), price);
        const inscription = tapPaymentLock({ split, destinations, kind, payer: 'payer', hash: 'ab'.repeat(32), expiry: 900 });
        const indexed = { amt: ordAmount(inscription.amt), al: inscription.al.map(a => ({ ...a, amt: ordAmount(a.amt) })) };
        assert.equal(indexed.amt, treasuryPayment(split));
        assert.deepEqual(indexed.al, tapPaymentAllocations(split, destinations, kind));
        const total = BigInt(indexed.amt) + indexed.al.reduce((sum, a) => sum + BigInt(a.amt), 0n);
        assert.equal(total.toString(), price);
        assert.equal(formatTapAmount(total.toString()), formatTapAmount(price));
        assert.equal(ordAmount(tapTransfer({ amount: price }).amt), price);
      }
    }
  });
}
test('B = 22.6 TAP gives exact tier, compound and link prices', () => {
  const base = parseTapAmount('22.6');
  assert.deepEqual([1, 2, 3, 4, 5].map(tier => formatTapAmount(feeFor('find', base, tier))), ['22.6', '67.8', '226', '678', '2260']);
  assert.deepEqual([1, 2, 3, 4, 5].map(tier => formatTapAmount(feeFor('compound', base, tier))), ['226', '226', '226', '678', '2260']);
  assert.equal(formatTapAmount(feeFor('link', base)), '452');
});
test('privileged compound mint quantities remain whole matter tokens', () => {
  const permit = compoundMintPermit({ tick: 'dmwc1', quantity: '3', address: 'receiver', salt: 'ab'.repeat(32) });
  assert.equal(permit.payload.amt, '3');
  assert.equal(new TextDecoder().decode(permit.signingBytes), `tap-token-mint-dmwc1-3-receiver-${'ab'.repeat(32)}`);
});
