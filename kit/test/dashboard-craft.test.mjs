import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { serveDashboard } from '../lib/dashboard.mjs';
import { DashboardState } from '../lib/dashboard-state.mjs';
import { dashboardFixture } from './fixtures/dashboard-service.mjs';
import { cleanup } from './helpers.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const COMPOUND = 'c2:' + 'ab'.repeat(32), MADE = 'c2:' + 'ef'.repeat(32);

async function start(t, setup = () => {}, { realPreview = false } = {}) {
  const f = await dashboardFixture(t);
  // The owner's mix: two v2 patterns, imported legacy units and one compound.
  f.patterns.length = 0;
  f.patterns.push({ number: '0', asset: 'p2:0', name: 'dmwflorite', tier: 4, fld: 10, knownMatchCount: '571' }, { number: '1', asset: 'p2:1', name: 'dmwnullspar', tier: 3, fld: 10, knownMatchCount: '40' },
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

test('ingredients: v2 patterns and compounds with their properties; imported units are shown but cannot be crafted', async t => {
  const { call, crafts } = await start(t);
  const { status, body } = await call('/api/craft');
  assert.equal(status, 200);
  const of = asset => body.ingredients.find(i => i.asset === asset);
  assert.deepEqual([of('p2:1').name, of('p2:1').craftable, of('p2:1').available, of('p2:1').properties], ['dmwnullspar', true, '92', { charge: 1, spectrum: 2, generation: '0', matches: '40' }]);
  assert.deepEqual([of('p2:2').properties.charge, of('p2:2').properties.spectrum], [2, 1]);
  assert.deepEqual([of('p0').name, of('p0').kind, of('p0').craftable, of('p0').reason], ['dmwflorite', 'legacy', false, 'craft_legacy']);
  assert.equal(body.maxInputs, 8);
  assert.equal(crafts.length, 0);
  // A legacy key is refused before any preview runs.
  assert.deepEqual((await call('/api/craft-preview', { recipe: 'fusion', inputs: [['p0', '1'], ['p2:1', '1']] })).body, { error: 'craft_legacy' });
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
  assert.deepEqual(body.result, { id: MADE, amount: '3', tier: 4, label: 'Compound · fusion of dmwnullspar + dmwmuffinite', properties: { charge: 3, spectrum: 3, generation: '1' }, snapshot: '20' });
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
  assert.deepEqual([view.crafts[0].state, view.crafts[0].batch, view.crafts[0].label], ['received', '51', 'Compound · fusion of dmwnullspar + dmwmuffinite']);
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
  assert.deepEqual([c.name, c.amount, c.tier, c.needsRefine], ['Compound · fusion of dmwnullspar + dmwmuffinite', '4', null, true]);
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
