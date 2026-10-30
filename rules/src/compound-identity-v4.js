import { assert, hashObject } from './core.js';
import { decimalV2, uintV2 } from './integers-v2.js';

// Deployment placeholder. Set this ONE height in the coordinated release after
// refreshing the fixed conversion manifest. Never select a gate from a recipe's
// client-supplied snapshot: consensus uses the batch execution height.
export const COMPOUND_IDENTITY_V4_HEIGHT = '973829';
export const compoundIdentityV4Active = height => BigInt(decimalV2(height)) >= BigInt(COMPOUND_IDENTITY_V4_HEIGHT);
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

// Callers resolve legacy ledger aliases against authenticated pattern records
// before reaching here. Different ledger keys for one pattern add together.
export function compoundIdentityV4(recipe, inputs) {
  assert(['fusion', 'resonance'].includes(recipe) && Array.isArray(inputs) && inputs.length >= 2, 'recipe');
  const totals = new Map();
  for (const [asset, amount] of inputs) {
    assert(/^(p2:(0|[1-9][0-9]*)|c2:[0-9a-f]{64})$/.test(asset) && uintV2(amount) !== '0', 'compound_inputs');
    totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(amount));
  }
  const sorted = [...totals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  assert(sorted.length >= 2, 'compound_inputs');
  const scale = sorted.reduce((g, [, n]) => gcd(g, n), 0n);
  const identity = { v: 4, recipe, inputs: sorted.map(([asset, n]) => [asset, String(n / scale)]) };
  const commitment = hashObject(identity);
  return { identity, commitment, id: `c2:${commitment}`, amount: String(scale) };
}
export function compoundRecordCommitment(record) {
  return record.v === 4 ? compoundIdentityV4(record.recipe, record.inputs.map(p => [p.asset, p.amount])).commitment :
    hashObject({ v: record.v, recipe: record.recipe, inputs: record.inputs, snapshot: record.snapshot, settingsHash: record.settingsHash, properties: record.properties });
}
