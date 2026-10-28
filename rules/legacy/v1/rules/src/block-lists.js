import { recordGet } from './record-index.js';
import { assert, integer, findId, hash } from './core.js';
import { analyzePattern } from './patterns.js';
import { patternAsset } from './claims.js';
import { encodeBinary, decodeBinary } from './binary.js';
// Each page covers a fixed height interval, so a new tip changes only its page.
// Rows: height delta, count, minted inscription (or null), finder (or null),
// find height (or null), permanent link height (or null), found flag.
export function* patternBlockPages({ pattern, history, finds = {}, minted = {}, links = {}, pageSize = 4096 }) {
  assert(integer(pageSize, 65536) && pageSize > 0, 'block_page_size');
  const asset = patternAsset(pattern), { counts } = analyzePattern(pattern, history);
  for (let from = 0; from < history.length; from += pageSize) {
    const to = Math.min(history.length - 1, from + pageSize - 1), rows = []; let previous = from;
    for (let block = from; block <= to; block++) {
      const count = counts[block]; if (!count) continue;
      const f = recordGet(finds, findId(block, pattern.number)), link = recordGet(links, block);
      rows.push([block - previous, count, recordGet(minted, `${asset}/${block}`) ?? null, f?.finder ?? null, f?.findHeight ?? null,
        link?.linkHeight ?? null, !!f]); previous = block;
    }
    const page = { v: 2, asset, from, to, hash: history.get(to).hash, rows }, bytes = encodeBinary(page);
    yield { from, to, count: rows.length, hash: hash(bytes), bytes };
  }
}
export function readBlockPage(bytes) {
  const page = decodeBinary(bytes, 10000000); let previous = page.from;
  assert(page.v === 2 && integer(page.from) && integer(page.to), 'block_page');
  return { ...page, rows: page.rows.map(([delta, count, minted, finder, findHeight, linkHeight, found]) => {
    previous += delta; assert(integer(delta) && previous <= page.to && integer(count) && count > 0, 'block_row');
    return { block: previous, count, minted, finder, findHeight, link: linkHeight === null ? null : { block: previous, linkHeight }, found };
  }) };
}
