import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PublicViews } from '../../service/src/public-views.mjs';
import { createPublicAPI } from '../../service/src/public-api.mjs';
import { Files } from '../../service/src/files.mjs';
import { save } from '../../service/load/common.mjs';
import { rules as r } from '../../service/src/rules.mjs';

export async function realProjections({ output, store, history, active, document, manifest, manifestHash }) {
  const before = JSON.parse(await readFile(join(output, 'public-api.json'))), last = active.db.get('bt/last'), counted = active.db.get('b/cnt');
  const reads = { head: async () => ({ tip: { height: counted }, counted }), tip: async () => ({ tip: counted }),
    rulesContext: async () => ({ ready: active.db.get('v2/ready') === manifestHash, last, settings: document, settingsHash: r.hashObject(document), manifest, manifestHash }) };
  const api = createPublicAPI({ views: new PublicViews({ store, history, reads, network: manifest.network }), files: new Files(join(store.directory, 'static')) });
  const after = {};
  for (const route of Object.keys(before)) {
    after[route] = await api.read(route);
    if (route !== '/status') {
      const key = route.startsWith('/records/') ? 'batches' : route.startsWith('/agents') ? 'agents' : 'patterns';
      let page = after[route];
      while (page.nextCursor ?? page.next) {
        const url = new URL(route, 'http://local'); url.searchParams.set('cursor', page.nextCursor ?? page.next);
        page = await api.read(url.pathname + url.search); after[route][key].push(...page[key]);
      }
    }
  }
  await save(join(output, 'activated-public-api.json'), after);
  const oldStatus = before['/status'], status = after['/status'];
  assert.equal(status.version, 2); assert.equal(status.state, 'ready'); assert.equal(status.settingsHash, manifest.settingsHash);
  for (const k of ['network', 'units', 'unit', 'catchingUp']) assert.deepEqual(status[k], oldStatus[k], k);
  for (const k of ['counted', 'tip', 'bitcoinTip']) assert.equal(String(status[k]), String(oldStatus[k]), k);
  for (const k of ['n', 'to']) assert.equal(String(status.batch[k]), String(oldStatus.batch[k]), k);
  assert.equal(status.publicIndex.caughtUp, oldStatus.publicIndex.caughtUp);
  const sorted = (rows, field) => [...rows].sort((a,b) => String(a[field]).localeCompare(String(b[field])));
  assert.deepEqual(sorted(after['/records/batches?limit=200'].batches, 'n'), sorted(before['/records/batches?limit=200'].batches, 'n'));
  for (let n = 1; n <= Number(last.n); n++) assert.deepEqual(await api.read('/records/batches/' + n), store.get('batches', String(n).padStart(16, '0')));
  assert.deepEqual(after['/patterns?limit=200'].patterns, before['/patterns?limit=200'].patterns);
  assert.deepEqual((await api.read('/compounds?limit=200')).compounds, before['/patterns?limit=200'].compounds);
  const agents = values => sorted(values.map(a => Object.fromEntries(['address', 'finds', 'discoveries', 'crafts', 'mints'].map(k => [k, String(a[k])]))), 'address');
  assert.deepEqual(agents(after['/agents?limit=200'].agents), agents(before['/agents?limit=200'].agents));
  return { batches: Number(last.n), agents: after['/agents?limit=200'].agents.length, patterns: after['/patterns?limit=200'].patterns.length,
    originalValuesPreserved: true, schemaChanges: 'v2 integer strings, bounded page metadata and activated settings are checked separately' };
}
