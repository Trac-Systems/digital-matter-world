import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { PUBLIC_READ_DEFAULTS } from './public-read-settings.mjs';
import { check } from './util.mjs';
import { Store, STORE_DEFAULTS } from './store.mjs';

// No Store.init(), writer lock, migrations, journal, adapters, or recovery jobs.
// Borrow only the ordinary read methods to preserve their validation/decoding.
export class PublicReadStore {
  constructor(directory, { sqliteCacheKiB = PUBLIC_READ_DEFAULTS.sqliteCacheKiB, storePageRows = STORE_DEFAULTS.pageLimit, defaultPageRows = STORE_DEFAULTS.defaultPageRows } = {}) {
    check([sqliteCacheKiB, storePageRows, defaultPageRows].every(n => Number.isSafeInteger(n) && n > 0), 'public_read_store_settings');
    Object.assign(this, { directory, storePageRows, defaultPageRows });
    this.db = new DatabaseSync(join(directory, 'index.sqlite'), { readOnly: true });
    this.db.exec(`PRAGMA query_only=ON; PRAGMA cache_size=-${sqliteCacheKiB}; PRAGMA temp_store=FILE`);
    this.getStmt = this.db.prepare('SELECT value FROM records WHERE space=? AND id=?');
    this.listStmt = this.db.prepare('SELECT id,value FROM records WHERE space=? AND id>? ORDER BY id LIMIT ?');
    this.countStmt = this.db.prepare('SELECT n FROM record_counts_decimal WHERE space=?');
  }
  close() { this.db.close(); }
}
for (const name of ['get', 'list', 'countUint', 'hasRows', 'count']) PublicReadStore.prototype[name] = Store.prototype[name];
