import { ed25519 } from '@noble/curves/ed25519';
import { sha256, utf8ToBytes, hexToBytes, bytesToHex, canonicalJSON, jsonBytes } from './signing.js';
import { accountKey, EMPTY_ACCOUNT_ROOT, verifyAccountProof } from './account-tree.js';
import { assetSettings } from './asset-settings.js';
import { financialUnfrozen } from './financial-lifecycle.js';
import { ordinalCodec } from '../rules/src/integers-v2.js';

const check = (ok, reason) => { if (!ok) throw Error(reason); };
const hex = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x);
const positive = x => uint(x) && x !== '0';
const asset = x => typeof x === 'string' && (/^[0-9a-z]{1,24}$/.test(x) || /^p2:(0|[1-9][0-9]*)$/.test(x) || /^c2:[0-9a-f]{64}$/.test(x));
const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
export const accountActionDigest = (network, action) => {
  const { sig, ...unsigned } = action;
  return sha256(utf8ToBytes('dmw-account-action-v2|' + network + '|' + canonicalJSON(unsigned)));
};

// Called only inside an authenticated, version-2 notary batch. It derives the
// updates from actions, rather than trusting caller-supplied replacement roots.
// One root/revision per touched agent and one supply root are written. Nonces
// live inside account trees; unresolved obligations remain separately addressable.
export async function applyRootAccounts(store, operation, { network, height, settings = {}, capture = null }) {
  const limits = assetSettings(settings), clock = ordinalCodec(typeof height === 'string');
  await financialUnfrozen(store, [
    ...(operation?.accounts?.map(a => 'ar/' + a.owner) ?? []), 'ar/supply',
    ...(operation?.actions?.filter(a => a.id).flatMap(a => ['ao/' + a.id, 'al/' + a.id]) ?? []),
  ]);
  check(operation?.v === 2 && operation.op === 'ar' && Array.isArray(operation.actions) && operation.actions.length > 0 && operation.actions.length <= limits.actions &&
    Array.isArray(operation.accounts) && operation.supply && hex(operation.availability), 'account_operation');
  check(jsonBytes(operation) <= limits.proofBytes, 'account_operation_bytes');
  const accounts = new Map(), supplyChanges = new Map(), obligations = new Map(), locks = new Map();
  for (const packet of operation.accounts) {
    check(hex(packet.owner) && uint(packet.revision) && !accounts.has(packet.owner), 'account_owner');
    const current = await store.get('ar/' + packet.owner) ?? { revision: '0', root: EMPTY_ACCOUNT_ROOT };
    check(current.revision === packet.revision, 'account_revision');
    const empty = packet.proof?.empty === true;
    check(!empty || current.root === EMPTY_ACCOUNT_ROOT && Object.keys(packet.proof).length === 1, 'account_empty_proof');
    accounts.set(packet.owner, { packet, current, empty, updates: new Map(), old: new Map((packet.proof.leaves ?? []).map(l => [l.key, l.value])) });
  }
  const account = owner => { const a = accounts.get(owner); check(a, 'account_missing'); return a; };
  const read = (a, key) => { check(a.empty || a.old.has(key), 'account_leaf_missing'); return a.updates.has(key) ? a.updates.get(key) : a.old.get(key) ?? null; };
  const change = (owner, name, available, held = 0n) => {
    check(asset(name), 'account_asset');
    const a = account(owner), key = accountKey('balance', name), old = read(a, key) ?? { available: '0', held: '0' };
    check(uint(old.available) && uint(old.held) && Object.keys(old).length === 2, 'account_balance');
    const next = { available: (BigInt(old.available) + available).toString(), held: (BigInt(old.held) + held).toString() };
    check(uint(next.available) && uint(next.held), 'account_insufficient');
    a.updates.set(key, next.available === '0' && next.held === '0' ? null : next);
  };
  const supply = (name, issued, burned = 0n) => {
    const prior = supplyChanges.get(name) ?? { issued: 0n, burned: 0n };
    supplyChanges.set(name, { issued: prior.issued + issued, burned: prior.burned + burned });
  };
  const authorize = action => {
    const a = account(action.owner);
    check(action.revision === a.current.revision && hex(action.nonce) && clock.valid(action.until) && clock.compare(height, action.until) <= 0 &&
      typeof action.sig === 'string' && /^[0-9a-f]{128}$/.test(action.sig) && ed25519.verify(action.sig, accountActionDigest(network, action), action.owner, { zip215: false }), 'account_signature');
    const key = accountKey('nonce', action.nonce); check(read(a, key) === null, 'account_replay'); a.updates.set(key, 'used');
  };
  const obligation = async id => {
    check(hex(id), 'obligation_id');
    if (!obligations.has(id)) obligations.set(id, await store.get('ao/' + id));
    return obligations.get(id);
  };
  const pair = (owner, name, amount, sign) => { check(positive(amount), 'account_amount'); change(owner, name, BigInt(amount) * sign); };
  for (const action of operation.actions) {
    if (action.type === 'credit') {
      pair(action.owner, action.asset, action.amount, 1n); supply(action.asset, BigInt(action.amount));
    } else if (action.type === 'credits') {
      check(Array.isArray(action.assets) && action.assets.length > 0 && action.assets.length <= limits.accountLeaves, 'account_credits');
      for (const [name, amount] of action.assets) { pair(action.owner, name, amount, 1n); supply(name, BigInt(amount)); }
    } else if (action.type === 'transfer') {
      authorize(action); pair(action.owner, action.asset, action.amount, -1n); pair(action.to, action.asset, action.amount, 1n);
    } else if (action.type === 'craft') {
      authorize(action);
      check(Array.isArray(action.in) && action.in.length && Array.isArray(action.out) && action.out.length, 'account_craft');
      for (const [name, amount] of action.in) { pair(action.owner, name, amount, -1n); supply(name, 0n, BigInt(amount)); }
      for (const [name, amount] of action.out) { pair(action.owner, name, amount, 1n); supply(name, BigInt(amount)); }
    } else if (action.type === 'reserve') {
      authorize(action); check(!await obligation(action.id) && positive(action.amount) && hex(action.terms), 'obligation_exists');
      change(action.owner, action.asset, -BigInt(action.amount), BigInt(action.amount));
      obligations.set(action.id, { state: 'reserved', owner: action.owner, asset: action.asset, amount: action.amount, terms: action.terms });
    } else if (action.type === 'lock') {
      authorize(action);
      check(hex(action.id) && hex(action.to) && hex(action.hash) && positive(action.amount) && clock.valid(action.refund) &&
        clock.compare(action.refund, clock.add(height, limits.lockMin)) >= 0 && clock.compare(action.refund, clock.add(height, limits.lockMax)) <= 0 &&
        !locks.has(action.id) && !await store.get('al/' + action.id), 'account_lock');
      change(action.owner, action.asset, -BigInt(action.amount), BigInt(action.amount));
      locks.set(action.id, { state: 'locked', owner: action.owner, to: action.to, asset: action.asset, amount: action.amount, hash: action.hash, refund: action.refund });
    } else if (['claim-lock', 'refund-lock'].includes(action.type)) {
      check(hex(action.id), 'account_lock');
      const lock = locks.has(action.id) ? locks.get(action.id) : await store.get('al/' + action.id);
      check(lock?.state === 'locked', 'account_lock_terminal');
      const refund = action.type === 'refund-lock';
      check(refund ? clock.compare(height, lock.refund) >= 0 : clock.compare(height, lock.refund) < 0 && hex(action.preimage) && bytesToHex(sha256(hexToBytes(action.preimage))) === lock.hash, 'account_lock_proof');
      for (const [name, amount] of lock.assets ?? [[lock.asset, lock.amount]]) {
        change(lock.owner, name, 0n, -BigInt(amount));
        change(refund ? lock.owner : lock.to, name, BigInt(amount));
      }
      locks.set(action.id, { ...lock, state: refund ? 'refunded' : 'claimed' });
    } else if (['consume', 'refund'].includes(action.type)) {
      const old = await obligation(action.id);
      check(old?.state === 'reserved' && hex(action.evidence), 'obligation_terminal');
      // The quorum independently proves the exit (including external refund or
      // recoverable authorization); elapsed time alone is never evidence.
      check(action.terms === old.terms, 'obligation_terms');
      const funding = await store.get('fp/' + action.id);
      if (action.type === 'consume') check(funding?.state === 'consumed' && funding.owner === old.owner &&
        funding.terms === old.terms && funding.permitHash === action.permitHash, 'obligation_funding');
      else if (funding) check(['credited', 'refunded'].includes(funding.state) && funding.owner === old.owner && funding.terms === old.terms, 'obligation_funding');
      if (action.type === 'consume' && await store.get('fd/asset/' + old.asset)) {
        const capacity = await store.get('dc/' + action.id);
        check(capacity?.state === 'reserved' && capacity.asset === old.asset && capacity.amount === old.amount && capacity.terms === old.terms, 'obligation_capacity');
      }
      change(old.owner, old.asset, action.type === 'refund' ? BigInt(old.amount) : 0n, -BigInt(old.amount));
      if (action.type === 'consume') { check(hex(action.permitHash), 'obligation_permit'); supply(old.asset, 0n, BigInt(old.amount)); }
      obligations.set(action.id, { ...old, state: action.type === 'refund' ? 'refunded' : 'consumed', evidence: action.evidence,
        ...(action.type === 'consume' ? { permitHash: action.permitHash } : {}) });
    } else throw Error('account_action');
  }
  const touches = [...accounts.values()].reduce((n, a) => n + a.updates.size, 0);
  check(touches <= limits.accountLeaves, 'account_leaf_budget');
  const writes = [];
  for (const [owner, a] of accounts) {
    check(a.updates.size > 0, 'account_untouched');
    const root = verifyAccountProof(a.current.root, a.packet.proof, a.updates, limits);
    writes.push(['ar/' + owner, { root, revision: (BigInt(a.current.revision) + 1n).toString() }]);
  }
  const currentSupply = await store.get('ar/supply') ?? { root: EMPTY_ACCOUNT_ROOT, revision: '0' };
  check(operation.supply.revision === currentSupply.revision, 'supply_revision');
  const supplyOld = new Map(operation.supply.proof.leaves.map(l => [l.key, l.value])), supplyUpdates = new Map();
  for (const [name, delta] of supplyChanges) {
    const key = accountKey('supply', name); check(supplyOld.has(key), 'supply_leaf_missing');
    const old = supplyOld.get(key) ?? { issued: '0', burned: '0' };
    check(uint(old.issued) && uint(old.burned) && Object.keys(old).length === 2, 'supply_value');
    const next = { issued: (BigInt(old.issued) + delta.issued).toString(), burned: (BigInt(old.burned) + delta.burned).toString() };
    check(BigInt(next.issued) >= BigInt(next.burned), 'supply_conservation'); supplyUpdates.set(key, next);
  }
  if (supplyUpdates.size) {
    const root = verifyAccountProof(currentSupply.root, operation.supply.proof, supplyUpdates, limits);
    writes.push(['ar/supply', { root, revision: (BigInt(currentSupply.revision) + 1n).toString() }]);
  } else check(equal(operation.supply.proof, { leaves: [], nodes: [] }), 'supply_untouched');
  // No partial writes on any invalid proof, including a late supply failure.
  if (capture) {
    for (const [owner, a] of accounts) capture(owner, a.current.root, a.packet.proof, a.updates);
    if (supplyUpdates.size) capture('supply', currentSupply.root, operation.supply.proof, supplyUpdates);
  }
  for (const [key, value] of writes) store.put(key, value);
  for (const [id, value] of obligations) store.put('ao/' + id, value);
  for (const [id, value] of locks) store.put('al/' + id, value);
  store.put('ar/availability', operation.availability);
  return { accounts: accounts.size, assetTouches: touches, obligations: obligations.size, writes: writes.length + obligations.size + locks.size + 1 };
}
