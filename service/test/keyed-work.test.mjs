import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyedWork } from '../src/keyed-work.mjs';

test('a caller marked after waits for background work on the same key instead of being refused', async () => {
  const work = new KeyedWork(); let release; const order = [];
  const background = work.run('id', () => new Promise(resolve => { release = resolve; })).then(() => order.push('background'));
  await assert.rejects(work.run('id', async () => 'refused'), /resource_busy/);
  const player = work.run('id', async () => { order.push('player'); return 'done'; }, { after: true });
  release(); assert.equal(await player, 'done'); await background;
  assert.deepEqual(order, ['background', 'player']);
});
