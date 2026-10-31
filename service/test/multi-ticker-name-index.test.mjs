import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { officialName, rebuildOfficialNames } from '../src/official-ticker-names.mjs';
import { rules } from '../src/rules.mjs';

test('official-name point index requires offline readiness and follows later catalog writes', async t => {
  const path = await mkdtemp(join(tmpdir(), 'dmw-name-index-')), store = await Store.open(path);
  t.after(async () => { await store.close(); await rm(path, { recursive: true }); });
  let height = String(BigInt(rules.MULTI_TICKER_HEIGHT) - 1n);
  const reads = { counted: async () => height, rulesContext: async () => ({ ready: true }) };
  const compound = 'c2:' + 'ab'.repeat(32);
  await store.put('patternsByAsset', 'p2:0', { name: 'Retained' });
  await store.put('compoundTypes', compound, { id: compound });
  // A v2 compound's official ticker is its first maker's choice, kept on its deployment job.
  await store.put('provisioning', compound, { asset: compound, chosenTicker: { tick: 'chosen', revision: 1, attempt: 0 } });
  await assert.rejects(officialName(reads, store, 'Retained'), /multi_ticker_inactive/);
  height = rules.MULTI_TICKER_HEIGHT;
  await assert.rejects(officialName(reads, store, 'Retained'), /ticker_name_index_required/);
  await rebuildOfficialNames(store);
  store.list = () => assert.fail('runtime name lookup cannot list the catalog');
  assert.equal((await officialName(reads, store, 'DMT-RETAINED')).asset, 'p2:0');
  assert.equal(await officialName(reads, store, 'dmwcabababab'), null);
  assert.equal((await officialName(reads, store, 'chosen')).asset, compound);
  assert.equal(await officialName(reads, store, 'unused'), null);
  await store.put('patternsByAsset', 'p2:1', { name: 'Later' });
  assert.equal((await officialName(reads, store, 'later')).asset, 'p2:1');
});
