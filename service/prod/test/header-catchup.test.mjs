import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { BitcoinViews } from '../bitcoin.mjs';
import { mine, parseHeader } from '../../../contract/tests/helpers/chain.mjs';
import { REGTEST_PARAMS } from '../../../contract/beacon/bitcoin.js';
import { temporary } from './helpers.mjs';

test('catch-up beyond the work budget survives every restart and commits verified chunks', async t => {
  const root = await temporary(t), filename = join(root, 'headers.sqlite'), rows = [];
  let prev = '00'.repeat(32);
  for (let n = 0; n < 37; n++) { const raw = mine(prev, 1000 + n); rows.push({ raw, ...parseHeader(raw) }); prev = rows.at(-1).hash; }
  const byHash = new Map(rows.map(r => [r.hash, r.raw])); let requests = 0;
  const client = { params: REGTEST_PARAMS, genesis: rows[0].hash, header: async id => { requests++; return byHash.get(id); } };
  let complete, previousVerified = 0, partial = false;
  for (let tick = 0; tick < 40 && !complete; tick++) {
    const views = new BitcoinViews(client, filename, { maxHeadersPerView: 5 }), before = requests;
    try { complete = await views.view(36, prev); }
    catch (e) { assert.equal(e.message, 'bitcoin_history_catching_up'); }
    const verified = views.db.prepare('SELECT count(*) AS n FROM headers').get().n;
    assert.ok(verified >= previousVerified && verified - previousVerified <= 5);
    assert.ok(requests - before <= 5); partial ||= verified > 0 && verified < rows.length;
    previousVerified = verified;
    if (complete) for (let n = 0; n < rows.length; n++) assert.equal(complete.hashAt(n), rows[n].hash);
    views.close();
  }
  assert.ok(complete); assert.ok(partial); assert.equal(requests, 37);
  const views = new BitcoinViews(client, filename, { maxHeadersPerView: 5 }); t.after(() => views.close());
  const fork = mine(rows[34].hash, 2000), forkHash = parseHeader(fork).hash; byHash.set(forkHash, fork);
  assert.equal((await views.view(35, forkHash)).hashAt(34), rows[34].hash);
  assert.equal((await views.view(36, prev)).hashAt(35), rows[35].hash);
});

test('catch-up never exposes an unlinked header or trusts a source hash mismatch', async () => {
  const raw = mine('00'.repeat(32), 1000), h = parseHeader(raw);
  const views = new BitcoinViews({ params: REGTEST_PARAMS, genesis: h.hash, header: async () => raw }, ':memory:', { maxHeadersPerView: 2 });
  try {
    await assert.rejects(views.view(0, 'ab'.repeat(32)), /bitcoin_header_binding/);
    assert.equal(views.db.prepare('SELECT count(*) AS n FROM headers').get().n, 0);
  } finally { views.close(); }
});

test('a reorg abandons an unavailable unfinished branch within the same work budget', async t => {
  const rows = [], byHash = new Map(); let previous = '00'.repeat(32);
  for (let n=0; n<12; n++) { const raw=mine(previous,1000+n); rows.push({raw,...parseHeader(raw)}); previous=rows.at(-1).hash; byHash.set(previous,raw); }
  let canonical=rows;
  const client={params:REGTEST_PARAMS,genesis:rows[0].hash,header:async id=>{assert.ok(byHash.has(id));return byHash.get(id);},blockHash:async n=>canonical[n]?.hash};
  const views=new BitcoinViews(client,join(await temporary(t),'headers.sqlite'),{maxHeadersPerView:2});t.after(()=>views.close());
  await assert.rejects(views.view(11,previous),/bitcoin_history_catching_up/);
  canonical=rows.slice(0,4);previous=canonical.at(-1).hash;
  for(let n=4;n<12;n++){const raw=mine(previous,2000+n);canonical.push({raw,...parseHeader(raw)});previous=canonical.at(-1).hash;byHash.set(previous,raw);}
  for(const row of rows.slice(4))byHash.delete(row.hash);
  let view;
  for(let tick=0;tick<30&&!view;tick++)try{view=await views.view(11,previous);}catch(error){assert.equal(error.message,'bitcoin_history_catching_up');}
  assert.ok(view);assert.equal(view.hashAt(11),previous);
});
