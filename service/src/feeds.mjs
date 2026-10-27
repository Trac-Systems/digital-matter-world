import { publicIdentities, encodeTracAddress } from '../../rules/src/trac-address.js';
import { collectFiles, recoverFeedVersions } from './retention.mjs';
import { rules } from './rules.mjs';
import { check, hash, heightKey } from './util.mjs';
// Refresh only the affected height page after a link, find or mint.
export async function patternPage({ store, files, history, pattern, page, size = 256 }) {
  check(Number.isSafeInteger(page) && page >= 0 && size <= 256, 'pattern_page');
  const from = page * size, to = Math.min(history.length, from + size), asset = rules.patternAsset(pattern), rows = [];
  for (let block = from; block < to; block++) {
    const count = rules.patternCount(pattern, history.get(block)); if (!count) continue;
    const find = store.get('finds', rules.findId(block, pattern.number));
    rows.push({ block, count, finder: find?.finder ?? null, findHeight: find?.findHeight ?? null, ...(find?.source ? { source: find.source } : {}),
      minted: store.get('minted', `${asset}/${block}`), link: store.get('links', heightKey(block)), found: !!find });
  }
  const body = publicIdentities({ v: 2, asset, from, to: to - 1, rows }), bytes = Buffer.from(JSON.stringify(body));
  check(bytes.length <= 60000, 'pattern_page_budget', 503);
  const publication = await files.immutable(`patterns/${asset}/${page}-${hash(bytes)}.json`, bytes);
  await files.json(`patterns/${asset}/${page}.json`, publication);
  const key = `${asset}/${page}`, previous = store.get('feedVersions', key) ?? [];
  const versions = [publication.path, ...previous.filter(p => p !== publication.path)];
  // These are replaceable views; accepted binary audits are retained forever.
  await store.transact([{ space: 'feedVersions', id: key, value: versions.slice(0, 16) },
    { space: 'feedDefinitions', id: key, value: { path: publication.path, pat: pattern.pat, fld: pattern.fld, dt: pattern.dt } }, ...versions.slice(16).map(path => ({ space: 'fileGarbage', id: path, value: true }))]);
  await collectFiles(store, files);
  let covered = store.get('feedCoverage', asset) ?? 0;
  if (page === covered) { covered++; await store.put('feedCoverage', asset, covered); }
  await files.json(`patterns/${asset}/index.json`, { asset, pages: Math.ceil(history.length / size), availableThroughPage: covered - 1, pageSize: size, template: '{page}.json', observedAt: Date.now() });
  return publication;
}
const rank = (a, b) => {
  const left = BigInt(a.matching) * BigInt(b.history), right = BigInt(b.matching) * BigInt(a.history);
  return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
};
function top(previous, incoming, compare = rank) {
  const rows = new Map(previous.map(r => [r.id, r]));
  for (const row of incoming) rows.set(row.id, row);
  return [...rows.values()].sort(compare).slice(0, 20);
}
export class Feeds {
  constructor({ store, files, history, reads, pagesPerTick = 4 }) { Object.assign(this, { store, files, history, reads, pagesPerTick }); }
  async markBlock(block, asset = null) {
    const patterns = this.store.get('meta', 'patterns') ?? [];
    const operations = patterns.filter(p => !asset || rules.patternAsset(p) === asset).map(p => ({ space: 'feedPages', id: `${rules.patternAsset(p)}/${heightKey(Math.floor(block / 256))}`, value: { pattern: p, page: Math.floor(block / 256) } }));
    if (operations.length) await this.store.transact(operations);
  }
  async markAgent(owner, assets) {
    check(/^[0-9a-f]{64}$/.test(owner) && Array.isArray(assets) && assets.length <= 100 && assets.every(rules.assetId), 'feed_agent');
    if (assets.length) await this.store.transact(assets.map(id => ({ space: 'agentAssets/' + owner, id, value: true })));
  }
  async events() {
    const patterns = this.store.get('meta', 'patterns') ?? [];
    for (const { id, value: e } of this.store.list('feedEvents', { limit: 4 })) {
      const timestamp = this.history.get(e.height).time * 1000, day = Math.floor(timestamp / 86400000), week = Math.floor((day + 3) / 7);
      const old = this.store.get('meta', 'rankings') ?? { day, week, today: [], thisWeek: [], allTime: [], compounds: [] };
      const winners = Object.entries(e.finds).map(([id, find]) => {
        const p = patterns.find(p => p.number === find.pattern);
        return { id, ...find, matching: String(p?.rarity ?? 1), history: String((p?.historyHeight ?? e.height) + 1) };
      });
      const compounds = Object.values(e.types).map(t => ({ id: t.id, firstMaker: t.firstMaker, mass: t.properties.mass, tier: t.tier }));
      const rankings = { day, week, today: top(old.day === day ? old.today : [], winners), thisWeek: top(old.week === week ? old.thisWeek : [], winners),
        allTime: top(old.allTime, winners), compounds: top(old.compounds, compounds, (a, b) => BigInt(a.mass) > BigInt(b.mass) ? -1 : BigInt(a.mass) < BigInt(b.mass) ? 1 : a.id.localeCompare(b.id)) };
      const operations = [{ space: 'meta', id: 'rankings', value: rankings }, { space: 'feedEvents', id }];
      const changed = new Set([e.tip, ...(e.links ?? []), ...winners.map(w => w.block)]);
      for (const p of patterns) for (const block of changed) operations.push({ space: 'feedPages', id: `${rules.patternAsset(p)}/${heightKey(Math.floor(block / 256))}`, value: { pattern: p, page: Math.floor(block / 256) } });
      for (const w of winners) operations.push({ space: 'agentAssets/' + w.finder, id: w.asset, value: true });
      for (const change of e.agents ?? []) for (const asset of change.assets) operations.push({ space: 'agentAssets/' + change.owner, id: asset, value: true });
      for (const discovery of e.discoveries) if (discovery.record.discoverer) {
        const owner = discovery.record.discoverer, count = (this.store.get('discoverers', owner) ?? 0) + 1;
        operations.push({ space: 'discoverers', id: owner, value: count });
        rankings.discoverers = top(rankings.discoverers ?? old.discoverers ?? [], [{ id: owner, discoveries: count }], (a, b) => b.discoveries - a.discoveries || a.id.localeCompare(b.id));
      }
      rankings.discoverers ??= old.discoverers ?? [];
      await this.store.transact(operations);
    }
    const rankings = this.store.get('meta', 'rankings');
    if (rankings) await this.files.json('records/index.json', publicIdentities({ ...rankings, discoverers: (rankings.discoverers ?? []).map(({ id, ...row }) => ({ address: encodeTracAddress(id), ...row })), observedAt: Date.now() }));
  }
  async tick() {
    if (this.running) return; this.running = true;
    try {
      if (!this.retentionReady) { await recoverFeedVersions(this.store, this.files); this.retentionReady = true; }
      await collectFiles(this.store, this.files);
      await this.events();
      const patterns = this.store.get('meta', 'patterns') ?? [];
      if (patterns.length) {
        let next = this.store.get('meta', 'feedPatternCursor') ?? 0;
        for (let i = 0; i < Math.min(this.pagesPerTick, patterns.length); i++) {
          const p = patterns[next++ % patterns.length], asset = rules.patternAsset(p), page = this.store.get('feedCoverage', asset) ?? 0;
          if (page * 256 < this.history.length) {
            await patternPage({ ...this, pattern: p, page });
          }
          await this.files.json(`patterns/${asset}/index.json`, { asset, pages: Math.ceil(this.history.length / 256), availableThroughPage: (this.store.get('feedCoverage', asset) ?? 0) - 1,
            pageSize: 256, template: '{page}.json', observedAt: Date.now() });
        }
        await this.store.put('meta', 'feedPatternCursor', next % patterns.length);
      }
      for (const { id, value } of this.store.list('feedPages', { limit: this.pagesPerTick })) {
        await patternPage({ ...this, ...value }); await this.store.transact([{ space: 'feedPages', id }]);
      }
      await this.refreshOwners();
    } finally { this.running = false; }
  }
  async refreshOwners() {
    const latest = this.store.get('meta', 'latest'); if (!latest) return;
    const rows = this.store.list('real', { limit: 40 }).map(r => r.value);
    for (const row of rows) {
      let owner = this.store.get('indexedOwners', row.inscription);
      if (this.reads.inscriptionOwner && (!owner || Date.now() - owner.observedAt >= 30000)) {
        const observed = await this.reads.inscriptionOwner(row.inscription);
        check(typeof observed?.address === 'string' && observed.address.length <= 128 && Number.isSafeInteger(observed.height), 'indexed_owner');
        owner = { ...observed, observedAt: Date.now() }; await this.store.put('indexedOwners', row.inscription, owner);
      }
    }
  }
}
