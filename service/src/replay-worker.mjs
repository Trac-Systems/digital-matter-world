import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { rules, processObservation } from './rules.mjs';
import { NodeEvidence } from './node-evidence.mjs';
import { PublicMintPrefetch } from '../../rules/src/public-mint-prefetch.js';
import { ClaimStorage } from '../../rules/src/claim-state.js';
import { recordGet } from '../../rules/src/record-index.js';
const CLOSURE_LOOKAHEAD = 1500, CLOSURE_HINTS = 3000;
parentPort.on('message', ({ id, input, headers, length, database, branch, shared, publicMintShared, headerPageSize, claimDatabase, claimCacheKiB, claimNodes, namedNodes, headerCachePages = 8, cacheKiB = 4096 }) => {
  let db, claimDb;
  try {
    const publicMints = new PublicMintPrefetch(id, (pairs, snapshot) => {
      const control = new Int32Array(publicMintShared, 0, 2);
      Atomics.store(control, 0, 0); parentPort.postMessage({ id, requestPublicMints: pairs, snapshot });
      Atomics.wait(control, 0, 0);
      if (Atomics.load(control, 0) !== 1) throw Error('public_mint_evidence_missing');
      return JSON.parse(new TextDecoder().decode(new Uint8Array(publicMintShared, 8, Atomics.load(control, 1))));
    }, !!input.settings?.document && rules.claimsNeverCloseActive(input.settings, input.executionHeight ?? input.height));
    for (const [, row] of namedNodes ?? []) publicMints.node(row);
    for (const [, row] of claimNodes ?? []) publicMints.node(row);
    publicMints.seed(input);
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
        namedProof.add(id, row); publicMints.node(row); return row;
      };
      claimNodeGet = id => {
        const raw = staged.has(id) ? null : query.get(id), row = staged.get(id) ?? (raw ? JSON.parse(raw.value) : undefined);
        claimProof.add(id, row); publicMints.node(row);
        return row;
      };
      // A closing round checks its groups one at a time, so the main thread would
      // read one plot per round trip. Look ahead over the next groups with a
      // separate reader that records no evidence and charges no budget; hints
      // only schedule reads in pages and never supply answers.
      if (input.settings?.document) try {
        const look = new ClaimStorage({ get: id => staged.get(id) ?? (raw => raw ? JSON.parse(raw.value) : undefined)(staged.has(id) ? null : query.get(id)),
          cacheSize: input.settings.document.values.proofDepth });
        const state = look.load(input.state, { decimal: true });
        let budget = CLOSURE_LOOKAHEAD;
        for (const round of state.rounds ?? []) {
          const c = round.closing; if (!c || round.closed) continue;
          const prefix = `closure/${round.window}/`;
          // The winners phase checks every slot once more; outcomes runs right before it.
          if (['headers', 'headerPages', 'outcomes', 'winners'].includes(c.phase)) {
            for (let n = BigInt(c.phase === 'winners' ? c.slot ?? '0' : '0'), end = BigInt(c.slots ?? '0'); n < end && budget > 0 && publicMints.hints.size < CLOSURE_HINTS; n++, budget--) {
              const id = recordGet(state.claimInputs, prefix + 'slots/' + n), slot = id && recordGet(state.claimSlots, `${round.window}/${id}`);
              if (slot?.asset !== undefined && slot.block !== undefined) publicMints.hint(slot.asset, String(slot.block));
            }
            continue;
          }
          if (!['groups', 'validate', 'tickets', 'groupDone'].includes(c.phase)) continue;
          // The hint cache drops its oldest entries first; stop before the next groups' hints are evicted.
          for (let g = BigInt(c.group ?? '0'), end = BigInt(c.groups ?? '0'); g < end && budget > 0 && publicMints.hints.size < CLOSURE_HINTS; g++, budget--) {
            const key = recordGet(state.claimInputs, prefix + 'groups/' + g), group = key && recordGet(state.claimInputs, prefix + 'group/' + key);
            if (group?.claim) publicMints.plot(group.claim);
          }
        }
      } catch { /* Hints are optional; the closure reads everything it needs on demand. */ }
    }
    const publicMintGet = (asset, block, deployment) => publicMints.get(asset, block, deployment);
    const output = processObservation({ ...input, history, hashAt: h => raw(h) ? get(h).hash : null }, { claimNodeGet, namedNodeGet, publicMintGet });
    parentPort.postMessage({ id, output: claimDatabase ? { ...output, claimEvidence: claimProof.value(), namedEvidence: namedProof.value() } : output });
  } catch (e) { parentPort.postMessage({ id, error: e.message }); }
  finally { db?.close(); claimDb?.close(); }
});
