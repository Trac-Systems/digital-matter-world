import { rules } from './rules.mjs';
import { check } from './util.mjs';

// The accepted notary read authenticates the two live pointers. Historical
// documents are immutable point reads, so a restart does not load all revisions.
export class StoredSettingsHistory {
  constructor(store) { this.store = store; this.validated = new Map(); }
  async refresh(accepted) {
    const current = rules.validateSettingsDocument(accepted.settings), scheduled = accepted.scheduledSettings ?? null;
    check(rules.hashObject(current) === accepted.settingsHash, 'settings_pin');
    if (scheduled) rules.settingsSuccessor(current, scheduled);
    const writes = [];
    for (const document of [current, ...(scheduled ? [scheduled] : [])]) {
      const id = rules.hashObject(document), old = this.store.get('settingsHistory', id);
      if (old) check(rules.hashObject(old) === id, 'settings_history_corrupt');
      else writes.push({ space: 'settingsHistory', id, value: document });
    }
    if (writes.length) await this.store.transact(writes);
    this.current = current; this.scheduled = scheduled;
  }
  // Documents are immutable by hash: validate each once. Every admitted move
  // reads its settings revision; re-hashing and re-validating per move cost
  // the gateway's main thread seconds per batch.
  get(hash) {
    const known = this.validated.get(hash); if (known) return known;
    const document = this.store.get('settingsHistory', hash);
    check(document && rules.hashObject(document) === hash, 'settings_unknown');
    const valid = rules.validateSettingsDocument(document);
    if (this.validated.size >= 64) this.validated.delete(this.validated.keys().next().value);
    this.validated.set(hash, valid); return valid;
  }
  at(batch, window) { return rules.effectiveSettings(this.current, this.scheduled, batch, window); }
}
