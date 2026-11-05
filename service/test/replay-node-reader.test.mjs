import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ReplayNodeReader } from '../src/replay-node-reader.mjs';
import { IndexRowCache } from '../../rules/src/index-row-cache.js';
import { NamedStorage } from '../../rules/src/named-storage.js';
import * as r from '../../rules/src/index.js';

test('SQLite point reads preserve demanded rows, staged precedence and bounded reuse across replay readers', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE records(space TEXT,id TEXT,value TEXT,PRIMARY KEY(space,id)) WITHOUT ROWID');
    const put = db.prepare('INSERT INTO records VALUES(?,?,?)'), rows = [];
    for (let i = 0; i < 8; i++) {
      const prefix = r.hash(String(i)), key = String(i), value = { n: i };
      const row = { prefix, key, value, commitment: r.hashObject(['dmw-named-leaf-v2', prefix, key, value]) };
      const id = r.hashObject(['dmw-stored-index-v2', row]); rows.push([id, row]); put.run('claimNodes', id, JSON.stringify(row));
    }
    const parent = r.hash('parent'), bad = r.hash('malformed'), large = r.hash('large');
    put.run('claimNodes', bad, '{'); put.run('claimNodes', large, JSON.stringify({ value: 'x'.repeat(256001) }));
    const supplied = { claimNodes: new Map([[parent, { children: Object.fromEntries([...rows.map(([id]) => id), bad, large].map((id, i) => [String(i), { storage: id }])) }]]) };
    let points = 0, pages = 0;
    const tracked = { prepare(sql) { const query = db.prepare(sql); return {
      all(...args) { pages++; return query.all(...args); }, get(...args) { points++; return query.get(...args); }
    }; } };
    const cache = new IndexRowCache(16, 100000), reader = new ReplayNodeReader(tracked, { cache, supplied });
    assert.deepEqual(reader.get('claimNodes', rows[0][0], [parent]), rows[0][1]);
    assert.equal(cache.rows.size, 1, 'unused siblings never displace demanded rows');
    for (const [id, row] of rows) {
      assert.deepEqual(reader.get('claimNodes', id), row);
      assert.deepEqual(cache.get('claimNodes/' + id), row);
    }
    assert.equal(pages, 0); assert.equal(points, rows.length);
    assert.equal(cache.has('claimNodes/' + bad), false); assert.equal(cache.has('claimNodes/' + large), false);
    const staged = { claimNodes: new Map([[rows[0][0], { ...rows[0][1], value: { n: 999 } }]]) };
    const next = new ReplayNodeReader(db, { cache, staged });
    assert.equal(next.get('claimNodes', rows[0][0]).value.n, 999);
    assert.equal(reader.get('claimNodes', rows[0][0]).value.n, 0, 'draft overrides never poison retained database rows');
    assert.throws(() => new NamedStorage({ get: id => next.get('claimNodes', id), cacheSize: 1 }).row(rows[0][0]), /named_storage_integrity/);
    assert.equal(reader.get('claimNodes', r.hash('missing')), undefined);
    assert.throws(() => reader.get('claimNodes', bad), SyntaxError, 'a demanded malformed row still fails');
    assert.equal(points, rows.length + 2); assert.equal(pages, 0, 'all local misses use direct primary-key queries');
    assert.ok(cache.bytes <= cache.limit); assert.ok(cache.rows.size <= cache.entries);
  } finally { db.close(); }
});
