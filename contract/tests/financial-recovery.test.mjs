import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, deployment, signedBatch, nonce, alice } from './helpers/harness.mjs';
import { checkpoint, chain, parseHeader } from './helpers/chain.mjs';
import { REGTEST_PARAMS, BitcoinBeacon } from '../beacon/bitcoin.js';
import { applyBeaconRecovery } from '../beacon/recovery.js';
import { accountKey, accountTree } from '../account-tree.js';
import { recoveryPageHash, recoveryEnd } from '../financial-lifecycle.js';
import { hashObject } from '../../rules/src/core.js';

for (const height of ['9007199254740992', '9223372036854775808', '1' + '0'.repeat(79)]) test(`recovery preserves decimal checkpoint height and revision ${height}`, async () => {
  const anchor = { ...checkpoint, height }, params = { ...REGTEST_PARAMS, interval: 4 }, db = new Map();
  const store = { get: async key => db.get(key), put: (key, value) => db.set(key, value), del: key => db.delete(key) };
  const beacon = new BitcoinBeacon(store, { checkpoint: anchor, params, integerVersion: 2 });
  await beacon.init(); assert.equal((await beacon.ingest(chain(2, anchor), null)).accepted, 2);
  db.set('b/rev', height); db.set('bt/last', { n: height });
  const previous = (await beacon.tip()).hash, id = nonce(80), alternative = chain(3, anchor, 601, 77), tip = parseHeader(alternative.at(-1)).hash;
  const key = accountKey('bitcoin-checkpoint', height), tree = accountTree(new Map([[key, anchor]]));
  db.set('s/beaconRecovery', { version: 2, archiveRoot: tree.root });
  const options = { checkpoint: anchor, params, integerVersion: 2 };
  await applyBeaconRecovery(store, { op: 'br', v: 2, type: 'begin', id, anchor, previous, proof: tree.prove([key]) }, options);
  await applyBeaconRecovery(store, { op: 'br', v: 2, type: 'append', id, sequence: '0', headers: alternative }, options);
  db.set('recoveryApproved/' + id, { root: nonce(81), previous, tip, lastBatch: height });
  await applyBeaconRecovery(store, { op: 'br', v: 2, type: 'adopt', id, previous, tip, reconciliation: nonce(81) }, options);
  const restored = new BitcoinBeacon(store, { ...options });
  assert.equal((await restored.tip()).height, (BigInt(height) + 3n).toString());
  assert.equal(await restored.revision(), (BigInt(height) + 1n).toString());
});

test('signed financial reconciliation unlocks pruned-ancestor checkpoint adoption without erasing orphan liabilities', async () => {
  const params = { ...REGTEST_PARAMS, interval: 4, branchDepth: 2 }, options = { ...deployment, beacon: { checkpoint, params } }, h = harness(options);
  await h.advance(16);
  const previous = (await h.state().head()).tip.hash, id = nonce(100), alternative = chain(18, checkpoint, 601, 77), tip = parseHeader(alternative.at(-1)).hash;
  assert.equal(await h.run('hd', { headers: alternative.slice(0, 2) }), 'header_parent');
  const key = accountKey('bitcoin-checkpoint', '0'), tree = accountTree(new Map([[key, checkpoint]]));
  h.db.set('s/beaconRecovery', { version: 2, archiveRoot: tree.root });
  h.db.set('s/assets', { version: 2, settings: { recoveryHeaders: 3, paymentPage: 2 } });
  const initialRoot = nonce(101);
  options.batchActivation = { sequence: 1, previousRoot: initialRoot, height: 16, hash: previous, ruleset: 'sc1', settingsRevision: nonce(102) };
  const batch = async ops => {
    const last = await h.state().batchLast(), head = await h.state().head(), n = last.n + 1;
    return h.run('bt', signedBatch({ v: 2, n, from: last.to, to: head.counted, previous: last.n ? h.db.get('bt/' + last.n) : initialRoot,
      ruleset: 'sc1', settingsRevision: nonce(102), execution: { height: head.tip.height, hash: head.tip.hash }, observation: n,
      receipts: nonce(103), finds: nonce(104), catalog: nonce(105), accounts: nonce(106), root: hashObject(['recovery-test', n, ops]), ops }, options));
  };
  const lifecycle = action => ({ op: 'fp', v: 2, id, type: 'lifecycle', action: { id, ...action }, evidence: nonce(107) });
  assert.equal(await batch([{ op: 'br', v: 2, type: 'begin', id, anchor: checkpoint, previous, proof: tree.prove([key]) }]), null);
  for (let i = 0; i < alternative.length; i += 3) assert.equal(await batch([{ op: 'br', v: 2, type: 'append', id, sequence: String(i / 3), headers: alternative.slice(i, i + 3) }]), null);
  const liabilityKey = 'fc/' + nonce(108), liability = { owner: alice.address, fees: [{ key: nonce(109), amount: '12' }], revision: '0' };
  h.db.set(liabilityKey, liability);
  const items = [{ key: liabilityKey, before: hashObject(liability), outcome: 'quarantine' }], manifest = recoveryPageHash(items, recoveryEnd);
  assert.equal(await batch([lifecycle({ type: 'recovery-begin', previous, tip, manifest, count: '1' })]), null);
  const before = structuredClone(h.db);
  assert.equal(await batch([lifecycle({ type: 'recovery-approve', batch: (await h.state().batchLast()).n })]), 'financial_recovery_incomplete');
  assert.deepEqual(h.db, before);
  assert.equal(await batch([lifecycle({ type: 'recovery-page', sequence: '0', items, next: recoveryEnd })]), null);
  assert.equal(await batch([lifecycle({ type: 'recovery-approve', batch: (await h.state().batchLast()).n })]), null);
  const approval = h.db.get('recoveryApproved/' + id), adopt = { op: 'br', v: 2, type: 'adopt', id, previous, tip, reconciliation: approval.root };
  assert.equal(approval.lastBatch, (await h.state().batchLast()).n);
  assert.equal(await batch([{ ...adopt, reconciliation: nonce(110) }]), 'recovery_reconciliation');
  assert.equal(await batch([adopt, lifecycle({ type: 'recovery-finish' })]), null);
  assert.equal((await h.state().head()).tip.hash, tip);
  assert.equal(await h.state().beacon().hashAt(1), parseHeader(alternative[0]).hash);
  assert.equal(h.db.get('fr/active'), null);
  assert.deepEqual(h.db.get(liabilityKey), liability);
  assert.equal(h.db.get('fq/' + liabilityKey).recovery, id);
  assert.equal(await batch([adopt]), 'recovery_state');
  await h.advance(1); assert.equal((await h.state().head()).tip.height, 19);
});
