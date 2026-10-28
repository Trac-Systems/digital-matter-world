import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { stableJSON, discoveryCommitment, moveId } from '../../rules/src/index.js';
import { signMove } from '../lib/signing.mjs';
import { runTool } from '../lib/tools.mjs';
import { Agent } from '../lib/agent.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { Journal } from '../lib/journal.mjs';
import { loadHistory } from '../lib/headers.mjs';
import { temp, cleanup, testWallet, fakeTrac } from './helpers.mjs';
import { FakeService } from './fake-service.mjs';

const proposal = { name: 'dmwnewdigits', pat: '[12]', fld: 4, dt: 'n' };
async function fixture(t) {
  const dir = await temp(t), raw = Buffer.from((await readFile(new URL('./fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex');
  const histories = {};
  for (const count of [59, 61, 62, 63, 64]) { const path = join(dir, `history-${count}.bin`); await writeFile(path, raw.subarray(0, count * 80)); histories[count - 1] = await loadHistory(path); }
  const history = histories[63], network = 'dmw-kit-test', fake = new FakeService({ network, history }), wallet = testWallet();
  const { trac, state } = fakeTrac({ get: h => history.get(h), hashAt: h => history.get(h)?.hash }, { network, tip: 61 });
  const service = new ServiceClient({ network, gateway: fake.gateway, receiptSigners: fake.witness.members, fetchImpl: fake.fetch });
  const directory = join(dir, 'journal'); let journal = await Journal.open(directory, network, { intervalMs: 0 });
  const agent = new Agent({ network, wallet, trac, service, journal, dryRun: false, puzzleBits: 0 });
  cleanup(t, () => journal.close());
  return { fake, agent, service, histories, dir, state, advance(tip) { state.tip = fake.tip = tip; }, async restart() {
    journal.close(); journal = await Journal.open(directory, network, { intervalMs: 0 }); agent.journal = journal;
  } };
}
test('commit/reveal survives lost replies and restarts without exposing or replacing the saved salt', async t => {
  const f = await fixture(t), args = { actionId: 'digits', proposal, history: f.histories[61], patterns: [] };
  f.fake.lose = '/moves'; await assert.rejects(f.agent.propose(args), /unknown/);
  const saved = f.agent.journal.get('discovery/digits').body, packet = f.agent.journal.get('discovery/digits/commit').body;
  assert.equal(packet.p.commitment, discoveryCommitment(proposal, saved.salt, f.agent.owner));
  assert.equal(JSON.stringify(f.fake.calls).includes(saved.salt), false); assert.equal(JSON.stringify(f.fake.calls).includes(proposal.name), false);
  assert.equal((await stat(join(f.dir, 'journal/journal.sqlite'))).mode & 0o077, 0);
  await f.restart(); const committed = await f.agent.propose(args);
  assert.equal(committed.phase, 'commit'); assert.equal(f.fake.entries.size, 1);
  assert.deepEqual(f.agent.journal.get('discovery/digits').body, saved);
  await assert.rejects(f.agent.propose({ ...args, proposal: { ...proposal, pat: '[23]' } }), /Conflicting/);
  const { publication } = f.fake.observe();
  f.advance(62);
  await assert.rejects(f.agent.reveal({ actionId: 'digits', publication, history: f.histories[62], patterns: [] }), /not yet open/);
  f.fake.observe(); f.advance(63); await f.restart();
  f.fake.lose = '/moves';
  await assert.rejects(f.agent.reveal({ actionId: 'digits', history: f.histories[63], patterns: [] }), /unknown/);
  await f.restart();
  const result = await f.agent.reveal({ actionId: 'digits', history: f.histories[63], patterns: [] });
  assert.equal(result.phase, 'reveal'); assert.equal(f.fake.entries.size, 2);
  assert.deepEqual(f.agent.journal.get('discovery/digits/reveal').body.p, { proposal, salt: saved.salt });
  const revealed = f.fake.observe().output;
  assert.equal(revealed.file.moves[0].reason, 'accepted'); assert.equal(revealed.file.discoveries[0].record.discoverer, f.agent.owner);
  assert.equal((await f.agent.reveal({ actionId: 'digits' })).replayed, true);
});
test('a witnessed audit recovers an unknown commitment without resending its stale packet', async t => {
  const f = await fixture(t); f.fake.lose = '/moves';
  await assert.rejects(f.agent.propose({ actionId: 'recover', proposal, history: f.histories[61], patterns: [] }), /unknown/);
  const { publication } = f.fake.observe(); f.advance(62); f.fake.observe(); f.advance(63); await f.restart();
  const result = await f.agent.reveal({ actionId: 'recover', publication, history: f.histories[63], patterns: [] });
  assert.equal(result.phase, 'reveal'); assert.equal(f.fake.calls.filter(c => c.path === '/moves').length, 2);
});
test('receipt inclusion rejects missing, duplicated, foreign, forged, late and mismatched witnesses', async t => {
  const f = await fixture(t);
  await f.agent.propose({ actionId: 'proof', proposal, history: f.histories[61], patterns: [] });
  const { output } = f.fake.observe(), original = output.file, move = f.agent.journal.get('discovery/proof/commit').body;
  for (const mutate of [
    file => { file.rootAttestations = []; },
    file => { file.rootAttestations.pop(); },
    file => { file.rootAttestations[2] = file.rootAttestations[0]; },
    file => { file.rootAttestations[2].signer = 'foreign'; },
    file => { file.rootAttestations[0].sig = '00'.repeat(64); },
    file => { file.rootAttestations[0].observedTip = file.tip + 2; },
    file => { file.rootAttestations[0].root = '00'.repeat(32); },
    file => { file.rootAttestations[0].network = 'another-network'; },
    file => { file.rootAttestations[0].count++; },
    file => { file.rootAttestations[0].hash = '00'.repeat(32); }
  ]) {
    const file = structuredClone(original); mutate(file); const publication = f.fake.publish(file);
    await assert.rejects(f.service.inclusion(move, { publication, hashAt: async h => f.histories[63].get(h)?.hash }), /quorum/);
    await assert.rejects(f.agent.reveal({ actionId: 'proof', publication, history: f.histories[61], patterns: [] }), /quorum/);
  }
  assert.equal(f.fake.calls.filter(c => c.path === '/moves').length, 1);
  const rejected = structuredClone(original); rejected.moves[0].reason = 'discovery_commit_budget';
  await assert.rejects(f.agent.reveal({ actionId: 'proof', publication: f.fake.publish(rejected) }), /not accepted/);
  const publication = f.fake.publish(original);
  const unpinned = new ServiceClient({ network: f.fake.network, gateway: f.fake.gateway, fetchImpl: f.fake.fetch });
  await assert.rejects(unpinned.audit(publication, { hashAt: h => f.histories[63].get(h)?.hash }), /quorum/);
  const proof = await f.service.inclusion(move, { publication, hashAt: async h => f.histories[63].get(h)?.hash });
  assert.equal(proof.contractCommitted, false); assert.equal(proof.attestations.length, 3);
  await assert.rejects(f.service.inclusion({ ...move, w: 'abcd' }, { publication, hashAt: h => f.histories[63].get(h)?.hash }), /missing/);
  await assert.rejects(f.service.inclusion(move, { publication, receipt: { ...proof.receipt, sequence: 99 }, hashAt: h => f.histories[63].get(h)?.hash }), /missing/);
  assert.equal(f.agent.journal.get('discovery/proof').result, null);
  const repeated = f.fake.observe({ entries: [] });
  assert.equal(repeated.output.file.receiptReference, original.receiptRoot.root);
  assert.equal((await f.service.audit(repeated.publication, { hashAt: h => f.histories[63].get(h)?.hash })).witnessed, false);
  await assert.rejects(f.service.inclusion(move, { publication: repeated.publication, hashAt: h => f.histories[63].get(h)?.hash }), /missing/);
});
test('reveal refuses a reorg or expiry and dry-run does not create secrets or send a move', async t => {
  const f = await fixture(t), args = { actionId: 'window', proposal, history: f.histories[61], patterns: [] };
  f.agent.dryRun = true; assert.equal((await f.agent.propose(args)).signed, false); assert.equal(f.agent.journal.recent().length, 0);
  f.agent.dryRun = false; await f.agent.propose(args); const { publication } = f.fake.observe();
  await assert.rejects(f.agent.reveal({ actionId: 'window', publication, history: f.histories[61], patterns: [] }), /window/);
  const head = await f.agent.trac.head(); f.agent.trac.head = async () => ({ ...head, tip: { ...head.tip, height: 206 } });
  await assert.rejects(f.agent.reveal({ actionId: 'window' }), /window/);
  f.agent.trac.head = async () => ({ ...head, tip: f.histories[63].get(63) });
  f.agent.trac.hashAt = async () => '00'.repeat(32);
  await assert.rejects(f.agent.reveal({ actionId: 'window' }), /reorganized/);
  assert.equal(f.fake.entries.size, 1);
  assert.equal(stableJSON(await f.agent.status()).includes(f.agent.journal.get('discovery/window').body.salt), false);
});

async function sealedAt58(t) {
  const f = await fixture(t); f.advance(58);
  f.fake.state = { lastTip: 57, counted: 57 };
  await f.agent.propose({ actionId: 'capacity', proposal, history: f.histories[58], patterns: [] });
  const { publication } = f.fake.observe();
  await assert.rejects(f.agent.reveal({ actionId: 'capacity', publication, history: f.histories[58], patterns: [] }), /not yet open/);
  f.advance(60);
  return f;
}
test('a definite HTTP reveal refusal survives restart and retries a stale packet with the same commitment and intent', async t => {
  const f = await sealedAt58(t), id = 'discovery/capacity/reveal';
  const parent = f.agent.journal.get('discovery/capacity').body;
  const commit = f.agent.journal.get('discovery/capacity/commit').body;
  f.service.fetchImpl = async (url, options) => new URL(url).pathname === '/moves'
    ? Response.json({ error: 'reveal_capacity' }, { status: 429 }) : f.fake.fetch(url, options);
  await assert.rejects(f.agent.reveal({ actionId: 'capacity', history: f.histories[60], patterns: [] }), /refused, not accepted/);
  const refused = f.agent.journal.get(id);
  assert.equal(refused.state, 'refused'); assert.equal(refused.result.code, 'reveal_capacity');
  assert.equal((await f.agent.hunting()).items[0].phase, 'reveal_window');
  assert.equal(f.fake.entries.size, 1);
  await f.restart(); f.advance(63); f.service.fetchImpl = f.fake.fetch;
  assert.equal((await f.agent.reveal({ actionId: 'capacity', history: f.histories[63], patterns: [] })).state, 'received');
  const sent = f.agent.journal.get(id);
  assert.equal(sent.body.b, 63); assert.notEqual(moveId(sent.body), moveId(refused.body));
  assert.deepEqual(sent.body.p, refused.body.p); assert.equal(sent.fingerprint, refused.fingerprint);
  assert.deepEqual(f.agent.journal.get('discovery/capacity').body, parent);
  assert.deepEqual(f.agent.journal.get('discovery/capacity/commit').body, commit);
  assert.ok(f.agent.journal.moveHistory(id).some(r => r.state === 'refused' && r.result.code === 'reveal_capacity' && stableJSON(r.body) === stableJSON(refused.body)));
  assert.equal(f.fake.entries.size, 2);
  assert.equal((await f.agent.reveal({ actionId: 'capacity' })).replayed, true);
});
test('legacy stale refusals have a typed dry-run-safe recovery that preserves the original packet and action ID', async t => {
  const f = await sealedAt58(t), id = 'discovery/capacity/reveal', parent = f.agent.journal.get('discovery/capacity');
  const body = await signMove(f.agent.wallet, { network: f.agent.network, type: 'discovery-reveal', payload: parent.body, tip: f.histories[60].get(60) }, { puzzleBits: 0 });
  f.agent.journal.reserve(id, parent.body, body);
  // Model the older kit's on-disk schema: unknown, no saved refusal or attempts.
  f.agent.journal.db.prepare("UPDATE actions SET state='unknown' WHERE scope=? AND id=?").run(f.agent.journal.scope, id);
  await f.restart(); f.advance(63);
  await assert.rejects(f.agent.reveal({ actionId: 'capacity', history: f.histories[63], patterns: [] }), /stale/);
  const args = { actionId: 'capacity', move: moveId(body), status: 429, code: 'reveal_capacity', confirmOriginalRefusal: true };
  const hunting = await f.agent.hunting();
  assert.equal(hunting.items[0].revealMove, args.move);
  assert.equal(JSON.stringify(hunting).includes(parent.body.salt), false);
  const recover = input => runTool({ agent: f.agent }, 'recover_refused_reveal', input);
  await assert.rejects(recover({ ...args, move: '00'.repeat(32) }), /does not match/);
  await assert.rejects(recover({ ...args, code: 'request_failed' }));
  await assert.rejects(recover({ ...args, confirmOriginalRefusal: false }));
  await assert.rejects(runTool({ agent: f.agent }, 'recover_refused_reveal', args, { readOnly: true }), /Use action/);
  f.agent.dryRun = true; assert.equal((await recover(args)).state, 'dry-run');
  assert.equal(f.agent.journal.get(id).state, 'unknown'); assert.equal(f.agent.journal.moveHistory(id).length, 0);
  f.agent.dryRun = false; const recovered = await recover(args);
  assert.equal(recovered.sent, false); assert.equal(recovered.state, 'refused'); assert.equal(f.fake.entries.size, 1);
  assert.deepEqual(f.agent.journal.get(id).body, body);
  assert.equal((await f.agent.hunting()).items[0].revealRefusal.source, 'owner_confirmed_original_response');
  assert.deepEqual(f.agent.journal.moveHistory(id).map(r => r.state), ['unknown', 'refused']);
  await f.restart();
  assert.equal((await f.agent.reveal({ actionId: 'capacity', history: f.histories[63], patterns: [] })).state, 'received');
  assert.deepEqual(f.agent.journal.get(id).body.p, parent.body);
  assert.equal(f.agent.journal.get(id).body.b, 63);
  assert.ok(f.agent.journal.moveHistory(id).some(r => r.state === 'unknown' && stableJSON(r.body) === stableJSON(body)));
  await assert.rejects(recover(args), /does not match/);
  await assert.rejects(recover({ ...args, move: moveId(f.agent.journal.get(id).body) }), /legacy unknown/);
});
test('ambiguous delivery is never refreshed, even after a later refusal; legacy recovery cannot override new attempts', async t => {
  const f = await sealedAt58(t), id = 'discovery/capacity/reveal'; f.fake.lose = '/moves';
  await assert.rejects(f.agent.reveal({ actionId: 'capacity', history: f.histories[60], patterns: [] }), /unknown/);
  const original = f.agent.journal.get(id).body;
  f.service.fetchImpl = async () => Response.json({ error: 'reveal_capacity' }, { status: 429 });
  await assert.rejects(f.agent.reveal({ actionId: 'capacity', history: f.histories[60], patterns: [] }), /reveal_capacity/);
  assert.equal(f.agent.journal.get(id).state, 'unknown');
  await assert.rejects(f.agent.recoverRefusedReveal({ actionId: 'capacity', move: moveId(original), status: 429, code: 'reveal_capacity', confirmOriginalRefusal: true }), /legacy unknown/);
  f.advance(63);
  await assert.rejects(f.agent.reveal({ actionId: 'capacity', history: f.histories[63], patterns: [] }), /stale/);
  assert.deepEqual(f.agent.journal.get(id).body, original);
});
test('only a complete response with an allowlisted pre-acceptance code is a refusal', async () => {
  for (const [status, code, refused] of [[429, 'reveal_capacity', true], [400, 'invalid_move', true], [503, 'tip_transition', true],
    [429, 'other', false], [400, 'request_failed', false], [500, 'reveal_capacity', false], [404, 'not_found', false]]) {
    const service = new ServiceClient({ fetchImpl: async () => Response.json({ error: code }, { status }) });
    await assert.rejects(service.request('/moves', { value: {} }), error => error.refusedBeforeAcceptance === refused);
  }
  for (const response of [() => new Response('<html>proxy</html>', { status: 429 }), () => new Response(new ReadableStream({ start(c) {
    c.enqueue(Buffer.from('{"error":"reveal_capacity"')); c.error(Error('interrupted'));
  } }), { status: 429 })]) {
    const service = new ServiceClient({ fetchImpl: async () => response() });
    await assert.rejects(service.request('/moves', { value: {} }), error => !error.refusedBeforeAcceptance);
  }
});
