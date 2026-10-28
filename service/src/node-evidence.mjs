import { rules } from './rules.mjs';
import { decodeNodeHints } from '../../rules/src/node-evidence.js';

// Exact touched hashes take priority over optional embedded rows. Both share
// one wire budget; an omitted hint or row only costs a later authenticated read.
export class NodeEvidence {
  constructor(limit, evidence = {}) {
    this.limit = limit; this.nodes = new Map(); this.sizes = new Map(); this.hints = new Set();
    this.bytes = Buffer.byteLength(rules.stableJSON({ nodes: [], hints: '' }));
    this.withHints = this.bytes <= limit;
    if (!this.withHints) this.bytes = 2;
    for (const id of decodeNodeHints(evidence.hints)) this.hint(id);
    for (const [id, row] of evidence.nodes ?? []) this.add(id, row);
  }
  hint(id) {
    if (this.hints.has(id)) return true;
    if (!this.withHints) return false;
    const size = 4 * (Math.ceil((this.hints.size + 1) * 32 / 3) - Math.ceil(this.hints.size * 32 / 3));
    while (this.nodes.size && this.bytes + size > this.limit) {
      const first = this.nodes.keys().next().value;
      this.bytes -= this.sizes.get(first); this.nodes.delete(first); this.sizes.delete(first);
    }
    if (this.bytes + size > this.limit) return false;
    this.hints.add(id); this.bytes += size; return true;
  }
  add(id, row) {
    if (!row || this.nodes.has(id) || !this.hint(id)) return;
    const size = Buffer.byteLength(rules.stableJSON([id, row])) + 1;
    if (this.bytes + size <= this.limit) { this.nodes.set(id, row); this.sizes.set(id, size); this.bytes += size; }
  }
  value() { return { nodes: [...this.nodes], ...(this.withHints ? { hints: Buffer.from([...this.hints].join(''), 'hex').toString('base64') } : {}) }; }
}
