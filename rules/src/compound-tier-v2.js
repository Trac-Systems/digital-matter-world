import { assert, hashObject } from './core.js';
import { uintV2, nextUint } from './integers-v2.js';
import { exactGet, exactSet } from './compounds-v2.js';

// Little-endian base-2^24 limbs are an encoding, not a precision ceiling.
// Each multiplication step touches two operand limbs and one result limb. Products,
// traversal stacks and comparison positions persist under the catalog root.
const BASE = 1n << 24n;
const get = (s, k) => exactGet(s, 'work', k);
const put = (s, k, v) => exactSet(s, 'work', k, v);
const limb = (s, id, i) => BigInt(get(s, `limb/${id}/${i}`) ?? '0');
function scalar(s, value) {
  uintV2(value); const id = hashObject(['compound-integer-limbs-v2', value]);
  if (!get(s, `integer/${id}`)) {
    let n = BigInt(value), length = 0n;
    do { put(s, `limb/${id}/${length++}`, String(n % BASE)); n /= BASE; } while (n);
    put(s, `integer/${id}`, { length: String(length) });
  }
  return id;
}
function multiply(s, a, b) {
  const id = hashObject(['compound-multiply-limbs-v2', a, b]);
  if (get(s, `integer/${id}`)) return id;
  const A = BigInt(get(s, `integer/${a}`).length), B = BigInt(get(s, `integer/${b}`).length);
  const saved = get(s, `multiply/${id}`) ?? { i: '0', j: '0', carry: '0', trim: null };
  const p = { ...saved }, i = BigInt(p.i), j = BigInt(p.j);
  if (i < A) {
    if (j < B) {
      const value = limb(s, id, i + j) + limb(s, a, i) * limb(s, b, j) + BigInt(p.carry);
      put(s, `limb/${id}/${i + j}`, String(value % BASE)); p.carry = String(value / BASE); p.j = String(j + 1n);
    } else {
      put(s, `limb/${id}/${i + B}`, p.carry); p.i = String(i + 1n); p.j = '0'; p.carry = '0';
    }
  } else {
    const length = p.trim === null ? A + B : BigInt(p.trim);
    if (length > 1n && limb(s, id, length - 1n) === 0n) p.trim = String(length - 1n);
    else { put(s, `integer/${id}`, { length: String(length) }); return id; }
  }
  put(s, `multiply/${id}`, p); return null;
}
function evaluateStep(s, root) {
  const done = get(s, `fraction/${root}`); if (done) return { done };
  const node = exactGet(s, 'nodes', root); assert(node, 'exact_fraction_unknown');
  if (node.op === 'fraction') {
    const value = { n: scalar(s, node.n), d: scalar(s, node.d) };
    put(s, `fraction/${root}`, value); return { done: value };
  }
  assert(node.op === 'product', 'exact_fraction_unknown');
  const p = { ...(get(s, `evaluate/${root}`) ?? { term: 0, power: '0', phase: 'n', n: scalar(s, '1'), d: scalar(s, node.divisor) }) };
  if (p.term === node.terms.length) { const value = { n: p.n, d: p.d }; put(s, `fraction/${root}`, value); return { done: value }; }
  const term = node.terms[p.term], child = get(s, `fraction/${term.root}`);
  if (!child) return { needed: term.root };
  const value = multiply(s, p[p.phase], child[p.phase]);
  if (value) {
    p[p.phase] = value;
    if (p.phase === 'n') p.phase = 'd';
    else { p.phase = 'n'; p.power = nextUint(p.power); if (p.power === term.power) { p.term++; p.power = '0'; } }
    put(s, `evaluate/${root}`, p);
  }
  return {};
}
export function compoundTierProgress(state, asset) {
  const record = exactGet(state, 'assets', asset); assert(record, 'compound_input_unknown');
  return exactGet(state, 'tiers', asset) ?? { cursor: '0', value: record.tier.value, phase: record.tier.value === null ? 'evaluate' : 'complete', depth: '0', threshold: 0, compare: null, left: null, right: null };
}
export function advanceCompoundTier(state, { asset, cursor, steps, settings }) {
  const record = exactGet(state, 'assets', asset); assert(record, 'compound_input_unknown');
  uintV2(cursor); assert(Number.isSafeInteger(steps) && steps > 0 && steps <= settings.values.compoundWorkBudget, 'compound_work_budget');
  const previous = compoundTierProgress(state, asset);
  assert(previous.cursor === cursor, 'compound_tier_cursor'); assert(previous.value === null, 'compound_tier_complete');
  const next = { ...state }, p = { ...previous }, expression = record.tier.expression;
  let performed = 0;
  for (; performed < steps && p.value === null; performed++) {
    if (p.phase === 'evaluate') {
      const root = p.depth === '0' ? expression.fraction : get(next, `stack/${asset}/${p.depth}`);
      const result = evaluateStep(next, root);
      if (result.needed) { p.depth = nextUint(p.depth); put(next, `stack/${asset}/${p.depth}`, result.needed); }
      else if (result.done) {
        if (p.depth !== '0') p.depth = String(BigInt(p.depth) - 1n);
        else p.phase = 'left';
      }
    } else if (p.phase === 'left') {
      const f = get(next, `fraction/${expression.fraction}`);
      p.left = multiply(next, f.n, scalar(next, expression.historyLength));
      if (p.left) p.phase = 'right';
    } else if (p.phase === 'right') {
      const f = get(next, `fraction/${expression.fraction}`);
      p.right = multiply(next, f.d, scalar(next, expression.thresholds[p.threshold]));
      if (p.right) { p.phase = 'compare'; p.compare = get(next, `integer/${p.left}`).length; }
    } else {
      const leftLength = get(next, `integer/${p.left}`).length, rightLength = get(next, `integer/${p.right}`).length;
      let comparison;
      if (leftLength !== rightLength) comparison = BigInt(leftLength) < BigInt(rightLength) ? -1 : 1;
      else if (p.compare === '0') comparison = 0;
      else {
        p.compare = String(BigInt(p.compare) - 1n);
        const a = limb(next, p.left, p.compare), b = limb(next, p.right, p.compare);
        if (a !== b) comparison = a < b ? -1 : 1;
      }
      if (comparison !== undefined) {
        if (comparison <= 0) p.value = 5 - p.threshold;
        else if (++p.threshold === expression.thresholds.length) p.value = 1;
        else { p.phase = 'right'; p.right = null; p.compare = null; }
      }
    }
  }
  p.cursor = String(BigInt(cursor) + BigInt(performed));
  if (p.value !== null) p.phase = 'complete';
  exactSet(next, 'tiers', asset, p);
  return { state: next, progress: p };
}
