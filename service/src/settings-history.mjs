import { rules } from './rules.mjs';
import { check } from './util.mjs';

// The accepted notary read authenticates the two live pointers. Historical
// documents are immutable point reads, so a restart does not load all revisions.
export class StoredSettingsHistory {
  constructor(store) { this.store = store; }
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
  get(hash) {
    const document = this.store.get('settingsHistory', hash);
    check(document && rules.hashObject(document) === hash, 'settings_unknown');
    return rules.validateSettingsDocument(document);
  }
  at(batch, window) { return rules.effectiveSettings(this.current, this.scheduled, batch, window); }
}
