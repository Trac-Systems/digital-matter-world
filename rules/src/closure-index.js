// Ordered AVL index backed by the authenticated claim map. Nodes contain only
// child keys and subtree counts; even a popular slot never stores a whole pool.
export function orderedIndex(io, prefix) {
  const get = key => key === null ? null : io.get(`${prefix}/${key}`);
  const put = node => { io.set(`${prefix}/${node.key}`, node); return node; };
  const height = n => n?.height ?? 0, count = n => BigInt(n?.count ?? '0');
  const update = n => {
    const l = get(n.left), r = get(n.right);
    return put({ ...n, height: Math.max(height(l), height(r)) + 1, count: String(count(l) + count(r) + 1n) });
  };
  const left = n => {
    const r = get(n.right), base = update({ ...n, right: r.left });
    return update({ ...r, left: base.key });
  };
  const right = n => {
    const l = get(n.left), base = update({ ...n, left: l.right });
    return update({ ...l, right: base.key });
  };
  function insert(root, key) {
    let n = get(root);
    if (!n) return put({ key, left: null, right: null, height: 1, count: '1' }).key;
    if (key === n.key) return root;
    n = update(key < n.key ? { ...n, left: insert(n.left, key) } : { ...n, right: insert(n.right, key) });
    const l = get(n.left), r = get(n.right), balance = height(l) - height(r);
    if (balance > 1) { if (key > l.key) n = update({ ...n, left: left(l).key }); n = right(n); }
    if (balance < -1) { if (key < r.key) n = update({ ...n, right: right(r).key }); n = left(n); }
    return n.key;
  }
  return { insert, count: root => count(get(root)),
    // A continuation step touches one tree level (or one local rotation).
    // The path is authenticated hot state, never an unbounded ticket pool.
    insertion: (root, key) => ({ original: root, cursor: root, key, path: [], stage: 'walk', root: null }),
    insertStep(task) {
      if (task.stage === 'walk') {
        const n = get(task.cursor);
        if (!n) { task.root = put({ key: task.key, left: null, right: null, height: 1, count: '1' }).key; task.stage = 'unwind'; }
        else if (task.key === n.key) return { root: task.original };
        else { task.path.push(n.key); task.cursor = task.key < n.key ? n.left : n.right; }
      } else {
        let n = get(task.path.pop());
        n = update(task.key < n.key ? { ...n, left: task.root } : { ...n, right: task.root });
        const l = get(n.left), r = get(n.right), balance = height(l) - height(r);
        if (balance > 1) { if (task.key > l.key) n = update({ ...n, left: left(l).key }); n = right(n); }
        if (balance < -1) { if (task.key < r.key) n = update({ ...n, right: right(r).key }); n = left(n); }
        task.root = n.key;
      }
      return task.stage === 'unwind' && !task.path.length ? { root: task.root } : null;
    },
    selection: (root, rank) => ({ cursor: root, rank: String(rank) }),
    selectStep(task) {
      const n = get(task.cursor); if (!n) throw Error('closure_index_rank');
      const before = count(get(n.left)), rank = BigInt(task.rank);
      if (rank === before) return n.key;
      if (rank < before) task.cursor = n.left;
      else { task.rank = String(rank - before - 1n); task.cursor = n.right; }
      return null;
    }, at(root, rank) {
    rank = BigInt(rank);
    for (let n = get(root); n; ) {
      const before = count(get(n.left));
      if (rank === before) return n.key;
      if (rank < before) n = get(n.left); else { rank -= before + 1n; n = get(n.right); }
    }
    throw Error('closure_index_rank');
  } };
}
