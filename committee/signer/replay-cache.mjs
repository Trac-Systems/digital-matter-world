import { createHash } from 'node:crypto';

// One successful audit can supply only the deterministic replay result to its
// immediate prepare. Policy still rereads authority, accepted roots, settings,
// receipts, financial evidence and notary preflight; journal reservation is not
// cached. A changed context, proposal or independently verified branch misses.
export class AuditedReplay {
  constructor(replay) { this.replay = replay; }
  key(network, proposal, context) {
    if (!proposal.batch?.settingsHash) return null;
    const { history, hashAt, views, claimNode, namedNode, replayNodes, ...data } = context;
    const sources = views ?? context.inputs.map(() => ({ history, hashAt }));
    const anchors = context.inputs.map((input, i) => {
      const source = sources[i];
      return [source.history.length, source.hashAt(input.tip), source.hashAt(input.height)];
    });
    return createHash('sha256').update(JSON.stringify({ network, proposal, data, anchors })).digest('hex');
  }
  async run(network, proposal, context) {
    const key = this.key(network, proposal, context);
    if (key && this.saved?.key === key) { this.hits++; return structuredClone(this.saved.result); }
    const result = await this.replay(network, proposal, context);
    if (this.auditing && key) this.candidate = { key, result: structuredClone(result) };
    return result;
  }
  async audit(action) {
    this.saved = null; this.candidate = null; this.auditing = true; this.hits ??= 0;
    try { const result = await action(); this.saved = this.candidate; return result; }
    finally { this.auditing = false; this.candidate = null; }
  }
  clear() { this.saved = null; }
}
