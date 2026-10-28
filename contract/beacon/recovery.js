import { BitcoinBeacon, targetFromBits, MAINNET_PARAMS } from './bitcoin.js';
import { accountKey, readAccountLeaf } from '../account-tree.js';
import { canonicalJSON } from '../signing.js';
import { assetSettings } from '../asset-settings.js';
import { ordinalCodec, decimalV2 } from '../../rules/src/integers-v2.js';

const check = (ok, reason) => { if (!ok) throw Error(reason); };
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const scoped = (store, id) => ({ get: key => store.get('br/' + id + '/' + key), put: (key, value) => store.put('br/' + id + '/' + key, value), del: key => store.del('br/' + id + '/' + key) });

// Recovery is streamed under ordinary PoW/difficulty/MTP validation. Only an
// authenticated archived boundary is a starting point. The old chain and all
// financial records remain intact; adoption is an atomic namespace pointer.
export async function applyBeaconRecovery(store, op, { params = MAINNET_PARAMS, checkpoint, poster, settings = {}, integerVersion = 1 }) {
  const clock = ordinalCodec(integerVersion === 2);
  const limits = assetSettings(settings), policy = await store.get('s/beaconRecovery');
  check(policy?.version === 2 && hex(policy.archiveRoot), 'recovery_inactive');
  check(op?.op === 'br' && op.v === 2 && hex(op.id), 'recovery_operation');
  const key = 'br/' + op.id + '/meta', old = await store.get(key), live = new BitcoinBeacon(store, { params, checkpoint, integerVersion });
  if (op.type === 'begin') {
    check(!old && op.anchor && ordinalCodec(typeof op.anchor.height === 'string').valid(op.anchor.height) && BigInt(decimalV2(op.anchor.height)) % BigInt(params.interval) === 0n &&
      hex(op.anchor.hash) && targetFromBits(op.anchor.bits) && /^[1-9][0-9]*$/.test(op.anchor.chainwork), 'recovery_anchor');
    check(Array.isArray(op.proof?.leaves) && Array.isArray(op.proof?.nodes), 'recovery_anchor_proof');
    const proven = readAccountLeaf(policy.archiveRoot, op.proof, accountKey('bitcoin-checkpoint', String(op.anchor.height)), limits);
    check(canonicalJSON(proven) === canonicalJSON(op.anchor), 'recovery_anchor_proof');
    const previous = await live.tip(); check(op.previous === previous.hash, 'recovery_head');
    const stage = new BitcoinBeacon(scoped(store, op.id), { params, checkpoint: op.anchor, recovery: false, integerVersion }); await stage.init();
    store.put(key, { state: 'building', anchor: op.anchor, previous, sequence: '0' });
  } else {
    check(old?.state === 'building', 'recovery_state');
    const candidate = new BitcoinBeacon(scoped(store, op.id), { params, checkpoint: old.anchor, recovery: false, integerVersion });
    if (op.type === 'append') {
      check(op.sequence === old.sequence && Array.isArray(op.headers) && op.headers.length > 0 && op.headers.length <= limits.recoveryHeaders, 'recovery_sequence');
      // BitcoinBeacon has a legacy per-message limit; stream submessages while
      // preserving the configured aggregate budget and transition atomicity.
      for (let i = 0; i < op.headers.length; i += 20) {
        const result = await candidate.ingest(op.headers.slice(i, i + 20), poster); check(!result.error && result.accepted > 0, result.error ?? 'recovery_progress');
      }
      store.put(key, { ...old, sequence: (BigInt(old.sequence) + 1n).toString() });
    } else if (op.type === 'adopt') {
      const head = await live.tip(), tip = await candidate.tip(), current = await live.raw(head.hash), next = await candidate.raw(tip.hash);
      check(op.previous === head.hash && op.tip === tip.hash && BigInt(next.chainwork) > BigInt(current.chainwork), 'recovery_work');
      const approval = await store.get('recoveryApproved/' + op.id);
      // Independent reconciliation commits to the old/new heads and affected
      // obligations. A timeout or a supplied boolean cannot approve a reorg.
      check(hex(op.reconciliation) && approval?.root === op.reconciliation && approval.previous === head.hash && approval.tip === tip.hash &&
        clock.compare(approval.lastBatch, (await store.get('bt/last'))?.n ?? clock.zero) === 0, 'recovery_reconciliation');
      const target = scoped(store, op.id);
      target.put('b/cnt', clock.max(await live.countedHeight(), await candidate.countedHeight()));
      target.put('b/rev', clock.add(await live.revision()));
      store.put('b/recovery', { id: op.id, checkpoint: old.anchor, previous: head, tip, reconciliation: op.reconciliation });
      store.put(key, { ...old, state: 'adopted', tip, reconciliation: op.reconciliation });
    } else throw Error('recovery_type');
  }
}
