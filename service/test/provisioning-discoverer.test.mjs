import test from 'node:test';
import assert from 'node:assert/strict';
import { provisioningFixture } from './provisioning-fixture.mjs';
import { mintAssetDefinition } from '../src/mint-assets.mjs';
import { updateRegistryAsset } from '../src/registry.mjs';
import { rules } from '../src/rules.mjs';

const discoverer = 'cd'.repeat(32);

test('a queued pattern follows a discoverer change without replacing its salt', async t => {
  const f = await provisioningFixture(t), old = await f.operator.enqueue('p2', f.pattern), definition = { ...f.pattern, discoverer };
  const updated = await f.operator.enqueue('p2', definition);
  assert.deepEqual(updated.definition, definition); assert.equal(updated.salt, old.salt);
  assert.deepEqual(updated.attempts, []); assert.equal(updated.state, 'queued');
  const sequence = f.store.sequence;
  assert.deepEqual(await f.operator.enqueue('p2', definition), updated);
  assert.equal(f.store.sequence, sequence);
});

test('the catalog sweep updates an uninscribed element job and keeps its independent package', async t => {
  const f = await provisioningFixture(t), asset = 'p2:32', pattern = { ...f.pattern, number: '32' };
  await f.store.put('meta', 'ruleState', { batchVersion: 2 });
  await f.store.put('patternsByAsset', asset, pattern); await f.operator.tick();
  const old = f.store.get('provisioning', asset);
  await f.store.put('patternsByAsset', asset, { ...pattern, discoverer }); await f.operator.tick();
  const updated = f.store.get('provisioning', asset);
  assert.equal(updated.definition.discoverer, discoverer); assert.equal(updated.salt, old.salt);
  assert.deepEqual(updated.attempts, old.attempts); assert.equal(updated.inscriptionText, old.inscriptionText);
  const definition = (await mintAssetDefinition(f.store, asset)).definition;
  const done = await f.complete(asset, definition);
  assert.equal(done.entry.pattern.discoverer, discoverer); assert.equal(done.entry.prov, rules.encodeTracAddress(discoverer));
});

test('an uninscribed deployment naming the old discoverer is rebuilt with a new package id', async t => {
  const f = await provisioningFixture(t);
  f.index('outsider.123.4.element'); f.mine();
  const old = await f.operator.advanceAsset('p2', f.pattern), definition = { ...f.pattern, discoverer };
  assert.equal(old.phase, 'deployment'); assert.equal(old.content.prov, rules.encodeTracAddress(f.pattern.discoverer));
  assert.ok(old.attempts.every(a => !a.inscription));
  const reset = await f.operator.enqueue('p2', definition);
  assert.deepEqual(reset.attempts, []); assert.notEqual(reset.salt, old.salt);
  assert.equal(reset.content, null); assert.equal(reset.inscriptionText, null); assert.equal(reset.state, 'queued');
  const updated = await f.operator.advanceAsset('p2', definition);
  assert.equal(updated.content.prov, rules.encodeTracAddress(discoverer));
  assert.equal(updated.elementId, old.elementId); assert.notEqual(updated.attempts[0].id, old.attempts[0].id);
  assert.equal((await f.complete('p2', definition)).state, 'registered');
});

test('an older uninscribed deployment without provenance keeps its exact package', async t => {
  const f = await provisioningFixture(t); f.index('outsider.123.4.element'); f.mine();
  const old = await f.operator.advanceAsset('p2', f.pattern), text = { ...old.content }; delete text.prov;
  const attempts = old.attempts.map(a => ({ ...a, text }));
  await f.operator.save(old, { attempts, content: text, inscriptionText: rules.stableJSON(text) });
  const updated = await f.operator.advanceAsset('p2', { ...f.pattern, discoverer });
  assert.equal(updated.salt, old.salt); assert.deepEqual(updated.attempts, attempts); assert.deepEqual(updated.content, text);
  assert.equal(updated.definition.discoverer, discoverer);
});

for (const phase of ['element', 'deployment']) test(`a discoverer change refuses a job with an inscribed ${phase}`, async t => {
  const f = await provisioningFixture(t), old = await f.operator.advanceAsset('p2', f.pattern);
  await f.operator.save(old, { attempts: [...old.attempts, { phase, attempt: 7, inscription: '11'.repeat(32) + 'i0' }] });
  const before = f.store.get('provisioning', 'p2'), sequence = f.store.sequence;
  await assert.rejects(f.operator.enqueue('p2', { ...f.pattern, discoverer }), /provisioning_definition_changed/);
  assert.deepEqual(f.store.get('provisioning', 'p2'), before); assert.equal(f.store.sequence, sequence);
});

for (const patch of [{ entry: { id: '11'.repeat(32) + 'i0' } }, { registeredAt: 1 }, { state: 'registered' }])
  test(`a discoverer change refuses existing registration evidence ${Object.keys(patch)[0]}`, async t => {
    const f = await provisioningFixture(t), old = await f.operator.enqueue('p2', f.pattern);
    await f.operator.save(old, patch);
    const before = f.store.get('provisioning', 'p2');
    await assert.rejects(f.operator.enqueue('p2', { ...f.pattern, discoverer }), /provisioning_definition_changed/);
    assert.deepEqual(f.store.get('provisioning', 'p2'), before);
  });

test('a registry entry or reported broadcast prevents changing an otherwise uninscribed job', async t => {
  const f = await provisioningFixture(t), old = await f.operator.enqueue('p2', f.pattern), definition = { ...f.pattern, discoverer };
  await updateRegistryAsset(f.registryPath, 'p2', () => ({ id: '11'.repeat(32) + 'i0', generation: 1 }));
  await assert.rejects(f.operator.enqueue('p2', definition), /provisioning_definition_changed/);
  assert.deepEqual(f.store.get('provisioning', 'p2'), old);
  const second = await f.operator.enqueue('p3', f.pattern);
  await f.store.put('inflight', 'deployment/p3/deployment', { inscriptionId: '22'.repeat(32) + 'i0', attempt: 0 });
  await assert.rejects(f.operator.enqueue('p3', definition), /provisioning_definition_changed/);
  assert.deepEqual(f.store.get('provisioning', 'p3'), second);
});

for (const patch of [{ pat: '456' }, { discoverer, fld: 10 }, { discoverer, name: 'dmwchanged' }])
  test(`other definition changes remain refused: ${Object.keys(patch).join(', ')}`, async t => {
    const f = await provisioningFixture(t), old = await f.operator.enqueue('p2', f.pattern);
    await assert.rejects(f.operator.enqueue('p2', { ...f.pattern, ...patch }), /provisioning_definition_changed/);
    assert.deepEqual(f.store.get('provisioning', 'p2'), old);
  });

test('a discoverer update waits for a concurrent inscription submission and then refuses', async t => {
  const f = await provisioningFixture(t), old = await f.operator.advanceAsset('p2', f.pattern), inscription = f.index(old.content);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const included = f.reads.included;
  f.reads.included = async id => { entered(); await gate; return included(id); };
  const submission = f.operator.submit('p2', { phase: 'element', inscription }); await started;
  const changed = assert.rejects(f.operator.enqueue('p2', { ...f.pattern, discoverer }), /provisioning_definition_changed/);
  release(); await submission; await changed;
  const job = f.store.get('provisioning', 'p2');
  assert.equal(job.definition.discoverer, f.pattern.discoverer);
  assert.equal(job.attempts.find(a => a.phase === 'element').inscription, inscription);
});

test('an active package build cannot overwrite a queued discoverer update', async t => {
  const f = await provisioningFixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const element = f.reads.elementByDefinition;
  f.reads.elementByDefinition = async (...args) => { entered(); await gate; return element(...args); };
  const building = f.operator.advanceAsset('p2', f.pattern); await started;
  const changing = f.operator.enqueue('p2', { ...f.pattern, discoverer }); release();
  const before = await building, after = await changing;
  assert.equal(after.definition.discoverer, discoverer); assert.deepEqual(after.attempts, before.attempts);
  assert.deepEqual(f.store.get('provisioning', 'p2'), after);
});
