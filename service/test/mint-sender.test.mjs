import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { MintSender } from '../src/mint-sender.mjs';
import { MintSenderJournal } from '../src/mint-sender-journal.mjs';
import { MintSenderView, senderKeyId } from '../src/mint-sender-view.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { requestKey, btc, fundingAmount, readMintSeed } from '../src/mint-sender-keys.mjs';
import { hex, unhex, networkFor } from '../../kit/lib/inscription-core.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t, { state = 'permit_issued', feeRate = 2 } = {}) {
  const directory = await mkdtemp(join(root, '.mb1-test-'));
  await chmod(directory, 0o700); let sender;
  t.after(async () => { try { await sender?.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const seed = new Uint8Array(32).fill(17), id = 'aa'.repeat(32), network = 'regtest'; let now = 1000000;
  const settings = mintSenderSettings({ enabled: true, directory, seedFile: join(directory, 'seed'), bitcoinApiUrlFile: join(directory, 'source'), feeWaitMs: 100, pollMs: 10, retryMs: 10 });
  const keyId = senderKeyId(seed, network), key = requestKey(seed, id, network), payer = requestKey(seed, 'bb'.repeat(32), network), receiver = requestKey(seed, 'cc'.repeat(32), network);
  const status = { requestId: id, state, payer: payer.address, receiver: receiver.address, fees: [], missing: [], amount: '1', payBy: { rail: 'tap', untilBlock: 100 }, counted: 50, fundingAddress: key.address,
    mintContent: { p: 'tap', op: 'token-mint', tick: 'dmwtest', amt: '1', dta: id, prv: { address: receiver.address } } };
  const coins = [{ txid: '11'.repeat(32), vout: 1, value: String(fundingAmount(settings)), script: hex(btc.p2tr(unhex(key.publicKey).slice(1)).script), confirmed: false, cardinal: true }];
  const sent = [], transactions = new Map(), reports = [], logs = []; let loseReply = false, reportFails = false, gatewayFails = false;
  const gateway = {
    async list() { if (gatewayFails) throw Error('secret remote error'); return { keyId, rows: [structuredClone(status)], next: null }; },
    async status(requestId) { if (gatewayFails) throw Error('secret remote error'); assert.equal(requestId, id); return structuredClone(status); },
    async report(requestId, inscription) { reports.push({ requestId, inscription }); if (reportFails) throw Error('secret remote error'); },
  };
  const bitcoin = {
    async verifyNetwork() {}, async utxos(address) { assert.equal(address, key.address); return structuredClone(coins); }, async feeRate() { return feeRate; },
    async transaction(id) { return transactions.get(id) ?? null; },
    async broadcast(raw, txid) { assert.equal(btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true }).id, txid); sent.push({ raw, txid }); if (!transactions.has(txid)) transactions.set(txid, { confirmed: false }); if (loseReply) { loseReply = false; throw Error('secret provider message'); } return txid; },
  };
  const journal = new MintSenderJournal(directory, { keyId, network, now: () => now });
  sender = new MintSender({ seed: seed.slice(), network, settings, journal, gateway, bitcoin, now: () => now, log: v => logs.push(v) });
  const tick = async () => { now += 20; await sender.tick(); await sender.drain(); };
  return { id, directory, settings, status, coins, sent, transactions, reports, logs, journal, gateway, bitcoin, key, payer, receiver,
    get sender() { return sender; }, get now() { return now; }, get row() { return sender.journal.get(id); }, tick,
    advance: n => { now += n; }, fee: n => { feeRate = n; }, lose: () => { loseReply = true; }, reportFails: b => { reportFails = b; }, gatewayFails: b => { gatewayFails = b; },
    view: () => new MintSenderView({ seed: seed.slice(), network, settings, now: () => now }),
    async restart() { await sender.close(); const journal = new MintSenderJournal(directory, { keyId, network, now: () => now }); sender = new MintSender({ seed: seed.slice(), network, settings, journal, gateway, bitcoin, now: () => now, log: v => logs.push(v) }); },
  };
}
test('sender pays only receiver postage and payer change, reports existing path, then observes minted', async t => {
  const f = await fixture(t); await f.tick();
  assert.equal(f.row.state, 'sent'); assert.equal(f.sent.length, 2); assert.equal(f.reports[0].inscription, f.row.plan.inscriptionId);
  const commit = btc.Transaction.fromRaw(unhex(f.row.plan.commitHex));
  assert.equal(hex(commit.getOutput(1).script), hex(btc.OutScript.encode(btc.Address(networkFor('regtest')).decode(f.payer.address))));
  f.status.state = 'minted'; await f.tick(); assert.equal(f.row.state, 'minted'); assert.equal(f.sent.length, 2);
});
test('journal replay survives lost commit reply and process restart; vanished mempool reuses identical bytes', async t => {
  const f = await fixture(t); f.lose(); await f.tick();
  assert.equal(f.row.state, 'sending'); const plan = f.row.plan; assert.equal(f.sent.length, 1);
  await f.restart(); f.transactions.clear(); await f.tick();
  assert.deepEqual(f.row.plan, plan); assert.equal(f.sent.length, 3); assert.deepEqual(f.sent[0], f.sent[1]);
  f.transactions.clear(); await f.tick(); assert.equal(f.sent[4].txid, plan.revealTxid); assert.equal(f.sent[4].raw, plan.revealHex);
  assert.throws(() => f.sender.journal.save({ ...f.row, plan: { ...plan, revealTxid: 'ff'.repeat(32) } }), /immutable/);
});
test('fee spike waits, exposes needs_user, and returns the set-aside to payer at an affordable fee', async t => {
  const f = await fixture(t, { feeRate: 50 }); await f.tick();
  assert.equal(f.row.state, 'funded'); assert.equal(f.sent.length, 0);
  f.advance(101); await f.tick(); assert.equal(f.row.state, 'needs_user'); assert.equal(f.sent.length, 0);
  await f.tick(); assert.equal(f.row.state, 'returning'); assert.equal(f.sent.length, 1); assert.equal(f.row.plan, undefined);
  const tx = btc.Transaction.fromRaw(unhex(f.row.returnPlan.hex)); assert.equal(tx.outputsLength, 1);
  assert.equal(hex(tx.getOutput(0).script), hex(btc.OutScript.encode(btc.Address(networkFor('regtest')).decode(f.payer.address))));
  f.transactions.set(tx.id, { confirmed: true }); await f.tick(); assert.equal(f.row.state, 'returned');
});
test('unaffordable returns keep retrying and do not burn the funding into fees', async t => {
  const f = await fixture(t, { state: 'expired', feeRate: 1000 }); await f.tick();
  assert.equal(f.row.state, 'returning'); assert.equal(f.row.returnPlan, undefined); assert.equal(f.sent.length, 0);
  f.fee(2); await f.tick(); assert.equal(f.sent.length, 1); assert.ok(f.row.returnPlan);
});
for (const state of ['expired', 'refunded', 'refundable', 'credited', 'someone_paid_first', 'minted']) test(state + ' returns unspent funding without a mint', async t => {
  const f = await fixture(t, { state }); await f.tick();
  assert.equal(f.row.state, 'returning'); assert.ok(f.row.returnPlan); assert.equal(f.row.plan, undefined); assert.equal(f.sent.length, 1);
});
test('public expiry without a terminal public state returns unspent funding', async t => {
  const f = await fixture(t, { state: 'awaiting_payment' }); f.status.publicMint = true; delete f.status.mintContent; f.status.counted = 101;
  await f.tick(); assert.equal(f.row.state, 'returning'); assert.equal(f.row.returnReason, 'expired');
});
test('public bulk delayed settlement keeps its set-aside after the checkout deadline without signing a mint', async t => {
  const f = await fixture(t, { state: 'awaiting_payment' });
  f.status.publicMint = true; f.status.publicBulkOrderId = 'dd'.repeat(32); delete f.status.mintContent; f.status.counted = 101;
  await f.tick(); assert.equal(f.row.state, 'funded'); assert.equal(f.sent.length, 0);
  assert.equal(f.row.returnPlan, undefined); assert.equal(f.row.plan, undefined);
});
test('payment-first: funded requests cannot inscribe before a permit; wallet report waits for verification', async t => {
  const f = await fixture(t, { state: 'awaiting_payment' }); await f.tick(); assert.equal(f.row.state, 'funded'); assert.equal(f.sent.length, 0);
  f.status.state = 'permit_issued'; f.status.sentInscription = '22'.repeat(32) + 'i0'; await f.tick(); assert.equal(f.sent.length, 0);
  f.status.state = 'minted'; await f.tick(); assert.equal(f.row.state, 'returning');
});
test('lost report replies retry the same inscription and gateway failures are visible and do not give up', async t => {
  const f = await fixture(t); f.reportFails(true); await f.tick(); assert.equal(f.row.state, 'sent'); assert.equal(f.row.failures, 1);
  const plan = f.row.plan; f.reportFails(false); await f.tick(); assert.equal(f.reports.length, 2); assert.equal(f.reports[0].inscription, f.reports[1].inscription);
  f.gatewayFails(true); await f.tick(); assert.equal(f.row.plan.inscriptionId, plan.inscriptionId);
  assert.ok(f.logs.some(l => l.event === 'mint_sender_discovery_retry')); assert.ok(f.logs.some(l => l.event === 'mint_sender_retry'));
  assert.ok(!JSON.stringify(f.logs).includes('secret'));
  f.gatewayFails(false); f.advance(60001); await f.tick(); assert.ok(f.reports.length >= 3);
});
test('independent journal excludes a second writer; seed permission checks reject public files', async t => {
  const f = await fixture(t);
  assert.throws(() => new MintSenderJournal(f.directory, { keyId: 'other', network: 'regtest' }), /locked/);
  const filename = join(f.directory, 'seed'); await writeFile(filename, new Uint8Array(32).fill(19), { mode: 0o600 });
  assert.equal((await readMintSeed(filename, { rootOwned: false })).length, 32);
  await chmod(filename, 0o644); await assert.rejects(readMintSeed(filename, { rootOwned: false }), /seed_unavailable/);
});
test('funding appears only while payable, TAP, enabled, and sender heartbeat is current', async t => {
  const f = await fixture(t, { state: 'awaiting_payment' }), view = f.view();
  const row = { id: f.id, kind: 'tap', payer: f.payer.address, receiver: f.receiver.address }, status = { state: 'awaiting_payment', payable: true };
  assert.equal(view.decorate(row, status).mintFunding, undefined);
  await f.sender.discover(); f.sender.sourceReady = true; f.sender.health(true);
  assert.equal(view.decorate(row, status).mintFunding.satoshis, fundingAmount(f.settings));
  assert.equal(view.decorate({ ...row, kind: 'ethereum' }, status).mintFunding, undefined);
  assert.equal(view.decorate(row, { ...status, state: 'permit_issued' }).mintFunding, undefined);
  assert.equal(view.decorate(row, { ...status, payable: false }).mintFunding, undefined);
  assert.equal(view.authorized('Bearer ' + view.token), true); assert.equal(view.authorized('Bearer bad'), false);
  f.advance(f.settings.heartbeatMaxAgeMs + 1); assert.equal(view.decorate(row, status).mintFunding, undefined);
  view.close();
});
test('health logs funded permit stalls and age counts even when an individual send fails', async t => {
  const f = await fixture(t); f.lose(); await f.tick(); f.advance(f.settings.stuckMs + 1); f.sender.health(true);
  assert.ok(f.logs.some(l => l.event === 'mint_sender_stuck' && l.requestId === f.id));
  assert.ok(f.logs.some(l => l.event === 'mint_sender_health' && l.oldestWaitingMs > 0));
});
test('a delayed request cannot block another funded request in an independent concurrency slot', async t => {
  const f = await fixture(t), id2 = 'dd'.repeat(32), key2 = requestKey(new Uint8Array(32).fill(17), id2, 'regtest');
  const status2 = { ...structuredClone(f.status), requestId: id2, fundingAddress: key2.address, mintContent: { ...f.status.mintContent, dta: id2 } };
  const list = f.gateway.list;
  f.gateway.list = async () => { const page = await list(); return { ...page, rows: [...page.rows, status2] }; };
  let release, reported;
  const delayed = new Promise(r => { release = r; }), completed = new Promise(r => { reported = r; });
  f.gateway.status = async id => { if (id === f.id) { await delayed; return structuredClone(f.status); } return structuredClone(status2); };
  f.gateway.report = async id => { if (id === id2) reported(); };
  f.bitcoin.utxos = async address => [{ ...f.coins[0], txid: address === key2.address ? '22'.repeat(32) : '11'.repeat(32), script: address === key2.address ? hex(btc.p2tr(unhex(key2.publicKey).slice(1)).script) : f.coins[0].script }];
  try {
    await f.sender.tick();
    await Promise.race([completed, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('second request blocked')), 1000); timer.unref(); })]);
    assert.equal(f.sender.journal.get(id2).state, 'sent'); assert.equal(f.row.plan, undefined);
  } finally { release(); await f.sender.drain(); }
});
test('a public winner awaiting its permit keeps the set-aside after the quote expiry', async t => {
  const f = await fixture(t, { state: 'paid' }); f.status.publicMint = true; delete f.status.mintContent; f.status.counted = 101; f.status.winner = { id: f.id };
  await f.tick(); assert.equal(f.row.state, 'funded'); assert.equal(f.sent.length, 0);
});
test('lost reveal reply preserves both signed transactions and reports the same inscription on retry', async t => {
  const f = await fixture(t), broadcast = f.bitcoin.broadcast; let calls = 0;
  f.bitcoin.broadcast = async (...args) => { const id = await broadcast(...args); if (++calls === 2) throw Error('provider secret'); return id; };
  await f.tick(); assert.equal(f.row.state, 'sending'); const plan = f.row.plan;
  await f.restart(); await f.tick(); assert.equal(f.row.state, 'sent'); assert.deepEqual(f.row.plan, plan);
  assert.deepEqual(f.sent[1], f.sent[3]); assert.equal(f.reports[0].inscription, plan.inscriptionId);
});
test('a permanent preparation failure exposes wallet fallback and returns unspent funding', async t => {
  const f = await fixture(t); f.status.mintContent.padding = 'x'.repeat(80001);
  await f.tick(); assert.equal(f.row.state, 'needs_user'); assert.equal(f.sent.length, 0);
  await f.tick(); assert.equal(f.row.state, 'returning'); assert.equal(f.row.plan, undefined);
});
test('daemon refuses a missing journal even when its entire state directory was lost', async t => {
  const f = await fixture(t), { startMinter } = await import('../minter.mjs');
  await assert.rejects(startMinter({ mode: 'regtest', data: join(f.directory, 'gateway'), listen: { host: '127.0.0.1', port: 1 },
    mintSender: { ...f.settings, directory: join(f.directory, 'missing') } }), /mint_sender_journal_missing/);
});
test('source outage closes new funding offers but known funded work keeps its own retry path', async t => {
  const f = await fixture(t, { state: 'awaiting_payment' }); await f.tick(); assert.equal(f.row.state, 'funded');
  f.advance(f.settings.healthMs + 1); f.bitcoin.verifyNetwork = async () => { throw Error('mint_sender_timeout'); };
  f.status.state = 'permit_issued'; await f.tick(); assert.equal(f.row.state, 'sent'); assert.equal(f.sender.sourceReady, false);
  assert.equal(f.view().ready(), false);
});
test('a gateway outage after the commit cannot prevent the saved reveal from broadcasting', async t => {
  const f = await fixture(t); f.lose(); await f.tick(); assert.equal(f.row.state, 'sending'); const plan = f.row.plan;
  f.gatewayFails(true); await f.tick(); assert.equal(f.row.state, 'sent');
  assert.equal(f.sent.at(-1).txid, plan.revealTxid); assert.equal(f.sent.at(-1).raw, plan.revealHex);
  assert.ok(f.logs.some(l => l.event === 'mint_sender_status_retry'));
});
test('a replaced payment outpoint can be rediscovered before any mint spend is signed', async t => {
  const f = await fixture(t, { state: 'awaiting_payment' }); await f.tick(); assert.equal(f.row.coin.txid, '11'.repeat(32));
  f.coins[0].txid = '44'.repeat(32); f.status.state = 'permit_issued'; await f.tick();
  assert.equal(f.row.state, 'sent'); assert.equal(f.row.plan.inputs[0].txid, '44'.repeat(32));
  assert.throws(() => f.sender.journal.save({ ...f.row, coin: { ...f.row.coin, txid: '55'.repeat(32) } }), /coin_immutable/);
});

test('successful ticker registration returns each fee payment set-aside with the original funding key', async t => {
  const f = await fixture(t, { state: 'minted' }), reference = '22'.repeat(32) + 'i0', id = 'ef'.repeat(32);
  const status = { ...f.status, requestId: id, tickerReturn: true, fundingId: f.id, fundingReference: reference, counted: '2100000000' };
  delete status.mintContent;
  f.gateway.list = async () => ({ keyId: f.sender.keyId, rows: [], next: null, tickerReturns: true });
  f.gateway.tickerReturns = async () => ({ keyId: f.sender.keyId, rows: [status], next: null });
  f.gateway.tickerReturnStatus = async value => { assert.equal(value, id); return status; };
  f.bitcoin.paymentFunding = async (address, value) => { assert.equal(address, f.key.address); assert.equal(value, reference); return f.coins; };
  await f.tick();
  const row = f.journal.get(id); assert.equal(row.state, 'returning'); assert.equal(row.plan, undefined);
  const tx = btc.Transaction.fromRaw(unhex(row.returnPlan.hex)); assert.equal(tx.outputsLength, 1);
  assert.equal(hex(tx.getOutput(0).script), hex(btc.OutScript.encode(btc.Address(networkFor('regtest')).decode(f.payer.address))));
  f.transactions.set(tx.id, { confirmed: true }); await f.restart(); await f.tick();
  assert.equal(f.sender.journal.get(id).state, 'returned'); assert.equal(f.reports.length, 0);
});

test('a fee payment no page reported is reported by the minter from its set-aside, once a minute, until the gateway shows it', async t => {
  const f = await fixture(t, { state: 'awaiting_payment' }), reported = [];
  f.bitcoin.spenders = async (txid, except) => { assert.equal(txid, f.coins[0].txid); assert.equal(except, f.coins[0].vout); return ['ee'.repeat(32)]; };
  f.gateway.reportPayment = async (requestId, sent) => { reported.push({ requestId, ...sent }); };
  await f.tick();
  assert.deepEqual(reported, [{ requestId: f.id, commitTxid: f.coins[0].txid, revealTxid: 'ee'.repeat(32) }]);
  assert.equal(f.sent.length, 0, 'nothing is spent before the permit');
  await f.tick(); assert.equal(reported.length, 1, 'not again within a minute');
  f.advance(60000); await f.tick(); assert.equal(reported.length, 2);
  f.status.inflight = { phase: 'payment', revealTxid: 'ee'.repeat(32) }; f.advance(60000); await f.tick();
  assert.equal(reported.length, 2, 'a payment the gateway already shows is not reported again');
  f.status.inflight = null; f.status.publicMint = true; f.advance(60000); await f.tick();
  assert.equal(reported.length, 2, 'public wallet mints are found by the gateway itself');
});
