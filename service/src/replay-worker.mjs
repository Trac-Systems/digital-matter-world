import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { rules, processObservation } from './rules.mjs';
parentPort.on('message', ({ id, input, headers, length, database, branch }) => {
  let db;
  try {
    const rows = new Map(headers), pages = new Map(); let pageQuery;
    if (database) {
      db = new DatabaseSync(database, { readOnly: true }); db.exec('PRAGMA cache_size=-4096; PRAGMA temp_store=FILE; BEGIN');
      pageQuery = db.prepare("SELECT id,value FROM records WHERE space='headers' AND id>=? AND id<? ORDER BY id");
      if (branch) {
        db.exec('CREATE TEMP TABLE branch (height INTEGER PRIMARY KEY, raw TEXT NOT NULL)');
        db.prepare(`INSERT INTO branch WITH RECURSIVE ancestors(value) AS (
          SELECT value FROM records WHERE space='headerObjects' AND id=? UNION ALL
          SELECT r.value FROM records r JOIN ancestors a ON r.space='headerObjects' AND r.id=json_extract(a.value,'$.parent'))
          SELECT json_extract(value,'$.height'),json_extract(value,'$.raw') FROM ancestors`).run(branch);
        const q = db.prepare('SELECT height,raw FROM branch WHERE height>=? AND height<? ORDER BY height');
        pageQuery = { all: (a, b) => q.all(Number(a), Number(b)).map(r => ({ id: r.height, value: JSON.stringify({ raw: r.raw }) })) };
      }
    }
    const raw = h => {
      if (!Number.isSafeInteger(h) || h < 0 || h >= length) return null;
      if (!pageQuery) return rows.get(h);
      const start = Math.floor(h / 1024) * 1024; let page = pages.get(start);
      if (!page) {
        page = new Map(pageQuery.all(String(start).padStart(16, '0'), String(start + 1024).padStart(16, '0')).map(r => [Number(r.id), JSON.parse(r.value).raw]));
        if (pages.size === 8) pages.delete(pages.keys().next().value); pages.set(start, page);
      }
      return page.get(h);
    };
    const get = h => { const bytes = raw(h); if (!bytes) throw Error('worker_history_missing'); return rules.parseHeader(bytes, h); };
    const history = { length, get, field: (h, f, dt = 'n') => {
      if (f === 4) return String(h);
      const row = get(h); return (f === 10 ? row.nonce : row.bits).toString(dt === 'h' ? 16 : 10);
    } };
    const output = processObservation({ ...input, history, hashAt: h => raw(h) ? get(h).hash : null });
    parentPort.postMessage({ id, output });
  } catch (e) { parentPort.postMessage({ id, error: e.message }); }
  finally { db?.close(); }
});
