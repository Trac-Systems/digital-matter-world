import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { readIndexSchema, ReadState, persistedRows, PlotRows, PatternRows } from './read-index-storage.mjs';
import { rules } from './rules.mjs';
import { check, hash, heightKey } from './util.mjs';
import { IndexedRows, PageTree, compare, pageCursor } from './paging.mjs';
import { collectionSpecs, eventSpec, agentSpecs } from './read-specs.mjs';

// This disposable index is rebuilt from accepted publications and the public
// Trac transaction log. Its cursor never substitutes for a consensus proof.
export class PublicIndex {
  constructor({ store, files, history, reads }) { Object.assign(this, { store, files, history, reads }); }
  async tick({ limit = 32 } = {}) {
    if (this.running) return;
    this.running = true;
    try {
      for (const { id, value: accepted } of this.store.list('batches', { after: this.store.get('meta', 'publicBatch') ?? '', limit })) {
        await this.store.transact([...accepted.publications.map((p, index) => ({ space: 'publicProvenance', id: heightKey(p.observation),
          value: { batch: accepted.batch.n, root: accepted.batch.root, index, count: accepted.publications.length, manifest: '/records/batches/' + accepted.batch.n } })),
        { space: 'meta', id: 'publicBatch', value: id }]);
      }
      for (const { id, value: publication } of this.store.list('publishedObservations', { after: this.store.get('meta', 'publicObservation') ?? '', limit })) {
        const bytes = await readFile(this.files.path(publication.audit.path.slice(1)));
        check(hash(bytes) === publication.audit.hash, 'public_audit_hash', 503);
        const file = rules.decodeBinary(bytes), operations = [];
        let sequence = this.store.get('meta', 'publicSequence') ?? 0;
        const provenance = { ...this.store.get('publicProvenance', id), audit: publication.audit, observation: file.observation, height: file.height };
        const branch = file.tipHash && this.history.view ? this.history.view(file.tip, file.tipHash) : this.history;
        // The counted clock may be ahead of this audit's observed branch tip.
        const at = branch.get(Math.min(file.height, file.tip)).time * 1000;
        const event = (type, data, key) => {
          const identity = `${id}/${type}/${key}`, eventId = hash(identity);
          if (this.store.get('publicEventKeys', eventId)) return;
          sequence++;
          operations.push({ space: 'publicEvents', id: heightKey(sequence), value: { id: eventId, sequence, at, type, data, provenance } },
            { space: 'publicEventKeys', id: eventId, value: sequence });
        };
        event('block', { height: file.height, tip: file.tip, windows: (file.settlements ?? []).map(s => s.window) }, 'block');
        for (const entry of file.moves ?? []) {
          const move = entry.move, moveId = rules.moveId(move);
          if (move.t === 'claim') for (const plot of move.p.plots) {
            const claim = { id: moveId + '/' + plot.block, agent: move.a, window: move.p.window, ...plot,
              header: move.p.header?.height === plot.block, receipt: file.receipts.find(r => r.move === moveId) ?? null, reason: entry.reason, provenance };
            operations.push({ space: 'publicClaims', id: claim.id, value: claim }); event('claim', claim, claim.id);
          }
          if (move.t === 'discovery-reveal') {
            const commitment = rules.discoveryCommitment(move.p.proposal, move.p.salt, move.a);
            operations.push({ space: 'publicDiscoveryOwners', id: commitment, value: move.a });
            event('discovery', { agent: move.a, commitment, state: entry.reason === 'accepted' ? 'revealed' : 'rejected', ...move.p.proposal, reason: entry.reason }, moveId);
          }
        }
        for (const settlement of file.settlements ?? []) {
          const blocks = new Set([...settlement.winners.map(w => w.block), ...(settlement.claims ?? []).map(c => c.block)]);
          for (const block of blocks) operations.push({ space: 'publicDraws', id: `${heightKey(block)}/${id}/${settlement.window}`, value: {
            ...settlement, block, settledAt: file.height, claims: (settlement.claims ?? []).filter(c => c.block === block),
            winners: settlement.winners.filter(w => w.block === block), provenance } });
          for (const winner of settlement.winners) event(winner.source === 'header' ? 'header_find' : 'find',
            { ...winner, finder: winner.winner, findHeight: file.height, window: settlement.window }, winner.id);
        }
        for (const { record } of file.discoveries ?? []) event('discovery', { ...record, asset: rules.patternAsset(record), agent: record.discoverer, state: 'accepted' }, rules.patternAsset(record));
        for (const rejected of file.discovery?.rejected ?? []) {
          const agent = operations.find(op => op.space === 'publicDiscoveryOwners' && op.id === rejected.commitment)?.value ?? this.store.get('publicDiscoveryOwners', rejected.commitment);
          event('discovery', { ...rejected, agent: agent ?? null, state: 'rejected' }, 'rejected/' + rejected.commitment);
        }
        const crafters = (file.ops ?? []).filter(o => o.op === 'xc');
        for (let i = 0; i < (file.crafts ?? []).length; i++) event('craft', { ...file.crafts[i], owner: crafters[i]?.request.owner ?? file.crafts[i].firstMaker }, i);
        for (let i = 0; i < (file.mintOperations ?? []).length; i++) {
          const input = file.mintOperations[i];
          if (file.mintOutcomes[i]?.reason !== 'accepted' || !['rq', 'mc'].includes(input.op)) continue;
          const r = input.request, requestId = rules.pendingId(file.receiptRoot.network, r);
          event(input.op === 'rq' ? 'mint_request' : 'mint_permit', { id: requestId, owner: r.owner, asset: r.asset, amount: r.amount,
            ...(r.block === undefined ? {} : { block: r.block }), ...(input.op === 'mc' ? { permitHash: input.evidence.authorization.permit.hash } : {}) }, requestId);
        }
        for (let i = 0; i < (file.linkOperations ?? []).length; i++) if (file.linkOutcomes[i]?.reason === 'accepted') {
          const r = file.linkOperations[i].request; event('link', { block: r.height, owner: r.owner, linkHeight: file.height }, r.height);
        }
        operations.push({ space: 'meta', id: 'publicSequence', value: sequence }, { space: 'meta', id: 'publicObservation', value: id });
        await this.store.transact(operations);
      }
      if (this.reads.publicTransactions) {
        const after = this.store.get('meta', 'publicTransaction') ?? 0;
        const page = await this.reads.publicTransactions(after, limit);
        const operations = []; let sequence = this.store.get('meta', 'publicSequence') ?? 0, height, at;
        for (const r of page.rows) {
          if (r.err !== null || r.val?.type !== 'tf') continue;
          check(rules.assetPairs(r.val.value.assets), 'public_transfer_assets', 503);
          const id = hash('transfer/' + r.tx);
          if (this.store.get('publicEventKeys', id)) continue;
          // Empty/non-transfer pages can advance while header fill catches up.
          // Only a new transfer needs a verified timestamp from that history.
          if (height === undefined) { height = await this.reads.counted(); at = this.history.get(height).time * 1000; }
          sequence++;
          operations.push({ space: 'publicEvents', id: heightKey(sequence), value: { id, sequence, at, type: 'transfer',
            data: { from: r.ipk, to: r.val.value.to, assets: r.val.value.assets, tx: r.tx }, provenance: { transaction: r.tx, index: r.index, height, timeSource: 'indexed_counted_block' } } },
          { space: 'publicEventKeys', id, value: sequence });
        }
        if (page.next !== after || operations.length) await this.store.transact([...operations,
          { space: 'meta', id: 'publicSequence', value: sequence }, { space: 'meta', id: 'publicTransaction', value: page.next }]);
      }
      await readIndexes.get(this.store)?.sync();
    } finally { this.running = false; }
  }
}

// Persisted projections and invalidations survive restarts and journal replay.
// They are never consensus evidence and may only describe accepted local data.
const readIndexes = new WeakMap();
export function publicReadIndex(views) {
  let index = readIndexes.get(views.store);
  if (!index) {
    index = new PublicReadIndex(views);
    readIndexes.set(views.store, index);
  }
  return index;
}

class PublicReadIndex {
  constructor(views) {
    this.views = views;
    this.store = views.store;
    this.db = typeof this.store.database === 'function' ? this.store.database() : this.store.db;
    readIndexSchema(this.db);
    this.state = new ReadState(this.db);
    this.restore();
  }
  restore() {
    this.receipts = persistedRows(this.db, 'receipts', collectionSpecs.receipts, { range: 'height' });
    this.batches = persistedRows(this.db, 'batches', { keys: ['n', 'from', 'to'] });
    this.agents = persistedRows(this.db, 'agents', collectionSpecs.agents, { facets: ['address'] });
    this.scores = new Map(this.state.rows('scores'));
    this.contributions = new Map(this.state.rows('contributions'));
    this.eventIds = new Map(this.state.rows('eventIds'));
    this.claims = new Map();
    this.draws = new Map();
    this.recordBlocks = new Map();
    this.events = persistedRows(this.db, 'events', eventSpec, {
      facets: ['type', 'actor', 'category'],
      emptyMatchesAll: true,
      range: 'sequence',
      queryValue: (key,value) => key==='actor'?JSON.stringify(Array.isArray(value)?value:[value]):String(value),
      values: (row,key) => {
        if(key==='actor') {
          const actors=[...new Set([row.data?.actor,row.data?.agent,row.data?.owner,row.data?.finder,row.data?.from,row.data?.to].filter(Boolean))].sort();
          return [...actors.map(a=>JSON.stringify([a])),...actors.flatMap((a,i)=>actors.slice(i+1).map(b=>JSON.stringify([a,b])))];
        }
        return [key==='category'?(['mint_request','mint_permit','transfer','link'].includes(row.type)?'money':'chain'):row[key]];
      },
    });
    this.finds = persistedRows(this.db, 'finds', collectionSpecs.finds, {
      facets: ['owner', 'asset', 'minted'],
      range: 'block',
      values: (r, k) => [k === 'owner' ? r.finder : k === 'minted' ? !!r.minted : r[k]],
    });
    this.plots = new PlotRows(this);
    this.patternRows = new Map();
    this.rightGroups = new Map();
    this.blockRights = new Map();
    this.deadlines = new PageTree('height');
    this.scheduled = new Map();
    this.active = new Set();
    const cursor = this.state.get('meta', 'cursor');
    this.length = cursor?.length ?? 0;
    this.counted = cursor?.counted ?? -1;
    this.head = cursor?.head;
    this.patternStamp = cursor?.patternStamp;
    this.ready = !!cursor;
    for (const p of JSON.parse(this.patternStamp ?? '[]')) this.patternRows.set(rules.patternAsset(p), new PatternRows(this, rules.patternAsset(p)));
    for (const [id, row] of this.state.rows('claims')) this.record('publicClaims', id, row, false);
    for (const [id, row] of this.state.rows('draws')) this.record('publicDraws', id, row, false);
    for (const [block, saved] of this.state.rows('rights')) this.installRights(Number(block), saved.rows, saved.scheduled);
  }
  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.refresh();
    try { await this.syncing; }
    finally { this.syncing = null; }
  }
  async available() {
    // A slow upstream head or an incremental backfill must not hold HTTP open.
    if (this.syncing && this.ready) return;
    const work = this.sync();
    let timer;
    try {
      await Promise.race([work.catch(error => { if (!this.ready) throw error; }), new Promise(resolve => { timer = setTimeout(resolve, 25); })]);
    } catch (error) {
      if (!this.ready) throw Object.assign(Error('index_catching_up'), { status: 503, cause: error });
    } finally { clearTimeout(timer); }
    check(this.ready, 'index_catching_up', 503);
  }
  patternComplete(asset) { return (this.state.get('coverage', asset) ?? 0) >= this.length; }
  header(height) {
    const cached = this.db.prepare('SELECT value FROM publicReadHeaderFields WHERE height=?').get(height);
    if (cached) return JSON.parse(cached.value);
    const { time, nonce, bits, hash } = this.views.history.get(height);
    const header = { height, time, nonce, bits, hash };
    this.db.prepare('INSERT INTO publicReadHeaderFields VALUES(?,?) ON CONFLICT(height) DO UPDATE SET value=excluded.value').run(height, JSON.stringify(header));
    return header;
  }
  score(id, contributions) {
    const changed = new Set(),
      valid = (address) => /^[0-9a-f]{64}$/.test(address ?? '');
    for (const [address, key] of this.contributions.get(id) ?? []) {
      const score = this.scores.get(address);
      score.refs--;
      if (key) score[key]--;
      changed.add(address);
    }
    contributions = contributions.filter(([address]) => valid(address));
    for (const [address, key] of contributions) {
      if (!this.scores.has(address))
        this.scores.set(address, { address, finds: 0, discoveries: 0, crafts: 0, mints: 0, refs: 0 });
      const score = this.scores.get(address);
      score.refs++;
      if (key) score[key]++;
      changed.add(address);
    }
    if (contributions.length) this.contributions.set(id, contributions);
    else this.contributions.delete(id);
    this.state.set('contributions', id, contributions.length ? contributions : undefined);
    for (const address of changed) {
      const { refs, ...row } = this.scores.get(address);
      this.state.set('scores', address, refs ? this.scores.get(address) : undefined);
      if (refs) this.agents.set(address, row);
      else {
        this.scores.delete(address);
        this.agents.delete(address);
      }
    }
  }
  event(id) {
    const old = this.eventIds.get(id);
    if (old) this.events.delete(old);
    const row = this.store.get('publicEvents', id);
    if (!row) {
      this.eventIds.delete(id);
      this.state.set('eventIds', id, undefined);
      this.score('event/' + id, []);
      return;
    }
    row.id ??= id;
    this.eventIds.set(id, row.id);
    this.state.set('eventIds', id, row.id);
    this.events.set(row.id, row, row.sequence);
    const d = row.data ?? {};
    this.score('event/' + id, [
      [d.agent ?? d.owner ?? d.from ?? d.actor, row.type === 'craft' ? 'crafts' : null],
      ...(row.type === 'transfer' ? [[d.to, null]] : []),
    ]);
  }
  record(space, id, row = this.store.get(space, id), persist = true) {
    if (space === 'mints') {
      this.score('mint/' + id, row ? [[row.request.owner, row.state === 'minted' ? 'mints' : null]] : []);
      return;
    }
    if (space === 'receiptObservations') {
      if (row) this.receipts.set(id, { id, height: Number(id.split('/')[0]), seal: row.seal, archive: row.archive });
      else this.receipts.delete(id);
      return;
    }
    if (space === 'batches') {
      if (row)
        this.batches.set(id, {
          n: row.batch.n,
          from: row.batch.from,
          to: row.batch.to,
          root: row.batch.root,
          manifest: '/records/batches/' + row.batch.n,
        });
      else this.batches.delete(id);
      return;
    }
    if (space === 'publicClaims' || space === 'publicDraws') {
      const target = space === 'publicClaims' ? this.claims : this.draws;
      if (persist) this.state.set(space === 'publicClaims' ? 'claims' : 'draws', id, row ?? undefined);
      const identity = space + '/' + id,
        oldBlock = this.recordBlocks.get(identity);
      if (oldBlock !== undefined) {
        const rows = target.get(oldBlock);
        rows?.delete(id);
        if (!rows?.size) target.delete(oldBlock);
        this.recordBlocks.delete(identity);
      }
      if (row) {
        this.recordBlocks.set(identity, row.block);
        if (!target.has(row.block)) target.set(row.block, new Map());
        target.get(row.block).set(id, { ...row, id: row.id ?? id });
      }
    }
  }
  find(id) {
    const f = this.store.get('finds', id);
    this.score('find/' + id, f ? [[f.finder, 'finds']] : []);
    if (!f) {
      this.finds.delete(id);
      return;
    }
    this.finds.set(id, {
      ...f,
      id: f.id ?? id,
      minted: !!this.store.get('minted', `${f.asset}/${f.block}`),
      provenance: this.store.get('findProvenance', id)
        ? { batch: this.store.get('findProvenance', id), manifest: '/records/batches/' + this.store.get('findProvenance', id) }
        : null,
    });
  }
  plot(height) {
    if (height < 0 || height >= this.views.history.length) { this.plots.delete(String(height)); return; }
    const patterns = this.views.patterns();
    this.plots.set(String(height), {
      found: patterns.some(p => !!this.store.get('finds', rules.findId(height, p.number))),
      linked: !!this.store.get('links', heightKey(height)),
      minted: patterns.some(p => !!this.store.get('minted', `${rules.patternAsset(p)}/${height}`)),
    });
  }
  patternBlock(height, patterns = this.views.patterns()) {
    if (!patterns.length) return;
    const header = height < this.views.history.length ? this.header(height) : null;
    for (const pattern of patterns) {
      const asset = rules.patternAsset(pattern);
      let index = this.patternRows.get(asset);
      if (!index) {
        index = new PatternRows(this, asset);
        this.patternRows.set(asset, index);
      }
      const count = header ? rules.patternCount(pattern, header) : 0;
      if (!count) {
        index.delete(String(height));
        continue;
      }
      index.set(String(height), this.patternRow(pattern, height, count));
    }
  }
  patternRow(pattern, height, count) {
    const find = this.store.get('finds', rules.findId(height, pattern.number));
    return { block: height, count, finder: find?.finder ?? null, findHeight: find?.findHeight ?? null,
      ...(find?.source ? { source: find.source } : {}), found: !!find,
      minted: this.store.get('minted', `${rules.patternAsset(pattern)}/${height}`), link: this.store.get('links', heightKey(height)) };
  }
  rightsBlock(block) {
    for (const old of this.blockRights.get(block) ?? []) {
      const group = this.rightGroups.get(old.group);
      group.index.delete(old.id);
      if (!group.index.rows.size) this.rightGroups.delete(old.group);
    }
    this.blockRights.delete(block);
    for (const entry of this.scheduled.get(block) ?? []) this.deadlines.delete(entry);
    this.scheduled.delete(block);
    if (block >= this.views.history.length) { this.state.set('rights', block, undefined); return; }
    const scheduled = [],
      schedule = (height) => {
        if (height > this.counted) {
          const entry = { key: height, tie: block + '/' + height, row: block };
          this.deadlines.set(entry, height);
          scheduled.push(entry);
        }
      };
    const rows = [],
      link = this.store.get('links', heightKey(block));
      for (const pattern of this.views.patterns()) {
        const asset = rules.patternAsset(pattern),
          id = asset + '/' + block;
        const find = this.store.get('finds', rules.findId(block, pattern.number));
        if (!find?.finder) continue;
        const header = this.header(block);
        if (!rules.patternCount(pattern, header)) continue;
        schedule(find.findHeight);
        if (find.findHeight !== null && find.findHeight > this.counted) continue;
        const finderUntil = find.findHeight === null ? null : find.findHeight + 1008;
        schedule(finderUntil);
        const role =
          find.finder && this.counted < finderUntil
            ? 'finder'
            : find.finder && link && link.linkHeight < find.findHeight
              ? 'bitmap'
              : 'public';
        const minted = this.store.get('minted', id),
          hold = this.store.get('holds', id) ?? this.store.get('replay/mints/holds', id);
        if (hold?.safeToReplace !== false) schedule(hold?.expiry + 1);
        const pending =
          hold && (hold.expiry >= this.counted || hold.safeToReplace === false) ? { id: hold.id, expiry: hold.expiry } : null;
        const row = {
          asset,
          block,
          amount: String(find.count),
          rightAllowed: true,
          whoMayMint: role,
          reason: minted ? 'minted' : pending ? 'pending' : role,
          finderUntil,
          finder: find.finder,
          currentHolder: null,
          link,
          minted,
          pending,
          found: true,
          void: false,
          time: header.time,
          find,
        };
        // Homogeneous eligibility groups let an owner query combine maintained
        // counts/orders without materializing any of the matching rights.
        const groupKey = JSON.stringify([
          asset,
          row.amount,
          role,
          role === 'finder' ? find.finder : null,
          !!minted,
          !!pending,
          link ? block : null,
        ]);
        let group = this.rightGroups.get(groupKey);
        if (!group) {
          group = { row, index: new IndexedRows(agentSpecs.mintRights, { range: 'block' }) };
          this.rightGroups.set(groupKey, group);
        }
        group.index.set(id, row, block * this.views.patterns().length + pattern.number);
        rows.push({ group: groupKey, id, row });
      }
    if (rows.length) this.blockRights.set(block, rows);
    if (scheduled.length) this.scheduled.set(block, scheduled);
    this.state.set('rights', block, rows.length || scheduled.length ? { rows, scheduled } : undefined);
  }
  installRights(block, rows, scheduled) {
    for (const r of rows) {
      let group = this.rightGroups.get(r.group);
      if (!group) { group = { row: r.row, index: new IndexedRows(agentSpecs.mintRights, { range: 'block' }) }; this.rightGroups.set(r.group, group); }
      group.index.set(r.id, r.row, block * JSON.parse(this.patternStamp ?? '[]').length + r.row.find.pattern);
    }
    this.blockRights.set(block, rows);
    this.scheduled.set(block, scheduled);
    for (const entry of scheduled) this.deadlines.set(entry, entry.key);
  }
  async refresh() {
    const head = await this.views.head(), length = this.views.history.length;
    if (this.ready && length === this.length && JSON.stringify(head) === JSON.stringify(this.head) &&
        !this.db.prepare('SELECT 1 FROM publicReadChanges LIMIT 1').get() &&
        [...this.patternRows.keys()].every(asset => this.patternComplete(asset))) return;
    // Populate the numeric plot universe in restartable chunks, without reading
    // even one historical header. Existing installations need no chain replay.
    let filled = this.state.get('meta', 'plotsThrough') ?? 0;
    while (filled < length) {
      const end = Math.min(length, filled + 4096);
      this.db.exec('SAVEPOINT publicReadFill');
      try { this.plots.fill(filled, end); this.state.set('meta', 'plotsThrough', end); this.db.exec('RELEASE publicReadFill'); }
      catch (error) { this.db.exec('ROLLBACK TO publicReadFill; RELEASE publicReadFill'); throw error; }
      filled = end; await yieldIO();
    }
    const patternStamp = JSON.stringify(this.views.patterns()), changedPatterns = patternStamp !== this.patternStamp;
    // Legacy pattern pages already contain historical counts. Import those
    // derived artifacts, never manufacture a startup history scan.
    const imports = await this.patternImports(changedPatterns);
    check(patternStamp === JSON.stringify(this.views.patterns()) && length === this.views.history.length, 'public_read_snapshot_changed', 503);
    const changes = this.db.prepare('SELECT space,id FROM publicReadChanges' + (this.ready ? '' : " WHERE space!='headers'")).all();
    const blocks = new Set(), finds = new Set(), previousCounted = this.counted;
    this.db.exec('SAVEPOINT publicReadRefresh');
    try {
      this.counted = head.counted;
      if (!this.ready) {
        for (const { id } of this.db.prepare("SELECT id FROM records WHERE space='publicEvents'").all()) this.event(id);
        for (const space of ['receiptObservations', 'batches', 'mints', 'publicClaims', 'publicDraws'])
          for (const { id } of this.db.prepare('SELECT id FROM records WHERE space=?').all(space)) this.record(space, id);
        for (const { id } of this.db.prepare("SELECT id FROM records WHERE space='finds'").all()) finds.add(id);
        for (const space of ['links', 'minted']) for (const { id } of this.db.prepare('SELECT id FROM records WHERE space=?').all(space)) blocks.add(Number(id.split('/').at(-1)));
      }
      for (const c of changes) {
        if (c.space === 'publicEvents') this.event(c.id);
        if (['receiptObservations', 'batches', 'mints', 'publicClaims', 'publicDraws'].includes(c.space)) this.record(c.space, c.id);
        if (c.space === 'finds' || c.space === 'findProvenance') {
          finds.add(c.id);
          const old = this.finds.rows.get(c.id)?.entry.row;
          if (old) blocks.add(old.block);
        }
        if (c.space === 'links' || this.ready && c.space === 'headers' && this.views.patterns().length) blocks.add(Number(c.id));
        if (['minted', 'holds', 'replay/mints/holds'].includes(c.space)) {
          const block = Number(c.id.split('/').at(-1));
          if (Number.isSafeInteger(block)) blocks.add(block);
          if (c.space === 'minted') {
            const asset = c.id.split('/')[0], p = this.views.patterns().find(p => rules.patternAsset(p) === asset);
            if (p) finds.add(rules.findId(block, p.number));
          }
        }
      }
      for (const id of finds) {
        const find = this.store.get('finds', id); if (find) blocks.add(find.block);
        this.find(id);
      }
      if (changedPatterns) {
        const assets = new Set(this.views.patterns().map(rules.patternAsset));
        for (const asset of this.patternRows.keys()) if (!assets.has(asset)) {
          this.patternRows.delete(asset); this.db.prepare('DELETE FROM publicReadPatternRows WHERE asset=?').run(asset); this.state.set('coverage', asset, undefined);
        }
        for (const p of this.views.patterns()) {
          const asset = rules.patternAsset(p);
          this.patternRows.set(asset, new PatternRows(this, asset));
          const old = JSON.parse(this.patternStamp ?? '[]').find(o => rules.patternAsset(o) === asset);
          if (!old || ['pat', 'fld', 'dt'].some(k => old[k] !== p[k])) {
            this.db.prepare('DELETE FROM publicReadPatternRows WHERE asset=?').run(asset); this.state.set('coverage', asset, 0);
            if (old) this.state.set('feedRequiresDefinition', asset, true);
          }
        }
        for (const { entry: { row } } of this.finds.rows.values()) blocks.add(row.block);
        for (const { id } of this.db.prepare("SELECT id FROM records WHERE space='minted'").all()) blocks.add(Number(id.split('/').at(-1)));
      }
      if (!this.ready || changedPatterns || changes.some(c => c.space === 'meta' && c.id === 'ruleState')) {
        this.score('patterns', this.views.patterns().map(p => [p.discoverer, 'discoveries']));
        this.score('commits', (this.store.get('meta', 'ruleState')?.discoveryCommits ?? []).map(c => [c.agent, null]));
      }
      if (this.counted < previousCounted) for (const block of this.blockRights.keys()) blocks.add(block);
      for (const entry of this.deadlines.entries({ direction: 'asc', to: this.counted })) blocks.add(entry.row);
      for (const { asset, rows, through } of imports) {
        const index = this.patternRows.get(asset), pattern = this.views.patterns().find(p => rules.patternAsset(p) === asset);
        for (const row of rows) index.set(String(row.block), this.patternRow(pattern, row.block, row.count));
        // A reorg can introduce a match absent from the older feed page. Overlay
        // every cached changed header in its range, including previous gaps.
        const from = Math.floor((through - 1) / 256) * 256;
        for (const r of this.db.prepare('SELECT height FROM publicReadHeaderFields WHERE height>=? AND height<?').all(from, through))
          this.patternBlock(r.height, [pattern]);
        this.state.set('coverage', asset, through);
      }
      const coverage = new Map(this.views.patterns().map(p => { const asset = rules.patternAsset(p); return [asset, this.state.get('coverage', asset) ?? 0]; }));
      for (const h of [...blocks].sort((a, b) => a - b)) {
        this.rightsBlock(h); this.patternBlock(h); this.plot(h);
        for (const [asset, through] of coverage) if (h === through) coverage.set(asset, h + 1);
      }
      for (const [asset, through] of coverage) this.state.set('coverage', asset, through);
      // New patterns advance over compact, already persisted header fields only.
      // A missing legacy projection is served as index_catching_up until an
      // existing feed page supplies it; it never causes a genesis replay.
      for (const p of this.views.patterns()) {
        const asset = rules.patternAsset(p), from = this.state.get('coverage', asset) ?? 0;
        const fields = this.db.prepare('SELECT height FROM publicReadHeaderFields WHERE height>=? AND height<? ORDER BY height LIMIT 4096').all(from, length);
        let through = from;
        for (const r of fields) { if (r.height !== through) break; this.patternBlock(r.height, [p]); through++; }
        this.state.set('coverage', asset, Math.min(through, length));
      }
      if (length < this.length) {
        this.db.prepare('DELETE FROM publicReadPlots WHERE height>=?').run(length);
        this.db.prepare('DELETE FROM publicReadPatternRows WHERE block>=?').run(length);
        for (const block of new Set([...this.blockRights.keys(), ...this.scheduled.keys()])) if (block >= length) this.rightsBlock(block);
      }
      this.state.set('meta', 'plotsThrough', length);
      this.length = length; this.head = head; this.patternStamp = patternStamp;
      this.state.set('meta', 'cursor', { length, counted: this.counted, head, patternStamp, sequence: this.store.sequence ?? null });
      this.db.exec('DELETE FROM publicReadChanges; DELETE FROM publicReadOldHashes; RELEASE publicReadRefresh');
      this.ready = true;
    } catch (error) {
      this.db.exec('ROLLBACK TO publicReadRefresh; RELEASE publicReadRefresh');
      this.restore(); throw error;
    }
  }
  async patternImports(changedPatterns) {
    const imports = [];
    if (!this.store.directory) return imports;
    let budget = 16;
    for (const p of this.views.patterns()) {
      const asset = rules.patternAsset(p), old = JSON.parse(this.patternStamp ?? '[]').find(o => rules.patternAsset(o) === asset);
      const changed = changedPatterns && (!old || ['pat', 'fld', 'dt'].some(k => old[k] !== p[k]));
      // An asset number reused on a different branch cannot use the old feed.
      if (changed && old) continue;
      let from = changed ? 0 : this.state.get('coverage', asset) ?? 0;
      while (from < this.views.history.length && budget > 0) {
        const page = Math.floor(from / 256), path = this.store.get('feedVersions', `${asset}/${page}`)?.[0];
        if (!path) break;
        if (this.state.get('feedRequiresDefinition', asset)) {
          const definition = this.store.get('feedDefinitions', `${asset}/${page}`);
          if (definition?.path !== path || definition.pat !== p.pat || definition.fld !== p.fld || definition.dt !== p.dt) break;
        }
        check(new RegExp(`^/patterns/${asset}/${page}-[0-9a-f]{64}\\.json$`).test(path), 'public_pattern_path', 503);
        const bytes = await readFile(join(this.store.directory, 'static', path.slice(1)));
        check(hash(bytes) === path.slice(-69, -5), 'public_pattern_hash', 503);
        const data = JSON.parse(bytes);
        check(data.asset === asset && data.from === page * 256 && data.to >= data.from && data.to < (page + 1) * 256 &&
          Array.isArray(data.rows) && data.rows.every(r => Number.isSafeInteger(r.block) && r.block >= data.from && r.block <= data.to && Number.isSafeInteger(r.count) && r.count > 0), 'public_pattern_page', 503);
        if (data.to < from) break;
        imports.push({ asset, through: data.to + 1, rows: data.rows });
        from = data.to + 1; budget--;
      }
    }
    return imports;
  }
  async rights(owner, onlyBlock, params) {
    if (owner !== undefined) check(/^[0-9a-f]{64}$/.test(owner), 'agent_key');
    const registry = await this.views.reads.registry();
    const balances = new Map(),
      holders = new Map(),
      links = new Map();
    const balance = async (asset) => {
      if (!balances.has(asset)) balances.set(asset, Promise.resolve(this.views.reads.balance(owner, asset)));
      return balances.get(asset);
    };
    const evidence = async (row) => {
      let link = row.link,
        currentHolder = null;
      if (link) {
        if (!links.has(row.block)) links.set(row.block, this.views.reads.link(row.block));
        link = await links.get(row.block);
        if (link) {
          if (!holders.has(row.block))
            holders.set(
              row.block,
              this.views.reads
                .bitmap(row.block)
                .then((b) => b.agent)
                .catch(() => null),
            );
          currentHolder = await holders.get(row.block);
        }
      }
      const right = rules.mintRight({
        find: row.find,
        owner: owner ?? row.finder ?? currentHolder ?? '0'.repeat(64),
        counted: this.counted,
        link,
        currentHolder,
      });
      const unavailable = right.role === 'bitmap' && !currentHolder;
      const amount = owner === undefined ? undefined : await balance(row.asset),
        enough = owner === undefined || BigInt(amount) >= BigInt(row.amount),
        rightAllowed = owner === undefined ? !unavailable : right.allowed,
        deploymentRegistered = !!registry.assets[row.asset] && !registry.assets[row.asset].suspended;
      return {
        ...row,
        link,
        currentHolder,
        rightAllowed,
        deploymentRegistered,
        whoMayMint: right.role,
        allowed: deploymentRegistered && rightAllowed && !row.minted && !row.pending && enough,
        reason: row.minted
          ? 'minted'
          : row.pending
            ? 'pending'
            : !deploymentRegistered
              ? 'asset_unregistered'
              : unavailable
                ? 'holder_unavailable'
                : !enough
                  ? 'insufficient_balance'
                  : right.role,
        ...(owner === undefined ? {} : { balance: amount }),
      };
    };
    // Only reason sorting / eligibility filtering needs balances before seeking.
    // Default pages fetch balances and current ownership just for selected rows.
    const eligibility =
      params.has('allowed') || params.has('reason') || params.has('whoMayMint') || params.get('sort') === 'reason';
    const filters = {};
    for (const [key, parse] of Object.entries(agentSpecs.mintRights.filters))
      if (params.has(key) && key !== 'block') filters[key] = parse(params.get(key));
    const selectedBlock = onlyBlock ?? (params.has('block') ? Number(params.get('block')) : undefined);
    const groups = (
      await Promise.all(
        [...this.rightGroups.values()].map(async (group) => {
          let row = group.index.rows.values().next().value.entry.row;
          if (params.has('asset') && row.asset !== params.get('asset')) return null;
          if (selectedBlock !== undefined && !group.index.rows.has(row.asset + '/' + selectedBlock)) return null;
          for (const key of ['minted', 'pending']) if (filters[key] !== undefined && !!row[key] !== filters[key]) return null;
          if (eligibility) row = await evidence(row);
          if (!agentSpecs.mintRights.match(row, filters)) return null;
          return { index: group.index, reason: row.reason };
        }),
      )
    ).filter(Boolean);
    if (selectedBlock === undefined && owner)
      for (const c of this.views.rows('types')) {
        if (params.has('asset') && c.id !== params.get('asset')) continue;
        const amount = await balance(c.id), deploymentRegistered = !!registry.assets[c.id] && !registry.assets[c.id].suspended,
          row = {
            asset: c.id,
            block: null,
            amount,
            balance: amount,
            deploymentRegistered,
            allowed: deploymentRegistered && BigInt(amount) > 0n,
            rightAllowed: true,
            whoMayMint: 'holder',
            reason: !deploymentRegistered ? 'asset_unregistered' : BigInt(amount) > 0n ? 'holder' : 'insufficient_balance',
            finderUntil: null,
            finder: null,
            currentHolder: null,
            link: null,
            minted: null,
            pending: null,
            compound: true,
          };
        const filters = {};
        for (const [k, parse] of Object.entries(agentSpecs.mintRights.filters))
          if (params.has(k)) filters[k] = parse(params.get(k));
        if (!agentSpecs.mintRights.match(row, filters)) continue;
        const index = new IndexedRows(agentSpecs.mintRights);
        index.set(c.id, row);
        groups.push({ index, reason: row.reason });
      }
    return {
      page(query) {
        const entries = [];
        let total = 0;
        for (const group of groups) {
          const q = {
            ...query,
            selectedFilters: onlyBlock === undefined ? { block: query.selectedFilters.block } : { block: onlyBlock },
          };
          // reason is constant inside an eligibility group; transform the anchor
          // into its stored reason while preserving the public cursor key.
          if (query.sortKey === 'reason' && query.anchor) {
            const c = compare(group.reason, query.anchor.key, 'reason') * (query.direction === 'asc' ? 1 : -1);
            if (c < 0) {
              total += group.index.page({ ...q, anchor: undefined, limit: 0 }).meta.total;
              continue;
            }
            q.anchor = c === 0 ? { ...query.anchor, key: group.index.rows.values().next().value.entry.row.reason } : undefined;
          }
          const page = group.index.page({ ...q, limit: query.limit + 1 });
          total += page.meta.total;
          for (const entry of page.entries) entries.push(query.sortKey === 'reason' ? { ...entry, key: group.reason } : entry);
        }
        const cmp = (a, b) =>
          (compare(a.key, b.key, query.sortKey) || compare(a.tie, b.tie, 'tie')) * (query.direction === 'asc' ? 1 : -1);
        entries.sort(cmp);
        const more = entries.length > query.limit;
        entries.length = Math.min(entries.length, query.limit);
        return {
          entries,
          meta: {
            total,
            next: more ? pageCursor(query.scope, entries.at(-1)) : null,
            limit: query.limit,
            sort: query.sortKey,
            order: query.direction,
            route: query.route,
          },
        };
      },
      hydrate: async (row) => (row.compound ? row : evidence(row)),
    };
  }
}
