import { accountKey, EMPTY_ACCOUNT_ROOT } from '../../contract/account-tree.js';
import { applyRootAccounts } from '../../contract/root-accounts.js';
import { applyPaymentPage } from '../../contract/payment-pages.js';
import { applyBeaconRecovery } from '../../contract/beacon/recovery.js';
import { AccountAvailability } from './account-availability.mjs';
import { accountSettings } from '../../rules/src/account-settings.js';
import { creditActions } from '../../rules/src/account-batch.js';
import { rules } from './rules.mjs';
import { publicAccountWrites } from './public-accounts.mjs';

// A batch-local view shared by every observation. Apply only a successfully
// packed observation; discarded attempts cannot leak records or proof nodes.
export class AccountBatchOverlay {
  constructor(store) { this.store = store; this.spaces = new Map(); this.financialReservations = new Map(); }
  get(space, id) { const rows = this.spaces.get(space); return rows?.has(id) ? rows.get(id) : this.store.get(space, id); }
  hasOverlay(space, id) { return this.spaces.get(space)?.has(id) ?? false; }
  apply(writes) {
    for (const { space, id, value } of writes) {
      if (!this.spaces.has(space)) this.spaces.set(space, new Map());
      this.spaces.get(space).set(id, value);
    }
  }
}

export async function buildCreditAccounts({ store, credits, crafts = [], transfers = [], compoundMerge = null, document, height, executionHeight = height, mergeManifest }) {
  const execution = new AccountExecution({ store, document, height, executionHeight, mergeManifest });
  const actions = [...rules.compoundMergeAction(compoundMerge), ...creditActions(credits), ...crafts.map(c => c.action), ...transfers.map(t => t.action)]; if (actions.length) await execution.accounts(actions);
  return execution.result();
}

// One disposable overlay per batch. Every later operation proves the roots
// produced by its predecessors, including funding usage. Nothing becomes
// visible until Pipeline commits the accepted batch and its availability nodes.
export class AccountExecution {
  constructor({ store, document, height, read, executionHeight = height, mergeManifest }) {
    Object.assign(this, { store, document, height, read, executionHeight, mergeManifest }); this.settings = accountSettings(document); this.accepted = new Map();
    this.availability = new AccountAvailability(store); this.changed = new Map(); this.balances = new Map(); this.operations = []; this.assetTouches = 0;
  }
  get(key) { return this.changed.has(key) ? this.changed.get(key) : this.store.get('accountRecords', key); }
  async base(key) {
    if (!this.accepted.has(key)) this.accepted.set(key, this.store.hasOverlay?.('accountRecords', key) || !this.read ?
      this.store.get('accountRecords', key) : await this.read(key));
    return this.accepted.get(key);
  }
  async getAsync(key) { return this.changed.has(key) ? this.changed.get(key) : this.base(key); }
  adapter() { return { get: key => this.getAsync(key), put: (key, value) => this.changed.set(key, value), del: key => this.changed.set(key, null) }; }
  async beacon(operation, deployment) {
    await applyBeaconRecovery(this.adapter(), operation, { ...deployment.beacon, poster: null, integerVersion: 2, settings: this.settings });
    this.operations.push(operation); return operation;
  }
  async accounts(actions) {
    const owners = new Map(), supplyKeys = new Set();
    const touch = (owner, kind, id) => { const keys = owners.get(owner) ?? new Set(); keys.add(accountKey(kind, id)); owners.set(owner, keys); };
    const balance = (owner, asset, supply = false) => { this.balances.set(owner + '/' + asset, { owner, asset }); touch(owner, 'balance', asset); if (supply) supplyKeys.add(accountKey('supply', asset)); };
    for (const a of actions) {
      if (['transfer', 'craft', 'reserve', 'lock'].includes(a.type)) touch(a.owner, 'nonce', a.nonce);
      if (a.type === 'compound-merge') {
        const manifest = rules.compoundMergeManifest(this.document.network, this.executionHeight, this.mergeManifest);
        if (!manifest) throw Error('compound_merge_authorization');
        for (const row of manifest.rows) { balance(row.holder, row.oldId, true); balance(row.holder, row.newId, true); }
      } else if (a.type === 'credits') for (const [asset] of a.assets) balance(a.owner, asset, true);
      else if (a.type === 'craft') for (const [asset] of [...a.in, ...a.out]) balance(a.owner, asset, true);
      else if (['credit', 'transfer', 'reserve', 'lock'].includes(a.type)) {
        balance(a.owner, a.asset, a.type === 'credit'); if (a.type === 'transfer') balance(a.to, a.asset);
      } else if (['consume', 'refund'].includes(a.type)) {
        const obligation = await this.getAsync('ao/' + a.id); if (!obligation) throw Error('obligation_missing');
        balance(obligation.owner, obligation.asset, a.type === 'consume');
      } else if (['claim-lock', 'refund-lock'].includes(a.type)) {
        const lock = await this.getAsync('al/' + a.id); if (!lock) throw Error('account_lock_missing');
        for (const [asset] of lock.assets ?? [[lock.asset, lock.amount]]) {
          balance(lock.owner, asset); balance(a.type === 'refund-lock' ? lock.owner : lock.to, asset);
        }
      } else throw Error('account_action');
    }
    const accounts = [];
    for (const [owner, keys] of [...owners].sort(([a], [b]) => a < b ? -1 : 1)) {
      const record = await this.getAsync('ar/' + owner) ?? { root: EMPTY_ACCOUNT_ROOT, revision: '0' };
      accounts.push({ owner, revision: record.revision, proof: record.root === EMPTY_ACCOUNT_ROOT ? { empty: true } : this.availability.prove(record.root, [...keys]) });
    }
    const supply = await this.getAsync('ar/supply') ?? { root: EMPTY_ACCOUNT_ROOT, revision: '0' };
    const operation = { op: 'ar', v: 2, actions, accounts, supply: { revision: supply.revision,
      proof: supplyKeys.size ? this.availability.prove(supply.root, [...supplyKeys]) : { leaves: [], nodes: [] } },
      availability: rules.hashObject(['dmw-account-availability-v2', actions, accounts]) };
    const applied = await applyRootAccounts(this.adapter(), operation, { network: this.document.network, height: this.height, executionHeight: this.executionHeight, mergeManifest: this.mergeManifest, settings: this.settings,
      capture: (_, root, proof, replacements) => this.availability.update(root, proof, replacements, this.settings) });
    this.assetTouches += applied.assetTouches;
    this.operations.push(operation); return operation;
  }
  async payment(input) {
    let operation = structuredClone(input);
    if (['page', 'surplus'].includes(operation.type)) {
      const funding = await this.getAsync('fp/' + operation.id), usage = await this.getAsync('fp/usage') ?? { root: EMPTY_ACCOUNT_ROOT, revision: '0' };
      if (!funding) throw Error('funding_missing');
      operation = { ...operation, sequence: funding.sequence, previous: funding.root, revision: usage.revision,
        proof: this.availability.prove(usage.root, operation.items.map(i => accountKey('payment', i.key))) };
    }
    await applyPaymentPage(this.adapter(), operation, { network: this.document.network, height: this.height, settings: this.settings,
      capture: (root, proof, replacements) => this.availability.update(root, proof, replacements, this.settings) });
    this.assetTouches += operation.proof?.leaves.length ?? 0;
    this.operations.push(operation); return operation;
  }
  result() {
    const publicWrites = publicAccountWrites({ store: this.store, get: key => this.get(key), availability: this.availability, balances: this.balances.values() });
    return { operations: this.operations, assetTouches: this.assetTouches, writes: [...publicWrites, ...this.availability.writes(), ...[...this.changed].map(([id, value]) => ({ space: 'accountRecords', id, value }))] }; }
}
