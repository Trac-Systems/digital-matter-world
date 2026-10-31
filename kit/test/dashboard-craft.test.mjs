import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { serveDashboard } from '../lib/dashboard.mjs';
import { DashboardState } from '../lib/dashboard-state.mjs';
import { dashboardFixture } from './fixtures/dashboard-service.mjs';
import { COMPOUND_IDENTITY_V4_HEIGHT } from '../../rules/src/index.js';
import { cleanup } from './helpers.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const COMPOUND = 'c2:' + 'ab'.repeat(32), MADE = 'c2:' + 'ef'.repeat(32);

async function start(t, setup = () => {}, { realPreview = false } = {}) {
  const f = await dashboardFixture(t);
  // The owner's mix: two v2 patterns, imported legacy units and one compound.
  f.patterns.length = 0;
  f.patterns.push({ number: '0', asset: 'p2:0', name: 'dmwflorite', legacy: { asset: 'p0' }, tier: 4, fld: 10, knownMatchCount: '571' }, { number: '1', asset: 'p2:1', name: 'dmwnullspar', tier: 3, fld: 10, knownMatchCount: '40' },
    { number: '2', asset: 'p2:2', name: 'dmwmuffinite', tier: 2, fld: 4, knownMatchCount: '900' },
    { number: '65522', asset: 'p2:65522', name: 'dmwechoite', tier: 4, fld: 11, knownMatchCount: '7' });
  f.balances.set('p2:1', { amount: '92', current: true }); f.balances.set('p2:2', { amount: '100', current: true }); f.balances.set('p0', { amount: '99', current: true });
  const service = f.agent.service, profile = service.profile.bind(service), events = [];
  const compoundRows = new Map([[COMPOUND, { id: COMPOUND, recipe: 'fusion', inputs: [{ asset: 'p2:1', amount: '1' }, { asset: 'p2:2', amount: '1' }],
    properties: { charge: 3, spectrum: 3, generation: '1' }, tier: { value: null } }]]);
  service.compounds = async ({ asset }) => ({ compounds: compoundRows.has(asset) ? [compoundRows.get(asset)] : [] });
  service.profile = async (owner, options) => options.collection === 'history' ? { history: events.filter(e => !options.type || e.type === options.type), nextCursor: null } : profile(owner, options);
  const state = new DashboardState(f.context), previews = [], crafts = [], refines = [], outcomes = [];
  // The gateway's verified preview, observed: fusion of any inputs; resonance
  // only with equal charges, as the rules decide.
  if (!realPreview) state.preview = async ({ recipe, inputs }) => {
    previews.push({ recipe, inputs });
    const charge = asset => Number(BigInt(asset.slice(3)) % 65521n);
    if (recipe === 'resonance' && new Set(inputs.map(([a]) => charge(a))).size > 1) throw Error('resonance_charge');
    const amount = String(inputs.map(([, a]) => BigInt(a)).reduce((a, b) => { while (b) [a, b] = [b, a % b]; return a; }));
    return { result: { amount, record: { id: MADE, commitment: MADE.slice(3), snapshot: { height: '20' }, tier: { value: 4 }, properties: { charge: 3, spectrum: 3, generation: '1' } } } };
  };
  // The kit's craft action, observed, writing journal rows like the real
  // action (signed intent, then the gateway receipt).
  f.agent.craft = async ({ actionId, recipe, inputs }) => {
    crafts.push({ actionId, recipe, inputs, saved: state.savedCrafts(50).some(c => c.actionId === actionId) });
    const outcome = outcomes.shift();
    if (!f.journal.get(`craft/${actionId}/v2-intent`)) f.journal.reserve(`craft/${actionId}/v2-intent`, { recipe, inputs }, { result: { record: { id: MADE }, amount: '1' } });
    if (outcome) throw outcome;
    if (!f.journal.get(`craft/${actionId}`)) f.journal.reserve(`craft/${actionId}`, { type: 'craft-v2' }, { v: 2 });
    f.journal.mark(`craft/${actionId}`, 'received', { move: sha('move/' + actionId), batch: '51' });
    return { state: 'received' };
  };
  f.agent.refineCompound = async args => { refines.push(args); return { state: 'received' }; };
  setup(f, { compoundRows });
  const dashboard = await serveDashboard(f.context, { state }); cleanup(t, () => dashboard.close());
  const token = new URL(dashboard.loginLink).hash.slice(1);
  const login = await fetch(dashboard.origin + '/login', { method: 'POST', headers: { origin: dashboard.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (path, body, headers = {}) => {
    const response = await fetch(dashboard.origin + path, { headers: { cookie, origin: dashboard.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { f, dashboard, state, call, previews, crafts, refines, outcomes, events, compoundRows, settle: () => state.craftTail };
}

test('ingredients preserve the pre-activation gate and show legacy units awaiting the upgrade', async t => {
  const { call, crafts } = await start(t);
  const { status, body } = await call('/api/craft');
  assert.equal(status, 200);
  const of = asset => body.ingredients.find(i => i.asset === asset);
  assert.deepEqual([of('p2:1').name, of('p2:1').craftable, of('p2:1').available, of('p2:1').properties], ['dmwnullspar', true, '92', { charge: 1, spectrum: 2, generation: '0', matches: '40' }]);
  assert.deepEqual([of('p2:2').properties.charge, of('p2:2').properties.spectrum], [2, 1]);
  assert.deepEqual([of('p0').name, of('p0').kind, of('p0').craftable, of('p0').reason], ['dmwflorite', 'legacy', false, 'craft_upgrade_pending']);
  assert.equal(body.maxInputs, 8);
  assert.equal(crafts.length, 0);
  // Before activation, a legacy key waits for the consensus upgrade.
  assert.deepEqual((await call('/api/craft-preview', { recipe: 'fusion', inputs: [['p0', '1'], ['p2:1', '1']] })).body, { error: 'craft_upgrade_pending' });
  assert.deepEqual((await call('/api/craft-preview', { recipe: 'fusion', inputs: [['p2:1', '1']] })).body, { error: 'craft_two_inputs' });
  assert.deepEqual((await call('/api/craft-preview', { recipe: 'fusion', inputs: [['p2:1', '93'], ['p2:2', '1']] })).body, { error: 'craft_over_available' });
});

test('one craftable pattern only: the page explains that a second pattern is needed', async t => {
  const { call } = await start(t, f => { f.balances.delete('p2:2'); });
  const { body } = await call('/api/craft');
  assert.deepEqual(body.ingredients.filter(i => i.craftable).map(i => i.asset), ['p2:1']);
  const source = await readFile(new URL('../dashboard/agent.js', import.meta.url), 'utf8');
  assert.match(source, /You need units of at least two patterns to craft — claim blocks of another pattern first\./);
});

test('resonance with different charges is refused with its reason; equal charges preview fine', async t => {
  const { call, crafts } = await start(t, f => f.balances.set('p2:65522', { amount: '5', current: true }));
  const { body } = await call('/api/craft');
  // 65522 mod 65521 = 1: dmwechoite has the same charge as dmwnullspar.
  assert.equal(body.ingredients.find(i => i.asset === 'p2:65522').properties.charge, 1);
  assert.deepEqual((await call('/api/craft-preview', { recipe: 'resonance', inputs: [['p2:1', '1'], ['p2:2', '1']] })).body, { error: 'resonance_charge' });
  assert.equal((await call('/api/craft-preview', { recipe: 'resonance', inputs: [['p2:1', '1'], ['p2:65522', '1']] })).status, 200);
  assert.equal(crafts.length, 0);
  // The page disables Resonance from the ingredients' charges and says why.
  const source = await readFile(new URL('../dashboard/agent.js', import.meta.url), 'utf8');
  assert.match(source, /Resonance needs the same charge on every ingredient\./);
});

test('preview shows the verified result before anything is signed, with sorted exact inputs and the units left', async t => {
  const { call, previews, crafts } = await start(t);
  const { status, body } = await call('/api/craft-preview', { recipe: 'fusion', inputs: [['p2:2', '3'], ['p2:1', '3']] });
  assert.equal(status, 200);
  assert.deepEqual(previews, [{ recipe: 'fusion', inputs: [['p2:1', '3'], ['p2:2', '3']] }]);
  assert.deepEqual(body.result, { id: MADE, amount: '3', existing: false, tier: 4, label: 'Nullspar + Muffinite fusion', properties: { charge: 3, spectrum: 3, generation: '1' }, snapshot: '20' });
  assert.deepEqual(body.inputs.map(i => [i.asset, i.amount, i.left]), [['p2:1', '3', '89'], ['p2:2', '3', '97']]);
  assert.equal(crafts.length, 0, 'a preview signs nothing');
});

test('the default preview is the kit\'s verified craft preview: a proof that does not match the accepted catalog is refused', async t => {
  const asked = [];
  const { call, crafts } = await start(t, f => {
    f.agent.trac.hashAt = async () => '00'.repeat(32);
    f.agent.service.craftPreview = async (value, limit) => { asked.push({ value, limit }); return { root: 'not-the-catalog', nodes: [] }; };
  }, { realPreview: true });
  const { status, body } = await call('/api/craft-preview', { recipe: 'fusion', inputs: [['p2:2', '1'], ['p2:1', '1']] });
  assert.deepEqual([status, body], [400, { error: 'craft_preview_proof' }]);
  assert.deepEqual(asked.map(a => a.value), [{ recipe: 'fusion', inputs: [['p2:1', '1'], ['p2:2', '1']], snapshot: { height: '20', hash: '00'.repeat(32) } }]);
  assert.equal((await call('/api/craft', { recipe: 'fusion', inputs: [['p2:2', '1'], ['p2:1', '1']] })).status, 400);
  assert.equal(crafts.length, 0, 'nothing is signed or saved');
  assert.deepEqual((await call('/api/craft')).body.crafts, []);
});

test('warnings: units needed to mint claimed blocks of an ingredient', async t => {
  const { call } = await start(t, f => f.claims.forEach(c => { c.asset = 'p2:1'; }));
  // Blocks 12 and 11 of dmwnullspar wait to mint (3 units each); block 10 is minted.
  let { body } = await call('/api/craft-preview', { recipe: 'fusion', inputs: [['p2:1', '90'], ['p2:2', '90']] });
  const w = body.warnings.find(w => w.asset === 'p2:1');
  assert.deepEqual([w.code, w.blocks, w.units, w.left], ['craft_uses_mint_units', 2, '6', '2']);
  ({ body } = await call('/api/craft-preview', { recipe: 'fusion', inputs: [['p2:1', '2'], ['p2:2', '2']] }));
  assert.deepEqual(body.warnings.map(w => [w.code, w.asset]), [['craft_mint_units_ok', 'p2:1']]);
});

test('confirm saves the action ID first, then calls the kit craft action with the exact inputs; progress reaches the batch', async t => {
  const { call, crafts, settle, events, state } = await start(t);
  const { status, body } = await call('/api/craft', { recipe: 'fusion', inputs: [['p2:2', '2'], ['p2:1', '2']] });
  assert.equal(status, 202);
  assert.match(body.id, /^[0-9a-f]{12}$/);
  await settle();
  assert.equal(crafts.length, 1);
  assert.deepEqual(crafts[0], { actionId: `dash-craft-${body.id}`, recipe: 'fusion', inputs: [['p2:1', '2'], ['p2:2', '2']], saved: true });
  let view = (await call('/api/craft')).body;
  assert.deepEqual([view.crafts[0].state, view.crafts[0].batch, view.crafts[0].label], ['received', '51', 'Nullspar + Muffinite fusion']);
  // Units going into an unconfirmed craft are not offered again.
  assert.equal(view.ingredients.find(i => i.asset === 'p2:1').available, '90');
  state.craftEvents = null;
  events.push({ id: sha('v2-event/craft/' + sha('move/dash-craft-' + body.id)), type: 'craft', provenance: { batch: '52' } });
  view = (await call('/api/craft')).body;
  assert.deepEqual([view.crafts[0].state, view.crafts[0].batch], ['confirmed', '52']);
});

test('a craft also confirms from this agent\'s public craft event of the new compound key', async t => {
  const { call, settle, events, f } = await start(t);
  await call('/api/craft', { recipe: 'fusion', inputs: [['p2:1', '1'], ['p2:2', '1']] });
  await settle();
  events.push({ id: 'other', type: 'craft', data: { owner: f.agent.address, asset: MADE }, provenance: { batch: '53' } });
  const view = (await call('/api/craft')).body.crafts[0];
  assert.deepEqual([view.state, view.batch, view.asset], ['confirmed', '53', MADE]);
});

test('an uncertain craft retries with the same saved action ID and is never re-signed under a new one', async t => {
  const { call, crafts, outcomes, settle } = await start(t);
  outcomes.push(Object.assign(Error('gateway timeout'), { code: 'transport_error' }));
  const { body } = await call('/api/craft', { recipe: 'fusion', inputs: [['p2:1', '1'], ['p2:2', '1']] });
  await settle();
  let view = (await call('/api/craft')).body.crafts[0];
  assert.deepEqual([view.state, view.error, view.signed], ['uncertain', 'transport_error', true]);
  assert.equal((await call('/api/craft-retry', { id: body.id })).status, 202);
  await settle();
  assert.deepEqual(crafts.map(c => c.actionId), [`dash-craft-${body.id}`, `dash-craft-${body.id}`]);
  view = (await call('/api/craft')).body.crafts[0];
  assert.equal(view.state, 'received');
  assert.equal((await call('/api/craft-retry', { id: body.id })).status, 409);
  assert.equal(crafts.length, 2);
});

test('your compounds: label, made-from and Refine for an open tier, run through the kit with a saved action ID', async t => {
  const { call, refines, settle } = await start(t, f => f.balances.set(COMPOUND, { amount: '4', current: true }));
  const { body } = await call('/api/craft');
  const c = body.compounds.find(c => c.asset === COMPOUND);
  assert.deepEqual([c.name, c.amount, c.tier, c.needsRefine], ['Nullspar + Muffinite fusion', '4', null, true]);
  assert.deepEqual(c.from.map(i => [i.name, i.amount]), [['dmwnullspar', '1'], ['dmwmuffinite', '1']]);
  // A compound is itself an ingredient, with the properties of its record.
  assert.deepEqual(body.ingredients.find(i => i.asset === COMPOUND).properties, { charge: 3, spectrum: 3, generation: '1', matches: null });
  const started = await call('/api/craft-refine', { asset: COMPOUND });
  assert.equal(started.status, 202);
  await settle();
  assert.deepEqual(refines, [{ actionId: `dash-refine-${started.body.id}`, asset: COMPOUND }]);
  assert.equal((await call('/api/craft-refine', { asset: 'c2:' + '00'.repeat(32) })).status, 400);
});

test('craft endpoints need the login cookie and the dashboard origin', async t => {
  const { dashboard, crafts, previews } = await start(t);
  const body = JSON.stringify({ recipe: 'fusion', inputs: [['p2:1', '1'], ['p2:2', '1']] });
  for (const path of ['/api/craft-preview', '/api/craft', '/api/craft-retry', '/api/craft-refine']) {
    const anonymous = await fetch(dashboard.origin + path, { method: 'POST', headers: { origin: dashboard.origin, 'content-type': 'application/json' }, body });
    assert.equal(anonymous.status, 401, path);
    const foreign = await fetch(dashboard.origin + path, { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json' }, body });
    assert.equal(foreign.status, 403, path);
  }
  assert.equal((await fetch(dashboard.origin + '/api/craft')).status, 401);
  assert.equal(crafts.length + previews.length, 0);
});


test('activated florite uses its canonical properties and previews exact legacy ledger debits', async t => {
  const { call, previews } = await start(t, f => {
    f.clock.counted = COMPOUND_IDENTITY_V4_HEIGHT;
    f.balances.set('p2:0', { amount: '5', current: true });
  });
  const { body } = await call('/api/craft');
  const florite = body.ingredients.find(i => i.asset === 'p0');
  assert.equal(florite.craftable, true); assert.equal(florite.properties.charge, 0); assert.equal(florite.properties.matches, '571');
  const result = await call('/api/craft-preview', { recipe: 'fusion', inputs: [['p0', '2'], ['p2:1', '2']] });
  assert.equal(result.status, 200); assert.equal(result.body.inputs[0].left, '97');
  assert.deepEqual(previews[0].inputs, [['p0', '2'], ['p2:1', '2']]);
  const mixed = await call('/api/craft-preview', { recipe: 'fusion', inputs: [['p0', '1'], ['p2:0', '1'], ['p2:1', '2']] });
  assert.equal(mixed.status, 200);
  assert.equal(mixed.body.result.label, 'Florite + Nullspar fusion');
  assert.equal(mixed.body.result.label, result.body.result.label);
  assert.deepEqual(mixed.body.inputs.map(i => [i.asset, i.left]), [['p0', '98'], ['p2:0', '4'], ['p2:1', '90']]);
});
test('dashboard distinguishes adding units to an authenticated existing compound', async t => {
  const { state, call } = await start(t);
  const preview = state.preview;
  state.preview = async args => { const value = await preview(args); value.result.existing = true; return value; };
  const { body } = await call('/api/craft-preview', { recipe: 'fusion', inputs: [['p2:1', '2'], ['p2:2', '2']] });
  assert.equal(body.result.existing, true); assert.equal(body.result.amount, '2');
  const source = await readFile(new URL('../dashboard/agent.js', import.meta.url), 'utf8');
  assert.match(source, /Adds \$\{fmtInt\(r.amount\)\} units to/);
  assert.doesNotMatch(source, /Imported.*can’t be crafted|craft_legacy/);
});

test('your compounds: token state and first maker; Make real on TAP signs a compound mint through the kit for the chosen units', async t => {
  let deployed = false;
  const made = [];
  const { state, call } = await start(t, (f, { compoundRows }) => {
    f.balances.set(COMPOUND, { amount: '4', current: true });
    compoundRows.get(COMPOUND).tier = { value: 5, expression: {} };
    compoundRows.get(COMPOUND).firstMaker = f.agent.address;
    f.agent.service.mintRights = async (owner, { asset } = {}) => ({ mintRights: asset ? [{ asset, compound: true, deploymentRegistered: deployed }] : [] });
    // A taken ticker gets a word added, so the deployed ticker is read from its registered deployment.
    f.agent.service.deploymentState = async asset => ({ asset, state: deployed ? 'registered' : 'awaiting_player_deploy', entry: deployed ? { tick: 'dmwcabababab' + 'amber' } : null });
    f.agent.makeReal = async args => { made.push(args); return { state: 'submitted', request: { id: 'cd'.repeat(32) } }; };
  });
  const c = (await call('/api/craft')).body.compounds.find(c => c.asset === COMPOUND);
  assert.deepEqual([c.tier, c.generation, c.charge, c.spectrum, c.firstMaker, c.token, c.ticker], [5, '1', 3, 3, true, 'not_deployed', null]);
  // The first maker deploys from the pattern deployment page, with the agent's address filled in.
  const link = new URL(c.deploymentLink);
  assert.equal(link.pathname, '/mint/' + COMPOUND); assert.equal(link.searchParams.get('owner'), state.agent.address);
  // Nothing is signed before its token is deployed.
  assert.deepEqual((await call('/api/mint-compound', { asset: COMPOUND, amount: '2' })).body, { error: 'compound_not_deployed' });
  deployed = true; state.craftReads.clear();
  const shown = (await call('/api/craft')).body.compounds.find(c => c.asset === COMPOUND);
  assert.equal(shown.deploymentLink, null); assert.equal(shown.ticker, 'dmwcababababamber');
  assert.deepEqual((await call('/api/mint-compound', { asset: COMPOUND, amount: '5' })).body, { error: 'compound_over_available' });
  assert.deepEqual((await call('/api/mint-compound', { asset: COMPOUND, amount: 'x' })).body, { error: 'invalid_compound_mint' });
  assert.equal(made.length, 0);
  const { status, body } = await call('/api/mint-compound', { asset: COMPOUND, amount: '2' });
  assert.equal(status, 200); assert.equal(body.requestId, 'cd'.repeat(32));
  assert.deepEqual([made.length, made[0].asset, made[0].amount, made[0].compound, made[0].block, made[0].kind], [1, COMPOUND, '2', true, undefined, 'tap']);
});

test('make real on TAP: a retry after an unclear result reuses the saved action and never signs a second request', async t => {
  const made = [], states = new Map();
  let lose = true, n = 0;
  const { f, call } = await start(t, (f, { compoundRows }) => {
    f.balances.set(COMPOUND, { amount: '4', current: true });
    compoundRows.get(COMPOUND).tier = { value: 5, expression: {} };
    f.agent.service.mintRights = async (owner, { asset } = {}) => ({ mintRights: asset ? [{ asset, compound: true, deploymentRegistered: true }] : [] });
    // Like the kit: the signed intent is journaled under its action ID before it is sent; a lost reply leaves it 'unknown'.
    f.agent.makeReal = async args => {
      made.push(args);
      const { actionId, asset, amount, receiver, payer, kind, compound } = args, key = 'mint/' + actionId, intent = { asset, amount, receiver, payer, kind, compound };
      const row = f.journal.reserve(key, intent, f.journal.get(key)?.body ?? { version: 2, receiver: args.receiver, payer: args.payer, kind: args.kind,
        request: { v: 2, owner: f.agent.owner, asset: args.asset, amount: args.amount, receive: sha(args.receiver), nonce: sha('nonce/' + n++), until: '100', expires: '200', settingsHash: 'd'.repeat(64) } });
      if (lose) { f.journal.mark(key, 'unknown'); throw Object.assign(Error('fetch failed'), { status: 502 }); }
      const id = (await import('../../rules/src/financial-mint.js')).financialMintId(f.agent.network, row.body.request);
      states.set(id, 'awaiting_payment'); f.journal.mark(key, 'submitted', { state: 'submitted' });
      return { state: 'submitted', request: { id } };
    };
    f.agent.service.mintStatus = async id => {
      if (!states.has(id)) throw Object.assign(Error('mint_not_found'), { status: 404 });
      return { requestId: id, state: states.get(id) };
    };
  });
  const mints = () => f.journal.db.prepare("SELECT id FROM actions WHERE id LIKE 'mint/%'").all().map(r => r.id);
  // The first click signs and saves the request, then the reply is lost.
  assert.ok((await call('/api/mint-compound', { asset: COMPOUND, amount: '2' })).status >= 500);
  assert.equal(mints().length, 1);
  // A deliberate retry sends the same saved action: same ID, same intent, nothing new signed.
  lose = false;
  const retried = await call('/api/mint-compound', { asset: COMPOUND, amount: '2' });
  assert.equal(retried.status, 200);
  assert.deepEqual(made.map(m => m.actionId), [made[0].actionId, made[0].actionId]);
  assert.deepEqual(made[1], made[0]);
  assert.equal(mints().length, 1);
  const id = retried.body.requestId;
  assert.equal(states.get(id), 'awaiting_payment');
  // While that request is open, another click (even for another amount) opens it again instead of a second request.
  const again = await call('/api/mint-compound', { asset: COMPOUND, amount: '1' });
  assert.deepEqual([again.body.requestId, again.body.replayed, again.body.amount], [id, true, '2']);
  assert.equal(made.length, 2); assert.equal(mints().length, 1);
  // Once it is minted (or expired), the next click is a new request with a new action.
  states.set(id, 'minted');
  const next = await call('/api/mint-compound', { asset: COMPOUND, amount: '1' });
  assert.equal(next.status, 200); assert.notEqual(next.body.requestId, id);
  assert.equal(made.length, 3); assert.notEqual(made[2].actionId, made[0].actionId); assert.equal(mints().length, 2);
});

test('your patterns: who may deploy during the discoverer\'s week, and the deployed ticker', async t => {
  const { state } = await start(t);
  const deployments = new Map();
  state.service.deploymentState = async asset => deployments.get(asset);
  state.service.profile = async () => ({ finds: [], rows: [] }); state.service.mintRights = async () => ({ mintRights: [], rows: [] });
  const row = asset => state.patternRow({ asset, ids: new Set([asset]), name: 'dmwflorite', tier: 4, discovered: true });
  const week = discoverer => ({ asset: 'p2:1', state: 'awaiting_player_deploy', phase: 'element', deployer: { onlyDiscoverer: true, until: '974730', discoverer, address: 'bc1p', counted: '973900' } });
  deployments.set('p2:1', week(state.agent.address));
  let p = await row('p2:1');
  assert.deepEqual([p.token, p.ownWeek, p.deployer.until, p.ticker], ['not_deployed', true, '974730', null]); assert.ok(p.deploymentLink);
  deployments.set('p2:1', week('trac1someoneelse'));
  p = await row('p2:1');
  assert.equal(p.ownWeek, false); assert.equal(p.deployer.onlyDiscoverer, true);
  deployments.set('p2:1', { asset: 'p2:1', state: 'registered', entry: { tick: 'dmwfloriteamber' } });
  p = await row('p2:1');
  assert.deepEqual([p.token, p.ticker, p.deployer, p.deploymentLink], ['deployed', 'dmwfloriteamber', null, null]);
});

test('an older compound id merged on mainnet is named and linked as the compound it became', async t => {
  const f = await dashboardFixture(t);
  const { COMPOUND_IDENTITY_V4_MERGES } = await import('../../rules/src/index.js'), [row] = COMPOUND_IDENTITY_V4_MERGES.rows;
  f.patterns.push({ number: '2', asset: 'p2:2', name: 'dmwmuffinite', tier: 2 });
  f.agent.service.compounds = async ({ asset }) => ({ compounds: asset === row.newId ? [{ id: row.newId, recipe: 'fusion', inputs: [{ asset: 'p2:1', amount: '1' }, { asset: 'p2:2', amount: '1' }] }] : [] });
  const regtest = new DashboardState(f.context);
  assert.deepEqual((await regtest.info()).merged, {}, 'the merge record is the mainnet one');
  f.agent.network = COMPOUND_IDENTITY_V4_MERGES.network;
  const state = new DashboardState(f.context);
  assert.equal((await state.info()).merged[row.oldId], row.newId);
  assert.deepEqual(await state.unitLabel(row.oldId), { ...await state.unitLabel(row.newId), mergedInto: row.newId });
  assert.equal((await state.unitLabel(row.oldId)).name, 'Test + Muffinite fusion');
});
