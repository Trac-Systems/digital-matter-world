import { check, sha256 } from './check.mjs';
import { nextCursor, isAsset } from './api-values.mjs';

export const MY_FINDS_READ_LIMIT = 16, FINDER_SOON_BLOCKS = 144;
const ordinal = value => (typeof value === 'string' || Number.isSafeInteger(value) && value >= 0) && /^(0|[1-9][0-9]*)$/.test(String(value));
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const COVERAGE = {
  source: 'local_journal_blocks',
  note: 'Checks saved claim/header blocks, observed winning blocks and delivered discovery witnesses. It cannot list finds from missing or reset journals, or unsaved discovery matches.',
  recovery: 'Restore the original player journal from backup. For missing history, use finds or agent_profile with a named asset, or block with collection finds, and keep the same player identity.'
};

export function findDeadline(find, counted, soonBlocks = FINDER_SOON_BLOCKS) {
  const findHeight = ordinal(find.findHeight) ? String(find.findHeight) : null;
  const finderUntil = ordinal(find.finderUntil) ? String(find.finderUntil) : null;
  if (finderUntil === null || !ordinal(counted)) return { findHeight, finderUntil, blocksLeft: null, endsSoon: null, finderExpired: null, deadlineState: 'unknown' };
  const remaining = BigInt(finderUntil) - BigInt(counted), blocksLeft = remaining > 0n ? remaining : 0n;
  const finderExpired = remaining <= 0n, endsSoon = !finderExpired && remaining <= BigInt(soonBlocks);
  return { findHeight, finderUntil, blocksLeft: String(blocksLeft), endsSoon, finderExpired,
    deadlineState: finderExpired ? 'expired' : endsSoon ? 'soon' : 'open' };
}

export async function myFinds(agent, { cursor, limit = 25, asset, soonBlocks = FINDER_SOON_BLOCKS } = {}) {
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'Invalid my_finds limit');
  check(asset === undefined || isAsset(asset) && /^p/.test(asset), 'Invalid my_finds asset');
  check(Number.isSafeInteger(soonBlocks) && soonBlocks >= 0 && soonBlocks <= 1008, 'Invalid finder deadline threshold');
  const scope = sha256('my_finds/' + agent.journal.scope + '/' + (asset ?? ''));
  let position = { scope, before: Number.MAX_SAFE_INTEGER };
  if (cursor !== undefined) {
    check(typeof cursor === 'string' && cursor.length <= 16384 && /^[\w-]+$/.test(cursor), 'Invalid my_finds cursor');
    try { position = JSON.parse(Buffer.from(cursor, 'base64url')); } catch { throw Error('Invalid my_finds cursor'); }
    check(position?.scope === scope && Number.isSafeInteger(position.before) && position.before > 0 &&
      (position.page === undefined || typeof position.page === 'string' && position.page.length <= 8192) &&
      Object.keys(position).every(k => ['scope', 'before', 'page'].includes(k)), 'Foreign or invalid my_finds cursor');
  }
  const indexed = agent.journal.indexFindBlocks(), head = await agent.trac.head();
  check(ordinal(head.counted), 'Invalid counted height');
  const counted = String(head.counted);
  const result = { finds: [], next: null, nextCursor: null, total: null, limit, counted, soonBlocks,
    reads: 0, coverage: COVERAGE, indexing: !indexed.complete, source: 'local-journal', order: 'journal_block', warnings: [] };
  const finish = next => ({ ...result, next: next ? encode(next) : null, nextCursor: next ? encode(next) : null });
  // Finish the bounded old-journal backfill before fixing the page anchor.
  // Later inserts are above that anchor and appear on the next traversal.
  if (!indexed.complete) return finish(position);
  while (result.finds.length < limit && result.reads < MY_FINDS_READ_LIMIT) {
    const block = agent.journal.findBlock(position.before);
    if (!block) return finish(null);
    let page;
    try {
      result.reads++;
      // Each block has its own index. With a named asset, the query is one
      // exact slot; otherwise the owner index avoids examining other finders.
      page = await agent.service.block(block.block, { collection: 'finds', ...(asset ? { asset } : { owner: agent.address }),
        limit: limit - result.finds.length, cursor: position.page, sort: 'asset', order: 'asc' });
      check(Array.isArray(page.finds) && page.finds.length <= limit - result.finds.length, 'Invalid my_finds page');
      const next = nextCursor(page);
      check(!next || next !== position.page, 'Repeated my_finds block cursor');
      for (const find of page.finds) {
        if (String(find.block) !== String(block.block) || ![agent.address, agent.owner].includes(find.finder) ||
          asset && find.asset !== asset || find.minted !== false) continue;
        check(isAsset(find.asset) && ordinal(find.count), 'Invalid my_finds row');
        result.finds.push({ block: String(find.block), pattern: find.pattern == null ? null : String(find.pattern),
          asset: find.asset, count: String(find.count), finder: agent.address, minted: false,
          source: find.source ?? null, window: find.window == null ? null : String(find.window), ...findDeadline(find, counted, soonBlocks) });
      }
      position = next ? { scope, before: block.position + 1, page: next } : { scope, before: block.position };
      if (next) return finish(position);
    } catch (error) {
      const stale = ['page_cursor_stale', 'claimed_cursor_stale'].includes(error.code ?? error.message);
      result.warnings.push({ block: String(block.block), code: stale ? 'block_cursor_restarted' : 'finds_unavailable' });
      // Restart only this block, never the agent-wide traversal. Keep the
      // local anchor on a failed read so an unavailable block is not skipped.
      return finish({ scope, before: block.position + 1, ...(stale ? {} : position.page ? { page: position.page } : {}) });
    }
  }
  return finish(agent.journal.findBlock(position.before) ? position : null);
}
