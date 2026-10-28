import { randomBytes } from 'node:crypto';
import { check, hash, serial, atomicWrite } from './util.mjs';
import { rules } from './rules.mjs';
import { candidate, same, generationDigest, deploymentPayload, deploymentOptions, verifyDeployment, elementByDefinition, elementByName } from './deployments.mjs';
import { updateRegistryAsset } from './registry.mjs';

export class Provisioner {
  constructor({ store, reads, network, registryPath, policy }) {
    Object.assign(this, { store, reads, network, registryPath, policy }); this.gate = serial();
    check(Number.isSafeInteger(policy.confirmations) && policy.confirmations === 1, 'provisioning_confirmation_policy');
  }
  async save(job, patch = {}) {
    const row = { ...job, ...patch, updatedAt: Date.now() };
    await this.store.put('provisioning', job.asset, row); return row;
  }
  async enqueue(asset, definition) {
    let job = this.store.get('provisioning', asset);
    if (job) { check(same(job.definition, definition), 'provisioning_definition_changed'); return job; }
    const entry = (await this.reads.registry()).assets[asset];
    job = { asset, network: this.network, generation: entry?.generation ?? 1, definition, displayLabel: definition.name ?? asset,
      kind: asset.startsWith('p') ? 'dmt' : 'compound', salt: randomBytes(32).toString('hex'), elementAttempt: 0, tickerAttempt: 0,
      privilege: this.policy.privilege, authorityKey: this.policy.authorityKey,
      attempts: [], spentSats: '0', state: entry ? 'confirming' : 'queued', ...(entry ? { entry } : {}) };
    return this.save(job);
  }
  request(asset, definition) { return this.gate(async () => this.advance(await this.enqueue(asset, definition))); }
  async tick() {
    return this.gate(async () => {
      const settings = (await this.reads.registry()).operator?.provisioning;
      if (settings) this.policy = { ...this.policy, ...settings };
      const patterns = this.store.get('meta', 'patterns') ?? [], cursor = this.store.get('meta', 'provisioningCursor') ?? { pattern: 0, type: '' };
      const definitions = [];
      for (let i = 0; i < Math.min(8, patterns.length); i++) { const p = patterns[(cursor.pattern + i) % patterns.length]; definitions.push([rules.patternAsset(p), p]); }
      const page = this.store.list('types', { after: cursor.type, limit: 8 }); definitions.push(...page.map(r => [r.id, r.value]));
      for (const [asset, definition] of definitions) {
        const job = await this.enqueue(asset, definition);
        if ((job.nextRetry ?? 0) <= Date.now()) await this.advance(job);
      }
      const next = { pattern: patterns.length ? (cursor.pattern + 8) % patterns.length : 0, type: page.length === 8 ? page.at(-1).id : '' };
      if (!same(cursor, next)) await this.store.put('meta', 'provisioningCursor', next);
    });
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
    return this.gate(async () => {
      let job = this.store.get('provisioning', asset);
      check(job && ['element', 'deployment'].includes(phase) && /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(inscription), 'deployment_submission');
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
          const name = job.elementAttempt === 0 ? job.displayLabel.toLowerCase() : candidate(job, 'element', job.elementAttempt);
          if (await elementByName(this.reads, name)) return this.save(job, { elementAttempt: job.elementAttempt + 1, state: 'retrying-collision', reason: 'element_name_occupied', nextRetry: 0 });
          const sent = await this.package(job, 'element', `${name}.${job.definition.pat}.${job.definition.fld}.element`);
          if (!sent) return this.store.get('provisioning', job.asset);
          const inclusion = await this.reads.included(sent.item.inscription).catch(() => null);
          if (inclusion?.confirmations >= this.policy.confirmations) return this.save(sent.job, { elementAttempt: job.elementAttempt + 1, state: 'retrying-collision', reason: 'element_ignored', nextRetry: 0 });
          return this.save(sent.job, { state: 'resolving-element', reason: 'element_index_pending', nextRetry: Date.now() + 1000 });
        }
      }
      const tick = job.tickerAttempt === 0 ? (job.kind === 'dmt' ? job.displayLabel.toLowerCase() : rules.compoundTicker(job.asset)) : candidate(job, job.kind === 'dmt' ? 'dmt-ticker' : 'compound-ticker', job.tickerAttempt);
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
          if (!['deployment_receiver', 'first_maker_receiver'].includes(error.message)) throw error;
          return this.save(job, { tickerAttempt: job.tickerAttempt + 1, state: 'retrying-collision', reason: 'ticker_occupied', nextRetry: 0 });
        }
        prior = { ...prior, inscription: occupied.ins };
        job = await this.save(job, { receiver, attempts: job.attempts.map(a => a.id === prior.id ? prior : a) });
      }
      if (occupied && occupied.ins !== prior?.inscription) return this.save(job, { tickerAttempt: job.tickerAttempt + 1, state: 'retrying-collision', reason: 'ticker_occupied', nextRetry: 0 });
      let entry = { network: this.network, asset: job.asset, generation: job.generation, kind: job.kind, displayLabel: job.displayLabel, tick, indexTick,
        privilege: this.policy.privilege, authorityKey: this.policy.authorityKey, options: deploymentOptions(job.kind),
        receiver: job.receiver,
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
      return this.save(this.store.get('provisioning', job.asset) ?? job, { state: /fund|budget|cost|fee_rate/.test(error.message) ? 'waiting-for-funds' : 'confirming',
        reason: /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'provisioning_dependency', nextRetry: Date.now() + 1000 });
    }
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
    return this.save(job, { entry, generation, state: 'registered', reason: null, registeredAt: job.registeredAt ?? Date.now(), nextRetry: Date.now() + 10000 });
  }
}

export async function createProvisioner({ config, store, reads }) {
  const settings = (await reads.registry()).operator;
  if (!settings?.provisioning) return null;
  const policy = settings.provisioning;
  return new Provisioner({ store, reads, network: config.network, registryPath: (config.prod ?? config.local).registry, policy });
}
