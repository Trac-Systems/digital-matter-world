import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { hash } from '../src/util.mjs';
import { recoverPreparation, auditJournal } from '../scripts/recover-preparation.mjs';
import { Journal } from '../../committee/signer/journal.mjs';
import { batchFixture, network } from '../../committee/test/fixture.mjs';
import { temp } from './helpers.mjs';

async function fixture() {
  const data = await temp('st1-repair-'), { proposal } = batchFixture(), id = hash('session'), key = 'batch/0/1';
  const session = { id, proposal, stage: 'blocked', reason: 'prepare_incomplete', peers: ['s0','s1','s2'], failures: Array(3).fill('committee_host_signer_unavailable') };
  const store = await Store.open(data), draft = { execution: 95, proposal };
  await new Pipeline({ store, replay: {} }).saveDraft(draft); await store.put('ceremonies', key, session); const reference = store.get('meta', 'draft'); await store.close();
  const proofs = [];
  for (const member of session.peers) {
    const path = join(data, member + '.log'), journal = await new Journal(path, 'local-test', network, member).load();
    await journal.append('tip', { highestTip: 100 }); await journal.close();
    const proof = await auditJournal({ journal: path, member, session: id, key }), out = join(data, member + '.json');
    await writeFile(out, JSON.stringify(proof)); proofs.push(out);
  }
  return { data, id, key, session, reference, draft, options: { repo: resolve('.'), data, key, session: id, counted: 96, proofs, backup: join(data, 'backup.json') } };
}

test('offline dry run, atomic repair, original-byte preservation and guarded rollback', async () => {
  const f = await fixture(); assert.equal((await recoverPreparation(f.options)).mode, 'dry-run');
  let store = await Store.open(f.data); assert.deepEqual(store.get('ceremonies', f.key), f.session); await store.close();
  assert.equal((await recoverPreparation({ ...f.options, apply: true })).mode, 'applied');
  store = await Store.open(f.data);
  assert.deepEqual(store.get('ceremonies', f.key), { ...f.session, retryBusy: true });
  const next = store.get('meta', 'draft'), text = await readFile(join(f.data, 'drafts', next.external + '.json'), 'utf8');
  assert.equal(hash(text), next.external); assert.deepEqual(JSON.parse(text), { ...f.draft, execution: 96 }); await store.close();
  await unlink(join(f.data, 'drafts', f.reference.external + '.json')); // startup pruning must not break rollback
  const rollback = { ...f.options, rollback: f.options.backup };
  assert.equal((await recoverPreparation(rollback)).mode, 'rollback-dry-run');
  assert.equal((await recoverPreparation({ ...rollback, apply: true })).mode, 'rolled-back');
  store = await Store.open(f.data); assert.deepEqual(store.get('ceremonies', f.key), f.session); assert.deepEqual(store.get('meta', 'draft'), f.reference); await store.close();
  assert.equal(hash(await readFile(join(f.data, 'drafts', f.reference.external + '.json'))), f.reference.external);
});

test('offline repair refuses a running gateway, any reserved slot, an expired deadline and post-repair progress', async () => {
  const f = await fixture(); let store = await Store.open(f.data);
  await assert.rejects(recoverPreparation(f.options), /store_in_use/); await store.close();
  await assert.rejects(recoverPreparation({ ...f.options, counted: 102 }), /recovery_clock/);
  const proof = JSON.parse(await readFile(f.options.proofs[0], 'utf8'));
  await writeFile(f.options.proofs[0], JSON.stringify({ ...proof, reservations: [{ session: hash('other-session'), slots: [f.key] }] }));
  await assert.rejects(recoverPreparation(f.options), /reservation_not_proven_absent/);
  await writeFile(f.options.proofs[0], JSON.stringify(proof));
  await recoverPreparation({ ...f.options, apply: true });
  store = await Store.open(f.data); await store.put('ceremonies', f.key, { ...f.session, stage: 'running' }); await store.close();
  await assert.rejects(recoverPreparation({ ...f.options, rollback: f.options.backup, apply: true }), /rollback_state_changed/);
});

test('read-only journal inventory detects both session and conflicting batch-slot reservations', async () => {
  const f = await fixture(), path = join(f.data, 's0.log'), journal = await new Journal(path, 'local-test', network, 's0').load();
  await journal.reserve([f.key], hash('digest'), hash('other-session')); await journal.close();
  const result = await auditJournal({ journal: path, member: 's0', session: f.id, key: f.key });
  assert.equal(result.reservations.length, 1); assert.equal(result.signed, 0);
});

test('a newer certified receipt root refuses offline repair without changing the ceremony', async () => {
  const f = await fixture(), store = await Store.open(f.data);
  const { context } = batchFixture(), input = context.inputs[0];
  await store.put('receiptCertificates', `${input.tip}/${input.tipHash}`, { seal: { ...input.receiptRoot, root: hash('later-receipts') }, attestations: [] });
  await store.close();
  await assert.rejects(recoverPreparation({ ...f.options, apply: true }), /receipt_certificate_changed/);
  const reopened = await Store.open(f.data); assert.deepEqual(reopened.get('ceremonies', f.key), f.session); await reopened.close();
});
