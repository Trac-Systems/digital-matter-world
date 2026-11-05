import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { serial } from './util.mjs';
import { Store } from './store.mjs';

// This is the only writable connection after startup. The Store owns journal
// fsync and the process lock; this thread owns apply and WAL checkpointing.
const store = new Store(workerData.directory, workerData.options);
store.db = new DatabaseSync(join(store.directory, 'index.sqlite'));
store.db.exec(`PRAGMA synchronous=FULL; PRAGMA temp_store=FILE; PRAGMA cache_size=-${store.sqliteCacheKiB}`);
store.prepareConnection();
let failed = false;
const gate = serial();
parentPort.on('message', message => { void gate(async () => {
  const { id, command, data } = message;
  try {
    if (failed) throw Error('store_unavailable');
    let result;
    switch (command) {
      case 'ready': break;
      case 'apply': store.apply(data); break;
      case 'rebuildEvidenceIndex': store.rebuildEvidenceIndex(); break;
      case 'migratePublicProjections': {
        const { migratePublicProjections } = await import('../scripts/migrate-public-projections.mjs');
        result = await migratePublicProjections(store, data); break;
      }
      case 'refreshPublicReadIndex': {
        const { publicReadIndex } = await import('./public-index.mjs');
        const { History } = await import('./history.mjs');
        const history = new History(store);
        Object.defineProperty(history, 'length', { value: data.historyLength });
        const index = publicReadIndex({ store, history,
          patterns: () => store.get('meta', 'patterns') ?? [], head: async () => data.head });
        index.views.head = async () => data.head; index.views.history = history;
        result = await index.sync(); break;
      }
      case 'acknowledgeBitmapLinks': store.acknowledgeBitmapLinks(data); break;
      case 'checkpoint': result = store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); break;
      case 'close': store.scratchDB?.close(); store.db.close(); break;
      default: throw Error('store_writer_command');
    }
    parentPort.postMessage({ id, result, state: store.committedState() });
    if (command === 'close') parentPort.close();
  } catch (error) {
    const fatal = !['rebuildEvidenceIndex', 'migratePublicProjections', 'refreshPublicReadIndex'].includes(command);
    failed ||= fatal;
    parentPort.postMessage({ id, fatal, error: { message: error.message, code: error.code, status: error.status } });
  }
}); });
