import test from 'node:test';
import assert from 'node:assert/strict';
import { affectsAgent, watchAgentEvents } from '../js/views/agents.js';

test('public result events match the selected player, including both transfer participants', () => {
  for (const [type, data] of [
    ['claim', { agent: 'player' }], ['find', { finder: 'player' }], ['header_find', { winner: 'player' }],
    ['discovery', { discoverer: 'player', state: 'accepted' }], ['discovery', { agent: 'player', state: 'rejected' }],
    ['craft', { owner: 'player' }], ['craft', { firstMaker: 'player' }],
    ['mint_request', { owner: 'player' }], ['mint_complete', { owner: 'player' }], ['mint_expired', { request: { owner: 'player' } }],
    ['transfer', { from: 'player', to: 'other' }], ['transfer', { from: 'other', to: 'player' }],
    ['binding', { address: 'player' }], ['action', { actor: 'player' }],
  ]) assert.equal(affectsAgent({ type, data }, 'player'), true, type);
  assert.equal(affectsAgent({ type: 'block', data: { height: 10 } }, 'player'), false);
  assert.equal(affectsAgent({ type: 'find', data: { finder: 'other' } }, 'player'), false);
  assert.equal(affectsAgent({ type: 'find', data: {} }, undefined), false);
});

function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let listener, selected = 'player', profiles = 0, boards = 0;
  const events = { on(type, fn) { assert.equal(type, 'event'); listener = fn; return () => { listener = null; }; } };
  const stop = watchAgentEvents({ events, address: () => selected,
    refreshProfile: () => { profiles++; return options.work?.(); }, refreshLeaderboard: () => { boards++; } });
  t.after(stop);
  return { emit: e => listener?.(e), select: a => { selected = a; }, stop, counts: () => [profiles, boards] };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('a burst refreshes the profile and leaderboard once after its last event', async t => {
  const s = setup(t);
  s.emit({ type: 'discovery', data: { agent: 'player', state: 'accepted' } });
  t.mock.timers.tick(300);
  s.emit({ type: 'craft', data: { owner: 'player' } });
  s.emit({ type: 'find', data: { finder: 'player' } });
  t.mock.timers.tick(399); assert.deepEqual(s.counts(), [0, 0]);
  t.mock.timers.tick(1); await settle(); assert.deepEqual(s.counts(), [1, 1]);
  t.mock.timers.tick(60000); assert.deepEqual(s.counts(), [1, 1], 'no periodic profile polling');
});

test('other players and anonymous blocks do not refresh the selected profile', async t => {
  const s = setup(t);
  s.emit({ type: 'find', data: { finder: 'other' } });
  s.emit({ type: 'block', data: { height: 20 } });
  t.mock.timers.tick(400); await settle(); assert.deepEqual(s.counts(), [0, 1]);
  s.select('other');
  s.emit({ type: 'find', data: { finder: 'other' } });
  t.mock.timers.tick(400); await settle(); assert.deepEqual(s.counts(), [1, 2]);
});

test('events during a slow refresh are combined into one later refresh', async t => {
  let done;
  const s = setup(t, { work: () => new Promise(resolve => { done = resolve; }) });
  s.emit({ type: 'craft', data: { owner: 'player' } });
  t.mock.timers.tick(400); assert.deepEqual(s.counts(), [1, 1]);
  for (let i = 0; i < 20; i++) s.emit({ type: 'find', data: { finder: 'player' } });
  t.mock.timers.tick(2000); assert.deepEqual(s.counts(), [1, 1]);
  done(); await settle();
  t.mock.timers.tick(400); assert.deepEqual(s.counts(), [2, 2]);
  done(); await settle();
});

test('leaving the view cancels pending refreshes and removes its listener', async t => {
  const s = setup(t);
  s.emit({ type: 'mint_complete', data: { owner: 'player' } });
  s.stop();
  s.emit({ type: 'craft', data: { owner: 'player' } });
  t.mock.timers.tick(1000); await settle(); assert.deepEqual(s.counts(), [0, 0]);
});
