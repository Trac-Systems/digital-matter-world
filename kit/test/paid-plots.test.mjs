import { bitcoinAddress } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { linkId, recordGet, verifyLinkInput } from '../../rules/src/index.js';
import { Agent } from '../lib/agent.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { Journal } from '../lib/journal.mjs';
import { signPlotRequest } from '../lib/signing.mjs';
import { temp, cleanup, testWallet, fakeTrac, history } from './helpers.mjs';
import { FakeService } from './fake-service.mjs';

async function fixture(t) {
  const dir = await temp(t), hist = history(70), network = 'dmw-kit-test', fake = new FakeService({ network, history: hist, tip: 20 }), wallet = testWallet();
  const { trac, state } = fakeTrac(hist, { network }), service = new ServiceClient({ network, gateway: fake.gateway, fetchImpl: fake.fetch });
  let journal = await Journal.open(join(dir, 'journal'), network, { intervalMs: 0 }); cleanup(t, () => journal.close());
  const agent = new Agent({ bitcoinNetwork: 'regtest', network, wallet, trac, service, journal, dryRun: false, puzzleBits: 0 });
  return { dir, hist, fake, agent, service, state, async restart() { journal.close(); journal = await Journal.open(join(dir, 'journal'), network, { intervalMs: 0 }); agent.journal = journal; } };
}
for (const kind of ['link']) test(`${kind} request signs shared rules, survives restart and leaves payment to the page`, async t => {
  const f = await fixture(t), run = args => f.agent.linkBitmap(args);
  const args = { actionId: 'plot', height: 7, payer: bitcoinAddress() };
  f.agent.dryRun = true; const preview = await run(args);
  assert.equal(preview.signed, false); assert.equal(f.fake.calls.length, 0); assert.equal(f.agent.journal.recent().length, 0);
  f.agent.dryRun = false; f.fake.lose = `/${kind}/request`;
  await assert.rejects(run(args), /unknown/); const body = f.agent.journal.get(`${kind}/plot`).body;
  await f.restart(); f.state.tip = f.fake.tip = 21;
  const result = await run(args), id = linkId(f.fake.network, body.request);
  assert.equal(result.state, 'submitted'); assert.equal(result.request.id, id); assert.equal(f.fake.requests.size, 1);
  const action = (await f.agent.status()).actions.find(row => row.id === `${kind}/plot`);
  assert.equal(action.requestId, id); assert.equal(action.paymentLink, result.paymentLink);
  assert.equal(JSON.stringify(action).includes(body.sig), false);
  assert.equal(result.paymentLink, `${f.service.origin}/${kind}/${id}`);
  assert.match((await f.fake.fetch(result.paymentLink)).headers.get('content-type'), /text\/html/);
  const sends = f.fake.calls.filter(c => c.path === `/${kind}/request`); assert.deepEqual(sends[0].body, sends[1].body);
  assert.equal(f.fake.calls.some(c => /payment|release|refund/.test(c.path)), false);
  assert.equal((await run(args)).replayed, true);
  await assert.rejects(run({ ...args, height: 8 }), /Conflicting/);
  await assert.rejects(run({ ...args, payer: bitcoinAddress('regtest', 3) }), /Conflicting/);
  f.fake.tip = 20;
  const evidence = f.fake.evidence(id);
  assert.equal(evidence.payment.allocations[0].amt, '100');
  const output = f.fake.observe({ linkOperations: [evidence] }).output;
  { assert.deepEqual(recordGet(output.state.links, 7), { block: 7, linkHeight: 20 }); assert.equal(output.file.linkOutcomes[0].reason, 'accepted'); }
});
test('paid Bitmap link refuses funded-only, refunded, underconfirmed, wrong-holder and preexisting-link evidence', async t => {
  const f = await fixture(t), result = await f.agent.linkBitmap({ actionId: 'link', height: 7, payer: bitcoinAddress() }), id = result.request.id;
  assert.throws(() => f.fake.evidence(id, { consumed: false }), /link_unpaid/);
  assert.throws(() => f.fake.evidence(id, { settlement: { ...f.fake.evidence(id).payment.settlement, refund: true } }), /link_unpaid/);
  assert.throws(() => f.fake.evidence(id, { settlement: { ...f.fake.evidence(id).payment.settlement, confirmations: 0 } }), /link_unpaid/);
  assert.throws(() => f.fake.evidence(id, { total: '1' }), /price/);
  assert.throws(() => f.fake.evidence(id, { payer: bitcoinAddress('regtest', 3) }), /terms/);
  const input = f.fake.evidence(id);
  assert.throws(() => f.fake.observe({ linkOperations: [{ ...input, bitmap: { ...input.bitmap, agent: 'ff'.repeat(32) } }] }), /link_owner/);
  assert.throws(() => f.fake.observe({ linkOperations: [{ ...input, previous: { block: 7, linkHeight: 1 } }] }), /link_owner/);
  const { bitmap, previous, ...paid } = input;
  assert.throws(() => signPlotRequest(f.agent.wallet, 'link', f.fake.network, { ...paid.request, owner: 'aa'.repeat(32) }, 15), /Foreign/);
});
test('plot requests refuse wrong service identity and retain the signed deadline', async t => {
  const f = await fixture(t), args = { actionId: 'bound', height: 7, payer: bitcoinAddress() }, fetch = f.service.fetchImpl;
  f.service.fetchImpl = async (...a) => { const response = await fetch(...a), value = await response.json(); return Response.json({ ...value, id: '00'.repeat(32) }); };
  await assert.rejects(f.agent.linkBitmap(args), /ID or payer/);
  const original = f.agent.journal.get('link/bound').body;
  f.service.fetchImpl = fetch; f.state.tip = f.fake.tip = 40;
  await f.restart(); assert.equal((await f.agent.linkBitmap(args)).state, 'submitted');
  assert.deepEqual(f.agent.journal.get('link/bound').body, original);
  await assert.rejects(f.agent.linkBitmap({ actionId: 'future', height: 41, payer: bitcoinAddress() }), /ahead/);
});
