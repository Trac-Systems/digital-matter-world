import test from 'node:test';
import assert from 'node:assert/strict';
import { describe } from '../console/js/words.js';
import { encodeTracAddress } from '../../rules/src/trac-address.js';

test('the console describes header finds and submissions without extra claims', () => {
  const agent = encodeTracAddress('11'.repeat(32));
  const find = describe({ type: 'header_find', data: { finder: agent, asset: 'p0', count: 3, block: 20 } });
  assert.match(find.text, /header find: received 3/); assert.match(find.text, /sending its header/); assert.equal(find.block, 20);
  const claim = describe({ type: 'claim', data: { agent, block: 20, patterns: [0, 1], header: true } });
  assert.match(claim.text, /header sent/); assert.doesNotMatch(claim.text, /\+1|bonus|extra/);
  const draw = describe({ type: 'draw', data: { settlements: [{ winners: [{ source: 'header', block: 20 }], claims: 0, window: 20 }] } });
  assert.match(draw.text, /1 header finds/);
  assert.match(describe({ type: 'draw', data: { settlements: [{ complete: false }] } }).text, /continuing/);
});

test('the feed says linked only for a completed link, not for a link request or a mint reservation', () => {
  const owner = encodeTracAddress('22'.repeat(32));
  const request = describe({ type: 'financial_link_reserve', data: { owner, block: '891928', action: 'link-reserve', state: 'reservable' } });
  assert.match(request.text, /asked to link the Bitmap of block 891,928; awaiting payment/); assert.doesNotMatch(request.text, /^linked/); assert.equal(request.block, '891928');
  assert.match(describe({ type: 'link', data: { owner, block: '891928', action: 'link-complete' } }).text, /^linked the Bitmap of block 891,928/);
  assert.match(describe({ type: 'financial_reserve', data: { owner, asset: 'p2:1', block: '510000', amount: '1', action: 'reserve' } }).text, /asked to mint 1 .* from block 510,000; awaiting payment/);
  assert.match(describe({ type: 'financial_consume', data: { owner, asset: 'p2:1', block: '550000', amount: '1', action: 'consume', state: 'authorized' } }).text, /payment final: permit to mint/);
  assert.match(describe({ type: 'financial_link_exit', data: { owner, block: '611638', action: 'link-exit' } }).text, /ended without a link/);
});
