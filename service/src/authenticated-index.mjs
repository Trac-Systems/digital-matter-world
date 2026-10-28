import { hash, check } from './util.mjs';

// An AVL map in the same SQLite transaction as its source records. Proofs
// expose hashes, never unrelated values. SQL read transactions pin old roots
// and nodes while the writer continues under WAL.
export const EMPTY_ROOT = hash('dmw-evidence-map-v2/empty');
const nodeHash = (key, valueHash, left, right) => hash(JSON.stringify(['dmw-evidence-map-v2', key, valueHash, left, right]));
export const evidenceKey = (space, id) => Buffer.from(space).toString('hex') + '/' + Buffer.from(String(id)).toString('hex');
export class AuthenticatedIndex {
  constructor(db) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS evidence_nodes(key TEXT PRIMARY KEY,valueHash TEXT NOT NULL,l TEXT,r TEXT,height INTEGER NOT NULL,hash TEXT NOT NULL) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS evidence_root(id INTEGER PRIMARY KEY,key TEXT); INSERT OR IGNORE INTO evidence_root VALUES(1,NULL)');
    this.read = db.prepare('SELECT * FROM evidence_nodes WHERE key=?');
    this.write = db.prepare('INSERT OR REPLACE INTO evidence_nodes VALUES(?,?,?,?,?,?)');
  }
  get(key) { return key === null ? null : this.read.get(key); }
  rootKey() { return this.db.prepare('SELECT key FROM evidence_root WHERE id=1').get().key; }
  root() { return this.get(this.rootKey())?.hash ?? EMPTY_ROOT; }
  save(n) {
    const l = this.get(n.l), r = this.get(n.r);
    n.height = 1 + Math.max(l?.height ?? 0, r?.height ?? 0);
    n.hash = nodeHash(n.key, n.valueHash, l?.hash ?? EMPTY_ROOT, r?.hash ?? EMPTY_ROOT);
    this.write.run(n.key, n.valueHash, n.l, n.r, n.height, n.hash); return n;
  }
  rotate(n, left) {
    const child = this.get(left ? n.r : n.l);
    if (left) { n.r = child.l; this.save(n); child.l = n.key; }
    else { n.l = child.r; this.save(n); child.r = n.key; }
    return this.save(child);
  }
  balance(n) {
    this.save(n);
    const l = this.get(n.l), r = this.get(n.r), delta = (l?.height ?? 0) - (r?.height ?? 0);
    if (delta > 1) {
      if ((this.get(l.l)?.height ?? 0) < (this.get(l.r)?.height ?? 0)) n.l = this.rotate(l, true).key;
      return this.rotate(n, false);
    }
    if (delta < -1) {
      if ((this.get(r.r)?.height ?? 0) < (this.get(r.l)?.height ?? 0)) n.r = this.rotate(r, false).key;
      return this.rotate(n, true);
    }
    return n;
  }
  set(key, valueHash) {
    const change = root => {
      const n = this.get(root);
      if (!n) return valueHash === null ? null : this.save({ key, valueHash, l: null, r: null }).key;
      if (key < n.key) n.l = change(n.l);
      else if (key > n.key) n.r = change(n.r);
      else if (valueHash !== null) n.valueHash = valueHash;
      else {
        if (!n.l || !n.r) { this.db.prepare('DELETE FROM evidence_nodes WHERE key=?').run(n.key); return n.l ?? n.r; }
        // Move the successor node, retaining its key and committed value.
        const removeMin = root => {
          const a = this.get(root);
          if (!a.l) return { min: a, root: a.r };
          const result = removeMin(a.l); a.l = result.root;
          return { min: result.min, root: this.balance(a).key };
        };
        const result = removeMin(n.r), successor = result.min;
        this.db.prepare('DELETE FROM evidence_nodes WHERE key=?').run(n.key);
        successor.l = n.l; successor.r = result.root; return this.balance(successor).key;
      }
      return this.balance(n).key;
    };
    this.db.prepare('UPDATE evidence_root SET key=? WHERE id=1').run(change(this.rootKey()));
  }
  proof(lower, upper, maxNodes) {
    let count = 0; const nodes = [];
    const visit = (key, lo, hi) => {
      if (key === null) return null;
      check(++count <= maxNodes, 'evidence_proof_budget');
      const n = this.get(key);
      if (hi !== null && hi <= lower || lo !== null && lo >= upper) return n.hash;
      const row = [n.key, n.valueHash, visit(n.l, lo, n.key), visit(n.r, n.key, hi)];
      nodes.push(row); return nodes.length - 1;
    };
    const root = visit(this.rootKey(), null, null);
    return { version: 2, root, nodes };
  }
}
export function verifyRange(root, lower, upper, proof, maxNodes) {
  // Postorder references keep wire depth constant as the index grows. Every
  // expanded node must be reachable exactly once; only out-of-range subtrees
  // may be replaced by hashes. Absence has the same coverage check as presence.
  if (proof?.version === 2) {
    check(Array.isArray(proof.nodes) && proof.nodes.length <= maxNodes, 'evidence_proof_budget');
    const seen = new Set(), hashes = [], leaves = []; let count = 0;
    const stack = [{ ref: proof.root, parent: proof.nodes.length, lo: null, hi: null }];
    while (stack.length) {
      const item = stack.pop(), { ref, parent, lo, hi } = item;
      if (item.finish) {
        const [key, value, l, r] = proof.nodes[ref];
        const digest = child => child === null ? EMPTY_ROOT : typeof child === 'string' ? child : hashes[child];
        hashes[ref] = nodeHash(key, value, digest(l), digest(r)); continue;
      }
      if (ref === null) continue;
      check(++count <= maxNodes, 'evidence_proof_budget');
      if (typeof ref === 'string') {
        check(/^[0-9a-f]{64}$/.test(ref) && (hi !== null && hi <= lower || lo !== null && lo >= upper), 'evidence_proof_gap'); continue;
      }
      check(Number.isSafeInteger(ref) && ref >= 0 && ref < parent && !seen.has(ref), 'evidence_proof'); seen.add(ref);
      const row = proof.nodes[ref];
      check(Array.isArray(row) && row.length === 4 && typeof row[0] === 'string' && /^[0-9a-f]{64}$/.test(row[1]) &&
        (lo === null || row[0] > lo) && (hi === null || row[0] < hi), 'evidence_proof');
      if (row[0] >= lower && row[0] <= upper) leaves.push([row[0], row[1]]);
      stack.push({ ...item, finish: true }, { ref: row[3], parent: ref, lo: row[0], hi }, { ref: row[2], parent: ref, lo, hi: row[0] });
    }
    check(seen.size === proof.nodes.length, 'evidence_proof');
    check((proof.root === null ? EMPTY_ROOT : hashes[proof.root]) === root, 'evidence_proof_root');
    return leaves.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  }
  const leaves = []; let count = 0;
  const visit = (p, lo, hi) => {
    if (p === null) return EMPTY_ROOT;
    check(++count <= maxNodes, 'evidence_proof_budget');
    if (typeof p === 'string') {
      check(/^[0-9a-f]{64}$/.test(p) && (hi !== null && hi <= lower || lo !== null && lo >= upper), 'evidence_proof_gap'); return p;
    }
    check(Array.isArray(p) && p.length === 4 && typeof p[0] === 'string' && /^[0-9a-f]{64}$/.test(p[1]) &&
      (lo === null || p[0] > lo) && (hi === null || p[0] < hi), 'evidence_proof');
    const l = visit(p[2], lo, p[0]);
    if (p[0] >= lower && p[0] <= upper) leaves.push([p[0], p[1]]);
    const r = visit(p[3], p[0], hi); return nodeHash(p[0], p[1], l, r);
  };
  check(visit(proof, null, null) === root, 'evidence_proof_root'); return leaves;
}
