import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, digest, r } from './bulk-helpers.mjs';
import { capacityKey, plotKey } from '../../contract/financial-capacity.js';
import { AccountExecution } from '../src/account-batch.mjs';

function timings(t) {
  const lines = [], write = process.stderr.write;
  t.mock.method(process.stderr, 'write', function (chunk, ...args) {
    if (typeof chunk === 'string' && chunk.startsWith('{')) {
      const line = JSON.parse(chunk);
      if (line.event === 'bulk_quote_timing') { lines.push(line); return true; }
    }
    return write.call(this, chunk, ...args);
  });
  return lines;
}

test('64-block quote and strict reserve finish while queued transitions repeat every 100 ms', async t => {
  const f = await fixture(t), lines = timings(t), input = f.input(64);
  const queued = Array.from({ length: 12 }, (_, i) => ({ type: 'consume', id: digest('background-' + i), permitHash: digest('permit-' + i) }));
  for (const transition of queued) await f.financial.submit(transition);
  const initialRevision = f.financial.revision, acceptedRevision = f.financial.acceptedRevision;
  const candidates = f.reads.bulkCandidates;
  f.reads.bulkCandidates = async (...args) => { await delay(350); return candidates(...args); };
  const scope = f.reads.financialScope;
  f.reads.financialScope = options => {
    const reads = scope(options), evidence = reads.financialEvidence;
    reads.financialEvidence = async (...args) => { await delay(350); return evidence(...args); };
    return reads;
  };
  let stopped = false, rounds = 0;
  const background = (async () => {
    while (!stopped) {
      await delay(100);
      if (stopped) break;
      for (const transition of queued) {
        const id = r.hashObject(['dmw-financial-transition-v2', transition]);
        assert.equal((await f.financial.submit(transition)).state, 'queued');
        // Exercise the inner idempotent branch too: it still increments the
        // global revision, as when another submit wins while waiting on gate.
        await f.financial.gate(() => f.financial.existing(id), { pending: true });
      }
      rounds++;
    }
  })();
  try {
    const quote = await f.bulk.quote(input), quoteRounds = rounds;
    assert.equal(quote.terms.members.length, 64);
    assert.equal(lines[0].attempts, 1);
    assert.ok(quoteRounds >= 3);
    assert.ok(f.financial.revision > initialRevision);
    assert.equal(f.financial.acceptedRevision, acceptedRevision);
    assert.deepEqual(await f.bulk.quote(input), quote);
    assert.equal(lines[1].cached, true, 'unrelated revisions preserve the completed quote');
    const status = await f.bulk.request(f.sign(quote));
    assert.equal(status.state, 'reserving');
    assert.equal(f.store.count('financialAdmissionPlot'), 64);
    assert.ok(rounds >= quoteRounds + 3, 'background work continued during strict reserve');
  } finally { stopped = true; await background; }
});

for (const kind of ['held', 'capacity', 'plot', 'scoped_plot']) test(`${kind} admission change during funding retries the quote and records the changed fingerprint`, async t => {
  const f = await fixture(t, { extra: kind === 'scoped_plot' }), lines = timings(t), input = f.input(64);
  const funding = f.senderView.bulkFunding; let changed = false;
  f.senderView.bulkFunding = async args => {
    if (!changed) {
      changed = true;
      const [space, id, value] = kind === 'held' ? ['financialAdmissionHeld', f.owner + '/' + input.asset, '99997'] :
        kind === 'capacity' ? ['financialAdmissionCapacity', capacityKey(input.deployment), '99997'] :
          ['financialAdmissionPlot', plotKey(input.asset, input.blocks[0], kind === 'scoped_plot' ? input.deployment : null), 'pending'];
      await f.financial.gate(() => f.store.put(space, id, value), { pending: true });
    }
    return funding(args);
  };
  const quote = await f.bulk.quote(input), line = lines[0];
  assert.equal(quote.terms.members.length, kind.endsWith('plot') ? 63 : 1);
  assert.equal(line.attempts, 2);
  assert.match(line.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(line.attemptReasons[0].reason, 'financial_snapshot_changed');
  assert.deepEqual(line.attemptReasons[0].changed, ['admission']);
  assert.notEqual(line.attemptReasons[0].fingerprint, line.attemptReasons[0].afterFingerprint);
  assert.equal(line.attemptReasons[1].reason, 'ok');
});

test('new unrelated queue writes and admissions during funding do not restart a quote', async t => {
  const f = await fixture(t), lines = timings(t), funding = f.senderView.bulkFunding;
  f.senderView.bulkFunding = async args => {
    await f.financial.submit({ type: 'consume', id: digest('unrelated-work'), permitHash: digest('unrelated-permit') });
    await f.financial.gate(() => f.store.transact([
      { space: 'financialAdmissionHeld', id: digest('other-owner') + '/' + f.input().asset, value: '9' },
      { space: 'financialAdmissionCapacity', id: capacityKey(digest('other-deployment')), value: '9' },
      { space: 'financialAdmissionPlot', id: plotKey(f.input().asset, '800000'), value: 'pending' },
    ]), { pending: true });
    return funding(args);
  };
  assert.equal((await f.bulk.quote(f.input(64))).terms.members.length, 64);
  assert.equal(lines[0].attempts, 1);
});

test('an admission value changing away and back cannot mix the quote snapshot', async t => {
  const f = await fixture(t), input = f.input(64), lines = timings(t), key = f.owner + '/' + input.asset;
  const held = value => f.financial.gate(() => f.store.put('financialAdmissionHeld', key, value), { pending: true });
  await held('99997');
  const candidates = f.reads.bulkCandidates, funding = f.senderView.bulkFunding;
  f.reads.bulkCandidates = async (...args) => { await held('0'); return candidates(...args); };
  f.senderView.bulkFunding = async args => { await held('99997'); return funding(args); };
  const quote = await f.bulk.quote(input);
  assert.equal(quote.terms.members.length, 1, 'selection uses the held amount captured before the scan');
  assert.equal(lines[0].attempts, 1);
  assert.equal(lines[0].attemptReasons[0].fingerprint, lines[0].attemptReasons[0].afterFingerprint);
});

test('accepted account writes still restart a quote even before the remote stamp advances', async t => {
  const f = await fixture(t), lines = timings(t), funding = f.senderView.bulkFunding; let changed = false;
  f.senderView.bulkFunding = async args => {
    if (!changed) {
      changed = true;
      const execution = new AccountExecution({ store: f.store, document: f.document, height: f.stamp().counted });
      await execution.accounts([{ type: 'credit', owner: f.owner, asset: f.input().asset, amount: '1' }]);
      await f.financial.gate(() => f.store.transact(execution.result().writes));
    }
    return funding(args);
  };
  assert.equal((await f.bulk.quote(f.input(64))).terms.members.length, 64);
  assert.equal(lines[0].attempts, 2);
  assert.deepEqual(lines[0].attemptReasons[0].changed, ['accepted']);
});

test('settings changes are fenced and cannot cache a quote under the old document', async t => {
  const f = await fixture(t), lines = timings(t), funding = f.senderView.bulkFunding;
  f.bulk.resources.bulkQuoteAttempts = 1;
  f.senderView.bulkFunding = async args => {
    f.bulk.document = { ...f.document, values: { ...f.document.values, moveFreshnessTips: f.document.values.moveFreshnessTips + 1 } };
    return funding(args);
  };
  await assert.rejects(f.bulk.quote(f.input(64)), /financial_snapshot_changed/);
  assert.equal(f.bulk.quoteResults.size, 0);
  assert.equal(lines[0].reason, 'financial_snapshot_changed');
  assert.deepEqual(lines[0].attemptReasons[0].changed, ['settings']);
});

test('cached quotes recheck member locks and deployment capacity', async t => {
  const f = await fixture(t), lines = timings(t), input = f.input(64);
  assert.equal((await f.bulk.quote(input)).terms.members.length, 64);
  await f.financial.gate(() => f.store.put('financialAdmissionPlot', plotKey(input.asset, '900063'), 'pending'), { pending: true });
  const locked = await f.bulk.quote(input);
  assert.equal(locked.terms.members.length, 63);
  assert.deepEqual(locked.skipped, [{ block: '900063', reason: 'block_pending' }]);
  await f.financial.gate(() => f.store.put('financialAdmissionCapacity', capacityKey(input.deployment), '99997'), { pending: true });
  assert.equal((await f.bulk.quote(input)).terms.members.length, 1);
  assert.ok(lines.every(line => !line.cached));
  assert.equal(new Set(lines.map(line => line.fingerprint)).size, 3);
});

for (const kind of ['held', 'plot', 'unrelated']) test(`strict reserve rechecks a real concurrent ${kind} admission inside the commit gate`, async t => {
  const f = await fixture(t), input = f.input(64), quote = await f.bulk.quote(input);
  const competing = { ...f.input(1, 'competing'), blocks: [kind === 'plot' ? '900000' : '800000'] };
  if (kind === 'held') {
    const context = await f.reads.assetContext(input.asset, competing.blocks[0], { bulkMint: true });
    context.find.count = '99999'; f.contexts.set(competing.blocks[0], context);
  }
  const other = await f.bulk.quote(competing), scope = f.reads.financialScope; let changed = false;
  f.reads.financialScope = options => {
    const reads = scope(options), evidence = reads.financialEvidence;
    reads.financialEvidence = async (...args) => {
      const result = await evidence(...args);
      if (!changed && args[0].id === quote.orderId) {
        changed = true;
        assert.equal((await f.bulk.request(f.sign(other))).state, 'reserving');
      }
      return result;
    };
    return reads;
  };
  const request = f.bulk.request(f.sign(quote));
  if (kind === 'unrelated') {
    assert.equal((await request).state, 'reserving');
    assert.equal(f.store.count('financialAdmissionPlot'), 65);
    assert.equal(f.store.get('financialAdmissionHeld', f.owner + '/' + input.asset), '195');
  } else {
    await assert.rejects(request, error => kind === 'held' ? error.message === 'financial_balance_reserved' :
      error.message === 'bulk_member_conflict' && r.stableJSON(error.details.indices) === '[0]');
    assert.equal(f.store.count('financialQueue'), 1, 'only the competing request is admitted');
    assert.equal(f.store.count('financialAdmissionPlot'), 1);
  }
  assert.equal(changed, true);
});

test('strict reserve keeps the accepted-root fence while pending work can overlap', async t => {
  const f = await fixture(t), quote = await f.bulk.quote(f.input(64)), scope = f.reads.financialScope;
  f.reads.financialScope = options => {
    const reads = scope(options), evidence = reads.financialEvidence;
    reads.financialEvidence = async (...args) => {
      const result = await evidence(...args);
      const execution = new AccountExecution({ store: f.store, document: f.document, height: f.stamp().counted });
      await execution.accounts([{ type: 'credit', owner: f.owner, asset: quote.terms.asset, amount: '1' }]);
      await f.financial.gate(() => f.store.transact(execution.result().writes));
      return result;
    };
    return reads;
  };
  await assert.rejects(f.bulk.request(f.sign(quote)), /financial_snapshot_changed/);
  assert.equal(f.store.count('financialQueue'), 0);
  assert.equal(f.store.count('financialAdmissionPlot'), 0);
});
