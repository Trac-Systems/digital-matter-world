import { sha256, utf8ToBytes, bytesToHex, canonicalJSON } from './signing.js';
import { accountKey, accountTree } from './account-tree.js';
const check = (ok, reason) => { if (!ok) throw Error(reason); };

// Explicit offline migration, never a balance-read fallback. The terminal
// legacy snapshot must be complete and independently matched by the quorum.
// Financial originals are retained verbatim beside the generated roots.
export function buildAccountImport(records, height) {
  check(Number.isSafeInteger(height) && height >= 0 && records instanceof Map, 'account_import');
  const addresses = new Map(), data = new Map(), supplies = new Map(), payments = new Map(), obligations = [], locks = [], originals = [], escrow = new Map(), expectedEscrow = new Map();
  for (const [key, value] of records) if (/^a\/[0-9a-f]{64}$/.test(key)) {
    check(!addresses.has(String(value)), 'account_import_owner'); addresses.set(String(value), key.slice(2)); data.set(key.slice(2), new Map());
  }
  const owner = n => { const address = addresses.get(String(n)); check(address, 'account_import_owner'); return address; };
  const change = (n, asset, available, held = 0n) => {
    const entries = data.get(owner(n)), key = accountKey('balance', asset), old = entries.get(key) ?? { available: '0', held: '0' };
    check(available >= 0n && held >= 0n, 'account_import_amount');
    entries.set(key, { available: (BigInt(old.available) + available).toString(), held: (BigInt(old.held) + held).toString() });
    supplies.set(asset, (supplies.get(asset) ?? 0n) + available + held);
  };
  for (const [key, value] of records) {
    let match;
    if ((match = /^v\/([0-9]+)\/([0-9a-z]+)$/.exec(key))) change(match[1], match[2], BigInt(value));
    else if ((match = /^e\/([0-9]+)\/([0-9a-z]+)$/.exec(key))) for (const [expiry, amount] of value) {
      change(match[1], match[2], height > expiry ? BigInt(amount) : 0n, height > expiry ? 0n : BigInt(amount));
      const k = match[1] + '/' + match[2]; if (height <= expiry) escrow.set(k, (escrow.get(k) ?? 0n) + BigInt(amount));
    }
    else if ((match = /^rq\/n\/([0-9]+)\/([0-9a-f]{64})$/.exec(key))) data.get(owner(match[1])).set(accountKey('nonce', match[2]), 'used');
    else if ((match = /^pay\/([0-9a-f]{64})$/.exec(key))) {
      check(/^[1-9][0-9]*$/.test(value.total) && /^(0|[1-9][0-9]*)$/.test(value.used) && BigInt(value.used) <= BigInt(value.total), 'account_import_payment');
      payments.set(accountKey('payment', match[1]), value);
    }
    else if ((match = /^m\/([0-9a-f]{64})$/.exec(key))) {
      const live = value.s === 0 && (value.h || height <= value.e);
      if (live) { const k = value.o + '/' + value.asset; expectedEscrow.set(k, (expectedEscrow.get(k) ?? 0n) + BigInt(value.amount)); }
      obligations.push(['ao/' + match[1], { state: live ? 'reserved' : value.s === 1 ? 'consumed' : 'refunded', owner: owner(value.o),
        asset: value.asset, amount: value.amount, terms: match[1], ...(value.permitHash ? { permitHash: value.permitHash } : {}), legacy: value }]);
    } else if ((match = /^l\/([0-9a-f]{64})$/.exec(key))) {
      for (const [asset, amount] of value.assets) change(value.o, asset, 0n, BigInt(amount));
      locks.push(['al/' + match[1], { state: 'locked', owner: owner(value.o), to: owner(value.to), assets: value.assets, hash: value.hash, refund: value.refund, legacy: value }]);
    }
    if (/^(?:a|an|v|e|rq\/n|pay|m|l)\//.test(key)) originals.push([key, value]);
  }
  for (const key of new Set([...escrow.keys(), ...expectedEscrow.keys()])) check((escrow.get(key) ?? 0n) === (expectedEscrow.get(key) ?? 0n), 'account_import_escrow');
  const accounts = [...data].map(([address, leaves]) => ({ address, leaves, record: { root: accountTree(leaves).root, revision: '0' } }));
  const supplyLeaves = new Map([...supplies].map(([asset, amount]) => [accountKey('supply', asset), { issued: amount.toString(), burned: '0' }]));
  originals.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { version: 2, height, accounts, supply: { leaves: supplyLeaves, root: accountTree(supplyLeaves).root, revision: '0', meaning: 'outstanding_at_import' },
    payments: { leaves: payments, root: accountTree(payments).root, revision: '0' }, obligations, locks, originals,
    financialRoot: bytesToHex(sha256(utf8ToBytes('dmw-financial-import-v2|' + canonicalJSON({ height, records: originals })))) };
}
