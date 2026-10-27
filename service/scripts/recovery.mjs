import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { History } from '../src/history.mjs';
import { Committee } from '../src/committee.mjs';
import { Mints } from '../src/mints.mjs';
import { check } from '../src/util.mjs';
check(process.version === 'v23.11.0', 'node_version');
const [filename, command = 'status'] = process.argv.slice(2);
check(['status', 'reconcile'].includes(command), 'recovery_command');
const config = await loadConfig(filename), store = await Store.open(config.data); let adapters;
try {
  if (command === 'reconcile') {
    adapters = await (await import(pathToFileURL(config.adapter).href)).createAdapters({ config, store, history: new History(store) });
    const committee = new Committee({ store, network: config.network, signers: config.committee, epoch: config.epoch ?? 1 });
    const mints = new Mints({ store, network: config.network, committee, ...adapters });
    await mints.supervise(); await mints.tick();
  }
  const spaces = ['activeMints', 'expiredMints', 'issuedMints', 'mintCredits', 'mintDeferred', 'mintRejected', 'observationRecovery', 'missedReceipts'];
  console.log(JSON.stringify(Object.fromEntries(spaces.map(space => [space, { count: store.count(space), ids: store.list(space, { limit: 100 }).map(r => r.id) }]))));
} finally { await adapters?.close(); await store.close(); }
