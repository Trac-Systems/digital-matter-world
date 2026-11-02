import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../lib/journal.mjs';
import { LinkJobs } from '../lib/link-jobs.mjs';
import { linkSettings, journalPacing } from '../lib/link-settings.mjs';
import { validatePlayerConfig } from '../lib/network.mjs';
import { temp, cleanup } from './helpers.mjs';

test('bulk jobs persist, merge duplicates, deduplicate unfinished sets and page in order', async t => {
  const dir = await temp(t); let journal = await Journal.open(dir, 'link-jobs'); cleanup(t, () => journal.close());
  let jobs = new LinkJobs(journal), first = jobs.create({ blocks: ['3', '1', '3'], payer: 'payer' });
  assert.equal(first.job.total, 2); assert.equal(first.job.counts.waiting, 2);
  assert.equal(jobs.create({ blocks: ['1', '3'], payer: 'payer' }).job.id, first.job.id);
  journal.close(); journal = await Journal.open(dir, 'link-jobs'); jobs = new LinkJobs(journal);
  assert.deepEqual(jobs.get(first.job.id), first.job);
  const second = jobs.create({ blocks: ['2'], payer: 'payer' });
  assert.equal(jobs.list({ limit: 1 }).jobs[0].id, second.job.id); assert.equal(jobs.list({ limit: 1 }).next, 1);
  assert.deepEqual(jobs.detail(first.job.id, { limit: 1 }).items.map(i => i.block), ['1']);
  assert.equal(jobs.detail(first.job.id, { offset: 1, limit: 1 }).next, null);
  const other = new Journal(journal.db, 'another-scope', { now: Date.now });
  assert.deepEqual(new LinkJobs(other).list(), { jobs: [], next: null });
});

test('cancel affects waiting items only and a sent item still finishes', async t => {
  const journal = await Journal.open(await temp(t), 'cancel'); cleanup(t, () => journal.close());
  const jobs = new LinkJobs(journal), { job } = jobs.create({ blocks: ['1', '2'], payer: 'payer' });
  const [first] = jobs.active(); jobs.update(first, { state: 'in_progress' });
  assert.deepEqual(jobs.cancel(job.id).job.counts, { waiting: 0, inProgress: 1, linked: 0, failed: 0, cancelled: 1 });
  assert.equal(jobs.get(job.id).state, 'running');
  jobs.update(first, { state: 'linked' }); assert.equal(jobs.get(job.id).state, 'cancelled');
  assert.notEqual(jobs.create({ blocks: ['1', '2'], payer: 'payer' }).job.id, job.id);
});

test('block and settings defaults and validation are applied to player configs', async t => {
  assert.deepEqual(linkSettings(), { maxBlocks: 500, linkConcurrency: 8 });
  assert.deepEqual(journalPacing(), { intervalMs: 1000, perTip: 12 });
  const config = { localOnly: true, adapter: '/test/adapter.mjs', gateway: 'http://127.0.0.1:1' };
  await validatePlayerConfig({ ...config, maxBlocks: 2, linkConcurrency: 1, journalPacing: { intervalMs: 0, perTip: 1 } });
  for (const value of [0, -1, 1.5, '8', null, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(validatePlayerConfig({ ...config, maxBlocks: value }), /maxBlocks/);
    await assert.rejects(validatePlayerConfig({ ...config, linkConcurrency: value }), /linkConcurrency/);
    assert.throws(() => journalPacing({ perTip: value }));
  }
  for (const value of [null, [], { unknown: 1 }, { intervalMs: -1 }, { intervalMs: '1' }]) assert.throws(() => journalPacing(value));
  const journal = await Journal.open(await temp(t), 'validate'); cleanup(t, () => journal.close());
  const jobs = new LinkJobs(journal, { maxBlocks: 2 });
  for (const blocks of [[], null, [1], ['01'], ['1.5'], ['-1'], ['1e2']]) assert.throws(() => jobs.create({ blocks, payer: 'p' }), /invalid_blocks/);
  assert.throws(() => jobs.create({ blocks: ['1', '2', '3'], payer: 'p' }), /too_many_blocks/);
});
