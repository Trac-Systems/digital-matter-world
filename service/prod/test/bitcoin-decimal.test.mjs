import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecimalBitcoinViews } from '../bitcoin-decimal.mjs';
import { mine, parseHeader, chain } from '../../../contract/tests/helpers/chain.mjs';
import { REGTEST_PARAMS } from '../../../contract/beacon/bitcoin.js';

for (const base of ['0', '9007199254740991', '9223372036854775807', '9'.repeat(80)]) {
  test(`decimal verified ancestry and catch-up restart at ${base}`, async t => {
    const first = mine('0'.repeat(64), 1000), anchor = parseHeader(first), raws = [first, ...chain(12, anchor)];
    const rows = raws.map((raw, i) => ({ raw, ...parseHeader(raw), height: String(BigInt(base) + BigInt(i)) }));
    const byHash = new Map(rows.map(r => [r.hash, r]));
    const client = { params: REGTEST_PARAMS, genesis: anchor.hash, headerInfo: async h => byHash.get(h), blockHash: async h => rows[Number(BigInt(h) - BigInt(base))]?.hash };
    const directory = await mkdtemp(join(tmpdir(), 'g4b-bitcoin-')), file = join(directory, 'headers.sqlite');
    let views = new DecimalBitcoinViews(client, file, { maxHeadersPerView: 3 }); t.after(() => views.close());
    // Large cases start at an independently trusted synthetic checkpoint.
    if (base !== '0') views.db.prepare('INSERT INTO decimal_headers VALUES(?,?,?,?,?,?,?)').run(anchor.hash, base, anchor.prev, first, anchor.time, JSON.stringify([anchor.time]), '[]');
    const target = rows.at(-1);
    await assert.rejects(views.view(target.height, target.hash), /bitcoin_history_catching_up/);
    views.close(); views = new DecimalBitcoinViews(client, file, { maxHeadersPerView: 3 });
    let view;
    for (let i = 0; i < 20; i++) { try { view = await views.view(target.height, target.hash); break; } catch (error) { assert.equal(error.message, 'bitcoin_history_catching_up'); } }
    assert.ok(view); assert.equal(view.length, String(BigInt(target.height) + 1n));
    for (const row of rows) assert.equal(view.get(row.height).hash, row.hash);
    assert.equal(views.db.prepare('SELECT typeof(height) AS type FROM decimal_headers WHERE hash=?').get(target.hash).type, 'text');
    views.close(); views = new DecimalBitcoinViews(client, file, { maxHeadersPerView: 3 });
    assert.equal((await views.view(target.height, target.hash)).get(base).hash, anchor.hash);
    const alternate = chain(2, rows[3], 601, 7).map((raw, i) => ({ raw, ...parseHeader(raw), height: String(BigInt(base) + 4n + BigInt(i)) }));
    for (const row of alternate) byHash.set(row.hash, row);
    let fork;
    for (let i = 0; i < 4; i++) { try { fork = await views.view(alternate[1].height, alternate[1].hash); break; } catch (error) { assert.equal(error.message, 'bitcoin_history_catching_up'); } }
    assert.equal(fork.hashAt(rows[3].height), rows[3].hash);
    assert.equal(fork.hashAt(alternate[0].height), alternate[0].hash);
    assert.equal((await views.view(target.height, target.hash)).hashAt(rows[4].height), rows[4].hash);
  });
}
