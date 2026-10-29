import test from 'node:test';
import assert from 'node:assert/strict';
import { findPayment, scriptText } from '../console/js/inscribe/public.js';

const hex = bytes => Buffer.from(bytes).toString('hex');
// An ord envelope whose JSON body is split into 520-byte pushes, as wallets inscribe it.
function envelope(text) {
  const body = Buffer.from(text), pushes = [];
  for (let i = 0; i < body.length; i += 520) { const part = body.subarray(i, i + 520); pushes.push(part.length < 76 ? Buffer.from([part.length]) : Buffer.from([77, part.length & 255, part.length >> 8]), part); }
  return hex(Buffer.concat([Buffer.from([32]), Buffer.alloc(32, 1), Buffer.from([0xac, 0, 0x63, 3]), Buffer.from('ord'), Buffer.from([1, 1, 10]), Buffer.from('text/plain'), Buffer.from([0]), ...pushes, Buffer.from([0x68])]));
}
const id = 'ab'.repeat(32), other = 'cd'.repeat(32), address = 'bc1pexample';
const redeem = request => JSON.stringify({ p: 'tap', op: 'token-auth', pad: 'x'.repeat(500), redeem: { items: [{ tick: 'tap', amt: '1', dta: `dmw-pay-v2|${request}|treasury` }] } });

test('inscription text is read across 520-byte pushes', () => {
  const text = redeem(id);
  assert.ok(text.indexOf(id) < 520 && text.indexOf(id) + 64 > 520 || text.length > 520);
  assert.ok(scriptText(envelope(text)).includes(`dmw-pay-v2|${id}|`));
});

test('the payment for a request is found among the payer’s confirmed transactions only', async () => {
  const txs = [
    { txid: '11'.repeat(32), status: { confirmed: false }, vin: [{ witness: ['00', envelope(redeem(id)), 'c0'] }] },
    { txid: '22'.repeat(32), status: { confirmed: true }, vin: [{ witness: ['00', envelope(redeem(other)), 'c0'] }] },
    { txid: '33'.repeat(32), status: { confirmed: true }, vin: [{ witness: ['00'] }] },
    { txid: '44'.repeat(32), status: { confirmed: true }, vin: [{ witness: ['00', envelope(redeem(id)), 'c0'] }] },
  ];
  const urls = [], fetchImpl = async url => { urls.push(url); return { ok: true, json: async () => txs }; };
  assert.equal(await findPayment(id, address, { fetchImpl }), '44'.repeat(32) + 'i0');
  assert.equal(urls[0], 'https://mempool.space/api/address/bc1pexample/txs');
  assert.equal(await findPayment('ef'.repeat(32), address, { fetchImpl }), null);
  assert.equal(await findPayment(id, address, { network: 'regtest', fetchImpl }), null);
  assert.equal(await findPayment('not-an-id', address, { fetchImpl }), null);
});
