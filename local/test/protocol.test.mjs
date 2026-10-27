import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { mintPermit, authority, redeem, sha256, testKey } from '../protocol.mjs';
import { localUrl } from '../common.mjs';

test('mint permit commits to receiver, block, ticker, deployment and data', () => {
  const key = testKey(), publicKey = secp256k1.getPublicKey(key);
  const input = { tick: 'dmw', blk: 100, dep: 'aa'.repeat(32) + 'i0', address: 'local-receiver', dta: 'matter', salt: 'local-salt' };
  const mint = mintPermit(input, key);
  const message = `tap-dmt-mint-dmw-100-${input.dep}-local-receiver-matter-local-salt`;
  assert.equal(mint.prv.hash, sha256(message));
  const signature = new secp256k1.Signature(BigInt(mint.prv.sig.r), BigInt(mint.prv.sig.s));
  assert(secp256k1.verify(signature, mint.prv.hash, publicKey));
  for (const [from, to] of [['local-receiver', 'different'], ['-100-', '-101-'], ['-dmw-', '-other-'], [input.dep, 'bb'.repeat(32) + 'i0'], ['matter', 'changed']]) assert.equal(secp256k1.verify(signature, sha256(message.replace(from, to)), publicKey), false);
});
test('authority and action payloads use JSON plus salt', () => {
  const key = testKey(), a = authority(key, { privilege: true, salt: 'local' });
  assert.equal(a.hash, sha256(JSON.stringify(a.auth) + 'local'));
  const r = redeem('local-authority', [{ op: 'claim', lock: 'local:0', preimage: 'secret' }], key, { salt: 'local' });
  assert.equal(r.hash, sha256(JSON.stringify(r.redeem) + 'local'));
});
test('RPC URL validation accepts only numeric loopback HTTP', () => {
  assert.equal(localUrl('http://127.0.0.1:18443').hostname, '127.0.0.1');
  for (const url of ['https://127.0.0.1', 'http://0.0.0.0', 'http://192.0.2.1', 'file:///etc/passwd', 'http://user:pass@127.0.0.1']) assert.throws(() => localUrl(url));
});
