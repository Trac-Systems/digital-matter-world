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
