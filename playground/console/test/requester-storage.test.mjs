import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberRequester, requesterHeaders, requesterSecret } from '../js/requester-storage.js';
import { walletError } from '../js/wallet-errors.js';

function storage(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; });
  return values;
}
test('requester credentials survive reloads per request and accompany only their own status, plan and payment', t => {
  const values = storage(t), id = 'a'.repeat(64), other = 'b'.repeat(64), secret = 'c'.repeat(64);
  rememberRequester({ publicMint: true, requestId: id, requesterSecret: secret });
  assert.equal(values.size, 1); assert.ok(requesterSecret(id) === secret);
  for (const path of ['/mint/' + id, '/web-api/mint/' + id, '/gateway/mint/' + id, '/gateway/web-api/mint/' + id]) {
    assert.ok(requesterHeaders(path)['X-Mint-Requester-Secret'] === secret);
  }
  assert.ok(requesterHeaders('/mint/payment', { requestId: id })['X-Mint-Requester-Secret'] === secret);
  assert.deepEqual(requesterHeaders('/mint/' + other), {});
  assert.deepEqual(requesterHeaders('/results/mints', { id }), {});
  assert.deepEqual(requesterHeaders('https://example.com/mint/' + id), {});
  assert.deepEqual(requesterHeaders('/mint/other'), {});
  rememberRequester({ publicMint: true, requestId: id }); assert.ok(requesterSecret(id) === secret, 'ordinary status reads do not erase credentials');
});
test('invalid storage and unavailable browser storage fail without sending credentials to unrelated reads', t => {
  const values = storage(t), id = 'a'.repeat(64);
  rememberRequester({ publicMint: true, requestId: id, requesterSecret: 'invalid' }); assert.equal(values.size, 0);
  values.set('dmw-public-mint-requester/' + id, 'invalid'); assert.equal(requesterSecret(id), null);
  globalThis.localStorage.setItem = () => { throw Error('storage unavailable'); };
  assert.throws(() => rememberRequester({ publicMint: true, requestId: id, requesterSecret: 'd'.repeat(64) }), /public_mint_storage_unavailable/);
  globalThis.localStorage.getItem = () => { throw Error('storage unavailable'); };
  assert.deepEqual(requesterHeaders('/mint/' + id), {});
});

test('public request limits explain the distinct wallet, connection and minute limits', () => {
  assert.equal(walletError(Error('public_mint_payer_capacity')), 'Too many open mint requests from this wallet. Finish or let one expire first.');
  assert.equal(walletError(Error('public_mint_ip_capacity')), 'Too many open mint requests from this connection. Finish or let one expire first.');
  assert.equal(walletError(Error('public_mint_start_rate')), 'Too many new mint requests. Wait a minute and try again.');
});

test('a Bitcoin node refusal for spent inputs and a bare timeout read as plain words', () => {
  assert.match(walletError(Error('[ELECTRS API] sendrawtransaction RPC error -25: bad-txns-inputs-missingorspent')), /^Nothing was paid\. .*still waiting for its block/);
  assert.match(walletError(Error('signal timed out')), /did not answer in time\. Nothing new was sent/);
  assert.equal(walletError(Error('Some other wallet sentence.')), 'Some other wallet sentence.');
});
