import { feeFixture } from '../helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { Links } from '../../src/links.mjs';
import { Store } from '../../src/store.mjs';
import { Files } from '../../src/files.mjs';
import { Intake } from '../../src/intake.mjs';
import { Pipeline } from '../../src/pipeline.mjs';
import { Outbox } from '../../src/transport.mjs';
import { serve } from '../../src/http.mjs';
import { patternPage } from '../../src/feeds.mjs';
import { pruneDrafts, collectFiles, recoverFeedVersions } from '../../src/retention.mjs';
import { rules } from '../../src/rules.mjs';
import { hash, heightKey } from '../../src/util.mjs';
import { temp, agent, network, secret, fixtureHistory, patterns, receiptSigners, attestRoot } from '../helpers.mjs';
import { harness, deployment, signedBatch } from '../../../contract/tests/helpers/harness.mjs';

test('signed HTTP links refuse wrong owners, prior links, unfinalized releases and refunds; pipeline publishes a paid link once', async () => {
  const store = await Store.open(await temp('links-')), files = new Files(join(store.directory, 'static')), who = agent(), history = fixtureHistory();
  const intake = new Intake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
  let counted = 1, holder = who.address, previous = null, payment;
  const reads = { counted: async () => counted, bitmap: async () => ({ agent: holder, address: 'local-holder' }), link: async () => previous,
    linkPaymentFor: async () => payment, linkPayment: async () => payment, linkTerms: async id => store.get('linkRequests', id).terms };
  const fees = feeFixture({ store }); Object.assign(reads, fees);
  const links = new Links({ store, network, reads, terms: fees.terms('link', 'local-treasury') });
  const http = await serve({ intake, files, links }); let pipeline;
  const post = async (path, body) => { const r = await fetch(http.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, value: await r.json() }; };
  try {
    const request = { owner: who.address, height: 1, nonce: hash('link-request'), until: 40 }, paymentHash = hash('link-hash');
    const body = { request, sig: rules.signLink(network, request, who.secret), payer: 'local-payer', paymentHash };
    assert.equal((await post('/link/request', { ...body, sig: '00'.repeat(64) })).value.error, 'link_signature');
    holder = agent(2).address; assert.equal((await post('/link/request', body)).value.error, 'link_owner'); holder = who.address;
    previous = { block: 1, linkHeight: 0 }; assert.equal((await post('/link/request', body)).value.error, 'link_exists'); previous = null;
    const quote = await post('/link/request', body); assert.equal(quote.status, 200); const { id, terms } = quote.value;
    payment = { id: 'ab'.repeat(32) + 'i0:0', requestId: id, kind: 'tap', payer: 'local-payer', total: '2000', consumed: false, confirmations: 1,
      tick: 'tap', lockKind: 'htlc', conditionType: 'hashlock', hash: paymentHash, refund: 'local-payer', claim: 'local-treasury', base: '1000',
      allocations: [{ tt: 'b', to: '1BitcoinEaterAddressDontSendf59kuE', amt: '1000', rl: 'bn' }], refundAfter: 200, verifiedHeight: 1, eventIndex: 0 };
    const funding = { id, paymentId: payment.id };
    assert.equal((await post('/link/payment', funding)).value.error, 'link_unpaid');
    payment.consumed = true; payment.settlement = { accepted: true, refund: false, paymentId: payment.id, txid: 'cd'.repeat(32), confirmations: 0 };
    assert.equal((await post('/link/payment', funding)).value.error, 'link_unpaid');
    payment.settlement.confirmations = 6; payment.settlement.refund = true;
    assert.equal((await post('/link/payment', funding)).value.error, 'link_unpaid'); payment.settlement.refund = false;
    holder = agent(2).address; assert.equal((await post('/link/payment', funding)).value.error, 'link_owner'); holder = who.address;
    assert.equal((await post('/link/payment', funding)).status, 200);
    const options = { ...deployment, network }, contract = harness(options);
    Object.assign(reads, { batchLast: async () => contract.state().batchLast(), committeeEpoch: () => contract.state().committeeEpoch(), balance: async () => '0', nonceUsed: async () => false });
    const transport = { prepareMessage: async (op, value) => ({ op, value }), sendMessage: async m => assert.equal(await contract.run(m.op, m.value), null), status: async job => ({ state: contract.db.get('bt/' + job.value.n) === job.value.root ? 'accepted' : 'pending' }) };
    const outbox = new Outbox({ store, transport, retryMs: 0, fallbackMs: 100000 });
    pipeline = new Pipeline({ store, files, intake, history, reads, links, outbox, patterns, settings: { puzzleBits: 0, receiptSigners }, committee: { attestRoot, signature: async (_, proposal) => ({ signature: { compact: signedBatch(proposal.batch, options).sig } }) } });
    for (let tip = 6; tip <= 9; tip++) {
      await intake.observe({ tip, hash: history.hashAt(tip), counted: tip - 5, confirmed: tip - 5, headers: tip === 6 ? Array.from({ length: 6 }, (_, i) => history.raw(i + 1)) : [history.raw(tip)] });
      if (tip > 6) { counted = tip - 6; await pipeline.tick(); await pipeline.tick(); }
    }
    assert.deepEqual(JSON.parse(contract.db.get('n/link/1')), { block: 1, linkHeight: 1 });
    assert.equal(store.get('linkStatus', id).state, 'accepted'); assert.equal(store.count('activeLinks'), 0);
    assert.deepEqual(store.get('links', heightKey(1)), { block: 1, linkHeight: 1 });
    assert.equal((await post('/link/payment', funding)).value.state, 'accepted');
    const batches = store.list('batches', { limit: 100 });
    assert.equal(batches.flatMap(r => r.value.batch.ops).filter(o => o.op === 'kv' && o.key === 'link/1').length, 1);
    assert.equal((await readdir(join(store.directory, 'drafts'))).length, 0);
  } finally { await http.close(); await pipeline?.close(); await store.close(); }
});

test('retention preserves live drafts and audits, keeps sixteen feed versions, and resumes interrupted garbage collection', async () => {
  const store = await Store.open(await temp('retention-')), files = new Files(join(store.directory, 'static')), history = fixtureHistory(20);
  const pipeline = new Pipeline({ store });
  try {
    const audit = await files.immutable('blocks/proof.bin', Buffer.from('permanent proof'));
    for (let n = 1; n <= 20; n++) await pipeline.saveDraft({ proposal: { batch: { n } }, body: 'x'.repeat(n) });
    assert.equal((await readdir(join(store.directory, 'drafts'))).length, 1);
    assert.equal((await pipeline.loadDraft()).proposal.batch.n, 20);
    await writeFile(join(store.directory, 'drafts', 'ab'.repeat(32) + '.json'), 'crash before checkpoint'); await pruneDrafts(store);
    assert.equal((await readdir(join(store.directory, 'drafts'))).length, 1);
    for (let n = 0; n < 24; n++) { await store.put('minted', 'p0/1', n); await patternPage({ store, files, history, pattern: patterns[0], page: 0 }); }
    assert.equal((await readdir(files.path('patterns/p0'))).filter(n => n.includes('-')).length, 16);
    const current = JSON.parse(await readFile(files.path('patterns/p0/0.json'), 'utf8'));
    const garbage = '/patterns/p0/0-' + 'ef'.repeat(32) + '.json'; await files.immutable(garbage.slice(1), Buffer.from('old view'));
    await store.put('fileGarbage', garbage, true); await collectFiles(store, files); await collectFiles(store, files);
    const orphan = '/patterns/p0/0-' + 'ed'.repeat(32) + '.json'; await files.immutable(orphan.slice(1), Buffer.from('interrupted publication'));
    await recoverFeedVersions(store, files);
    assert.equal((await readdir(files.path('patterns/p0'))).filter(n => n.includes('-')).length, 16);
    assert.ok(await readFile(files.path(current.path.slice(1)))); assert.equal((await readFile(files.path(audit.path.slice(1)))).toString(), 'permanent proof');
  } finally { await pipeline.close(); await store.close(); }
});

for (const existing of [false, true]) test(`current feed publication recovers after pointer write and before version checkpoint (existing=${existing})`, async () => {
  const directory = await temp('feed-publication-crash-'), files = new Files(join(directory, 'static')), history = fixtureHistory(20);
  let store = await Store.open(directory);
  try {
    if (existing) await patternPage({ store, files, history, pattern: patterns[0], page: 0 });
    await store.put('minted', 'p0/1', 'current-inscription');
    const transact = store.transact.bind(store);
    store.transact = async operations => {
      if (operations.some(o => o.space === 'feedVersions')) throw Error('crash_before_feed_checkpoint');
      return transact(operations);
    };
    await assert.rejects(patternPage({ store, files, history, pattern: patterns[0], page: 0 }), /crash_before_feed_checkpoint/);
    const current = JSON.parse(await readFile(files.path('patterns/p0/0.json'), 'utf8'));
    store.transact = transact; await store.close(); store = await Store.open(directory);
    await recoverFeedVersions(store, files); await recoverFeedVersions(store, files);
    assert.equal(store.get('feedVersions', 'p0/0')[0], current.path);
    assert.equal(JSON.parse(await readFile(files.path(current.path.slice(1)), 'utf8')).rows.find(r => r.block === 1).minted, 'current-inscription');
  } finally { await store.close(); }
});

test('journal rotation is bounded even without any accepted Bitcoin batches', async () => {
  const directory = await temp('idle-journal-'); let store = await Store.open(directory);
  try {
    for (let n = 0; n < 30; n++) await store.put('working', 'same', { n, bytes: 'x'.repeat(100000) });
    assert.ok(await store.bytes() < 2000000); await store.close(); store = await Store.open(directory);
    assert.equal(store.get('working', 'same').n, 29);
  } finally { await store.close(); }
});
