import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { createReadAPI } from '../api.mjs';
import { publicPath } from '../public-proxy.mjs';
import { botsOnce } from '../bots.mjs';

const key = 'ab'.repeat(32), owner = encodeTracAddress(key), other = encodeTracAddress('cd'.repeat(32));
const representations = [
  ['trac1', owner], ['hex', key], ['bytes', Uint8Array.from(Buffer.from(key, 'hex'))], ['buffer', Buffer.from(key, 'hex')],
];
const routes = [
  ['/api/player', '/agents/' + owner],
  ...['balances', 'mintRights', 'bitmaps', 'finds'].map(name => ['/api/player/' + name, '/agents/' + owner + '/' + name]),
  ...['', '/finds', '/claims', '/draws', '/matches', '/slotList', '/mintRights'].map(suffix => ['/api/blocks/151' + suffix, '/blocks/151' + suffix]),
];
const absolute = path => new URL(path, 'http://127.0.0.1');
const targetFor = (path, target) => target + '?limit=1' + (path.startsWith('/api/blocks/') ? '&owner=' + owner : '');

for (const [name, address] of representations) {
  for (const [path, target] of routes) test(`${name} current owner: ${path}`, async () => {
    const calls = [], profile = { address: owner, counts: { mintRights: 212 }, pages: { mintRights: { route: '/agents/' + owner + '/mintRights' } } };
    const engine = { state: { player: { address } }, get: async value => { calls.push(value); return profile; } };
    const api = createReadAPI({ engine, views: { localPlayer: async () => ({ address: key, discoveries: [] }) } });
    const result = await api(absolute(path + '?limit=1'));
    assert.deepEqual(calls, [targetFor(path, target)]);
    assert.equal(result.address, owner);
    assert.equal(result.counts.mintRights, 212);
    assert.deepEqual(result.pages.mintRights, profile.pages.mintRights);
    assert.ok(!JSON.stringify(result).includes(key));
    if (path === '/api/player') assert.deepEqual(result.discoveries, []);
  });

  test(`${name} owner in direct and nested public routes preserves paging`, () => {
    for (const [path, target] of routes.slice(1)) {
      const source = path + '?limit=1', mapped = targetFor(path, target);
      assert.equal(publicPath(source, address), mapped);
      const query = new URLSearchParams({ source, path: '/claims/0/patterns', limit: '2', cursor: 'opaque+/=' });
      const expected = new URLSearchParams(query); expected.set('source', mapped);
      assert.equal(publicPath('/api/list?' + query, address), '/list?' + expected);
    }
  });

  test(`${name} current owner preserves explicit owners and public routes`, () => {
    for (const path of ['/api/blocks/151', '/api/blocks/151/mintRights']) {
      const source = path + '?owner=' + other + '&cursor=opaque';
      assert.equal(publicPath(source, address), source.slice(4));
    }
    for (const source of ['/api/agents/' + other + '/mintRights?limit=1', '/api/blocks?limit=1', '/api/gateway/blocks/151?limit=1']) {
      assert.equal(publicPath(source, address), source.replace(/^\/api(?:\/gateway)?/, ''));
    }
  });

  test(`${name} bot transfer uses the current player's canonical address`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'dmw-player-owner-'));
    t.after(() => rm(directory, { recursive: true }));
    const calls = [], events = [], actor = { name: 'bot-0', strategy: 'prospector', address: 'cd'.repeat(32), journal: { get: () => true } };
    const engine = {
      directory, state: { player: { address } }, settings: { bots: { count: 1, paused: false } },
      trac: async name => name === 'head' ? { tip: { height: 151 } } : '1', actor: async () => actor,
      action: async (...args) => { calls.push(args); }, emit: (...args) => events.push(args),
    };
    await botsOnce(engine);
    assert.deepEqual(calls, [['transfer', { actionId: 'bot-0-transfer', to: owner, assets: [['p0', '1']] }, 'bot-0']]);
    const state = JSON.parse(await readFile(join(directory, 'bots.json'), 'utf8'));
    assert.equal(state['bot-0'].transfer, true);
    assert.ok(!state['bot-0'].halted);
    assert.equal(events.at(-1)[1].action, 'transfer');
  });
}

for (const [name, address] of [
  ['bad checksum', owner.slice(0, -1) + (owner.endsWith('q') ? 'p' : 'q')], ['uppercase', owner.toUpperCase()],
  ['short hex', key.slice(2)], ['short bytes', new Uint8Array(31)], ['missing', undefined], ['object', {}],
]) test(`invalid current owner (${name}) fails before any read`, async () => {
  let reads = 0;
  const api = createReadAPI({
    engine: { state: { player: { address } }, get: async () => { reads++; } },
    views: { localPlayer: async () => { reads++; return {}; } },
  });
  for (const [path] of routes) await assert.rejects(api(absolute(path + '?limit=1')), { code: 'trac_address_required', status: 400 });
  assert.equal(reads, 0);
});

test('owner normalization follows the current player on each request without changing stored identity', async () => {
  const calls = [], engine = { state: { player: { address: key } }, get: async path => { calls.push(path); return {}; } };
  const api = createReadAPI({ engine });
  await api(absolute('/api/player/mintRights'));
  assert.equal(engine.state.player.address, key);
  engine.state.player.address = other;
  await api(absolute('/api/player/mintRights'));
  assert.equal(engine.state.player.address, other);
  assert.deepEqual(calls, ['/agents/' + owner + '/mintRights', '/agents/' + other + '/mintRights']);
});
