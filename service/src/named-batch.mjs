import { rules } from './rules.mjs';
import { NodeEvidence } from './node-evidence.mjs';

// Collect creation-time policy documents before replay. The actual executor
// collects touched index paths while doing its required first planning pass;
// executing every claim here too duplicated all occurrence-tree updates.
export function namedBatchEvidence({ store, state, entries, settings, settingsDocuments = [], batch, gateway, history, counted, renewal }) {
  const proof = new NodeEvidence(settings.values.proofBytes);
  const persistence = new rules.NamedStorage({ cacheSize: settings.values.proofDepth, get(id) {
    const row = store.get('namedNodes', id);
    proof.add(id, row);
    return row;
  } });
  const named = state.namedSnapshot ? persistence.load(state.namedSnapshot) : rules.emptyNamedDiscovery();
  const documents = [settings, ...settingsDocuments];
  const settingsHistory = { get(hash) {
    let d = documents.find(d => rules.hashObject(d) === hash);
    if (!d) { d = store.get('settingsHistory', hash); if (!d || rules.hashObject(d) !== hash) throw Error('settings_unknown'); documents.push(d); }
    return rules.validateSettingsDocument(d);
  } };
  for (const { move } of entries) if (move.v === 2) {
    settingsHistory.get(move.settingsHash);
    if (move.t === 'discovery-reveal-v2') {
      const commitment = rules.namedGet(named.records, `commit/${move.a}/${move.p.commitmentId}`);
      if (commitment) settingsHistory.get(commitment.settingsHash);
    }
  }
  // This is a bounded cache, not a lifetime/packet acceptance limit. The
  // executor streams omitted paths by hash from the accepted predecessor.
  return { ...proof.value(), settingsDocuments: documents.filter(d => rules.hashObject(d) !== rules.hashObject(settings)) };
}
