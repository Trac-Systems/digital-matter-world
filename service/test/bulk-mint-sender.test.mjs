import test from 'node:test';
import assert from 'node:assert/strict';
import { measureBulkInscriptions, buildBulkInscriptionPlan, signBulkCommit } from '../../kit/lib/inscription-batch-core.mjs';
import { btc } from '../src/mint-sender-keys.mjs';
import { hex, unhex, networkFor } from '../../kit/lib/inscription-core.mjs';
import { inscriptionContents } from '../src/mint-payments.mjs';
import { bulkFixture } from './helpers/bulk-sender.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MintSenderJournal } from '../src/mint-sender-journal.mjs';
import { BulkMintSender } from '../src/bulk-mint-sender.mjs';
import { senderKeyId } from '../src/mint-sender-view.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { MintSender } from '../src/mint-sender.mjs';

test('bulk exact dummy witnesses reproduce frozen 16/64 sizing and funding shrink', async () => {
  const address = btc.p2tr(btc.TAPROOT_UNSPENDABLE_KEY).address;
  for (const [n, satoshis] of [[16, 39838], [32, 72682], [48, 105526], [64, 138370]]) {
    const measured = measureBulkInscriptions({ texts: Array(n).fill('x'.repeat(793)), receiver: address, payer: address, network: 'mainnet' });
    assert.equal(measured.revealVsizes[0], 5296);
    const maxFees = measured.commitVsize * 4 + measured.revealVsizes.reduce((s, v) => s + v * 4, 0);
    assert.equal(n * 546 + maxFees + 6546, satoshis);
  }
  const high = await bulkFixture(64, { feeRate: 2 });
  assert.equal(high.quote.fits, false); assert.ok(high.quote.maxMembers > 16 && high.quote.maxMembers < 64);
  const low = await bulkFixture(64); assert.equal(low.quote.fits, true); low.key.privateKey.fill(0);
  await assert.rejects(bulkFixture(65), /bulk_funding_input/);
});

for (const count of [1, 16, 64]) test(`bulk ${count} leaves retain one postage output each and sign every child`, async () => {
  const f = await bulkFixture(count), secrets = Array.from({ length: count }, () => new Uint8Array(32).fill(3));
  try {
    const draft = await buildBulkInscriptionPlan({ ...f, publicKey: f.key.publicKey, feeRate: 1, leafSecrets: secrets });
    assert.ok(secrets.every(s => s.every(b => b === 0)));
    const plan = await signBulkCommit(draft, f.key.privateKey), commit = btc.Transaction.fromRaw(unhex(plan.commit.hex));
    assert.equal(commit.inputsLength, 1); assert.equal(commit.getInput(0).index, 1);
    assert.equal(plan.reveals.length, Math.ceil(count / 16));
    assert.equal(commit.outputsLength, count + plan.reveals.length + 1);
    assert.equal(hex(commit.getOutput(commit.outputsLength - 1).script), hex(btc.OutScript.encode(btc.Address(networkFor('regtest')).decode(f.terms.payer))));
    // Raw transactions do not retain previous output amounts.
    let fees = BigInt(f.funding.value) - Array.from({ length: commit.outputsLength }, (_, i) => commit.getOutput(i).amount).reduce((a, b) => a + b, 0n);
    for (const reveal of plan.reveals) {
      const tx = btc.Transaction.fromRaw(unhex(reveal.hex), { allowUnknownInputs: true });
      assert.equal(tx.inputsLength, reveal.members.length + 1); assert.equal(tx.outputsLength, reveal.members.length);
      assert.ok(tx.weight <= 100000); assert.equal(tx.id, reveal.txid);
      const parsed = inscriptionContents(reveal.hex); assert.equal(parsed.contents.length, reveal.members.length);
      reveal.members.forEach((m, i) => {
        assert.equal(tx.getInput(i).index, m.index); assert.equal(commit.getOutput(m.index).amount, 546n);
        assert.equal(tx.getOutput(i).amount, 546n); assert.equal(m.inscription, `${tx.id}i${i}`);
        assert.deepEqual(parsed.contents[i], f.manifest.members[m.index].mintContent);
      });
      fees += BigInt(reveal.feeSats);
    }
    assert.equal(String(fees), plan.feeSats);
    assert.equal(BigInt(plan.changeSats) + BigInt(plan.feeSats) + BigInt(count * 546), BigInt(f.funding.value));
    assert.equal((await signBulkCommit(draft, f.key.privateKey)).commit.txid, plan.commit.txid);
  } finally { f.key.privateKey.fill(0); }
});

test('bulk builder refuses changed permits, funding, fee ceiling and incomplete delivery', async () => {
  const f = await bulkFixture(1);
  try {
    for (const mutate of [x => x.funding.value = String(BigInt(x.funding.value) + 1n), x => x.funding.cardinal = false,
      x => x.manifest.complete = false, x => x.manifest.members[0].mintContent.blk = '1', x => x.manifest.members[0].permitHash = '00'.repeat(32),
      x => x.manifest.permitRoot = '00'.repeat(32)]) {
      const input = structuredClone({ terms: f.terms, funding: f.funding, manifest: f.manifest }); mutate(input);
      await assert.rejects(buildBulkInscriptionPlan({ ...input, publicKey: f.key.publicKey, feeRate: 1 }));
    }
    await assert.rejects(buildBulkInscriptionPlan({ ...f, publicKey: f.key.publicKey, feeRate: 3 }), /bulk_fee_wait/);
  } finally { f.key.privateKey.fill(0); }
});

async function senderFixture(t, count = 16) {
  const f = await bulkFixture(count), directory = await mkdtemp(join(tmpdir(), 'bulk-sender-'));
  const keyId = senderKeyId(f.seed, 'regtest'), settings = mintSenderSettings({ enabled: true, directory, seedFile: join(directory, 'seed'), bitcoinApiUrlFile: join(directory, 'source') });
  let journal = new MintSenderJournal(directory, { keyId, network: 'regtest' }), state = 'permit_issued', fee = 1, complete = true;
  const sent = [], present = new Map(), spent = new Map(), reports = [];
  const item = () => ({ orderId: f.orderId, termsHash: f.manifest.termsHash, state, payer: f.terms.payer, receiver: f.terms.receiver,
    fundingAddress: f.key.address, fundingSats: f.terms.mintFunding.satoshis, paymentId: f.funding.paymentId, count, permitRoot: f.manifest.permitRoot });
  const gateway = {
    bulkPage: async () => ({ keyId, rows: [item()], next: null }),
    bulkItem: async () => ({ keyId, item: item(), terms: structuredClone(f.terms), permit: { ...structuredClone(f.manifest), complete } }),
    bulkStatus: async () => ({ orderId: f.orderId, termsHash: f.manifest.termsHash, progress: { issued: state === 'expired' ? 0 : count, released: state === 'expired' ? count : 0 } }),
    reportBulkFinish: async report => { reports.push(report); },
  };
  const bitcoin = {
    bulkFunding: async () => structuredClone(f.funding), feeRate: async () => fee,
    outspend: async coin => spent.get(`${coin.txid}:${coin.vout}`) ?? { spent: false },
    transaction: async txid => present.get(txid) ?? null,
    broadcast: async (raw, txid) => {
      const saved = journal.bulk(f.orderId); assert.ok(saved.plan || saved.returnPlan, 'whole signed family is durable before broadcast');
      const tx = btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true }); assert.equal(tx.id, txid);
      sent.push({ raw, txid }); present.set(txid, { confirmed: false });
      for (let i = 0; i < tx.inputsLength; i++) spent.set(`${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`, { spent: true, txid });
      return txid;
    },
  };
  const owner = { seed: f.seed, network: 'regtest', keyId, settings, journal, gateway, bitcoin, now: Date.now, log() {} };
  let sender = new BulkMintSender(owner);
  t.after(async () => { journal.close(); f.key.privateKey.fill(0); await rm(directory, { recursive: true, force: true }); });
  await sender.discover();
  return { ...f, directory, gateway, bitcoin, sent, present, spent, reports, owner, get row() { return journal.bulk(f.orderId); }, get sender() { return sender; }, get journal() { return journal; },
    setState: value => { state = value; }, setFee: value => { fee = value; }, setComplete: value => { complete = value; },
    async restart() { journal.close(); journal = new MintSenderJournal(directory, { keyId, network: 'regtest' }); owner.journal = journal; sender = new BulkMintSender(owner); },
  };
}

test('bulk 64 sender journals all reveals, reports every member and waits for terminal acceptance', async t => {
  const f = await senderFixture(t, 64); await f.sender.process(f.orderId);
  assert.equal(f.row.state, 'sent'); assert.equal(f.sent.length, 5); assert.equal(f.reports.length, 1); assert.equal(f.reports[0].members.length, 64);
  const projection = await readFile(join(f.directory, 'status', 'bulk-' + f.orderId + '.json'), 'utf8');
  assert.ok(!projection.includes('hex')); assert.ok(!projection.includes('psbt')); assert.equal(JSON.parse(projection).mintSender.sentBatches, 4);
  const saved = JSON.stringify(f.row.plan); await f.restart(); await f.sender.process(f.orderId);
  assert.equal(JSON.stringify(f.row.plan), saved); assert.deepEqual(f.sent.slice(5), f.sent.slice(0, 5));
  f.setState('minted'); await f.sender.process(f.orderId); assert.equal(f.row.state, 'minted'); assert.equal(f.sent.length, 10);
});

test('bulk sender retains the side payment across restarts and only permits missing side for returns', async t => {
  const f = await senderFixture(t, 1), read = f.gateway.bulkItem;
  let side = { to: f.terms.receiver, amount: '5', dta: `dmw-bulk-deployer-v1|${f.orderId}` };
  f.gateway.bulkItem = async () => ({ ...await read(), deployerPayment: side });
  const calls = [];
  f.bitcoin.bulkFunding = async input => { calls.push(input); return null; };
  await f.sender.process(f.orderId);
  assert.deepEqual(calls[0].deployerPayment, side); assert.equal(calls[0].allowMissingDeployer, false);
  await f.restart(); side = { ...side, amount: '6' };
  await assert.rejects(f.sender.process(f.orderId), /bulk_sender_binding_changed/);
  side.amount = '5'; f.setState('expired'); await f.sender.process(f.orderId);
  assert.equal(calls.at(-1).allowMissingDeployer, true);
});

for (const point of [0, 1, 2, 3]) for (const when of ['before', 'after']) test(`bulk crash ${when} broadcast ${point} resumes identical saved bytes`, async t => {
  const f = await senderFixture(t, 33), send = f.bitcoin.broadcast; let calls = 0;
  f.bitcoin.broadcast = async (...args) => {
    const fail = calls++ === point;
    if (fail && when === 'before') throw Error('crash');
    const result = await send(...args);
    if (fail && when === 'after') throw Error('lost reply');
    return result;
  };
  await assert.rejects(f.sender.process(f.orderId));
  const plan = JSON.stringify(f.row.plan); assert.ok(plan); await f.restart();
  f.bitcoin.broadcast = send; await f.sender.process(f.orderId);
  assert.equal(JSON.stringify(f.row.plan), plan); assert.equal(f.row.state, 'sent');
  const expected = [f.row.plan.commit, ...f.row.plan.reveals].map(r => ({ raw: r.hex, txid: r.txid }));
  assert.deepEqual(f.sent.slice(-4), expected);
});

test('bulk missing signatures and stalled fees never cause a timed release or replacement plan', async t => {
  const f = await senderFixture(t, 1); f.setComplete(false);
  await f.sender.process(f.orderId); assert.equal(f.row.state, 'waiting_permits'); assert.equal(f.sent.length, 0);
  f.setComplete(true); f.setFee(50); await f.sender.process(f.orderId);
  assert.equal(f.row.state, 'fee_wait'); assert.equal(f.row.plan, undefined); assert.equal(f.row.returnPlan, undefined);
  f.setFee(1); await f.sender.process(f.orderId); const plan = JSON.stringify(f.row.plan);
  f.setState('expired'); await f.sender.process(f.orderId);
  assert.equal(JSON.stringify(f.row.plan), plan); assert.equal(f.row.returnPlan, undefined);
});

test('bulk accepted expiry returns only uncommitted funding; cross-order spends and mutations reject', async t => {
  const f = await senderFixture(t, 1); f.setState('expired'); await f.sender.process(f.orderId);
  assert.equal(f.row.state, 'returning'); assert.ok(f.row.returnPlan); assert.equal(f.row.plan, undefined);
  const raw = f.row.returnPlan.hex; await f.restart(); await f.sender.process(f.orderId); assert.equal(f.row.returnPlan.hex, raw);
  assert.throws(() => f.journal.saveBulk({ ...f.row, id: 'a1'.repeat(32), returnPlan: { ...f.row.returnPlan } }), /spend_conflict/);
  assert.throws(() => f.journal.saveBulk({ ...f.row, coin: { ...f.row.coin, vout: 2 } }), /immutable/);
});

test('bulk spent funding halts and a gateway outage still resumes signed reveals', async t => {
  const f = await senderFixture(t, 1); await f.sender.process(f.orderId);
  const plan = JSON.stringify(f.row.plan); f.gateway.bulkItem = async () => { throw Error('offline'); };
  await f.sender.process(f.orderId); assert.equal(JSON.stringify(f.row.plan), plan);
  f.spent.set(`${f.funding.txid}:${f.funding.vout}`, { spent: true, txid: '99'.repeat(32) });
  const sends = f.sent.length; await f.sender.attempt(f.orderId);
  assert.equal(f.row.state, 'needs_attention'); assert.equal(f.sent.length, sends); assert.equal(JSON.stringify(f.row.plan), plan);
});

test('bulk and single delivery share four slots fairly even while issued bulk orders remain unresolved', async t => {
  const f = await senderFixture(t, 1), owner = f.owner, single = new MintSender({ ...owner, seed: owner.seed.slice() });
  single.sourceReady = single.sourceVerified = true; single.lastSourceCheck = Date.now();
  single.discover = single.refunds.discover = single.bulk.discover = async () => {};
  single.health = () => {}; single.journal.due = () => Array.from({ length: 8 }, (_, i) => ({ id: String(i) }));
  single.journal.bulkDue = () => Array.from({ length: 8 }, (_, i) => ({ id: String(i) }));
  let release; const gate = new Promise(r => { release = r; }), started = [];
  single.attempt = async id => { started.push('single:' + id); await gate; };
  single.bulk.attempt = async id => { started.push('bulk:' + id); await gate; };
  try {
    await single.tick(); assert.equal(single.active.size, 4); assert.equal(started.filter(v => v.startsWith('single:')).length, 2);
    assert.equal(started.filter(v => v.startsWith('bulk:')).length, 2);
  } finally { release(); await single.drain(); single.seed.fill(0); }
});

test('bulk failed durable plan write broadcasts nothing and can prepare again safely', async t => {
  const f = await senderFixture(t, 1), save = f.journal.saveBulk.bind(f.journal); let fail = true;
  f.journal.saveBulk = row => { if (row.plan && fail) { fail = false; throw Error('disk failure'); } return save(row); };
  await assert.rejects(f.sender.process(f.orderId), /disk failure/);
  assert.equal(f.sent.length, 0); assert.equal(f.row.plan, undefined);
  await f.sender.process(f.orderId); assert.equal(f.row.state, 'sent'); assert.equal(f.sent.length, 2);
});
