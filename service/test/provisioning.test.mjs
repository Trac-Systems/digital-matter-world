import test from 'node:test';
import assert from 'node:assert/strict';
import { Provisioner } from '../src/provisioning.mjs';
import { candidate, verifyDeployment } from '../src/deployments.mjs';
import { provisioningFixture } from './provisioning-fixture.mjs';

test('idle provisioning does not rewrite an unchanged cursor', async t => {
  const f = await provisioningFixture(t), before = f.store.sequence;
  await f.operator.tick(); await f.operator.tick();
  assert.equal(f.store.sequence, before);
  await f.store.put('meta', 'provisioningCursor', { pattern: 8, type: 'gone' });
  await f.operator.tick();
  assert.deepEqual(f.store.get('meta', 'provisioningCursor'), { pattern: 0, type: '' });
  const reset = f.store.sequence;
  await f.operator.tick(); assert.equal(f.store.sequence, reset);
});

test('a job waiting for the player is not rewritten on every pass', async t => {
  const f = await provisioningFixture(t); f.funds(0n);
  const waiting = await f.operator.request('p2', f.pattern), before = f.store.sequence;
  assert.equal(waiting.state, 'awaiting_player_deploy');
  await f.operator.request('p2', f.pattern); await f.operator.request('p2', f.pattern); await f.operator.tick();
  assert.equal(f.store.sequence, before);
  assert.deepEqual(f.store.get('provisioning', 'p2'), waiting);
});

test('exact pair reuse wins over occupied names, keeps attribution and independent type', async t => {
  const f = await provisioningFixture(t), id = f.index('Outsider.123.4.element'); f.index('dmwexample.999.4.element'); f.mine();
  const job = await f.complete(); assert.equal(job.entry.elementId, id); assert.equal(job.definition.discoverer, f.pattern.discoverer);
  assert.equal(job.attempts.length, 1); assert.equal(job.reused, true); assert.equal(job.state, 'registered');
  assert.equal((await f.reads.registry()).feePolicy.retained, true);
});
test('name and ticker races, repeated salted fallbacks, crash recovery and concurrent calls', async t => {
  const f = await provisioningFixture(t); let elementRace = false, tickerRace = false;
  f.hook(async p => {
    const text = p.entries[0].text;
    if (typeof text === 'string' && !elementRace) { elementRace = true; f.index('dmwexample.999.4.element'); }
    if (typeof text === 'object' && !tickerRace) { tickerRace = true; f.index({ ...text, prv: 'outsider' }); }
  });
  await Promise.all([f.operator.request('p2', f.pattern), f.operator.request('p2', f.pattern)]);
  const saved = f.store.get('provisioning', 'p2'), fallback = candidate(saved, 'element', 1);
  f.index(`${fallback}.888.4.element`); f.mine();
  const recovered = new Provisioner(f), job = await f.complete('p2', f.pattern, recovered);
  assert.equal(job.salt, saved.salt); assert.ok(job.elementAttempt >= 2 && job.tickerAttempt >= 1);
  assert.equal(job.entry.tick.length, 32); assert.notEqual(job.entry.elementId, job.attempts[0].inscription);
  const n = f.packages.size; await f.complete('p2', f.pattern, recovered); assert.equal(f.packages.size, n);
  assert.equal((await f.reads.registry()).generations.p2.length, 1);
});
test('pair race adopts indexed winner; the service never needs Bitcoin funds', async t => {
  const f = await provisioningFixture(t); f.funds(0n);
  assert.equal((await f.operator.request('p2', f.pattern)).state, 'awaiting_player_deploy'); assert.equal(f.packages.size, 0);
  f.funds(1000000000n); let winner;
  f.hook(async p => { if (typeof p.entries[0].text === 'string') winner ??= f.index('outsider.123.4.element'); });
  const job = await f.complete(); assert.equal(job.entry.elementId, winner); assert.equal(job.reused, true);
});
test('complete binding rejects wrong type, options, element, authority and unavailable point lookup', async t => {
  const f = await provisioningFixture(t), job = await f.complete();
  for (const patch of [{ dt: 'h' }, { elementId: '00'.repeat(32) + 'i0' }, { authorityKey: '00' }, { options: { prj: '1' } }])
    await assert.rejects(verifyDeployment(f.reads, { ...job.entry, ...patch }));
  f.reads.element = undefined;
  await assert.rejects(verifyDeployment(f.reads, job.entry), /tap_element_lookup_required/);
});
test('compound allocator uses registry ticker and occupied friendly label falls back', async t => {
  const f = await provisioningFixture(t); f.index({ op: 'token-deploy', tick: 'dmwc1', prv: 'outsider' });
  const job = await f.complete('c1', { id: 'c1', firstMaker: 'ab'.repeat(32) });
  assert.equal(job.entry.kind, 'compound'); assert.notEqual(job.entry.tick, 'dmwc1'); assert.equal(job.entry.tick.length, 32);
});

test('reorg replacing an element retains old generation and allocates a new deployment payload', async t => {
  const f = await provisioningFixture(t), original = await f.complete();
  f.elements.splice(0); f.deployments.delete(original.entry.indexTick);
  // The old reveal remains canonical but its TAP deployment is now ignored.
  const winner = f.index('newwinner.123.4.element'); f.mine();
  const job = await f.complete();
  assert.equal(job.entry.elementId, winner); assert.notEqual(job.entry.id, original.entry.id);
  assert.equal(job.generation, 2); assert.equal(job.tickerAttempt, 1);
  assert.deepEqual((await f.reads.registry()).generations.p2.map(e => e.id), [original.entry.id, job.entry.id]);
  assert.equal(job.definition.discoverer, original.definition.discoverer);
});

test('periodic provisioning fairly revisits more than one page of accepted assets', async t => {
  const f = await provisioningFixture(t), visited = [];
  await f.store.put('meta', 'patterns', Array.from({ length: 19 }, (_, number) => ({ ...f.pattern, number })));
  f.operator.advance = async job => { visited.push(job.asset); return job; };
  await f.operator.tick(); await f.operator.tick(); await f.operator.tick();
  assert.equal(new Set(visited).size, 19);
});

test('authority verification uses a named lookup and rejects an explicitly cancelled authority', async t => {
  const f = await provisioningFixture(t), job = await f.complete(), tap = f.reads.tap;
  let cancelled = false;
  f.reads.tap = async path => {
    if (path.startsWith('getPrivilegeAuthList')) throw Error('global_list_forbidden');
    if (path.startsWith('getPrivilegeAuthCancelled/')) return cancelled;
    return tap(path);
  };
  await verifyDeployment(f.reads, job.entry);
  cancelled = true; await assert.rejects(verifyDeployment(f.reads, job.entry), /privilege_cancelled/);
});

test('an indexed player deployment is recovered before POST without allocating a second ticker', async t => {
  const f = await provisioningFixture(t);
  let job = await f.operator.request('p2', f.pattern);
  const element = f.index(job.content); f.mine();
  job = await f.operator.request('p2', f.pattern);
  assert.equal(job.phase, 'deployment'); assert.equal(job.elementId, element);
  const id = f.index(job.content); f.canonical.set(id, f.canonical.get(id) + 1);
  job = await f.operator.request('p2', f.pattern);
  assert.equal(job.reason, 'deployment_confirmations'); assert.equal(job.tickerAttempt, 0);
  f.mine(); job = await f.operator.request('p2', f.pattern);
  assert.equal(job.state, 'registered'); assert.equal(job.entry.id, id); assert.equal(job.entry.receiver, 'maker');
  assert.equal(job.tickerAttempt, 0); assert.equal(job.attempts.length, 2);
});

test('element registration binds the deploying wallet and independent verification checks indexed names', async t => {
  const f = await provisioningFixture(t);
  let job = await f.operator.request('p2', f.pattern);
  const element = f.index(job.content); f.mine();
  job = await f.operator.submit('p2', { phase: 'element', inscription: element });
  const id = f.index(job.content); f.mine();
  f.reads.inscription = async () => ({ address: 'different-player' });
  await assert.rejects(f.operator.submit('p2', { phase: 'deployment', inscription: id }), /deployment_receiver/);
  f.reads.inscription = async () => ({ address: 'maker' });
  job = await f.operator.submit('p2', { phase: 'deployment', inscription: id });
  assert.equal(job.state, 'registered'); assert.equal(job.entry.elementName, f.pattern.name);
  f.elements[0].tick = 'renamed';
  await assert.rejects(verifyDeployment(f.reads, job.entry), /element_name/);
  f.elements[0].tick = f.pattern.name; f.contents.set(element, 'different.123.4.element');
  await assert.rejects(verifyDeployment(f.reads, job.entry), /element_content/);
});

test('first pattern quote says deployment needed without payment, reservation or permit', async t => {
  const { Mints } = await import('../src/mints.mjs');
  const f = await provisioningFixture(t);
  await f.store.put('meta', 'patterns', [f.pattern]);
  let touched = 0;
  const mints = new Mints({ store: f.store, network: f.network, reads: { assetContext: async () => { touched++; throw Error('unregistered'); } } });
  mints.provisioner = f.operator;
  const quote = await mints.quote({ asset: 'p2', block: 123, amount: '1' });
  assert.equal(quote.state, 'deployment_needed'); assert.equal(quote.requestId, null); assert.equal(quote.reservation, 'none');
  assert.equal(quote.payable, false); assert.deepEqual(quote.fees, []);
  assert.equal(quote.deployment.inscriptionText, 'dmwexample.123.4.element');
  assert.equal(touched, 0); assert.equal(f.store.count('mints'), 0); assert.equal(f.store.count('holds'), 0);
});

test('a copied deploy sent to a different wallet allocates a replacement ticker', async t => {
  const f = await provisioningFixture(t);
  const first = await f.operator.request('p2', f.pattern), element = f.index(first.content); f.mine();
  const deploy = await f.operator.submit('p2', { phase: 'element', inscription: element });
  const occupied = f.index(deploy.content); f.mine();
  f.reads.inscription = async id => ({ address: id === occupied ? 'other-wallet' : 'maker' });
  assert.equal((await f.operator.request('p2', f.pattern)).reason, 'ticker_occupied');
  const replacement = await f.operator.request('p2', f.pattern);
  assert.equal(replacement.state, 'awaiting_player_deploy'); assert.equal(replacement.phase, 'deployment');
  assert.notEqual(replacement.content.tick, deploy.content.tick);
  assert.equal(replacement.elementId, element); assert.equal(replacement.receiver, 'maker');
});
