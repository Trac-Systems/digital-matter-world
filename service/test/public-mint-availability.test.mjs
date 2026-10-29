import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { PublicMints } from '../src/public-mints.mjs';
import { serve } from '../src/http.mjs';
import * as r from '../../rules/src/index.js';

for (const activation of [undefined, '12']) test(`public listing answers before ${activation ?? 'unscheduled'} activation while checkout remains closed`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rh2-public-read-')), store = await Store.open(directory);
  let http;
  t.after(async () => { await http?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.put('meta', 'ruleState', { batchVersion: 2, counted: '10' });
  const document = r.settingsRevision({ network: 'local', effectiveBatch: '2', effectiveBitcoinWindow: '10', values: {
    ...r.SETTINGS_PROFILE, ...(activation ? { ...r.PUBLIC_MINT_SETTINGS, publicMintActivationHeight: activation } : {}) } });
  const mints = { store, document }; mints.publicMints = new PublicMints(mints);
  http = await serve({ intake: { store }, files: { serve: async () => false }, mints });
  const list = await fetch(http.url + '/public-mints?asset=p2:0&limit=25');
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { v: 3, asset: 'p2:0', state: 'inactive', activationHeight: activation ?? null,
    rows: [], mintRights: [], total: 0, next: null, nextCursor: null });
  const invalid = await fetch(http.url + '/public-mints?asset=bad&limit=25');
  assert.equal(invalid.status, 400);
  for (const route of ['quote', 'start']) {
    const response = await fetch(http.url + '/public-mints/' + route, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ asset: 'p2:0', block: '1', tapAddress: 'unused' }) });
    assert.equal(response.status, 409); assert.equal((await response.json()).error, 'public_mint_inactive');
  }
  assert.equal(store.count('publicMintRequests'), 0);
});
