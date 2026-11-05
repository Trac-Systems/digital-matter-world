import test from 'node:test';
import assert from 'node:assert/strict';
import { provisioningFixture } from './provisioning-fixture.mjs';
import { mintAssetDefinition, patternCatalogId } from '../src/mint-assets.mjs';
import { FinancialMints } from '../src/financial-mints.mjs';
import { serve } from '../src/http.mjs';
import { rules } from '../src/rules.mjs';
import { ed25519 } from '../../contract/node_modules/@noble/curves/ed25519.js';

async function fixture(t) {
  const f = await provisioningFixture(t);
  const legacy = { ...f.pattern, number: 0, name: 'dmwflorite' };
  const pure = { ...f.pattern, number: '1', name: 'dmwnullspar', pat: '456', key: '11'.repeat(32), catalogRevision: '0' };
  await f.store.put('meta', 'patterns', [legacy]);
  await f.store.put('meta', 'ruleState', { batchVersion: 2 });
  await f.store.put('patternsByAsset', 'p2:0', { ...legacy, number: '0', key: '00'.repeat(32), legacy: { asset: 'p0', record: legacy } });
  await f.store.put('patternsByAsset', 'p2:1', pure);
  return { ...f, legacy, pure };
}

test('v2 provisioning retains imported ledger identity and the v1 inscription format', async t => {
  const f = await fixture(t);
  assert.equal(patternCatalogId('pz'), 'p2:35');
  assert.equal((await mintAssetDefinition(f.store, 'p2:0')).asset, 'p0');
  await assert.rejects(mintAssetDefinition(f.store, 'p1'), /asset_unknown/);
  await f.operator.tick();
  assert.equal(f.store.get('provisioning', 'p0').content, 'dmwflorite.123.4.element');
  assert.equal(f.store.get('provisioning', 'p2:1').content, 'dmwnullspar.456.4.element');
  assert.equal(f.store.get('provisioning', 'p1'), null);
  assert.equal(f.store.get('provisioning', 'p2:0'), null, 'catalog alias cannot allocate another token');
  const imported = await f.operator.request('p2:0');
  assert.equal(imported.asset, 'p0');
  assert.deepEqual(imported.definition, f.legacy);
  const element = f.index(imported.content);
  const deploy = await f.operator.submit('p2:0', { phase: 'element', inscription: element });
  assert.deepEqual(deploy.content, { p: 'tap', op: 'dmt-deploy', tick: 'dmwflorite', elem: element, dt: 'n', prv: f.privilege, prov: rules.encodeTracAddress(f.pattern.discoverer) });
  const deployment = f.index(deploy.content);
  assert.equal((await f.operator.submit('p2:0', { phase: 'deployment', inscription: deployment })).state, 'registered');
  assert.equal((await f.reads.registry()).assets.p0.id, deployment);
  assert.equal((await f.operator.state('p2:0')).state, 'registered');
  // Refining v2 catalog statistics does not change an in-progress package.
  await f.store.put('patternsByAsset', 'p2:1', { ...f.pure, catalogRevision: '1', tier: 3 });
  assert.equal((await f.operator.request('p2:1')).content, 'dmwnullspar.456.4.element');
  const resolved = await mintAssetDefinition(f.store, 'p2:1');
  const pure = await f.complete(resolved.asset, resolved.definition);
  assert.equal(pure.entry.tick, 'dmwnullspar');
  assert.equal((await f.reads.registry()).assets['p2:1'].id, pure.entry.id);
});

test('one asset whose definition changed never holds back the rest of the provisioning sweep', async t => {
  const f = await fixture(t);
  const names = 'bcdefghij';
  for (let i = 2; i <= 10; i++) await f.store.put('patternsByAsset', `p2:${i}`, { ...f.pure, number: String(i), name: 'dmwsweep' + names[i - 2], key: String(i).padStart(2, '0').repeat(32) });
  await f.operator.tick();
  // p2:1 is first in the page; its pattern no longer matches its open job.
  await f.store.put('patternsByAsset', 'p2:1', { ...f.pure, pat: '789' });
  await f.store.put('meta', 'provisioningCursor', { pattern: 0, type: '', named: '', compound: '' });
  await f.store.put('patternsByAsset', 'p2:9', { ...f.pure, number: '9', name: 'dmwsweeplate', key: '99'.repeat(32) });
  await assert.rejects(f.operator.tick(), /provisioning_definition_changed/);
  assert.notEqual(f.store.get('meta', 'provisioningCursor').named, '', 'the cursor moves past the failing page');
  await f.operator.tick().catch(() => {});
  assert.ok(f.store.get('provisioning', 'p2:9'), 'a later asset is still reached');
});

test('deployment-state reads are local and never enqueue or advance; p2 prepare and registration routes work', async t => {
  const f = await fixture(t);
  const http = await serve({ intake: { store: f.store }, files: { serve: async () => false }, operator: { provisioner: f.operator } });
  t.after(() => http.close());
  const get = async path => { const response = await fetch(http.url + path); assert.equal(response.status, 200); return response.json(); };
  const post = async value => { const response = await fetch(http.url + '/mint/deployment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); assert.equal(response.status, 200); return response.json(); };
  const sequence = f.store.sequence, tap = f.reads.tap, registry = f.reads.registry;
  f.reads.tap = f.reads.registry = () => assert.fail('status read consulted an external source');
  assert.equal((await get('/mint/deployment-state/p2:1')).state, 'not_started');
  assert.equal((await get('/mint/deployment-state/p2%3A0')).asset, 'p0');
  assert.equal(f.store.sequence, sequence);
  f.reads.tap = tap; f.reads.registry = registry;
  await get('/mint/deployment/p2:1');
  await f.operator.work.drain();
  const job = await get('/mint/deployment-state/p2:1');
  assert.equal(job.phase, 'element');
  const element = f.index(job.content);
  const deploy = await post({ asset: 'p2:1', phase: 'element', inscription: element });
  assert.equal(deploy.phase, 'deployment');
  const id = f.index(deploy.content);
  assert.equal((await post({ asset: 'p2:1', phase: 'deployment', inscription: id })).state, 'registered');
  const before = f.store.sequence;
  await get('/mint/deployment-state/p2:1'); await get('/mint/deployment-state/p2:1');
  assert.equal(f.store.sequence, before);
  assert.equal((await post({ asset: 'p2:0' })).asset, 'p0');
});

test('v2 quote offers deployment before financial registration and creates no mint request', async t => {
  const f = await fixture(t), document = rules.settingsRevision({ network: f.network, effectiveBatch: '1', effectiveBitcoinWindow: '100', values: { ...rules.SETTINGS_PROFILE } });
  const mints = new FinancialMints({ store: f.store, reads: { ...f.reads, financialDeployment: () => assert.fail('undeployed financial lookup') },
    network: f.network, document, financial: {} });
  mints.provisioner = f.operator;
  for (const [asset, ledger] of [['p2:0', 'p0'], ['p0', 'p0'], ['p2:1', 'p2:1']]) {
    const quote = await mints.quote({ asset, block: '1', amount: '1' });
    assert.equal(quote.state, 'deployment_needed'); assert.equal(quote.asset, ledger);
    assert.equal(quote.requestId, null); assert.equal(quote.payable, false); assert.deepEqual(quote.fees, []);
    assert.equal(quote.deploymentPage, '/mint/' + (ledger === 'p0' ? 'p2:0' : ledger));
  }
  assert.equal(f.store.count('mints'), 0);
});

test('a registered v2 compound keeps its existing financial registration path', async t => {
  const f = await fixture(t), asset = 'c2:' + 'aa'.repeat(32), submitted = [];
  const document = rules.settingsRevision({ network: f.network, effectiveBatch: '1', effectiveBitcoinWindow: '100', values: { ...rules.SETTINGS_PROFILE } });
  const generation = { id: 'bb'.repeat(32), action: { type: 'deployment-open' } };
  const mints = new FinancialMints({ store: f.store, reads: { batchStamp: async () => ({}), financialDeployment: async value => {
    assert.equal(value, asset); return generation;
  } }, network: f.network, document, financial: { submit: async value => submitted.push(value) } });
  const definition = { id: asset, commitment: 'aa'.repeat(32), v: 3, recipe: 'fusion', firstMaker: 'cd'.repeat(32) };
  await f.store.put('compoundTypes', asset, definition);
  // Its Bitcoin deployment comes first, from the provisioner; the financial registration follows.
  let registered = false;
  mints.provisioner = { request: async (id, value, options) => {
    assert.equal(id, asset); assert.deepEqual(value, definition); assert.equal(options.registeredAsIs, true);
    return registered ? { asset, state: 'registered' } : { asset, state: 'awaiting_player_deploy' };
  } };
  const needed = await mints.quote({ asset, amount: '1' });
  assert.equal(needed.state, 'deployment_needed'); assert.equal(needed.deploymentPage, '/mint/' + asset); assert.equal(needed.payable, false);
  registered = true;
  const quote = await mints.quote({ asset, amount: '1' });
  assert.equal(quote.state, 'deployment_pending'); assert.equal(quote.payable, false);
  assert.deepEqual(submitted, []);
  await mints.deploymentTick();
  assert.deepEqual(submitted, [{ type: 'lifecycle', ...generation }]);
});

test('c2 compounds use the deployment-state, ticker choice, prepare and registration routes', async t => {
  const f = await fixture(t), commitment = '5e'.repeat(32), asset = 'c2:' + commitment;
  const secret = Buffer.alloc(32, 7), maker = Buffer.from(ed25519.getPublicKey(secret)).toString('hex');
  await f.store.put('compoundTypes', asset, { id: asset, commitment, v: 3, recipe: 'fusion', firstMaker: maker });
  f.reads.officialName = async name => f.store.get('officialCatalogNames', name) ?? null;
  const http = await serve({ intake: { store: f.store }, files: { serve: async () => false }, operator: { provisioner: f.operator } });
  t.after(() => http.close());
  const get = async path => { const response = await fetch(http.url + path); assert.equal(response.status, 200); return response.json(); };
  const post = async value => { const response = await fetch(http.url + '/mint/deployment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); assert.equal(response.status, 200); return response.json(); };
  assert.equal((await get('/mint/deployment-state/' + asset)).state, 'not_started');
  assert.equal((await get('/mint/deployment-state/' + encodeURIComponent(asset))).kind, 'compound');
  await get('/mint/deployment/' + asset); await f.operator.work.drain();
  assert.equal((await get('/mint/deployment-state/' + asset)).state, 'awaiting_ticker');
  // The first maker's agent signs the choice; the reply is the deployment state.
  const expiry = Date.now() + 60000, message = rules.compoundTickerMessage({ network: f.network, asset, ticker: 'fivee', revision: 1, expiry, firstMaker: rules.encodeTracAddress(maker) });
  const choose = signer => fetch(http.url + '/mint/deployment-ticker', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ asset, ticker: 'fivee', revision: 1, expiry, agentSignature: Buffer.from(ed25519.sign(Buffer.from(message), signer)).toString('hex') }) });
  const refused = await choose(Buffer.alloc(32, 8));
  assert.equal(refused.status, 403); assert.equal((await refused.json()).error, 'first_maker_signature');
  const chosen = await choose(secret); assert.equal(chosen.status, 200);
  const job = await chosen.json();
  assert.equal(job.state, 'awaiting_player_deploy'); assert.equal(job.phase, 'deployment'); assert.equal(job.chosenTicker.tick, 'fivee');
  assert.deepEqual(job.content, { p: 'tap', op: 'token-deploy', tick: 'fivee', prv: f.privilege, prov: rules.encodeTracAddress(maker), max: '18446744073709551615', dec: '0' });
  assert.deepEqual(await get('/mint/deployment-state/' + asset), job);
  assert.equal((await post({ asset, phase: 'deployment', inscription: f.index(job.content) })).state, 'registered');
  assert.equal((await f.reads.registry()).assets[asset].tick, 'fivee');
  const missing = await fetch(http.url + '/mint/deployment-state/c2:' + '5e'.repeat(31));
  assert.equal(missing.status, 400); assert.equal((await missing.json()).error, 'deployment_asset');
});

test('reused count and all three pattern-free element inscriptions select their frozen legacy deployments', async t => {
  const { readFile } = await import('node:fs/promises');
  const elements = JSON.parse(await readFile(new URL('./fixtures/legacy-elements.json', import.meta.url)));
  for (const { ins: elementId, fld, pat, tick, deployCount } of elements) {
    const fieldValue = pat === null;
    const f = await provisioningFixture(t);
    const pattern = { ...f.pattern, number: '0', fld, pat: fieldValue ? '^1' : pat, ...(fieldValue ? { amountMode: 'field-value' } : {}) };
    f.index(rules.tapElementText(tick, pattern), elementId);
    const job = await f.complete('p2:0', pattern);
    assert.equal(job.reused, true); assert.equal(job.entry.elementId, elementId);
    assert.equal(job.attempts.length, 1, 'only the DMW token is deployed');
    const ids = rules.legacyDeployments(job.entry.elementId, job.entry.privilege);
    assert.equal(ids.length, deployCount, 'membership is by the reused inscription, including an empty group');
    const result = rules.legacyDeployFee('1000000000000000000', rules.splitFee('1000000000000000000'), {
      kind: 'find', deployment: job.entry, height: rules.LEGACY_DEPLOY_SHARE_HEIGHT,
      document: { values: { legacyDeployShareBps: 1000, legacyDeployPayoutMinAtoms: '1000000000000000000' } } });
    assert.equal(result.legacyDeploy?.count ?? 0, ids.length);
    if (!ids.length) assert.deepEqual(result.split, rules.splitFee('1000000000000000000'));
  }
});
