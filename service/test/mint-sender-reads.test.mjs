import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FinancialMints } from '../src/financial-mints.mjs';
import { WebCheckout } from '../src/web-checkout.mjs';
import { serve } from '../src/http.mjs';
import { Store } from '../src/store.mjs';
import { MintSenderView } from '../src/mint-sender-view.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { requestKey } from '../src/mint-sender-keys.mjs';
import { senderJSON, MintSenderJournal } from '../src/mint-sender-journal.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
test('claimed/public status, payment response and existing checkout plan carry the same sender contract', async t => {
  const directory = await mkdtemp(join(root, '.mb1-reads-')); await chmod(directory, 0o700);
  let http, store, journal, view;
  t.after(async () => { await http?.close(); view?.close(); journal?.close(); await store?.close(); await rm(directory, { recursive: true, force: true }); });
  store = await Store.open(join(directory, 'gateway'));
  const settings = mintSenderSettings({ enabled: true, directory: join(directory, 'sender'), seedFile: join(directory, 'seed'), bitcoinApiUrlFile: join(directory, 'source') });
  const seed = new Uint8Array(32).fill(29), receiver = requestKey(seed, '11'.repeat(32), 'regtest').address;
  const document = { values: { pendingBlocks: 432, publicMintPageSize: 50 } };
  const mints = new FinancialMints({ store, network: 'fixture', reads: { counted: async () => '50' }, document, financial: {} });
  view = mints.mintSender = new MintSenderView({ seed, network: 'regtest', settings });
  // This fixture has no pattern index; the live gateway rechecks availability and finds the block public.
  mints.publicMints.state = () => ({ state: 'public' });
  journal = new MintSenderJournal(settings.directory, { keyId: view.keyId, network: 'regtest' });
  senderJSON(join(settings.directory, 'health.json'), { at: Date.now(), ready: true, keyId: view.keyId, policy: view.policy });
  await store.put('meta', 'ruleState', { counted: '50' });
  const ids = ['aa'.repeat(32), 'bb'.repeat(32)];
  for (const [i, id] of ids.entries()) {
    await store.put('mints', id, { id, kind: 'tap', publicMint: i === 1, payer: receiver, receiver, state: 'awaiting_payment', created: '40', expiry: '100',
      request: { owner: '99'.repeat(32), asset: 'p2:0', block: String(i + 1), amount: '2', expires: '100' }, paymentIds: [],
      quote: { fees: [], fullFees: [], payableAmount: '0', price: '0', split: {}, baseFee: '1' } });
    await store.put('accountRecords', 'fp/' + id, { state: 'open', paid: [] });
  }
  const checkout = new WebCheckout({ store, mints, reads: { counted: async () => '50' }, config: { mode: 'regtest', network: 'fixture', endpoints: { ethereum: 'http://127.0.0.1:1' }, local: { escrow: { chainId: '31337' } } } });
  http = await serve({ intake: { store }, mints, files: { serve: async () => false }, web: { handle: async () => false } });
  const request = async (path, options) => { const response = await fetch(http.url + path, options); return { code: response.status, body: await response.json() }; };
  assert.equal((await request('/internal/mint-sender/requests')).code, 404);
  const page = await request('/internal/mint-sender/requests?limit=1', { headers: { authorization: 'Bearer ' + view.token } });
  assert.equal(page.code, 200); assert.equal(page.body.rows.length, 1); assert.equal(page.body.next, ids[0]); assert.equal(page.body.rows[0].payer, receiver);
  for (const id of ids) {
    const read = await request('/mint/' + id), plan = await checkout.plan('mint', id);
    assert.equal(read.code, 200); assert.equal(read.body.mintFunding.address, view.address(id));
    assert.deepEqual(read.body.mintFunding, plan.mintFunding); assert.equal(read.body.mintSender.state, 'waiting_funding');
    const saved = store.get('mints', id);
    const permit = { p: 'tap', op: 'dmt-mint', dta: id, prv: { address: receiver } };
    await store.put('mints', id, { ...saved, state: 'permit_issued', permit });
    const inscription = 'dd'.repeat(32) + 'i0';
    const result = await request('/mint/payment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, inscription }) });
    assert.equal(result.code, 200); assert.equal(result.body.sentInscription, inscription); assert.equal(result.body.mintFunding, undefined);
    journal.save({ id, state: 'sent', address: view.address(id), payer: receiver, receiver, createdAt: Date.now(), plan: { commitTxid: 'cc'.repeat(32), revealTxid: inscription.slice(0, 64), inscriptionId: inscription } });
    assert.equal((await request('/mint/' + id)).body.mintSender.revealTxid, inscription.slice(0, 64));
  }
  const ethereum = { ...store.get('mints', ids[0]), kind: 'ethereum' }; await store.put('mints', ids[0], ethereum);
  assert.equal((await request('/mint/' + ids[0])).body.mintSender, undefined);
  assert.equal((await request('/internal/mint-sender/requests?limit=101', { headers: { authorization: 'Bearer ' + view.token } })).code, 400);
});
