import { TickerProvisioning } from './ticker-provisioning.mjs';
import { randomBytes } from 'node:crypto';
import { check, hash } from './util.mjs';
import { KeyedWork, parallelPage } from './keyed-work.mjs';
import { rules } from './rules.mjs';
import { candidate, same, generationDigest, deploymentPayload, deploymentOptions, verifyDeployment, elementByDefinition, elementByName } from './deployments.mjs';
import { updateRegistryAsset } from './registry.mjs';
import { mintAssetDefinition, patternCatalogId } from './mint-assets.mjs';
import { encodeTracAddress, isTracAddress } from '../../rules/src/trac-address.js';
import { lifecycleSignal } from './lifecycle.mjs';
import { verifyTickerChoice, TICKER_CHOICE_KEYS, TICKER_CHOICE_MS } from './compound-ticker.mjs';
import { tickerAvailable, reserveTicker, releaseTicker } from './ticker-availability.mjs';

// Background pacing: a failed step retries after RETRY_MS; a registered deployment is re-verified
// every RECHECK_MS. Source verification runs independently for each asset.
const RETRY_MS = 30000, RECHECK_MS = 600000;
const stopping = error => error?.name === 'AbortError' || /^[a-z_]+_stopping$/.test(error?.message ?? '') || lifecycleSignal()?.aborted === true;
const tracId = id => isTracAddress(id) ? id : encodeTracAddress(id);
// A name already packaged for an attempt keeps it (an older job may use an earlier fallback form).
const packagedName = (job, phase, attempt) => {
  const text = job.attempts.find(a => a.phase === phase && a.attempt === attempt)?.text;
  return phase === 'element' ? (typeof text === 'string' ? text.split('.')[0] : undefined) : text?.tick;
};
// A compound's official ticker is the one its first maker chose for the current attempt.
// Without one the job waits for the choice; there is no automatic compound ticker.
const choiceFor = job => job.kind === 'compound' && job.chosenTicker?.attempt === job.tickerAttempt ? job.chosenTicker : null;
const needsChoice = job => job.kind === 'compound' && !choiceFor(job);
// Jobs that move only when a person acts: the player's inscription, or the first maker's ticker.
const waitsForPlayer = job => job.state === 'awaiting_ticker' || job.state === 'awaiting_player_deploy' && !needsChoice(job);
const reservation = asset => 'official/' + asset;
const TRANSIENT = new Set(['tap_snapshot_changed', 'tap_quorum_unavailable', 'tap_lookup_index_catching_up', 'http_timeout', 'http_unavailable', 'http_capacity']);
export class Provisioner {
  constructor({ store, reads, network, registryPath, policy, concurrency = 4 }) {
    Object.assign(this, { store, reads, network, registryPath, policy, concurrency });
    this.tickers = new TickerProvisioning(this);
    this.work = new KeyedWork({ concurrency, capacity: Math.max(concurrency, 64) }); this.enqueues = new KeyedWork();
    check(Number.isSafeInteger(policy.confirmations) && policy.confirmations === 1, 'provisioning_confirmation_policy');
  }
  async save(job, patch = {}) {
    const row = { ...job, ...patch, updatedAt: Date.now() };
    await this.store.put('provisioning', job.asset, row); return row;
  }
  enqueue(asset, definition) { return this.enqueues.run(asset, async () => {
    let job = this.store.get('provisioning', asset);
    if (job) { check(same(job.definition, definition), 'provisioning_definition_changed'); return job; }
    const entry = (await this.reads.registry()).assets[asset];
    job = { asset, network: this.network, generation: entry?.generation ?? 1, definition, displayLabel: definition.name ?? asset,
      kind: asset.startsWith('p') ? 'dmt' : 'compound', salt: randomBytes(32).toString('hex'), elementAttempt: 0, tickerAttempt: 0,
      privilege: this.policy.privilege, authorityKey: this.policy.authorityKey,
      attempts: [], spentSats: '0', state: entry ? 'confirming' : 'queued', ...(entry ? { entry } : {}) };
    return this.save(job);
  }, { join: true }); }
  async state(asset) {
    const resolved = await mintAssetDefinition(this.store, asset);
    const job = this.store.get('provisioning', resolved.asset);
    const shown = job ?? { asset: resolved.asset, definition: resolved.definition, kind: resolved.asset.startsWith('p') ? 'dmt' : 'compound',
      displayLabel: resolved.definition.name ?? resolved.asset, state: 'not_started' };
    return { ...shown, catalogAsset: resolved.catalogAsset, ...await this.deployerView(shown) };
  }
  // During the discoverer's week only the discoverer's bound TAP wallet may deploy
  // a pattern's token; after it anyone may. The week is the finder-week clock.
  async deployer(job) {
    if (job.kind !== 'dmt' || !job.definition?.discoverer) return null;
    const catalog = patternCatalogId(job.asset), pattern = catalog && this.store.get('patternsByAsset', catalog);
    if (!pattern) return null;
    const context = await this.reads.rulesContext?.();
    check(context?.settings, 'deployment_week_settings');
    // A network without a release clock (public minting never activated) has no discoverer's week.
    let until;
    try { until = rules.discovererWeekEnd(pattern, context.settings); }
    catch (error) { if (error.message === 'claim_policy_missing') return null; throw error; }
    let address = null;
    try { address = this.reads.bindings.resolve(job.definition.discoverer, 'tap', null, 'discoverer')?.request.address ?? null; }
    catch (error) { if (!/^(?:discoverer_address_missing|binding_transition)$/.test(error.message)) throw error; }
    return { until, discoverer: job.definition.discoverer, address };
  }
  // What deployment pages show before anyone pays for an inscription.
  async deployerView(job) {
    if (job.state === 'registered') return {};
    const rule = await this.deployer(job);
    if (!rule) return {};
    const counted = rules.decimalV2(await this.reads.counted());
    return { deployer: { ...rule, onlyDiscoverer: BigInt(counted) < BigInt(rule.until), counted } };
  }
  async request(asset, definition, { registeredAsIs = false } = {}) {
    const resolved = definition ? { asset, definition, catalogAsset: asset } : await mintAssetDefinition(this.store, asset);
    const shown = async job => ({ ...(definition ? job : { ...job, catalogAsset: resolved.catalogAsset }), ...await this.deployerView(job) });
    // Mint quotes take a registered deployment as is; the background tick re-verifies it.
    const known = registeredAsIs && this.store.get('provisioning', resolved.asset);
    if (known?.state === 'registered' && same(known.definition, resolved.definition)) return shown(known);
    // A live registry entry stays usable while a background recheck retries a busy source.
    if (known?.entry && same(known.definition, resolved.definition)) {
      const live = (await this.reads.registry()).assets?.[resolved.asset];
      if (live && !live.suspended && live.id === known.entry.id && known.registeredAt) return shown({ ...known, state: 'registered', entry: live });
    }
    const job = await this.enqueue(resolved.asset, resolved.definition);
    check(same(job.definition, resolved.definition), 'provisioning_definition_changed');
    if (!waitsForPlayer(job) && (job.nextRetry ?? 0) <= Date.now()) {
      this.advanceAsset(resolved.asset, resolved.definition).catch(() => {});
    }
    return shown(job);
  }
  advanceAsset(asset, definition) { return this.work.run(asset, async () => this.advance(await this.enqueue(asset, definition)), { join: true }); }
  async close() { await this.tickers.work.drain(); await this.enqueues.drain(); await this.work.drain(); }
  async tick() {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      const settings = (await this.reads.registry()).operator?.provisioning;
      if (settings) this.policy = { ...this.policy, ...settings };
      const patterns = this.store.get('meta', 'patterns') ?? [], cursor = this.store.get('meta', 'provisioningCursor') ?? { pattern: 0, type: '' };
      const definitions = [];
      const v2 = this.store.get('meta', 'ruleState')?.batchVersion === 2;
      const named = v2 ? this.store.list('patternsByAsset', { after: cursor.named ?? '', limit: 8 }) : [];
      if (v2) for (const row of named) { const r = await mintAssetDefinition(this.store, row.id); definitions.push([r.asset, r.definition]); }
      else for (let i = 0; i < Math.min(8, patterns.length); i++) { const p = patterns[(cursor.pattern + i) % patterns.length]; definitions.push([rules.patternAsset(p), p]); }
      const page = this.store.list('types', { after: cursor.type, limit: 8 }); definitions.push(...page.map(r => [r.id, r.value]));
      const compounds = v2 ? this.store.list('compoundTypes', { after: cursor.compound ?? '', limit: 8 }) : [];
      definitions.push(...compounds.filter(r => !r.value.retired).map(r => [r.id, r.value]));
      await parallelPage(definitions, async ([asset, definition]) => {
        const job = await this.enqueue(asset, definition);
        // A job waiting for the player's inscription advances when the player submits it.
        if (!waitsForPlayer(job) && (job.nextRetry ?? 0) <= Date.now()) await this.advanceAsset(asset, definition);
      }, this.concurrency);
      const next = { pattern: !v2 && patterns.length ? (cursor.pattern + 8) % patterns.length : 0, type: page.length === 8 ? page.at(-1).id : '',
        ...(v2 ? { named: named.length === 8 ? named.at(-1).id : '', compound: compounds.length === 8 ? compounds.at(-1).id : '' } : {}) };
      if (!same(cursor, next)) await this.store.put('meta', 'provisioningCursor', next);
    })().finally(() => { this.ticking = null; });
    return this.ticking;
  }
  async package(job, phase, text) {
    const attempt = phase === 'element' ? job.elementAttempt : job.tickerAttempt;
    let item = job.attempts.find(a => a.phase === phase && a.attempt === attempt);
    if (!item) {
      item = { phase, attempt, id: hash([this.network, job.asset, job.generation, phase, attempt, job.salt].join('/')), text };
      job = await this.save(job, { attempts: [...job.attempts, item] });
    }
    check(same(item.text, text), 'provisioning_attempt_changed');
    if (!item.inscription) {
      const waiting = { state: 'awaiting_player_deploy', phase, content: text,
        inscriptionText: typeof text === 'string' ? text : rules.stableJSON(text), reason: null };
      // Waiting for the player is a steady state. Rewriting it on every tick
      // churns the store and invalidates every operator evidence snapshot.
      if (!Object.entries(waiting).every(([k, v]) => same(job[k], v))) await this.save(job, waiting);
      return null;
    }
    return { job, item };
  }
  async submit(asset, { phase, inscription }) {
    if (!this.store.get('provisioning', asset)) asset = (await mintAssetDefinition(this.store, asset)).asset;
    return this.work.run(asset, async () => {
      let job = this.store.get('provisioning', asset);
      check(job && ['element', 'deployment'].includes(phase) && /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(inscription), 'deployment_submission');
      // A job opened before its compound was merged into the deterministic id stays closed.
      check(job.kind !== 'compound' || !this.store.get('compoundTypes', job.asset)?.retired, 'compound_retired');
      const attempt = phase === 'element' ? job.elementAttempt : job.tickerAttempt;
      const item = job.attempts.find(a => a.phase === phase && a.attempt === attempt);
      check(item && same(await this.reads.content(inscription), item.text), 'deployment_content');
      check((await this.reads.included(inscription))?.confirmations >= this.policy.confirmations, 'deployment_confirmations');
      const receiver = await this.receiver(job, inscription);
      check(!item.inscription || item.inscription === inscription, 'deployment_submission_conflict');
      job = await this.save(job, { receiver, attempts: job.attempts.map(a => a.id === item.id ? { ...a, inscription } : a) });
      return this.advance(job);
    });
  }
  async receiver(job, inscription) {
    const receiver = (await this.reads.inscription(inscription))?.address;
    check(typeof receiver === 'string' && receiver.length > 0, 'deployment_receiver');
    if (job.kind === 'compound') {
      const maker = this.reads.bindings.resolve(job.definition.firstMaker, 'tap', null, 'firstMaker');
      check(receiver === maker.request.address, 'first_maker_receiver');
    } else {
      // An inscription included during the discoverer's week counts only in the discoverer's wallet.
      const rule = await this.deployer(job);
      if (rule) {
        const height = (await this.reads.included(inscription))?.height ?? await this.reads.counted();
        if (BigInt(rules.decimalV2(height)) < BigInt(rule.until)) check(rule.address !== null && receiver === rule.address, 'discoverer_receiver');
      }
    }
    if (job.receiver) check(receiver === job.receiver, 'deployment_receiver');
    return receiver;
  }
  async suspend(job, reason) {
    const registry = await this.reads.registry(), entry = registry.assets[job.asset];
    if (entry && !entry.suspended) await updateRegistryAsset(this.registryPath, job.asset, latest => ({ ...latest, suspended: true }));
    return this.save(job, { state: 'confirming', reason, nextRetry: Date.now() + 1000 });
  }
  async advance(job) {
    try {
      if (job.entry) {
        try {
          await verifyDeployment(this.reads, { ...job.entry, suspended: false }, { confirmations: this.policy.confirmations });
          return await this.register(job);
        } catch (error) {
          // A moving tip or a busy indexer is not evidence against the deployment: retry, keep it live.
          if (TRANSIENT.has(error.message)) return this.save(job, { nextRetry: Date.now() + RETRY_MS });
          // A read cut off because this process is stopping says nothing about the deployment.
          if (stopping(error)) throw error;
          await this.suspend(job, error.message);
          const winner = await this.reads.tap('getDeployment/' + encodeURIComponent(job.entry.indexTick ?? job.entry.tick));
          if (winner && winner.ins !== job.entry.id) return this.save(job, { entry: null, tickerAttempt: job.tickerAttempt + 1, state: 'retrying-collision', reason: 'deployment_race', nextRetry: 0 });
          const canonical = await this.reads.included(job.entry.id).catch(() => null);
          if (canonical && (canonical.confirmations < this.policy.confirmations || winner)) return this.store.get('provisioning', job.asset);
          // A still-included inscription can become an ignored deployment when
          // its element loses after a reorg. Only decide absence at a complete tip.
          if (canonical && job.kind === 'dmt') await elementByDefinition(this.reads, job.definition);
          // A reorg never silently replaces a still-confirmed mapping. Retain
          // its generation, reconcile the same package before another attempt.
          job = await this.save(job, { entry: null, state: 'resolving-element', reason: 'deployment_reorg' });
        }
      }
      if (job.kind === 'dmt') {
        const element = await elementByDefinition(this.reads, job.definition);
        if (element) {
          const inclusion = await this.reads.included(element.ins);
          check(inclusion?.confirmations >= this.policy.confirmations, 'element_confirmations');
          job = await this.save(job, { elementId: element.ins, elementName: element.tick, reused: !job.attempts.some(a => a.inscription === element.ins), state: 'inscribed' });
        } else {
          const name = job.elementAttempt === 0 ? job.displayLabel.toLowerCase() : packagedName(job, 'element', job.elementAttempt) ??
            candidate(job, 'element', job.elementAttempt, job.displayLabel.toLowerCase());
          if (await elementByName(this.reads, name)) return this.save(job, { elementAttempt: job.elementAttempt + 1, state: 'retrying-collision', reason: 'element_name_occupied', nextRetry: 0 });
          const sent = await this.package(job, 'element', rules.tapElementText(name, job.definition));
          if (!sent) return this.store.get('provisioning', job.asset);
          const inclusion = await this.reads.included(sent.item.inscription).catch(() => null);
          if (inclusion?.confirmations >= this.policy.confirmations) return this.save(sent.job, { elementAttempt: job.elementAttempt + 1, state: 'retrying-collision', reason: 'element_ignored', nextRetry: 0 });
          return this.save(sent.job, { state: 'resolving-element', reason: 'element_index_pending', nextRetry: Date.now() + 1000 });
        }
      }
      if (needsChoice(job) && !await this.keptAutoTicker(job)) return this.awaitTicker(job);
      const choice = choiceFor(job);
      const first = job.kind === 'dmt' ? job.displayLabel.toLowerCase() : choice?.tick ?? rules.compoundTicker(job.asset);
      const tick = choice ? choice.tick : job.tickerAttempt === 0 ? first : packagedName(job, 'deployment', job.tickerAttempt) ?? candidate(job, job.kind === 'dmt' ? 'dmt-ticker' : 'compound-ticker', job.tickerAttempt, first);
      const indexTick = job.kind === 'dmt' ? 'dmt-' + tick : tick;
      const occupied = await this.reads.tap('getDeployment/' + encodeURIComponent(indexTick));
      let prior = job.attempts.find(a => a.phase === 'deployment' && a.attempt === job.tickerAttempt);
      // The player may lose the POST reply, or the indexer may see the reveal
      // before its inclusion registration retry. Recognize that exact
      // package instead of mistaking its own ticker for a collision.
      if (occupied && prior && !prior.inscription && same(await this.reads.content(occupied.ins), prior.text)) {
        check((await this.reads.included(occupied.ins))?.confirmations >= this.policy.confirmations, 'deployment_confirmations');
        let receiver;
        try { receiver = await this.receiver(job, occupied.ins); }
        catch (error) {
          if (!['deployment_receiver', 'first_maker_receiver', 'discoverer_receiver'].includes(error.message)) throw error;
          return this.save(job, { tickerAttempt: job.tickerAttempt + 1, state: 'retrying-collision', reason: 'ticker_occupied', nextRetry: 0 });
        }
        prior = { ...prior, inscription: occupied.ins };
        job = await this.save(job, { receiver, attempts: job.attempts.map(a => a.id === prior.id ? prior : a) });
      }
      if (occupied && occupied.ins !== prior?.inscription) return this.save(job, { tickerAttempt: job.tickerAttempt + 1, state: 'retrying-collision', reason: 'ticker_occupied', nextRetry: 0 });
      // A package made before deploys carried prov keeps its exact text.
      const prov = prior ? prior.text?.prov : tracId(job.kind === 'dmt' ? job.definition.discoverer : job.definition.firstMaker);
      let entry = { network: this.network, asset: job.asset, generation: job.generation, kind: job.kind, displayLabel: job.displayLabel, tick, indexTick,
        privilege: this.policy.privilege, authorityKey: this.policy.authorityKey, options: deploymentOptions(job.kind),
        receiver: job.receiver, ...(prov === undefined ? {} : { prov }),
        ...(job.kind === 'dmt' ? { elementId: job.elementId, elementName: job.elementName, dt: job.definition.dt, pattern: job.definition } : { firstMaker: job.definition.firstMaker }),
        tap: { treasury: this.policy.tapTreasury }, ethereum: { treasury: this.policy.ethereumTreasury } };
      if (prior && !same(prior.text, deploymentPayload(entry))) return this.save(job, { tickerAttempt: job.tickerAttempt + 1,
        state: 'retrying-collision', reason: 'deployment_element_changed', nextRetry: 0 });
      job = await this.save(job, { state: 'deploying', reason: null });
      const sent = await this.package(job, 'deployment', deploymentPayload(entry));
      if (!sent) return this.store.get('provisioning', job.asset);
      entry = { ...entry, id: sent.item.inscription }; entry.approval = generationDigest(entry);
      job = await this.save(sent.job, { entry, state: 'confirming', reason: 'deployment_index_pending', nextRetry: Date.now() + 1000 });
      if (!occupied) return job;
      await verifyDeployment(this.reads, entry, { confirmations: this.policy.confirmations });
      return this.register(job);
    } catch (error) {
      if (stopping(error)) throw error;
      return this.save(this.store.get('provisioning', job.asset) ?? job, { state: /fund|budget|cost|fee_rate/.test(error.message) ? 'waiting-for-funds' : 'confirming',
        reason: /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'provisioning_dependency', nextRetry: Date.now() + RETRY_MS });
    }
  }
  // A compound packaged under its automatic ticker before first makers chose keeps it only once that deploy was
  // submitted for registration. A deploy that is merely in a block is not registered: its first maker may still
  // choose a ticker, and the unregistered automatic token stays unmintable (signers sign only registered deployments).
  async keptAutoTicker(job) {
    const prior = job.attempts.find(a => a.phase === 'deployment' && a.attempt === job.tickerAttempt);
    return !!prior?.inscription;
  }
  async deployInBlock(job, item) {
    const sent = this.store.get('inflight', `deployment/${job.asset}/deployment`);
    if (sent?.attempt === item.attempt && (sent.confirmations > 0 || await this.reads.included(sent.inscriptionId).catch(() => null))) return true;
    const occupied = await this.reads.tap('getDeployment/' + encodeURIComponent(item.text.tick.toLowerCase()));
    return !!occupied && same(await this.reads.content(occupied.ins), item.text);
  }
  async awaitTicker(job) {
    const waiting = { state: 'awaiting_ticker', phase: 'deployment', content: null, inscriptionText: null,
      reason: ['ticker_occupied', 'deployment_race'].includes(job.reason) ? job.reason : 'ticker_choice_required' };
    if (Object.entries(waiting).every(([k, v]) => same(job[k] ?? null, v))) return job;
    return this.save(job, waiting);
  }
  // The first maker chooses (or changes) the compound's official ticker, signed by their agent
  // or by the TAP Wallet bound to it. Once its deploy is in a block the ticker is fixed.
  async chooseTicker(asset, input) {
    check(input && typeof input === 'object' && Object.keys(input).every(k => TICKER_CHOICE_KEYS.includes(k)) &&
      (input.agentSignature === undefined) !== (input.walletSignature === undefined) && typeof input.ticker === 'string', 'ticker_choice_request');
    const resolved = await mintAssetDefinition(this.store, asset);
    check(resolved.asset.startsWith('c') && resolved.definition?.firstMaker, 'ticker_choice_asset');
    check(!this.store.get('compoundTypes', resolved.asset)?.retired, 'compound_retired');
    const now = Date.now();
    check(Number.isSafeInteger(input.expiry) && input.expiry > now && input.expiry <= now + TICKER_CHOICE_MS, 'ticker_choice_expired');
    const tick = rules.validateOfficialTicker(input.ticker);
    await this.enqueue(resolved.asset, resolved.definition);
    return this.work.run(resolved.asset, async () => {
      let job = this.store.get('provisioning', resolved.asset);
      check(same(job.definition, resolved.definition), 'provisioning_definition_changed');
      const previous = job.chosenTicker ?? null, revision = (previous?.revision ?? 0) + 1;
      check(input.revision === revision, 'ticker_choice_stale', 409);
      const firstMaker = tracId(job.definition.firstMaker);
      const message = rules.compoundTickerMessage({ network: this.network, asset: job.asset, ticker: tick, revision, expiry: input.expiry, firstMaker });
      const by = verifyTickerChoice({ message, firstMaker, input, bindings: this.reads.bindings, bitcoinNetwork: this.reads.bindings?.bitcoinNetwork ?? 'mainnet' });
      const current = job.attempts.find(a => a.phase === 'deployment' && a.attempt === job.tickerAttempt);
      const fixed = job.entry || job.state === 'registered' || current?.inscription || !!choiceFor(job) && current && await this.deployInBlock(job, current);
      // A chosen ticker's deploy already in a block continues under it; an automatic one is replaced until registered.
      if (fixed) { await this.advance(job).catch(() => {}); check(false, 'ticker_fixed', 409); }
      if (choiceFor(job)?.tick === tick) return this.request(job.asset);
      // The same checks as deploying your own ticker; this compound's own names are its own.
      const registry = await this.reads.registry();
      const { tickerConflicts } = await import('../../rules/src/ticker-names.js');
      await tickerConflicts(tick, { officialName: async name => {
        check(typeof this.reads.officialName === 'function', 'ticker_official_lookup_required');
        const row = await this.reads.officialName(name), other = registry.officialName?.(name) ?? null;
        return row && row.asset !== job.asset ? row : other && other !== job.asset ? other : null;
      } });
      check(await tickerAvailable(this.reads, tick), 'ticker_occupied');
      await reserveTicker(this.store, tick, reservation(job.asset));
      // Release what this compound held before: an earlier choice, and the automatic name it never deployed.
      for (const name of new Set([previous?.tick, rules.compoundTicker(job.asset)].filter(n => n && n !== tick))) {
        await releaseTicker(this.store, name, reservation(job.asset));
        if (this.store.get('officialCatalogNames', name)?.asset === job.asset) await this.store.transact([{ space: 'officialCatalogNames', id: name }]);
      }
      await this.store.put('officialCatalogNames', tick, { asset: job.asset, name: tick });
      // A packaged attempt is superseded by a new one; the collision logic continues from there.
      const attempt = current ? job.tickerAttempt + 1 : job.tickerAttempt;
      job = await this.save(job, { chosenTicker: { tick, revision, attempt, by, at: now }, tickerAttempt: attempt,
        state: 'queued', phase: 'deployment', content: null, inscriptionText: null, reason: null, nextRetry: 0 });
      await this.advance(job);
      return this.request(job.asset);
    });
  }
  async register(job) {
    const { inclusion, authorityKey, elementId, dt } = await verifyDeployment(this.reads, { ...job.entry, suspended: false }, { confirmations: this.policy.confirmations });
    const old = (await this.reads.registry()).assets[job.asset];
    const generation = Math.max(job.generation, (old?.generation ?? 0) + (old && old.id !== job.entry.id ? 1 : 0));
    const entry = { ...job.entry, network: job.network, asset: job.asset, generation, authorityKey, ...(job.kind === 'dmt' ? { elementId, dt } : {}),
      options: job.entry.options ?? deploymentOptions(job.kind), displayLabel: job.displayLabel,
      suspended: false, inclusion: { height: inclusion.height, blockHash: inclusion.blockHash }, confirmations: this.policy.confirmations };
    entry.approval = generationDigest(entry);
    if (!same(old, entry) || !job.registeredAt) await updateRegistryAsset(this.registryPath, job.asset, () => entry);
    return this.save(job, { entry, generation, state: 'registered', reason: null, registeredAt: job.registeredAt ?? Date.now(), nextRetry: Date.now() + RECHECK_MS });
  }
}

export async function createProvisioner({ config, store, reads }) {
  const settings = (await reads.registry()).operator;
  if (!settings?.provisioning) return null;
  const policy = settings.provisioning;
  return new Provisioner({ store, reads, network: config.network, registryPath: (config.prod ?? config.local).registry, policy });
}
