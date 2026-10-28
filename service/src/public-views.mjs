import { rules } from './rules.mjs';
import { check, heightKey } from './util.mjs';
import { currentFee } from './fees.mjs';
import { publicReadIndex } from './public-index.mjs';
import { pageRows } from './paging.mjs';
import { agentSpecs, blockSpecs } from './read-specs.mjs';
import { setImmediate as yieldIO } from 'node:timers/promises';

export function readRows(store, space) {
  const db = typeof store.database === 'function' ? store.database() : store.db;
  return db.prepare('SELECT id,value FROM records WHERE space=? ORDER BY id').all(space).map(({ id, value }) => {
    const row = JSON.parse(value); return row && typeof row === 'object' ? { ...row, id: row.id ?? id } : { id, value: row };
  });
}
const ownerKey = owner => check(/^[0-9a-f]{64}$/.test(owner), 'agent_key');
const sum = (rows, get) => rows.reduce((n, row) => n + BigInt(get(row) ?? 0), 0n).toString();
const batchProvenance = batch => batch ? { batch, manifest: '/records/batches/' + batch } : null;

export class PublicViews {
  constructor({ store, history, reads, mints, network, bitcoinNetwork = reads?.bindings?.bitcoinNetwork ?? 'mainnet', claimsPerWindow = rules.CLAIM_DEFAULTS.claimsPerWindow }) { Object.assign(this, { store, history, reads, mints, network, bitcoinNetwork, claimsPerWindow }); this.readIndex = store.get('meta', 'ruleState')?.batchVersion === 2 ? null : publicReadIndex(this); }
  async indexed(url, policies, primary) {
    const path = url.pathname,
      params = new URLSearchParams(url.searchParams),
      owner = params.get('owner') ?? undefined;
    const profile = /^\/agents\/([0-9a-f]{64})$/.exec(path),
      blockSummary = /^\/blocks\/(\d+)$/.exec(path);
    const eligible =
      profile ||
      blockSummary ||
      ['/world', '/blocks', '/finds', '/events', '/feed', '/mint-rights', '/receipts', '/records/batches', '/agents'].includes(
        path,
      ) ||
      /^\/patterns\/[a-z0-9]{1,24}\/blocks$/.test(path) ||
      /^\/agents\/[0-9a-f]{64}\/(?:finds|history|mintRights)$/.test(path) ||
      /^\/blocks\/\d+\/(?:finds|mintRights|claims|draws|matches|slotList)$/.test(path);
    if (!eligible) return undefined;
    this.readIndex ??= publicReadIndex(this);
    const index = this.readIndex;
    if (this.refreshOnRead !== false) await index.available();
    else check(index.ready, 'public_index_pending', 503);
    const requestedBlock = /^\/blocks\/(\d+)(?:\/|$)/.exec(path);
    if (requestedBlock && Number(requestedBlock[1]) >= index.length && Number(requestedBlock[1]) < this.history.length)
      check(false, 'index_catching_up', 503);
    const subset = (rows, filters) => ({
      page: (q) => {
        const selectedFilters={...q.selectedFilters,...filters};
        for(const key of ['owner','block'])if(filters[key]!==undefined&&q.selectedFilters[key]!==undefined&&filters[key]!==q.selectedFilters[key]) {
          return {entries:[],meta:{total:0,next:null,limit:q.limit,sort:q.sortKey,order:q.direction,route:q.route}};
        }
        if(filters.actor&&q.selectedFilters.actor&&filters.actor!==q.selectedFilters.actor)selectedFilters.actor=[filters.actor,q.selectedFilters.actor].sort();
        return rows.page({...q,selectedFilters,sourceFilters:filters});
      },
    });
    if (profile || blockSummary) {
      const specs = profile ? agentSpecs : blockSpecs;
      const base = path,
        values = await Promise.all(
          Object.keys(specs).map(async (key) => {
            const route = base + '/' + key + (owner ? '?owner=' + owner : ''),
              url = new URL(route, 'http://local');
            url.searchParams.set('limit', params.get('limit') ?? '50');
            const value = await this.indexed(url, { ['/' + key]: { ...specs[key], route } }, '/' + key);
            return [key, value?.[key] ?? (await this.agentList(profile[1], key))];
          }),
        );
      if (profile) {
        const row = index.agents.rows.get(profile[1])?.entry.row ?? {
          address: profile[1],
          finds: 0,
          discoveries: 0,
          crafts: 0,
          mints: 0,
        };
        return {
          ...row,
          scores: { finds: row.finds, discoveries: row.discoveries, crafts: row.crafts, mints: row.mints },
          ...Object.fromEntries(values),
        };
      }
      const height = Number(blockSummary[1]);
      check(height < this.history.length, 'block_not_found', 404);
      const plot = index.plots.rows.get(String(height)).entry.row, head = index.head;
      const window = head.tip.height, collections = Object.fromEntries(values);
      return { ...plot, header: this.history.get(height), window,
        claimWindow: { window, closesAt: window + 2, drawAt: window + 2, settlesAt: window + 2,
          claimable: height <= head.counted, claimsPerWindow: this.claimsPerWindow }, ...collections,
        link: await this.reads.link(height) };
    }
    if (['/events', '/feed'].includes(path)) return { events: index.events };
    if (path === '/finds') return { finds: index.finds };
    if (path === '/receipts') return { receipts: index.receipts };
    if (path === '/records/batches') return { batches: index.batches };
    if (path === '/agents') {
      if (params.get('q')) return { agents: [...index.agents.rows.values()].map((r) => r.entry.row) };
      return { agents: index.agents };
    }
    if (['/world', '/blocks'].includes(path)) {
      const h = index.head,
        from = params.has('from') ? Number(params.get('from')) : 0,
        to = params.has('to') ? Number(params.get('to')) : Math.min(h.tip.height, this.history.length - 1);
      check(
        Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to >= from && to < this.history.length,
        'world_range',
      );
      const plots = subset(index.plots, { from, to });
      const page = pageRows(plots, params, policies[primary]);
      for (const [position, e] of page.entries.entries()) {
        e.row = { ...e.row, finds: subset(index.finds, { block: e.row.height }) };
        policies['/plots/' + position + '/finds'] = { ...blockSpecs.finds, route: '/blocks/' + e.row.height + '/finds' };
      }
      return { tip: h.tip.height, counted: h.counted, from, to, plots: { page: () => page } };
    }
    if (path.startsWith('/patterns/')) {
      const asset = path.split('/')[2];
      check(index.patternRows.has(asset), 'pattern_not_found', 404);
      return { asset, rows: index.patternRows.get(asset) };
    }
    const agent = /^\/agents\/([0-9a-f]{64})\/(\w+)$/.exec(path);
    if (agent?.[2] === 'finds') return { finds: subset(index.finds, { owner: agent[1] }) };
    if (agent?.[2] === 'history') return { history: subset(index.events, { actor: agent[1] }) };
    const block = /^\/blocks\/(\d+)\/(\w+)$/.exec(path);
    if (block) {
      const height = Number(block[1]),
        key = block[2];
      check(height < this.history.length, 'block_not_found', 404);
      if (key === 'finds') return { finds: subset(index.finds, { block: height }) };
      const round = (this.store.get('meta', 'ruleState')?.rounds ?? []).find((r) => r.window === index.head.tip.height);
      if (key === 'claims') {
        const claims = [...(index.claims.get(height) ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r),
          identities = new Set(claims.map((c) => `${c.agent}/${c.window}`));
        for (const c of round?.claims ?? [])
          if (c.block === height && !identities.has(`${c.agent}/${round.window}`))
            claims.push({ ...c, window: round.window, header: round.headerSenders.some(s => s.block === c.block && s.agent === c.agent) });
        return { claims };
      }
      if (key === 'draws')
        return { draws: [...(index.draws.get(height) ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r) };
      if (key === 'matches' || key === 'slotList') {
        const matches = this.patterns().map((p) => ({
          asset: rules.patternAsset(p),
          number: p.number,
          count: rules.patternCount(p, this.history.get(height)),
        }));
        return {
          [key]:
            key === 'matches' ? matches : (round?.slots.filter((s) => s.block === height) ?? matches.filter((m) => m.count > 0)),
        };
      }
    }
    if (path === '/mint-rights') check(owner !== undefined, 'owner_required');
    params.delete('owner');
    const rows = await index.rights(agent?.[1] ?? owner, block ? Number(block[1]) : undefined, params),
      page = pageRows(rows, params, policies[primary]);
    await Promise.all(
      page.entries.map(async (e) => {
        e.row = await rows.hydrate(e.row);
      }),
    );
    return { mintRights: { page: () => page } };
  }
  rows(space) { return readRows(this.store, space); }
  patterns() { return this.store.get('meta', 'patterns') ?? []; }
  async head() {
    if (this.reads.head) return this.reads.head();
    return { tip: { height: this.history.length - 1 }, counted: await this.reads.counted() };
  }
  async status() {
    if (this.store.get('meta', 'ruleState')?.batchVersion === 2) return this.statusV2();
    const head = await this.head(), batch = await this.reads.batchLast(), fee = currentFee(await this.reads.registry());
    const observed = this.store.get('meta', 'head'), bitcoinTip = (await this.reads.tip()).tip;
    const processedObservation = Number(this.store.get('meta', 'publicObservation') ?? 0), latest = this.store.get('meta', 'latest');
    const indexed = this.store.get('publishedObservations', heightKey(processedObservation));
    const processedBatch = Number(this.store.get('meta', 'publicBatch') ?? 0), indexedBatch = this.store.get('batches', heightKey(processedBatch));
    const latestObservation = latest?.observation ?? 0, observationLag = Math.max(0, latestObservation - processedObservation), batchLag = Math.max(0, batch.n - processedBatch);
    return { version: 1, state: 'ready', network: this.network, unit: rules.TAP_UNIT,
      units: { tap: 18, bridgedTap: 18, bitcoin: 8, ethereum: 18, matter: 0 }, tip: head.tip.height, counted: head.counted, batch, bitcoinTip,
      catchingUp: observed?.tip !== bitcoinTip || head.tip.height !== bitcoinTip || batch.to !== head.counted,
      feePolicy: { baseFee: fee.baseFee, feeSettings: fee.feeSettings ?? rules.FEE_DEFAULTS, revision: fee.id, unit: rules.TAP_UNIT }, settings: await this.reads.settings(),
      publicIndex: { processedObservation, latestObservation, observationLag, indexedHeight: indexed?.height ?? null, indexedTip: indexed?.tip ?? null,
        latestHeight: latest?.height ?? null, latestTip: latest?.tip ?? null, processedBatch, latestBatch: batch.n, batchLag,
        indexedBatchHeight: indexedBatch?.batch.to ?? null, eventSequence: this.store.get('meta', 'publicSequence') ?? 0,
        caughtUp: processedObservation === latestObservation && processedBatch === batch.n } };
  }
  async feePolicyV2(document) {
    const revision = document.values.feePolicyRevision, base = { revision, unit: rules.TAP_UNIT };
    try {
      const fee = currentFee(await this.reads.registry());
      return fee.id === revision ? { ...base, baseFee: fee.baseFee, feeSettings: fee.feeSettings ?? rules.FEE_DEFAULTS } : base;
    } catch { return base; }
  }
  async statusV2() {
    const context = await this.reads.rulesContext(), head = await this.head(), source = await this.reads.tip();
    const document = rules.validateSettingsDocument(context.settings);
    check(document.network === this.network && rules.hashObject(document) === context.settingsHash, 'settings_pin');
    const tip = rules.decimalV2(head.tip.height), counted = rules.decimalV2(head.counted), bitcoinTip = rules.decimalV2(source.tip);
    const batch = { ...context.last, n: rules.decimalV2(context.last.n), to: rules.decimalV2(context.last.to) };
    const latest = this.store.get('meta', 'latest'), projected = this.store.get('meta', 'v2PublicProgress');
    const pending = this.store.hasRows('feedEvents'), localBatch = this.store.get('meta', 'v2Last');
    return { version: 2, state: context.ready ? 'ready' : 'waiting_notary', network: this.network, unit: rules.TAP_UNIT,
      units: { tap: 18, bridgedTap: 18, bitcoin: 8, ethereum: 18, matter: 0 }, tip, counted, batch, bitcoinTip,
      catchingUp: tip !== bitcoinTip || batch.to !== counted,
      // Quotes stay authoritative; the site shows the pinned revision's current prices.
      feePolicy: await this.feePolicyV2(document),
      settings: document, settingsHash: context.settingsHash, scheduledSettings: context.scheduledSettings ?? null,
      publicIndex: { processedObservation: projected?.observation ?? null, latestObservation: latest ? rules.decimalV2(latest.observation) : null,
        processedBatch: projected?.batch ?? null, latestBatch: batch.n, pendingEvents: String(pending),
        eventSequence: rules.decimalV2(this.store.get('meta', 'publicSequence') ?? '0'),
        caughtUp: !pending && !!localBatch && rules.decimalV2(localBatch.n) === batch.n } };
  }
  finds() { return this.rows('finds').map(f => ({ ...f, minted: !!this.store.get('minted', `${f.asset}/${f.block}`),
    provenance: batchProvenance(this.store.get('findProvenance', f.id)) })); }
  receipts() { return this.rows('receiptObservations').map(r => ({ id: r.id, height: Number(r.id.split('/')[0]), seal: r.seal, archive: r.archive })); }
  events() { return this.rows('publicEvents'); }
  batches() { return this.rows('batches').map(r => ({ n: r.batch.n, from: r.batch.from, to: r.batch.to, root: r.batch.root, manifest: '/records/batches/' + r.batch.n })); }
  batch(n) { const row = this.store.get('batches', heightKey(n)); check(row, 'batch_not_found', 404); return row; }
  plots(from = 0, to = this.history.length - 1, counted = this.history.length - 1) {
    check(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to >= from && to < this.history.length, 'world_range');
    const finds = new Map(), rounds = this.store.get('meta', 'ruleState')?.rounds ?? [];
    for (const f of this.finds()) { if (!finds.has(f.block)) finds.set(f.block, []); finds.get(f.block).push(f); }
    const minted = new Set(this.rows('minted').map(r => Number(r.id.split('/').at(-1))));
    return Array.from({ length: to - from + 1 }, (_, i) => {
      const height = from + i;
      return { height, ...rules.plotRegion(height), hash: this.history.hashAt(height), claimable: height <= counted, found: !!finds.get(height)?.length,
        linked: !!this.store.get('links', heightKey(height)), minted: minted.has(height), finds: finds.get(height) ?? [] };
    });
  }
  async world(from, to) {
    const h = await this.head();
    from ??= 0; to ??= Math.min(h.tip.height, this.history.length - 1);
    return { tip: h.tip.height, counted: h.counted, from, to, plots: this.plots(from, to, h.counted) };
  }
  async worldMap(from, to) {
    const index = this.readIndex;
    if (this.refreshOnRead !== false) await index.available();
    else check(index.ready, 'public_index_pending', 503);
    const tip = index.head.tip.height;
    to ??= Math.min(tip, this.history.length - 1);
    from ??= Math.max(0, to - 40000);
    check(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to >= from && to <= tip && to < this.history.length && to - from <= 40000, 'world_range');
    check(to < index.length, 'index_catching_up', 503);
    // The canvas needs only marks. Plain plots and their region/halving are
    // deterministic; do not hydrate 40,001 hashes or paginate them over HTTP.
    // This bounded range reads the same committed projection as /world.
    const marks = [];
    for (const row of index.db.prepare('SELECT * FROM publicReadPlots WHERE height>=? AND height<=? AND (found OR linked OR minted) ORDER BY height').all(from, to)) {
      const page = row.found ? pageRows(index.finds, new URLSearchParams({ block: String(row.height), limit: '200' }), { ...blockSpecs.finds, route: '/blocks/' + row.height + '/finds' }) : null;
      const finds = page?.entries.map(e => e.row) ?? [];
      marks.push({ height: row.height, found: !!row.found, linked: !!row.linked, minted: !!row.minted,
        finds: finds.slice(0, 2).map(f => ({ asset: f.asset ?? f.pattern, minted: !!(f.minted || f.inscription) })),
        findCount: finds.length, findMinted: finds.some(f => f.minted || f.inscription) });
    }
    return { tip, counted: index.head.counted, from, to, marks };
  }
  async catalog() {
    const registered = await this.reads.registry(), supply = await this.reads.assetSupply();
    const names = new Map(this.patterns().map(p => [rules.patternAsset(p), p.name]));
    const totals = new Map();
    for await (const row of this.catalogRows('mints')) {
      if (row.state !== 'minted') continue;
      const total = totals.get(row.request.asset) ?? { minted: 0, madeReal: 0n };
      total.minted++; total.madeReal += BigInt(row.request.amount ?? 0);
      totals.set(row.request.asset, total);
    }
    const mapping = asset => { const entry = registered.assets[asset], job = this.store.get('provisioning', asset); return { displayLabel: entry?.displayLabel ?? names.get(asset) ?? asset, actualTicker: entry?.tick ?? null, deploymentId: entry?.id ?? null, generation: entry?.generation ?? null, jobState: job?.state ?? (entry ? 'registered' : 'queued') }; };
    const stats = asset => ({ ...mapping(asset), supply: supply[asset] ?? '0', minted: totals.get(asset)?.minted ?? 0,
      madeReal: (totals.get(asset)?.madeReal ?? 0n).toString() });
    const compounds = [];
    for await (const { amount, ...c } of this.catalogRows('types')) compounds.push({ ...c, name: `${c.recipe === 'resonance' ? 'Resonance' : 'Fusion'}: ${c.inputs.map(([asset, amount]) => `${amount} ${names.get(asset) ?? ('Compound ' + asset.slice(0, 8))}`).join(' + ')}`,
      tier: c.tier ?? null, token: registered.assets[c.id]?.tick ?? null, ...stats(c.id) });
    return { patterns: this.patterns().map(p => ({ ...p, asset: rules.patternAsset(p), ...stats(rules.patternAsset(p)) })), compounds };
  }
  async *catalogRows(space) {
    const db = typeof this.store.database === 'function' ? this.store.database() : this.store.db;
    const query = db.prepare('SELECT id,value FROM records WHERE space=? AND id>? ORDER BY id LIMIT 128');
    let after = '';
    for (;;) {
      const page = query.all(space, after);
      for (const { id, value } of page) { const row = JSON.parse(value); yield { ...row, id: row.id ?? id }; }
      if (page.length < 128) return;
      after = page.at(-1).id;
      await yieldIO();
    }
  }
  async patternBlocks(asset) {
    const pattern = this.patterns().find(p => rules.patternAsset(p) === asset); check(pattern, 'pattern_not_found', 404);
    const rows = [];
    for (let block = 0; block < this.history.length; block++) {
      const count = rules.patternCount(pattern, this.history.get(block)); if (!count) continue;
      const find = this.store.get('finds', rules.findId(block, pattern.number));
      rows.push({ block, count, finder: find?.finder ?? null, findHeight: find?.findHeight ?? null, ...(find?.source ? { source: find.source } : {}), found: !!find,
        minted: this.store.get('minted', `${asset}/${block}`), link: this.store.get('links', heightKey(block)) });
    }
    return { asset, rows };
  }
  async rights(owner, onlyBlock) {
    if (owner !== undefined) ownerKey(owner);
    const h = await this.head(), registry = await this.reads.registry(), out = [], balances = new Map(), links = new Map(), holders = new Map();
    const balance = async asset => {
      if (!balances.has(asset)) balances.set(asset, await this.reads.balance(owner, asset));
      return balances.get(asset);
    };
    const blocks = onlyBlock === undefined ? [...new Set(this.rows('finds').map(r => r.block))] : [onlyBlock];
    for (const block of blocks) {
      for (const pattern of this.patterns()) {
        const count = rules.patternCount(pattern, this.history.get(block)); if (!count) continue;
        const asset = rules.patternAsset(pattern), found = this.store.get('finds', rules.findId(block, pattern.number));
        const find = found; if (!find?.finder) continue;
        if (find.findHeight !== null && find.findHeight > h.counted) continue;
        // Accepted batches maintain the link index. Only linked blocks need a
        // live ownership read; scanning unlinked slots makes no RPCs.
        if (!links.has(block)) links.set(block, this.store.get('links', heightKey(block)) ? await this.reads.link(block) : null);
        const link = links.get(block);
        if (link && !holders.has(block)) holders.set(block, await this.reads.bitmap(block).then(b => b.agent).catch(() => null));
        const currentHolder = holders.get(block) ?? null;
        const right = rules.mintRight({ find, owner: owner ?? find.finder ?? currentHolder ?? '0'.repeat(64), counted: h.counted, link, currentHolder });
        const minted = this.store.get('minted', `${asset}/${block}`), hold = this.store.get('holds', `${asset}/${block}`) ?? this.store.get('replay/mints/holds', `${asset}/${block}`);
        const pending = hold && (hold.expiry >= h.counted || hold.safeToReplace === false) ? { id: hold.id, expiry: hold.expiry } : null;
        const unavailable = right.role === 'bitmap' && !currentHolder;
        const enough = owner === undefined || BigInt(await balance(asset)) >= BigInt(find.count);
        const rightAllowed = owner === undefined ? !unavailable : right.allowed;
        const deploymentRegistered = !!registry.assets[asset];
        out.push({ asset, block, amount: String(find.count), deploymentRegistered, allowed: deploymentRegistered && rightAllowed && !minted && !pending && enough,
          rightAllowed, whoMayMint: right.role, reason: minted ? 'minted' : pending ? 'pending' : !deploymentRegistered ? 'asset_unregistered' : unavailable ? 'holder_unavailable' : !enough ? 'insufficient_balance' : right.role,
          finderUntil: find.findHeight === null ? null : find.findHeight + 1008, finder: find.finder, currentHolder, link, minted, pending,
          ...(owner === undefined ? {} : { balance: await balance(asset) }), found: true, void: false, time: this.history.get(block).time, find });
      }
    }
    if (onlyBlock === undefined && owner) for (const c of this.rows('types')) {
      const amount = await balance(c.id), deploymentRegistered = !!registry.assets[c.id];
      out.push({ asset: c.id, block: null, amount, balance: amount, deploymentRegistered, allowed: deploymentRegistered && BigInt(amount) > 0n, rightAllowed: true, whoMayMint: 'holder',
        reason: !deploymentRegistered ? 'asset_unregistered' : BigInt(amount) > 0n ? 'holder' : 'insufficient_balance', finderUntil: null, finder: null, currentHolder: null, link: null, minted: null, pending: null, compound: true });
    }
    return out;
  }
  async block(height, owner) {
    check(Number.isSafeInteger(height) && height >= 0 && height < this.history.length, 'block_not_found', 404);
    const plot = this.plots(height, height)[0], head = await this.head(), rounds = this.store.get('meta', 'ruleState')?.rounds ?? [];
    const round = rounds.find(r => r.window === head.tip.height);
    const claims = this.rows('publicClaims').filter(c => c.block === height), identities = new Set(claims.map(c => `${c.agent}/${c.window}`));
    for (const r of rounds) for (const c of r.claims) if (c.block === height && !identities.has(`${c.agent}/${r.window}`))
      claims.push({ ...c, window: r.window, header: r.headerSenders.some(s => s.block === c.block && s.agent === c.agent) });
    const draws = this.rows('publicDraws').filter(d => d.block === height), matches = this.patterns().map(p => ({ asset: rules.patternAsset(p), number: p.number, count: rules.patternCount(p, this.history.get(height)) }));
    const window = head.tip.height;
    return { ...plot, header: this.history.get(height), window,
      claimWindow: { window, closesAt: window + 2, drawAt: window + 2, settlesAt: window + 2, claimable: height <= head.counted, claimsPerWindow: this.claimsPerWindow }, claims, draws,
      slotList: round?.slots.filter(s => s.block === height) ?? matches.filter(m => m.count > 0), matches,
      link: await this.reads.link(height), mintRights: await this.rights(owner, height) };
  }
  agents() {
    const agents = new Map(), get = address => {
      if (!address || !/^[0-9a-f]{64}$/.test(address)) return null;
      if (!agents.has(address)) agents.set(address, { address, finds: 0, discoveries: 0, crafts: 0, mints: 0 });
      return agents.get(address);
    };
    for (const f of this.finds()) { const a = get(f.finder); if (a) a.finds++; }
    for (const p of this.patterns()) { const a = get(p.discoverer); if (a) a.discoveries++; }
    for (const m of this.rows('mints')) { const a = get(m.request.owner); if (a && m.state === 'minted') a.mints++; }
    for (const e of this.events()) { const d = e.data, a = get(d.agent ?? d.owner ?? d.from ?? d.actor); if (a && e.type === 'craft') a.crafts++; if (e.type === 'transfer') get(d.to); }
    for (const c of this.store.get('meta', 'ruleState')?.discoveryCommits ?? []) get(c.agent);
    return [...agents.values()];
  }
  async agentList(owner, key) {
    ownerKey(owner);
    if (key === 'bitmaps') return this.reads.bitmaps(owner);
    if (key === 'balances') {
      const assets = [...this.patterns().map(rules.patternAsset), ...this.rows('types').map(c => c.id)];
      return Promise.all(assets.map(async asset => ({ asset, amount: await this.reads.balance(owner, asset) })));
    }
    if (key === 'mintRights') return this.rights(owner);
    if (key === 'finds') return this.finds().filter(f => f.finder === owner);
    if (key === 'history') return this.events().filter(e => [e.data?.actor, e.data?.agent, e.data?.owner, e.data?.finder, e.data?.from, e.data?.to].includes(owner));
    if (key === 'discoveries') {
      const state = this.store.get('meta', 'ruleState') ?? {};
      return [...this.patterns().filter(p => p.discoverer === owner).map(p => ({ ...p, asset: rules.patternAsset(p), state: 'accepted' })),
        ...(state.discoveryQueue ?? []).filter(c => c.agent === owner).map(c => ({ ...c.proposal, state: 'revealed', opensAt: c.tip + 2 })),
        ...(state.discoveryCommits ?? []).filter(c => c.agent === owner).map(c => ({ state: 'sealed', exists: true, opensAt: c.tip + 2 }))];
    }
    check(false, 'collection_not_found', 404);
  }
  async profile(owner) {
    ownerKey(owner); const output = { ...(this.agents().find(a => a.address === owner) ?? { address: owner, finds: 0, discoveries: 0, crafts: 0, mints: 0 }) };
    output.scores = { finds: output.finds, discoveries: output.discoveries, crafts: output.crafts, mints: output.mints };
    for (const key of ['balances', 'bitmaps', 'finds', 'discoveries', 'history', 'mintRights']) output[key] = await this.agentList(owner, key);
    return output;
  }
  async resultList(kind) {
    if (kind === 'mints') return this.rows('mints').map(r => ({ ...this.mints.public(r.id), asset: r.request.asset, block: r.request.block, amount: r.request.amount, kind: r.kind, owner: r.request.owner }));
    if (kind === 'ethereum') return Promise.all(this.rows('mints').filter(r => r.kind === 'ethereum' && (r.payment?.split || r.payment?.depositFinal)).map(async r => ({ id: r.id, ...await (this.reads.publicEscrow ?? this.reads.escrowDeposit)(r.payer, r.id) })));
    if (kind === 'payments') {
      const direct = new Map();
      for (const row of this.rows('mints').filter(r => r.kind === 'tap')) for (const item of row.payment?.receipts ?? []) {
        if (!item.accepted) continue;
        const value = { id: item.key, requestId: item.origin ?? row.id, reference: item.reference ?? null, payer: row.payer,
          role: item.role, to: item.to, ticker: item.ticker, amount: item.amount, total: item.amount, tt: item.tt,
          confirmations: item.confirmations, final: item.confirmations >= (row.payment.requiredConfirmations ?? 1), action: 'paid' };
        // The same receipt can appear in its original request and a credit user.
        if (!direct.has(item.key) || direct.get(item.key).confirmations < value.confirmations) direct.set(item.key, value);
      }
      const ids = new Set([...this.rows('linkRequests').map(r => r.paymentId)].filter(Boolean));
      const rows = await Promise.all([...ids].map(async id => ({ id, consumed: await this.reads.tap('getLockConsume/' + id) })));
      return [...direct.values(), ...rows.filter(r => r.consumed)];
    }
    if (kind === 'payouts') return this.rows('payoutTotals').map(r => ({ ...r, owed: (BigInt(r.accrued) - BigInt(r.paid)).toString() }));
    if (kind === 'owed') return this.rows('commissionOwed');
    if (kind === 'paid') return this.rows('payoutPaid');
    if (kind === 'links') return Promise.all(this.rows('links').map(async link => {
      const holder = await this.reads.bitmap(link.block).catch(() => null);
      return { ...link, owner: holder?.agent ?? null, address: holder?.address ?? null, holderUnavailable: !holder };
    }));
    check(false, 'collection_not_found', 404);
  }
  async results() {
    const result = { unit: rules.TAP_UNIT };
    for (const key of ['mints', 'payments', 'ethereum', 'payouts', 'owed', 'paid', 'links']) result[key] = await this.resultList(key);
    const totals = await this.reads.publicTreasury();
    return { ...result, treasury: totals.treasury, outstandingSupply: totals.outstandingSupply, burn: {
      tap: (BigInt(sum(result.payments.filter(r => r.final && r.role === 'burn' && r.to === rules.tapBurnAddress(this.bitcoinNetwork)), r => r.amount)) +
        BigInt(sum(result.payments.filter(r => r.consumed?.action === 'claim').flatMap(r => r.consumed.al ?? []).filter(a => a.tt === 'b'), r => r.amt))).toString(),
      ethereum: sum(result.ethereum.filter(r => r.deposit.status === 2), r => r.deposit.split?.burnAmount) } };
  }
}
