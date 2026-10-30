import test from 'node:test';
import assert from 'node:assert/strict';
import { provisioningFixture } from './provisioning-fixture.mjs';
import { candidate, deploymentPayload, generationDigest, verifyDeployment, NAME_WORDS } from '../src/deployments.mjs';
import { mintAssetDefinition } from '../src/mint-assets.mjs';
import { serve } from '../src/http.mjs';
import { hash } from '../src/util.mjs';
import { rules } from '../src/rules.mjs';

// A v2 catalog pattern released at height 50 with a 100 block finder window: the
// discoverer's week ends at block 150. The fixture tip starts at 100.
async function fixture(t, { releaseHeight = '50', releaseFinderWindow = 100 } = {}) {
  const f = await provisioningFixture(t), wallets = new Map();
  const pattern = { number: '1', name: 'dmwflorite', pat: '456', fld: 4, dt: 'n', discoverer: 'ab'.repeat(32), key: '11'.repeat(32), catalogRevision: '0', releaseHeight, releaseFinderWindow };
  await f.store.put('meta', 'ruleState', { batchVersion: 2 });
  await f.store.put('patternsByAsset', 'p2:1', pattern);
  f.reads.bindings = { resolve: (agent, rail, snapshot, role) => {
    assert.deepEqual([agent, rail, role], [pattern.discoverer, 'tap', 'discoverer']); return { request: { address: 'discoverer-wallet' } }; } };
  f.reads.inscription = async id => ({ address: wallets.get(id) ?? 'discoverer-wallet' });
  const { definition } = await mintAssetDefinition(f.store, 'p2:1');
  const inscribe = (text, wallet) => { const id = f.index(text); if (wallet) wallets.set(id, wallet); f.mine(); return id; };
  const waiting = async () => { await f.operator.request('p2:1'); await f.operator.work.drain(); return f.store.get('provisioning', 'p2:1'); };
  return { ...f, pattern, definition, wallets, inscribe, waiting };
}

test('during the discoverer\'s week only the discoverer\'s wallet deploys a pattern; pages are told before anyone inscribes', async t => {
  const f = await fixture(t);
  const state = await f.operator.state('p2:1');
  assert.deepEqual(state.deployer, { until: '150', discoverer: f.pattern.discoverer, address: 'discoverer-wallet', onlyDiscoverer: true, counted: '100' });
  // The public reply carries the discoverer's trac1 address.
  const http = await serve({ intake: { store: f.store }, files: { serve: async () => false }, operator: { provisioner: f.operator } });
  t.after(() => http.close());
  const shown = await (await fetch(http.url + '/mint/deployment-state/p2:1')).json();
  assert.equal(shown.deployer.discoverer, rules.encodeTracAddress(f.pattern.discoverer)); assert.equal(shown.deployer.until, '150');
  // Another wallet's element inscription during the week is refused.
  let job = await f.waiting();
  assert.equal(job.phase, 'element');
  const foreign = f.inscribe(job.content, 'someone-else');
  await assert.rejects(f.operator.submit('p2:1', { phase: 'element', inscription: foreign }), /discoverer_receiver/);
  // The discoverer's own element and deployment are accepted; the deploy names the discoverer.
  f.elements.splice(0);
  job = await f.operator.submit('p2:1', { phase: 'element', inscription: f.inscribe(job.content) });
  assert.equal(job.phase, 'deployment');
  assert.equal(job.content.prov, rules.encodeTracAddress(f.pattern.discoverer));
  // A copy of the deploy in another wallet during the week is refused too.
  const copy = f.inscribe(job.content, 'someone-else');
  f.deployments.clear();
  await assert.rejects(f.operator.submit('p2:1', { phase: 'deployment', inscription: copy }), /discoverer_receiver/);
  job = await f.operator.submit('p2:1', { phase: 'deployment', inscription: f.inscribe(job.content) });
  assert.equal(job.state, 'registered'); assert.equal(job.entry.receiver, 'discoverer-wallet'); assert.equal(job.entry.prov, job.content.prov);
  // A registered pattern shows no deployer rule.
  assert.equal((await f.operator.state('p2:1')).deployer, undefined);
});

test('after the discoverer\'s week anyone may deploy a pattern', async t => {
  const f = await fixture(t, { releaseHeight: '0', releaseFinderWindow: 50 });
  assert.equal((await f.operator.state('p2:1')).deployer.onlyDiscoverer, false);
  let job = await f.waiting();
  job = await f.operator.submit('p2:1', { phase: 'element', inscription: f.inscribe(job.content, 'someone-else') });
  job = await f.operator.submit('p2:1', { phase: 'deployment', inscription: f.inscribe(job.content, 'someone-else') });
  assert.equal(job.state, 'registered'); assert.equal(job.entry.receiver, 'someone-else');
  assert.equal(job.entry.prov, rules.encodeTracAddress(f.pattern.discoverer));
});

test('a pattern without a discoverer binding cannot be deployed during the week', async t => {
  const f = await fixture(t);
  f.reads.bindings = { resolve: () => { throw Error('discoverer_address_missing'); } };
  assert.equal((await f.operator.state('p2:1')).deployer.address, null);
  const job = await f.waiting();
  await assert.rejects(f.operator.submit('p2:1', { phase: 'element', inscription: f.inscribe(job.content) }), /discoverer_receiver/);
});

test('a compound deploy names its first maker', async t => {
  const f = await provisioningFixture(t), asset = 'c2:' + '5e'.repeat(32), record = { id: asset, commitment: '5e'.repeat(32), v: 3, recipe: 'fusion', firstMaker: 'cd'.repeat(32) };
  await f.store.put('compoundTypes', asset, record);
  const job = await f.complete(asset, record);
  assert.equal(job.attempts[0].text.prov, rules.encodeTracAddress(record.firstMaker)); assert.equal(job.entry.prov, job.attempts[0].text.prov);
  // A deployed payload with another prov does not verify against the entry.
  f.contents.set(job.entry.id, { ...job.attempts[0].text, prov: rules.encodeTracAddress('ef'.repeat(32)) });
  await assert.rejects(verifyDeployment(f.reads, job.entry), /deployment_options/);
});

test('fallback names are the name plus readable words, deterministic, and fit the ticker length', () => {
  const job = { network: 'dmw-mainnet', asset: 'p0', generation: 1, salt: 'aa'.repeat(32) };
  assert.equal(NAME_WORDS.length, new Set(NAME_WORDS).size);
  assert.ok(NAME_WORDS.every(w => /^[a-z]{3,7}$/.test(w)));
  const names = Array.from({ length: 300 }, (_, i) => candidate(job, 'dmt-ticker', i + 1, 'dmwflorite'));
  assert.equal(new Set(names).size, names.length, 'every attempt gets a new name');
  assert.deepEqual(names, Array.from({ length: 300 }, (_, i) => candidate({ ...job }, 'dmt-ticker', i + 1, 'dmwflorite')));
  for (const name of names) assert.match(name, /^dmwflorite[a-z]{3,14}$/);
  assert.ok(NAME_WORDS.includes(names[0].slice('dmwflorite'.length)));
  assert.notEqual(candidate({ ...job, salt: 'bb'.repeat(32) }, 'dmt-ticker', 1, 'dmwflorite'), undefined);
  // A long name is shortened to fit 32 characters; the dmw prefix stays.
  const long = 'dmw' + 'x'.repeat(29);
  for (const attempt of [1, 150, 20000]) {
    const name = candidate(job, 'element', attempt, long);
    assert.ok(name.length <= 32 && name.startsWith('dmwxx') && /^[a-z0-9]+$/.test(name), name);
  }
  assert.throws(() => candidate(job, 'element', 0, 'dmwflorite'), /candidate_name/);
  assert.throws(() => candidate(job, 'element', 1, 'florite'), /candidate_name/);
});

test('an existing deployment without prov keeps verifying and its approval digest is unchanged', async t => {
  const f = await provisioningFixture(t), job = await f.complete();
  const { prov, ...older } = job.entry, text = { ...job.attempts.at(-1).text };
  delete text.prov;
  assert.deepEqual(deploymentPayload(older), text);
  const keys = ['network', 'asset', 'generation', 'id', 'privilege', 'authorityKey', 'elementId', 'elementName', 'receiver', 'dt', 'kind', 'tick', 'indexTick', 'options'];
  assert.equal(generationDigest(older), hash(rules.stableJSON(Object.fromEntries(keys.map(k => [k, older[k] ?? null])))));
  f.contents.set(older.id, text);
  const entry = { ...older, approval: generationDigest(older) };
  await f.store.put('provisioning', 'p2', { ...f.store.get('provisioning', 'p2'), entry, attempts: job.attempts.map(a => a.phase === 'deployment' ? { ...a, text } : a) });
  const { updateRegistryAsset } = await import('../src/registry.mjs');
  await updateRegistryAsset(f.registryPath, 'p2', () => entry);
  await verifyDeployment(f.reads, entry);
  const rechecked = await f.operator.advance(f.store.get('provisioning', 'p2'));
  assert.equal(rechecked.state, 'registered'); assert.equal(rechecked.entry.prov, undefined);
  assert.equal((await f.reads.registry()).assets.p2.suspended, false);
});

test('a deploy packaged before prov existed keeps its exact text, and a ticker already offered keeps its name', async t => {
  const f = await provisioningFixture(t); f.funds(0n);
  let job = await f.operator.advanceAsset('p2', f.pattern);
  job = await f.operator.submit('p2', { phase: 'element', inscription: f.index(job.content) });
  assert.equal(job.phase, 'deployment');
  const { prov, ...older } = job.attempts.at(-1).text;
  await f.store.put('provisioning', 'p2', { ...job, content: older, inscriptionText: rules.stableJSON(older), attempts: job.attempts.map(a => a.phase === 'deployment' ? { ...a, text: older } : a) });
  job = await f.operator.advanceAsset('p2', f.pattern);
  assert.equal(job.state, 'awaiting_player_deploy'); assert.deepEqual(job.content, older);
  job = await f.operator.submit('p2', { phase: 'deployment', inscription: f.index(older) });
  assert.equal(job.state, 'registered'); assert.equal(job.entry.prov, undefined);
  // An older hex fallback already packaged for an attempt is kept.
  const g = await provisioningFixture(t); g.funds(0n);
  g.index({ p: 'tap', op: 'dmt-deploy', tick: 'dmwexample', prv: 'outsider' });
  let other = await g.operator.advanceAsset('p2', g.pattern);
  await g.operator.submit('p2', { phase: 'element', inscription: g.index(other.content) });
  other = await g.operator.advanceAsset('p2', g.pattern);
  assert.equal(other.tickerAttempt, 1); assert.equal(other.attempts.at(-1).phase, 'deployment'); assert.match(other.content.tick, /^dmwexample[a-z]+$/);
  const hexName = 'dmw' + 'c'.repeat(29), offered = { ...other.attempts.at(-1).text, tick: hexName };
  await g.store.put('provisioning', 'p2', { ...other, content: offered, inscriptionText: rules.stableJSON(offered), attempts: other.attempts.map(a => a.phase === 'deployment' ? { ...a, text: offered } : a) });
  other = await g.operator.advanceAsset('p2', g.pattern);
  assert.equal(other.content.tick, hexName); assert.equal(other.state, 'awaiting_player_deploy');
});
