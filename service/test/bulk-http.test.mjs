import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, b, digest } from './bulk-helpers.mjs';
const { serve } = await import('../src/http.mjs');
const { createWeb } = await import('../src/web.mjs');
async function server(t, f) {
  const listener = await serve({ bulkMints: f.bulk, intake: { store: f.store }, files: { serve: () => false },
    web: createWeb({ bulkMints: f.bulk }), responseTimeoutMs: 2000 });
  t.after(() => listener.close());
  const post = (path, body) => fetch(listener.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ...listener, post };
}

test('bulk loopback routes preserve hex wire identities, exact retry and no-store', async t => {
  const f = await fixture(t), http = await server(t, f);
  const quoteReply = await http.post('/mint/bulk/quote', f.input(2)); assert.equal(quoteReply.status, 200);
  const q = await quoteReply.json(); assert.equal(q.terms.owner, f.owner);
  const body = f.sign(q), reply = await http.post('/mint/bulk/request', body);
  assert.equal(reply.status, 202); assert.equal((await reply.json()).state, 'reserving');
  assert.equal((await http.post('/mint/bulk/request', body)).status, 200);
  const terms = await fetch(http.url + '/web-api/mint/bulk/' + q.orderId + '/terms');
  assert.equal(terms.headers.get('cache-control'), 'no-store'); assert.deepEqual((await terms.json()).terms, q.terms);
  assert.equal((await fetch(http.url + '/mint/bulk/' + q.orderId + '/members?offset=0&limit=65')).status, 400);
  assert.equal((await fetch(http.url + '/mint/bulk/' + q.orderId + '/permit?offset=0&limit=17')).status, 400);
  for (const offset of ['0x1', '01', '', '-1', '1.0']) assert.equal((await fetch(http.url + '/mint/bulk/' + q.orderId + '/members?offset=' + offset)).status, 400);
  assert.equal((await fetch(http.url + '/mint/bulk/' + q.orderId + '?unknown=1')).status, 400);
  const html = await fetch(http.url + '/mint/bulk/' + q.orderId, { headers: { accept: 'text/html' } });
  assert.match(html.headers.get('content-type'), /text\/html/);
  // The site app renders the order (its route is /mint/bulk/<order>); no page-specific entry script.
  assert.match(await html.text(), /src="\/web\/app.js"/);
  const json = await fetch(http.url + '/mint/bulk/' + q.orderId, { headers: { accept: 'application/json' } });
  assert.equal((await json.json()).orderId, q.orderId);
});

test('bulk HTTP body caps, unknown keys and sender bearer auth are isolated from old routes', async t => {
  const f = await fixture(t), http = await server(t, f), q = await f.bulk.quote(f.input());
  assert.equal((await http.post('/mint/bulk/quote', { ...f.input(), extra: true })).status, 400);
  assert.equal((await http.post('/mint/bulk/quote', { padding: 'x'.repeat(b.BULK_LIMITS.quoteInputBytes) })).status, 413);
  await f.bulk.request(f.sign(q));
  assert.equal((await fetch(http.url + '/internal/mint-sender/bulk')).status, 404);
  const sender = await fetch(http.url + '/internal/mint-sender/bulk/' + q.orderId, { headers: { authorization: 'Bearer local-test' } });
  assert.equal(sender.status, 200); assert.equal((await sender.json()).terms.owner, f.owner);
  const bad = await fetch(http.url + '/internal/mint-sender/bulk?limit=51', { headers: { authorization: 'Bearer local-test' } });
  assert.equal(bad.status, 400);
});

test('bulk unverified HTTP payment hint cannot hide pay or replace accepted reference', async t => {
  const f = await fixture(t), http = await server(t, f), q = await f.bulk.quote(f.input()), id = q.orderId;
  await f.bulk.request(f.sign(q)); await f.execute();
  const unindexed = await http.post('/mint/bulk/payment', { orderId: id, paymentId: digest('unknown') + 'i0', commitTxid: null, revealTxid: null });
  assert.equal(unindexed.status, 202); assert.equal((await unindexed.json()).payable, true);
  const commit = await http.post('/mint/bulk/payment', { orderId: id, paymentId: null, commitTxid: digest('commit'), revealTxid: null });
  assert.equal(commit.status, 202); assert.equal((await commit.json()).payable, true);
  assert.deepEqual(f.bulk.row(id).references, []);
  const reference = f.payment(q);
  const paid = await http.post('/mint/bulk/payment', { orderId: id, paymentId: reference, commitTxid: null, revealTxid: null });
  assert.equal(paid.status, 202); await f.execute();
  const status = await (await fetch(http.url + '/web-api/mint/bulk/' + id)).json();
  assert.equal(status.payment.reference, reference); assert.equal(status.state, 'paid');
});

test('bulk verified finish repeat returns 200 while first report remains 202', async t => {
  const f = await fixture(t), http = await server(t, f), q = await f.bulk.quote(f.input()), id = q.orderId;
  await f.bulk.request(f.sign(q)); await f.execute();
  await f.bulk.payment({ orderId: id, paymentId: f.payment(q), commitTxid: null, revealTxid: null }); await f.execute();
  await f.bulk.tick(); await f.execute(); await f.bulk.tick();
  const report = { orderId: id, members: await f.reveal(id) };
  assert.equal((await http.post('/mint/bulk/finish', report)).status, 202); await f.execute();
  assert.equal((await http.post('/mint/bulk/finish', report)).status, 200);
});

test('bulk sender discovery reads summaries without loading every permit manifest', async t => {
  const f = await fixture(t), q = await f.bulk.quote(f.input());
  await f.bulk.request(f.sign(q)); await f.execute();
  f.bulk.permit = async () => assert.fail('sender list loaded a permit manifest');
  const page = await f.bulk.senderPage();
  assert.equal(page.rows.length, 1); assert.equal(page.rows[0].orderId, q.orderId);
  assert.equal(page.rows[0].paymentId, null);
});

test('slow bulk quotes survive the HTTP response deadline without restarting source work', async t => {
  const f = await fixture(t), http = await server(t, f), original = f.reads.bulkCandidates;
  let calls = 0, slow = true;
  f.reads.bulkCandidates = async (...args) => {
    calls++;
    if (slow) await new Promise(resolve => setTimeout(resolve, 2400));
    return original(...args);
  };
  const input = f.input(64), first = await http.post('/mint/bulk/quote', input);
  assert.equal(first.status, 503); assert.equal((await first.json()).error, 'request_pending');
  const resumed = await http.post('/mint/bulk/quote', input);
  assert.equal(resumed.status, 200, 'identical retry joins the original preview');
  const quote = await resumed.json(); assert.equal(quote.terms.members.length, 64); assert.equal(calls, 1);
  await f.store.put('bulkCursors', 'activeBulkOrders', '');
  const cached = await http.post('/mint/bulk/quote', input); assert.equal(cached.status, 200);
  assert.deepEqual(await cached.json(), quote); assert.equal(calls, 1);
  slow = false;
  await f.financial.gate(() => f.store.put('financialAdmissionHeld', f.owner + '/' + input.asset, '99997'), { pending: true });
  const changed = await f.bulk.quote(input); assert.equal(changed.terms.members.length, 1); assert.equal(calls, 2);
  f.height('974138'); await f.bulk.quote(input); assert.equal(calls, 3);
});
