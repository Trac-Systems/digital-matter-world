import { viewerSummary, summaryBytes } from '../src/binary.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTracAddress, decodeTracAddress, isTracAddress, publicIdentities, wireIdentities, tracReadRoute, publicCursorAnchor, wireCursorAnchor } from '../src/trac-address.js';

// Synthetic ascending-byte vector; no wallet or signing key is used.
const key = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join('');
const address = 'trac1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sqt4yhr';
test('Trac bech32m vector, byte encoding and strict checksum/padding validation', () => {
  assert.equal(encodeTracAddress(key), address);
  assert.equal(encodeTracAddress(Uint8Array.from(key.match(/../g), x => parseInt(x, 16))), address);
  assert.equal(decodeTracAddress(address), key);
  for (let n = 0; n < 32; n++) { const k = n.toString(16).padStart(2, '0').repeat(32); assert.equal(decodeTracAddress(encodeTracAddress(k)), k); }
  for (const bad of [key, address.toUpperCase(), address.replace('trac', 'other'), address.slice(0, -1) + 'q', address + 'q', address.slice(0, -1), null, 'trac1']) {
    assert.equal(isTracAddress(bad), false); assert.throws(() => decodeTracAddress(bad), /trac1/);
  }
});
test('presentation changes identity fields without changing hashes, wallets, amounts or source packets', () => {
  const wire = { owner: key, hash: key, id: key, address: '0x' + '1'.repeat(40), split: { finder: '1'.repeat(64) },
    data: { from: key, to: key, winner: key, currentHolder: key }, headerSenders: [key], amount: 12n };
  const shown = publicIdentities(wire);
  assert.equal(shown.owner, address); assert.equal(shown.data.to, address); assert.deepEqual(shown.headerSenders, [address]);
  assert.equal(shown.hash, key); assert.equal(shown.id, key); assert.equal(shown.split.finder, wire.split.finder); assert.equal(shown.address, wire.address);
  assert.equal(shown.amount, '12'); assert.equal(wire.owner, key);
  assert.deepEqual(wireIdentities(shown), { ...wire, amount: '12' });
});
test('routes, filters, nested continuation routes and cursor owners use trac1 only', () => {
  const route = '/agents/' + key + '/history?actor=' + key;
  const outward = tracReadRoute(route, 'public');
  assert.equal(outward, '/agents/' + address + '/history?actor=' + address);
  assert.equal(tracReadRoute(outward), route);
  assert.throws(() => tracReadRoute(route), /trac1/);
  const nested = '/list?' + new URLSearchParams({ source: route, path: '/history' });
  assert.equal(tracReadRoute(tracReadRoute(nested, 'public')), nested);
  const entry = { row: { address: key }, key, tie: key + '\u00000' };
  const anchor = publicCursorAnchor(entry);
  assert.equal(anchor.key, address); assert.ok(!anchor.tie.includes(key));
  assert.deepEqual(wireCursorAnchor(anchor), { key: entry.key, tie: entry.tie });
  const shownEntry = { row: { address }, key: address, tie: address + '\u00000' };
  assert.deepEqual(wireCursorAnchor(publicCursorAnchor(shownEntry)), { key: shownEntry.key, tie: shownEntry.tie });
  for (const source of ['//remote.invalid/agents/' + address, '/blocks/../agents/' + address, '/blocks/1#hidden'])
    assert.throws(() => tracReadRoute('/list?' + new URLSearchParams({ source, path: '/rows' })), /invalid_list_source/);
});

test('downloadable viewer summaries project identities while audit records stay raw', () => {
  const file = { v: 3, height: 1, hash: 'f'.repeat(64), tip: 6, tipHash: 'e'.repeat(64), receipts: [], receiptRoot: { root: 'd'.repeat(64) }, moves: [], settlements: [{ winners: [{ winner: key, finder: key }] }], discoveries: [{ record: { discoverer: key } }], crafts: [{ firstMaker: key }] };
  const summary = viewerSummary(file);
  assert.equal(summary.settlements[0].winners[0].winner, address);
  assert.equal(summary.discoveries[0].discoverer, address);
  assert.equal(summary.crafts[0].firstMaker, address);
  assert.ok(!new TextDecoder().decode(summaryBytes(file)).includes(key));
});
