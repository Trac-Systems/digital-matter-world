import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import * as r from '../../rules/src/index.js';
import { Journal } from '../lib/journal.mjs';
import { proposeNamed, revealNamed } from '../lib/named-discovery.mjs';
import { findPatterns } from '../lib/search.mjs';
import { loadHistory } from '../lib/headers.mjs';
import { searchMatchPage } from '../lib/search-matches.mjs';
import { gameTools } from '../lib/tools.mjs';
import { serviceError as oldError } from './fixtures/bafea17-errors.mjs';
const settings = r.settingsRevision({ network: 'fixture', effectiveBatch: '43', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
const secret = r.hashBytes('kit v2 fixture'), owner = r.bytesToHex(ed25519.getPublicKey(secret)), gateway = r.hashBytes('kit gateway fixture');
const proposal = { name: 'dmwtest', pat: '1', fld: 4, dt: 'n' };
async function verified(directory) {
  const path = join(directory, 'headers.bin');
  await writeFile(path, Buffer.from((await readFile(new URL('./fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex'));
  return loadHistory(path);
}
test('field-value search emits exact TAP amounts, distinct identities and mode-aware tool schemas', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dmw-field-value-search-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = await verified(directory), value = { ...proposal, fld: 10, pat: '[0-9]', amountMode: 'field-value' };
  const page = await findPatterns({ history, tip: history.get(63), existing: [], owner: r.encodeTracAddress(owner), settings, candidates: [value], maxCandidates: 1 });
  assert.equal(page.rejected.length, 0);
  const expected = Array.from({ length: 64 }, (_, h) => BigInt(history.get(h).nonce));
  assert.equal(page.accepted[0].localOccurrenceTotal, String(expected.reduce((a, b) => a + b, 0n)));
  assert.equal(page.accepted[0].localMatchCount, String(expected.filter(n => n > 0n).length));
  assert.equal(page.accepted[0].matches[0].count, '2083236893');
  const one = await searchMatchPage({ history, tip: history.get(63), proposal: value, settings, pageSize: 1 });
  const two = await searchMatchPage({ history, tip: history.get(63), proposal: value, settings, pageSize: 1, cursor: one.nextCursor });
  assert.equal(two.matches[0].count, '2573394689');
  await assert.rejects(searchMatchPage({ history, tip: history.get(63), proposal: { ...value, amountMode: 'count' }, settings, pageSize: 1, cursor: one.nextCursor }), /cursor changed/);
  const tools = gameTools({ agent: { owner, service: {}, trac: {} }, history });
  assert.equal(tools.search_patterns.schema.parse({ candidates: [value] }).candidates[0].amountMode, 'field-value');
  assert.equal(tools.propose_pattern.schema.parse({ actionId: 'value', proposal: value }).proposal.amountMode, 'field-value');
  assert.throws(() => tools.propose_pattern.schema.parse({ actionId: 'value', proposal: { ...value, amountMode: 'bad' } }));
});

test('proposing field values before activation cannot save or send a commitment; local evidence works after activation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dmw-field-value-propose-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = await verified(directory), value = { ...proposal, fld: 10, pat: '[0-9]', amountMode: 'field-value' };
  let counted = String(BigInt(r.FIELD_VALUE_AMOUNT_HEIGHT) - 1n);
  const agent = { owner, dryRun: true, actionId() {}, journal: { get: () => null, reserve: () => assert.fail('dry run saved') },
    trac: { head: async () => ({ counted, tip: history.get(63) }), hashAt: async h => history.get(h).hash },
    service: { submit: () => assert.fail('dry run submitted') } };
  await assert.rejects(proposeNamed(agent, { actionId: 'value', proposal: value, history }, { settings }), /pattern_amount_inactive/);
  counted = r.FIELD_VALUE_AMOUNT_HEIGHT;
  const result = await proposeNamed(agent, { actionId: 'value', proposal: value, history }, { settings });
  assert.equal(result.state, 'dry-run'); assert.equal(result.witnesses, settings.values.minMatchingBlocks);
});
test('v2 kit keeps the exact witnessed proposal and uncertain packet across journal restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dmw-r1b-journal-'));
  let journal, tip = 31, sends = 0, fail = true;
  try {
    const history = await verified(directory), header = h => history.get(Number(h));
    const anchor = { height: '31', hash: header(31).hash }, matches = ['1', '10', '11'].map(height => ({ height, hash: header(height).hash, count: height === '11' ? '2' : '1' }));
    journal = await Journal.open(directory, 'fixture', { intervalMs: 0, perTip: 100 });
    const a = { owner, journal, dryRun: false, actionId: id => assert.match(id, /^[a-z]+$/),
      wallet: { publicKey: Buffer.from(owner, 'hex'), sign: bytes => ed25519.sign(bytes, secret) },
      trac: { head: async () => ({ tip: header(tip), counted: tip }), hashAt: async h => header(h).hash,
        discoveryCommitment: async (agent, commitment) => ({ agent, commitment, eligible: '33', expires: '175', opened: false, settingsHash: r.hashObject(settings) }) },
      service: { submit: async move => {
        sends++; if (fail) throw Error('lost_response');
        return r.signReceiptV2(move, { tip: String(tip), hash: header(tip).hash, sequence: String(sends), batch: '43' }, gateway);
      } } };
    const args = { actionId: 'keep', proposal, history, witnesses: { anchor, matches } };
    await assert.rejects(proposeNamed(a, args, { settings }), /lost_response/);
    const body = journal.get('discovery/keep').body, packet = journal.get('discovery/keep/commit').body;
    assert.equal(journal.get('discovery/keep/commit').state, 'unknown');
    journal.close(); journal = await Journal.open(directory, 'fixture', { intervalMs: 0, perTip: 100 }); a.journal = journal;
    fail = false; await proposeNamed(a, args, { settings });
    assert.deepEqual(journal.get('discovery/keep').body, body); assert.deepEqual(journal.get('discovery/keep/commit').body, packet);
    tip = 33; const revealed = await revealNamed(a, { actionId: 'keep', history }, { settings });
    assert.equal(revealed.state, 'received'); assert.deepEqual(journal.get('discovery/keep/reveal').body.p.matches, matches);
    const count = sends; await revealNamed(a, { actionId: 'keep', history }, { settings }); assert.equal(sends, count);
    const hunt = journal.hunting({ limit: 10 }); assert.ok(!JSON.stringify(hunt).includes(body.salt));
  } finally { journal?.close(); await rm(directory, { recursive: true, force: true }); }
});
test('v2 local search accepts constant-count definitions and emits real blocks without catalog scans', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dmw-r1b-search-'));
  try {
    const history = await verified(directory);
    const page = await findPatterns({ history, tip: history.get(63), existing: [], owner: r.encodeTracAddress(owner), settings, candidates: [{ ...proposal, fld: 11, pat: '4' }], maxCandidates: 1 });
    assert.equal(page.accepted.length, 1); assert.equal(page.accepted[0].localMatchCount, '64');
    assert.equal(page.accepted[0].matches[0].hash, history.get(0).hash);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('v2 local search refuses taken names and accepted definitions before any commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dmw-r1b-taken-'));
  try {
    const history = await verified(directory), candidate = { ...proposal, fld: 11, pat: '4' };
    const accepted = { ...candidate, number: 0, key: r.definitionKey(candidate, settings) };
    const search = (existing, candidates) => findPatterns({ history, tip: history.get(63), existing, owner: r.encodeTracAddress(owner), settings, candidates, maxCandidates: candidates.length });
    let page = await search([accepted], [candidate, { ...candidate, name: candidate.name + 'x' }, { ...candidate, pat: '1' }]);
    assert.deepEqual(page.rejected.map(x => x.reason), ['pattern_duplicate', 'pattern_duplicate', 'pattern_exists']);
    page = await search([], [candidate, { ...candidate, pat: '1' }]);
    assert.deepEqual(page.rejected.map(x => x.reason), ['pattern_exists']); assert.equal(page.accepted.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('unmodified bafea17 refusal formatter clearly reports upgrade_required and retains ambiguous sends', () => {
  const error = oldError({ service: 'Gateway service', origin: 'http://127.0.0.1:1', route: '/moves', method: 'POST', status: 409, code: 'upgrade_required', reason: 'request refused', submission: true });
  assert.match(error.message, /upgrade_required/); assert.match(error.message, /same action ID/);
});

test('known closure refusal retains retry timing across restart; later refusal never clears an ambiguous send', async () => {
  const { sendNamedMove } = await import('../lib/named-discovery.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'dmw-lp2-retry-')); let journal;
  try {
    journal = await Journal.open(directory, 'fixture', { intervalMs: 0, perTip: 100 });
    let calls = 0, mode = 'refuse'; const bodies = [];
    const a = { owner, journal, dryRun: false, resources: r.RESOURCE_PROFILE,
      wallet: { publicKey: Buffer.from(owner, 'hex'), sign: bytes => ed25519.sign(bytes, secret) },
      trac: { head: async () => ({ tip: { height: 100, hash: r.hash('100') } }), hashAt: async () => r.hash('100') },
      service: { submit: async move => { calls++; bodies.push(move);
        if (mode === 'refuse') throw Object.assign(Error('closure_backlog_capacity'), { code: 'closure_backlog_capacity', status: 429, refusedBeforeAcceptance: true, retryAfterMs: 80 });
        if (mode === 'unknown') throw Error('lost_response');
        return { move: r.moveIdV2(move) };
      } } };
    const payload = { commitment: r.hash('retry') };
    await assert.rejects(sendNamedMove(a, 'keep', 'discovery-commit-v2', payload, settings), /closure_backlog_capacity/);
    assert.equal(journal.get('keep').state, 'refused'); const until = journal.get('keep').result.retryAt;
    journal.close(); journal = await Journal.open(directory, 'fixture', { intervalMs: 0, perTip: 100 }); a.journal = journal;
    mode = 'ok'; await sendNamedMove(a, 'keep', 'discovery-commit-v2', payload, settings);
    assert.ok(Date.now() >= until); assert.equal(calls, 2); assert.equal(journal.get('keep').state, 'received');
    mode = 'unknown'; await assert.rejects(sendNamedMove(a, 'uncertain', 'discovery-commit-v2', payload, settings), /lost_response/);
    const saved = journal.get('uncertain').body;
    mode = 'refuse'; await assert.rejects(sendNamedMove(a, 'uncertain', 'discovery-commit-v2', payload, settings), /closure_backlog_capacity/);
    assert.equal(journal.get('uncertain').state, 'unknown'); assert.deepEqual(bodies.at(-1), saved);
  } finally { journal?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('plain-name tools and local proposal preflight refuse before activation and preserve plain names after it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dmw-plain-search-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = await verified(directory), plain = { ...proposal, name: 'florite' };
  let counted = String(BigInt(r.PLAIN_NAMES_HEIGHT) - 1n);
  const agent = { owner, dryRun: true, actionId() {}, catalog: async () => [], namedContext: async () => ({ settings }),
    journal: { get: () => null, reserve: () => assert.fail('dry run saved') },
    trac: { head: async () => ({ counted, tip: history.get(63) }), hashAt: async h => history.get(h).hash },
    service: { submit: () => assert.fail('dry run submitted') } };
  agent.propose = args => proposeNamed(agent, args, { settings });
  const tools = gameTools({ agent, history });
  const args = tools.propose_pattern.schema.parse({ actionId: 'plain', proposal: plain });
  await assert.rejects(tools.propose_pattern.run(args), /pattern_name/);
  await assert.rejects(proposeNamed(agent, { ...args, history }, { settings }), /pattern_name/);
  await assert.rejects(tools.pattern_search_matches.run({ proposal: plain }), /pattern_name/);
  counted = r.PLAIN_NAMES_HEIGHT;
  assert.equal((await tools.propose_pattern.run(args)).state, 'dry-run');
  const found = await tools.search_patterns.run({ candidates: [plain], maxCandidates: 1 });
  assert.equal(found.accepted[0].proposal.name, 'florite');
  assert.equal(found.rejected.length, 0);
  assert.ok((await tools.pattern_search_matches.run({ proposal: plain })).matches.length >= 3);
  for (const name of ['ab', 'UPPER', 'x'.repeat(33), 'dmt-florite']) assert.throws(() => tools.propose_pattern.schema.parse({ ...args, proposal: { ...plain, name } }));
  const collision = await findPatterns({ history, tip: history.get(63), settings, executionHeight: counted,
    existing: [{ ...plain, pat: '2' }], owner: r.encodeTracAddress(owner), candidates: [plain], maxCandidates: 1 });
  assert.equal(collision.rejected[0].reason, 'pattern_exists');
});
