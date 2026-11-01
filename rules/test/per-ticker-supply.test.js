import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import * as r from '../src/index.js';
const height = Number(r.PER_TICKER_SUPPLY_HEIGHT), secret = new Uint8Array(32).fill(13), owner = r.bytesToHex(ed25519.getPublicKey(secret));
const official = { id: r.hash('official') + 'i0' }, extra = { id: r.hash('extra') + 'i0', officialDeployment: official.id };

test('supply activation preserves official and historical keys and separates additional tickers', () => {
  assert.equal(r.perTickerSupplyActive(height - 1), false); assert.equal(r.perTickerSupplyActive(String(height)), true);
  assert.equal(r.tickerSupplyScope(official, height), null); assert.equal(r.tickerSupplyScope(extra, height - 1), null);
  assert.equal(r.tickerSupplyScope(extra, height), extra.id);
  assert.equal(r.publicPlotId('p2:7', '12'), r.hashObject(['dmw-public-plot-v1', 'p2:7', '12']));
  assert.notEqual(r.publicPlotId('p2:7', '12'), r.publicPlotId('p2:7', '12', extra.id));
});

test('per-ticker mint rights retain the finder week and reject duplicate holds and mints', () => {
  const find = { asset: 'p1', block: 100, count: 3, finder: owner, findHeight: height - 1 };
  const make = (state, deployment, n, counted = height) => {
    const request = { owner, asset: find.asset, block: find.block, amount: '3', receive: r.hash('receiver'), nonce: r.hash(String(n)), until: counted + 100, expires: counted + 432 };
    return r.acceptMintRequest({ state, deployment, request, sig: r.signRequest('rq', 'local', request, secret), network: 'local', counted, find, balance: '3' });
  };
  const a = make(undefined, official, 1), b = make(a.state, extra, 2);
  assert.equal(a.pending.key, 'p1/100'); assert.equal(b.pending.key, 'p1/100/' + extra.id);
  assert.throws(() => make(b.state, extra, 3), /block_pending/);
  b.state.pending[b.id].consumed = true;
  const done = r.finishMintRequest(b.state, b.id, height, { inscription: r.hash('mint') + 'i0' });
  assert.throws(() => make(done.state, extra, 4), /already_minted/);
  const before = make(undefined, official, 5, height - 1);
  assert.throws(() => make(before.state, extra, 6, height - 1), /block_pending/);
  for (const deployment of [official, extra]) {
    assert.equal(r.mintRight({ find, owner: r.hash('other'), counted: height }).allowed, false);
    assert.equal(r.mintRight({ find, owner: r.hash('other'), counted: height + 1007 }).allowed, true);
  }
});

test('independent public claim evidence keeps official history and ticker winners separate', () => {
  const asset = 'p2:7', block = '12', pattern = { number: '7', releaseHeight: '0' }, settings = { publicMintActivationHeight: '1', claimsNeverCloseHeight: '1' };
  const state = { claimReservations: {}, finds: { [r.findIdV2(block, pattern.number)]: { finder: owner } }, headerAwards: {}, publicMintGet: () => null }, patterns = { 7: pattern };
  const payment = n => ({ id: r.hash(String(n)), reference: r.hash('payment' + n) + 'i0', complete: true, height: '1', transactionIndex: String(n), inscriptionIndex: '0' });
  for (const [n, deployment] of [[1, undefined], [2, extra.id]]) {
    const claim = r.publicScanClaim({ state, pattern, asset, block, settings, height, deployment });
    assert.equal(claim.publicWinner, null);
    r.applyPublicClaimScan({ state, patterns, operation: { asset, block, deployment, payments: [payment(n)], claim }, settings, height });
  }
  assert.equal(r.publicScanClaim({ state, pattern, asset, block, settings, height }).publicWinner, r.hash('1'));
  assert.equal(r.publicScanClaim({ state, pattern, asset, block, settings, height, deployment: extra.id }).publicWinner, r.hash('2'));
  const reader = r.publicMintEvidenceReader([{ asset, block, id: r.hash('1') }, { asset, block, deployment: extra.id, id: r.hash('2') }], null, 10000);
  assert.equal(reader.get(asset, block), r.hash('1')); assert.equal(reader.get(asset, block, extra.id), r.hash('2')); assert.equal(reader.rows().length, 2);
});
