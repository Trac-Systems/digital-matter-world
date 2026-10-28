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
import { serviceError as oldError } from './fixtures/bafea17-errors.mjs';
const settings = r.settingsRevision({ network: 'fixture', effectiveBatch: '43', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
const secret = r.hashBytes('kit v2 fixture'), owner = r.bytesToHex(ed25519.getPublicKey(secret)), gateway = r.hashBytes('kit gateway fixture');
const proposal = { name: 'dmwtest', pat: '1', fld: 4, dt: 'n' };
async function verified(directory) {
  const path = join(directory, 'headers.bin');
  await writeFile(path, Buffer.from((await readFile(new URL('./fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex'));
  return loadHistory(path);
}
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
