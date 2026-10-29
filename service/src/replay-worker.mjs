import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { rules, processObservation } from './rules.mjs';
import { NodeEvidence } from './node-evidence.mjs';
parentPort.on('message', ({ id, input, headers, length, database, branch, shared, publicMintShared, headerPageSize, claimDatabase, claimCacheKiB, claimNodes, namedNodes, headerCachePages = 8, cacheKiB = 4096 }) => {
  let db, claimDb;
  try {
    const decimal = !!input.settings?.document;
    const rows = new Map(headers), pages = new Map(); let pageQuery;
    if (database) {
      db = new DatabaseSync(database, { readOnly: true }); db.exec(`PRAGMA cache_size=-${cacheKiB}; PRAGMA temp_store=FILE; BEGIN`);
      pageQuery = db.prepare("SELECT id,value FROM records WHERE space='headers' AND id>=? AND id<? ORDER BY id");
      if (branch) {
        const bounded = input.settings?.batchVersion === 2 || input.state?.batchVersion === 2;
        db.exec('CREATE TEMP TABLE branch (height INTEGER PRIMARY KEY, raw TEXT NOT NULL)');
        db.prepare(`INSERT INTO branch WITH RECURSIVE ancestors(hash,value) AS (
          SELECT id,value FROM records WHERE space='headerObjects' AND id=? UNION ALL
          SELECT r.id,r.value FROM records r JOIN ancestors a ON r.space='headerObjects' AND r.id=json_extract(a.value,'$.parent')
          ${bounded ? "WHERE NOT EXISTS(SELECT 1 FROM records c WHERE c.space='headers' AND c.id=printf('%016d',json_extract(a.value,'$.height')) AND json_extract(c.value,'$.hash')=a.hash)" : ''})
          SELECT json_extract(value,'$.height'),json_extract(value,'$.raw') FROM ancestors`).run(branch);
        const q = db.prepare('SELECT height,raw FROM branch WHERE height>=? AND height<? ORDER BY height');
        const floor = db.prepare('SELECT height,raw FROM branch ORDER BY height LIMIT 1').get();
        if (!floor) throw Error('worker_history_missing');
        const canonicalQuery = pageQuery;
        pageQuery = { all: (a, b) => [
          ...(bounded && Number(a) < floor.height ? canonicalQuery.all(a, String(Math.min(Number(b), floor.height)).padStart(16, '0')) : []),
          ...q.all(Number(a), Number(b)).map(r => ({ id: r.height, value: JSON.stringify({ raw: r.raw }) }))] };
      }
    }
    const raw = h => {
      if (decimal) return rows.get(rules.decimalV2(h)) ?? null;
      if (!Number.isSafeInteger(h) || h < 0 || h >= length) return null;
      if (!pageQuery) {
        if (rows.has(h)) return rows.get(h);
        const start = Math.floor(h / headerPageSize) * headerPageSize; let page = pages.get(start);
        if (!page) {
          const count = Math.min(headerPageSize, length - start), control = new Int32Array(shared, 0, 1);
          Atomics.store(control, 0, 0); parentPort.postMessage({ id, requestHeaders: { start, count } });
          Atomics.wait(control, 0, 0);
          if (Atomics.load(control, 0) !== 1) throw Error('worker_history_missing');
          page = new Uint8Array(shared, 4, count * 80).slice();
          if (pages.size >= headerCachePages) pages.delete(pages.keys().next().value); pages.set(start, page);
        }
        return page.subarray((h - start) * 80, (h - start + 1) * 80);
      }
      const start = Math.floor(h / headerPageSize) * headerPageSize; let page = pages.get(start);
      if (!page) {
        page = new Map(pageQuery.all(String(start).padStart(16, '0'), String(start + headerPageSize).padStart(16, '0')).map(r => [Number(r.id), JSON.parse(r.value).raw]));
        if (pages.size >= headerCachePages) pages.delete(pages.keys().next().value); pages.set(start, page);
      }
      return page.get(h);
    };
    const get = h => { const bytes = raw(h); if (!bytes) throw Error('worker_history_missing'); return rules.parseHeader(bytes, h); };
    const history = { length, get, field: (h, f, dt = 'n') => {
      if (f === 4) return String(h);
      const row = get(h); return (f === 10 ? row.nonce : row.bits).toString(dt === 'h' ? 16 : 10);
    } };
    let claimNodeGet, namedNodeGet;
    const claimProof = input.settings?.document && new NodeEvidence(input.settings.document.values.auditTotalBytes, input.claimEvidence);
    const namedProof = input.settings?.document && new NodeEvidence(input.settings.document.values.proofBytes, input.namedEvidence);
    if (claimDatabase) {
      if (!Number.isSafeInteger(claimCacheKiB) || claimCacheKiB < 1) throw Error('claim_cache_setting');
      claimDb = new DatabaseSync(claimDatabase, { readOnly: true }); claimDb.exec(`PRAGMA cache_size=-${claimCacheKiB}; BEGIN`);
      const query = claimDb.prepare("SELECT value FROM records WHERE space='claimNodes' AND id=?"), staged = new Map(claimNodes);
      const namedQuery = claimDb.prepare("SELECT value FROM records WHERE space='namedNodes' AND id=?"), namedStaged = new Map(namedNodes);
      namedNodeGet = id => {
        const raw = namedStaged.has(id) ? null : namedQuery.get(id);
        const row = namedStaged.get(id) ?? (raw ? JSON.parse(raw.value) : undefined);
        namedProof.add(id, row); return row;
      };
      claimNodeGet = id => {
        const raw = staged.has(id) ? null : query.get(id), row = staged.get(id) ?? (raw ? JSON.parse(raw.value) : undefined);
        claimProof.add(id, row);
        return row;
      };
    }
    const publicMintGet = (asset, block) => {
      const control = new Int32Array(publicMintShared, 0, 2);
      Atomics.store(control, 0, 0); parentPort.postMessage({ id, requestPublicMint: [asset, block] });
      Atomics.wait(control, 0, 0);
      if (Atomics.load(control, 0) !== 1) throw Error('public_mint_evidence_missing');
      return new TextDecoder().decode(new Uint8Array(publicMintShared, 8, Atomics.load(control, 1))) || null;
    };
    const output = processObservation({ ...input, history, hashAt: h => raw(h) ? get(h).hash : null }, { claimNodeGet, namedNodeGet, publicMintGet });
    parentPort.postMessage({ id, output: claimDatabase ? { ...output, claimEvidence: claimProof.value(), namedEvidence: namedProof.value() } : output });
  } catch (e) { parentPort.postMessage({ id, error: e.message }); }
  finally { db?.close(); claimDb?.close(); }
});
