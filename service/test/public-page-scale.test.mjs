import { tracReadRoute } from '../../rules/src/trac-address.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PublicViews } from '../src/public-views.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { agentSpecs, collectionSpecs, eventSpec, patternBlocksSpec } from '../src/read-specs.mjs';
import { rules } from '../src/rules.mjs';
import { hash, heightKey } from '../src/util.mjs';

// One short integration/scale test: the slow paths are compared with the old
// raw projection, then grow tenfold and prohibit collection reads after backfill.
test('indexed public pages preserve live cursors/filters and stay bounded at 10x rows', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE records(space TEXT,id TEXT,value TEXT,PRIMARY KEY(space,id)) WITHOUT ROWID');
  const putStmt = db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)'),
    getStmt = db.prepare('SELECT value FROM records WHERE space=? AND id=?');
  const put = (space, id, value) => putStmt.run(space, String(id), JSON.stringify(value));
  const store = {
    db,
    get(space, id) {
      const r = getStmt.get(space, String(id));
      return r ? JSON.parse(r.value) : null;
    },
  };
  const owner = 'a'.repeat(64),
    other = 'b'.repeat(64);
  let length = 1,
    counted = 1000000,
    balance = '10',
    calls = 0,
    holder = other;
  const history = {
    get length() {
      return length;
    },
    get: (h) => ({ height: h, time: h, hash: String(h), nonce: 1, bits: 1 }),
    hashAt: (h) => String(h),
  };
  const table = Array.from({ length: 3 }, (_, number) => ({ number, name: 'pattern' + number, pat: '[0-9]', fld: 4, dt: 'n' }));
  put('meta', 'patterns', table);
  put('meta', 'ruleState', { rounds: [] });
  const reads = {
    registry: async () => ({ assets: { p0: {}, p1: {}, p2: {} } }),
    head: async () => ({ tip: { height: length - 1 }, counted }),
    balance: async () => {
      calls++;
      return balance;
    },
    link: async (block) => store.get('links', heightKey(block)),
    bitmap: async () => {
      if (holder === null) throw Error('unavailable');
      return { agent: holder };
    },
  };
  const views = new PublicViews({ store, history, reads }),
    api = createPublicAPI({ views });
  const rawViews = Object.create(views);
  rawViews.indexed = undefined;
  const oracle = createPublicAPI({ views: rawViews });
  function append(to) {
    db.exec('BEGIN');
    for (let h = length; h <= to; h++) {
      put('headers', heightKey(h), { fields: history.get(h) });
      put('finds', rules.findId(h, 0), {
        block: h,
        pattern: 0,
        asset: 'p0',
        count: String(h).length,
        finder: h % 2 ? owner : other,
        findHeight: h + 3,
        window: h,
      });
      put('publicEvents', heightKey(h), {
        id: hash('event' + h),
        sequence: h,
        at: h % 7 === 0 ? null : h,
        type: h % 2 ? 'claim' : 'transfer',
        data: { agent: h % 2 ? owner : other, patterns: [0, 1, 2] },
      });
    }
    db.exec('COMMIT');
    length = to + 1;
  }
  put('headers', heightKey(0), { fields: history.get(0) });
  append(24);
  const cases = [
    ['/world', collectionSpecs.plots, [{ from: '2', to: '19' }, { found: 'true', minted: 'false' }, { linked: 'false' }]],
    [
      '/patterns/p0/blocks',
      patternBlocksSpec,
      [
        { from: '3', to: '20' },
        { found: 'true', minted: 'false' },
      ],
    ],
    ['/finds', collectionSpecs.finds, [{ owner, asset: 'p0' }, { minted: 'false', block: '3' }, { asset: '' }]],
    ['/events', eventSpec, [{ type: 'claim', actor: owner, since: '8' }, { category: 'money' }, { type: '' }]],
    ['/agents/' + owner + '/history', eventSpec, [{ since: '4' }]],
    [
      '/mint-rights?owner=' + owner,
      agentSpecs.mintRights,
      [{ allowed: 'true' }, { whoMayMint: 'none' }, { asset: 'p0', block: '4' }, { reason: 'public' }],
    ],
  ];
  async function equal(path, query = {}) {
    const u = new URL(path, 'http://local');
    for (const [k, v] of Object.entries({ limit: '3', ...query })) u.searchParams.set(k, v);
    const p = u.pathname + u.search,
      expected = await oracle.read(tracReadRoute(p, 'public')),
      actual = await api.read(tracReadRoute(p, 'public'));
    assert.deepEqual(actual, expected, p);
    if (expected.next) {
      u.searchParams.set('cursor', expected.next);
      u.searchParams.set('limit', '2');
      assert.deepEqual(await api.read(tracReadRoute(u.pathname + u.search, 'public')), await oracle.read(tracReadRoute(u.pathname + u.search, 'public')), 'continuation ' + p);
    }
  }
  for (const [path, spec, filters] of cases)
    for (const sort of spec.keys)
      for (const order of ['asc', 'desc']) for (const filter of [{}, ...filters]) await equal(path, { sort, order, ...filter });
  // Changed balances are read live; minted/holds and deletions update exact
  // filtered counts; rollback does not leak a change into the read indexes.
  await equal('/agents/'+owner+'/finds',{owner:other});
  await equal('/agents/'+owner+'/history',{actor:other});
  put('publicEvents',heightKey(2),{id:hash('event2'),sequence:2,at:2,type:'transfer',data:{from:owner,to:other,assets:[['p0','1']]}});
  await equal('/agents/'+owner+'/history',{actor:other});
  await assert.rejects(api.read('/events?' + new URLSearchParams({ actor: JSON.stringify([owner,other]) })), /trac1/);
  balance = '0';
  await equal('/mint-rights?owner=' + owner, { sort: 'reason', allowed: 'false' });
  balance = '10';
  put('minted', 'p0/3', 'inscription');
  put('holds', 'p1/4', { id: 'hold', expiry: counted });
  await equal('/world', { minted: 'true' });
  await equal('/mint-rights?owner=' + owner, { pending: 'true' });
  counted++;
  await equal('/mint-rights?owner=' + owner, { pending: 'true' });
  db.prepare('DELETE FROM records WHERE space=? AND id=?').run('publicEvents', heightKey(2));
  await equal('/events');
  db.exec('BEGIN');
  put('minted', 'p0/4', 'rollback');
  db.exec('ROLLBACK');
  await equal('/world', { minted: 'true' });
  put('links', heightKey(3), { block: 3, linkHeight: 0 });
  await equal('/mint-rights?owner=' + other, { sort: 'reason', allowed: 'true' });
  holder = owner;
  await equal('/mint-rights?owner=' + other, { whoMayMint: 'none' });
  holder = null;
  await equal('/mint-rights?owner=' + other, { reason: 'holder_unavailable' });
  holder = other;
  counted = 25;
  await equal('/mint-rights?owner=' + other, { sort: 'reason' });
  counted = 1000000;
  const measurements = [];
  for (const n of [4500, 45000]) {
    append(n);
    await views.readIndex.sync();
    await api.read('/world?limit=1');
    const saved = views.rows;
    views.rows = (space) => {
      assert.equal(space, 'types', 'no full collection read: ' + space);
      return [];
    };
    put('meta', 'patterns', table); // An unchanged publication must not rebuild history.
    const timings = {};
    for (const [path, query] of [
      ['/world', { sort: 'region', found: 'true', from: '100', to: String(n - 100) }],
      [
        '/patterns/p0/blocks',
        { sort: 'count', found: 'true', from: String(Math.floor(n / 2)), to: String(Math.floor(n / 2) + 75) },
      ],
      ['/agents', { sort: 'finds', address: owner }],
      ['/events', { sort: 'type', category: 'money', since: String(Math.floor(n / 2)) }],
      ['/mint-rights?owner=' + owner, { sort: 'block' }],
      ['/mint-rights?owner=' + owner, { sort: 'reason', allowed: 'true' }],
    ]) {
      const u = new URL(path, 'http://local');
      for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
      const samples = [];
      for (let repeat = 0; repeat < 5; repeat++) {
        calls = 0;
        const start = performance.now();
        const page = await api.read(tracReadRoute(u.pathname + u.search, 'public'));
        samples.push(performance.now() - start);
        assert.ok(page.total > 0);
        assert.ok(calls <= 3, 'at most one balance read per page asset');
      }
      timings[u.pathname + ' ' + query.sort] = samples.sort((a, b) => a - b)[2];
      assert.ok(samples[2] < 50, JSON.stringify({ n, path, query, ms: samples[2] }));
    }
    views.rows = saved;
    measurements.push(timings);
  }
  t.diagnostic(JSON.stringify({ rows: [4500, 45000], rights: [13500, 135000], medianMs: measurements }));
  for (const key of Object.keys(measurements[0]))
    assert.ok(measurements[1][key] < Math.max(10, measurements[0][key] * 3), '10x growth: ' + key);
});
