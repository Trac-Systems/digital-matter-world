import { check } from '../src/util.mjs';
import { rules } from '../src/rules.mjs';
import { KeyedWork } from '../src/keyed-work.mjs';
import { inscriptionContents } from '../src/mint-payments.mjs';

const hash = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const inscription = v => typeof v === 'string' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(v);
const count = value => {
  check(typeof value === 'number' || typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'bulk_source_count');
  const n = Number(value); check(Number.isSafeInteger(n) && n >= 0, 'bulk_source_count'); return n;
};
const absent = error => error.status === 404 || error.rpcCode === -5;
const bytes = value => Buffer.byteLength(JSON.stringify(value));

// Each installation is one independent source identity. The cache cannot be
// shared between gateway/signers, and every use remains inside a fresh fence.
export function installTapBatchReads(reads, index) {
  const source = index.indexer, contexts = new WeakSet(), cache = new Map();
  const work = new KeyedWork({ concurrency: 4, capacity: 256 });
  let cacheBytes = 0, lastStamp = null, epoch = 0;
  const limits = () => import('../../rules/src/bulk-mint.js').then(m => m.BULK_LIMITS);
  function clear() { cache.clear(); cacheBytes = 0; epoch++; }
  function remember(key, entry, cap) {
    const old = cache.get(key); if (old) cacheBytes -= old.bytes;
    entry.bytes = bytes({ base: entry.base, kinds: entry.kinds });
    cache.delete(key);
    if (entry.bytes <= cap.transactionCacheBytes) { cache.set(key, entry); cacheBytes += entry.bytes; }
    while (cache.size > cap.transactionCache || cacheBytes > cap.transactionCacheBytes) {
      const first = cache.keys().next().value; cacheBytes -= cache.get(first).bytes; cache.delete(first);
    }
  }
  function context(view) { check(view && contexts.has(view), 'bulk_snapshot_required'); return view; }
  reads.withBulkSnapshot = async (at, fn) => {
    source.onSnapshotFailure?.(clear);
    try {
      return await source.at(at, async stamp => {
        check(hash(stamp.hash), 'bulk_snapshot_stamp');
        const normalized = { height: rules.decimalV2(stamp.height), hash: stamp.hash };
        // Clear on any source tip change, including same-height branch changes.
        if (lastStamp !== rules.stableJSON(normalized)) { clear(); lastStamp = rules.stableJSON(normalized); }
        const view = Object.freeze({ stamp: Object.freeze(normalized), at: Object.freeze({ ...at, tip: normalized.height, tipHash: normalized.hash }), epoch });
        contexts.add(view);
        try { return await fn(view); } finally { contexts.delete(view); }
      });
    } catch (error) { clear(); throw error; }
  };
  async function list(path, lengthPath, cap) {
    let total;
    try { total = await source.tap(lengthPath); } catch (error) { if (absent(error)) return { rows: [], complete: false }; throw error; }
    if (total === null || total === undefined) return { rows: [], complete: false };
    total = count(total); check(total <= cap.sourcePageRows * cap.sourcePages, 'bulk_source_page_limit');
    const rows = [];
    for (let offset = 0; offset < total; offset += cap.sourcePageRows) {
      let page;
      try { page = await source.tap(`${path}?offset=${offset}&max=${cap.sourcePageRows}`); }
      catch (error) { if (absent(error)) return { rows, complete: false }; throw error; }
      if (page === null || page === undefined) return { rows, complete: false };
      check(Array.isArray(page) && page.length <= cap.sourcePageRows && bytes(page) <= cap.sourcePageBytes, 'bulk_source_page');
      check(page.length <= total - offset, 'bulk_source_length_changed');
      page.forEach((value, i) => {
        check(value && inscription(value.ins), 'bulk_source_row'); rows.push({ index: offset + i, value });
      });
      if (page.length !== Math.min(cap.sourcePageRows, total - offset)) return { rows, complete: false };
    }
    return { rows, complete: true };
  }
  async function transaction(txid, kinds, view, cap) {
    const key = `${view.stamp.hash}/${txid}`;
    return work.run(key, async () => {
      context(view);
      let entry = cache.get(key);
      if (entry && Date.now() - entry.at >= 60000) { cache.delete(key); cacheBytes -= entry.bytes; entry = null; }
      if (!entry) {
        let inclusion = null, tx;
        try {
          inclusion = await reads.included(txid + 'i0', view.at);
          tx = inclusion?.tx ?? await reads.bitcoinTransaction(txid);
        } catch (error) { if (!absent(error)) throw error; }
        if (!tx) return { txid, stamp: view.stamp, inclusion: null, inscriptions: [], transfers: [], mints: [], complete: { transfers: false, mints: false } };
        check(tx.txid === txid && typeof tx.hex === 'string' && /^(?:[0-9a-f]{2})+$/.test(tx.hex) && tx.hex.length / 2 <= cap.rawTransactionBytes, 'bulk_transaction_bytes');
        const parsed = inscriptionContents(tx.hex, { inscriptionBytes: cap.redeemBytes });
        check(parsed.txid === txid && parsed.contents.length <= cap.members, 'bulk_transaction_binding');
        if (inclusion) check(hash(inclusion.blockHash ?? inclusion.hash) && BigInt(inclusion.height) <= BigInt(view.stamp.height) && BigInt(inclusion.confirmations) > 0n, 'bulk_transaction_inclusion');
        entry = { base: { txid, stamp: view.stamp, inclusion: inclusion ? { height: rules.decimalV2(inclusion.height), hash: inclusion.blockHash ?? inclusion.hash, confirmations: count(inclusion.confirmations) } : null,
          inscriptions: parsed.contents.map((content, i) => ({ id: `${txid}i${i}`, content })) }, kinds: {}, bytes: 0, at: Date.now() };
      }
      for (const kind of kinds) if (!entry.kinds[kind]?.complete) {
        const stem = kind === 'transfers' ? 'Transferred' : 'Minted';
        const result = await list(`get${stem}List/${txid}`, `get${stem}ListLength/${txid}`, cap);
        result.rows = result.rows.map(({ index, value }) => {
          check(value.ins.slice(0, 64) === txid, 'bulk_transaction_row_binding');
          const fields = kind === 'transfers' ? ['ins', 'fail', 'int', 'addr', 'taddr', 'tick', 'amt', 'dta'] : ['ins', 'fail', 'addr', 'tick', 'amt', 'dta'];
          return { index, value: Object.fromEntries(fields.filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]])) };
        });
        entry.kinds[kind] = result;
      }
      if (entry.base.inclusion && view.epoch === epoch && lastStamp === rules.stableJSON(view.stamp)) remember(key,
        { ...entry, kinds: Object.fromEntries(Object.entries(entry.kinds).filter(([, result]) => result.complete && result.rows.length)) }, cap);
      return structuredClone({ ...entry.base, transfers: entry.kinds.transfers?.rows ?? [], mints: entry.kinds.mints?.rows ?? [],
        complete: { transfers: entry.kinds.transfers?.complete === true, mints: entry.kinds.mints?.complete === true } });
    }, { after: true });
  }
  reads.bulkTransactions = async (txids, { kinds = ['transfers', 'mints'], view } = {}) => {
    const cap = await limits();
    check(Array.isArray(txids) && txids.length <= cap.members && txids.every(hash) && new Set(txids).size === txids.length, 'bulk_transaction_ids');
    check(Array.isArray(kinds) && kinds.length > 0 && kinds.every(k => ['transfers', 'mints'].includes(k)) && new Set(kinds).size === kinds.length, 'bulk_transaction_kinds');
    if (!view) return reads.withBulkSnapshot(undefined, scoped => reads.bulkTransactions(txids, { kinds, view: scoped }));
    context(view);
    return Promise.all(txids.map(txid => transaction(txid, kinds, view, cap)));
  };
  reads.bulkMintMatches = async ({ receiver, ticker, expected, view }) => {
    const cap = await limits();
    check(typeof receiver === 'string' && receiver.length > 0 && receiver.length <= 128 && typeof ticker === 'string' && ticker.length > 0 && ticker.length <= 64 &&
      Array.isArray(expected) && expected.length > 0 && expected.length <= cap.members && new Set(expected.map(m => m.index)).size === expected.length &&
      expected.every(m => Number.isSafeInteger(m.index) && m.index >= 0 && m.index < cap.members && typeof m.block === 'string' && /^(0|[1-9][0-9]*)$/.test(m.block) &&
        typeof m.amount === 'string' && /^[1-9][0-9]*$/.test(m.amount) && typeof m.dta === 'string' && hash(m.permitHash)), 'bulk_mint_expected');
    if (!view) return reads.withBulkSnapshot(undefined, scoped => reads.bulkMintMatches({ receiver, ticker, expected, view: scoped }));
    context(view);
    // Use the durable account index only to locate candidate pages. Refresh
    // each selected 500-row page once under this outer fence; never find(max=1).
    const stream = index.stream(index.watch('mint', [receiver, ticker]));
    check(await index.canonical(stream), 'bulk_lookup_reorg');
    const pages = new Map(), matches = [];
    for (const m of expected) {
      const key = JSON.stringify(['permit', m.dta, m.amount]);
      const positions = index.db.prepare('SELECT pos FROM lookup_keys WHERE stream=? AND key=? ORDER BY pos LIMIT ?').all(stream.id, key, cap.sourcePageRows + 1);
      check(positions.length <= cap.sourcePageRows, 'bulk_source_page_limit');
      for (const { pos } of positions) {
        const start = Math.floor(pos / cap.sourcePageRows) * cap.sourcePageRows;
        if (!pages.has(start)) pages.set(start, []);
        pages.get(start).push({ m, pos });
      }
    }
    check(pages.size <= cap.sourcePages, 'bulk_source_page_limit');
    const path = `getAccountMintList/${encodeURIComponent(receiver)}/${encodeURIComponent(ticker)}`;
    for (const [offset, needed] of pages) {
      const values = await source.tap(`${path}?offset=${offset}&max=${cap.sourcePageRows}`);
      check(Array.isArray(values) && values.length <= cap.sourcePageRows && bytes(values) <= cap.sourcePageBytes, 'bulk_source_page');
      for (const { m, pos } of needed) {
        const value = values[pos - offset];
        if (value?.fail === false && value.addr === receiver && value.tick === ticker && value.amt === m.amount && value.dta === m.dta && inscription(value.ins)) matches.push({ index: m.index, inscription: value.ins, permitHash: m.permitHash });
      }
    }
    // DMT's direct winner lookup recovers even before the account cursor catches
    // up. These are candidates only: the transaction evidence is verified below.
    const missing = expected.filter(m => !matches.some(r => r.index === m.index));
    await Promise.all(missing.map(async m => {
      const value = await work.run(`winner/${view.stamp.hash}/${ticker}/${m.block}`, () => source.tap(`getDmtMintHolderByBlock/${encodeURIComponent(ticker)}/${m.block}`), { join: true });
      if (value && inscription(value.ins)) matches.push({ index: m.index, inscription: value.ins, permitHash: m.permitHash });
    }));
    const ids = [...new Set(matches.map(m => m.inscription.slice(0, 64)))];
    const transactions = await reads.bulkTransactions(ids, { kinds: ['mints'], view });
    return matches.filter(candidate => {
      const m = expected.find(m => m.index === candidate.index), tx = transactions.find(t => t.txid === candidate.inscription.slice(0, 64));
      const p = tx?.inscriptions.find(p => p.id === candidate.inscription)?.content;
      return tx?.inclusion && tx.complete.mints && p?.p === 'tap' && p.op === 'dmt-mint' && p.blk === m.block && p.dta === m.dta && p.prv?.hash === m.permitHash && p.prv.address === receiver &&
        tx.mints.some(({ value: v }) => v.ins === candidate.inscription && v.fail === false && v.addr === receiver && v.tick === ticker && v.amt === m.amount && v.dta === m.dta);
    }).sort((a, b) => a.index - b.index);
  };
  return reads;
}
