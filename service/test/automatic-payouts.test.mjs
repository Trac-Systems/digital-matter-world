import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/store.mjs';
import { Payouts } from '../src/payouts.mjs';
import { payoutGate } from '../src/payout-index.mjs';
import { serve } from '../src/http.mjs';
import { hash, heightKey } from '../src/util.mjs';
import { MintSenderView } from '../src/mint-sender-view.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { requestKey } from '../src/mint-sender-keys.mjs';

const seed = new Uint8Array(32).fill(82);
function address(n) { const key = requestKey(seed, hash(String(n)), 'regtest'); try { return key.address; } finally { key.privateKey.fill(0); } }
const draft = (to, amount, n = '1') => ({ proposal: { batch: { n } }, items: [{ output: { file: { observation: n,
  commissions: [{ id: hash(n), role: 'discoverer', to, amount }] } } }] });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'payout-ledger-'));
  let store = await Store.open(join(dir, 'store'));
  const files = { json: async () => {}, serve: async () => false };
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, files, get store() { return store; }, get ledger() { return new Payouts({ store, files }); },
    async reopen() { await store.close(); store = await Store.open(join(dir, 'store')); } };
}

test('commission index follows accruals, partial and full records atomically and survives restart', async t => {
  const f = await fixture(t), beneficiary = address(1), key = hash(beneficiary);
  await f.store.transact(f.ledger.accruals(draft(beneficiary, '10')));
  assert.deepEqual(f.store.get('payoutPayable', key), { beneficiary });
  await f.ledger.record({ beneficiary, amount: '4', reference: 'partial', txid: hash('partial') });
  assert.equal(f.ledger.page({}, 'regtest').rows[0].amount, '6');
  await f.reopen();
  await f.ledger.record({ beneficiary, amount: '6', reference: 'rest', txid: hash('rest') });
  assert.equal(f.store.get('payoutPayable', key), null);
  assert.equal(f.store.get('payoutPaid', hash('rest')).evidence, 'operator_recorded_transaction');
  await f.store.put('payoutTotals', 'custody/' + key, { beneficiary, accrued: '20', paid: '0' });
  assert.equal(f.store.countUint('payoutPayable'), '0');
});

test('discovery pages only the outstanding index and rechecks current minimum and network destinations', async t => {
  const f = await fixture(t);
  for (let n = 1; n <= 5; n++) await f.store.transact(f.ledger.accruals(draft(address(n), String(n), String(n))));
  await f.store.put('payoutTotals', hash(address(1)), { beneficiary: address(1), accrued: '1', paid: '0', legacyDeploy: true, payoutMinAtoms: '3' });
  const invalid = 'not-a-bitcoin-address';
  await f.store.transact(f.ledger.accruals(draft(invalid, '10', '7')));
  const original = f.store.list.bind(f.store); f.store.list = (space, options) => { assert.equal(space, 'payoutPayable'); return original(space, options); };
  f.store.count = () => assert.fail('history count');
  let after = '', found = [];
  do { const page = f.ledger.page({ after, limit: 2 }, 'regtest'); found.push(...page.rows); after = page.next; } while (after);
  assert.equal(found.length, 5); assert.equal(new Set(found.map(r => r.id)).size, 5);
  assert.equal(found.find(r => r.beneficiary === invalid).blocked, 'payout_destination');
  assert.equal(found.some(r => r.beneficiary === address(1)), false);
  await f.store.transact([{ space: 'meta', id: 'v2Last', value: { n: '8' } },
    { space: 'batches', id: heightKey('8'), value: { batch: { settingsHash: 'new' } } },
    { space: 'settingsHistory', id: 'new', value: { values: { legacyDeployPayoutMinAtoms: '1' } } }]);
  assert.ok(f.ledger.page({}, 'regtest').rows.some(r => r.beneficiary === address(1)));
  assert.throws(() => f.ledger.page({ after: '../bad' }, 'regtest'), /payout_page/);
  assert.throws(() => f.ledger.automatic(address(1), 'mainnet'), /payout_destination/);
});

test('offline payable rebuild is idempotent and excludes custody and settled totals', async t => {
  const f = await fixture(t), beneficiary = address(1);
  await f.store.transact(f.ledger.accruals(draft(beneficiary, '10')));
  await f.store.put('payoutPayable', hash(beneficiary));
  await f.store.put('payoutPayable', hash('stale'), { beneficiary: 'stale' });
  await f.ledger.rebuildIndex(); const before = f.store.list('payoutPayable');
  await f.ledger.rebuildIndex(); assert.deepEqual(f.store.list('payoutPayable'), before);
  assert.deepEqual(before, [{ id: hash(beneficiary), value: { beneficiary } }]);
});

test('reserved amount and reference survive new accruals; manual races and conflicting records are refused', async t => {
  const f = await fixture(t), beneficiary = address(1);
  await f.store.transact(f.ledger.accruals(draft(beneficiary, '10')));
  const prepared = f.ledger.automatic(beneficiary, 'regtest');
  await f.ledger.reserve(prepared, 'regtest');
  assert.throws(() => f.ledger.prepare(beneficiary), /payout_reserved/);
  await f.store.transact(f.ledger.accruals(draft(beneficiary, '4', '2')));
  assert.equal(f.ledger.automatic(beneficiary, 'regtest').amount, '10');
  await assert.rejects(f.ledger.record({ beneficiary, amount: '1', txid: hash('manual'), reference: 'manual' }), /payout_reserved/);
  const payment = { ...prepared, txid: hash('auto') };
  await f.ledger.record(payment, { automatic: true }); await f.ledger.record(payment, { automatic: true });
  assert.equal(f.store.get('payoutPaid', hash(prepared.reference)).evidence, 'automatic_payout_transaction');
  const next = f.ledger.automatic(beneficiary, 'regtest');
  assert.equal(next.amount, '4'); assert.notEqual(next.reference, prepared.reference);
  await assert.rejects(f.ledger.record({ ...payment, txid: hash('changed') }, { automatic: true }), /payout_reference_conflict/);
});

test('concurrent records and batch accrual gate cannot lose or overpay a total', async t => {
  const f = await fixture(t), beneficiary = address(1);
  await f.store.transact(f.ledger.accruals(draft(beneficiary, '10')));
  const results = await Promise.allSettled(['a', 'b'].map(reference => f.ledger.record({ beneficiary, amount: '7', reference, txid: hash(reference) })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await Promise.all([
    payoutGate(f.store, () => f.store.transact(f.ledger.accruals(draft(beneficiary, '8', '2')))),
    f.ledger.record({ beneficiary, amount: '3', reference: 'c', txid: hash('c') })
  ]);
  assert.equal(f.ledger.prepare(beneficiary).amount, '8');
});

test('automatic payout routes require minter auth and refuse exceeds-owed; record retries keep one txid', async t => {
  const f = await fixture(t), beneficiary = address(1);
  await f.store.transact(f.ledger.accruals(draft(beneficiary, '10')));
  const view = new MintSenderView({ seed: seed.slice(), network: 'regtest', settings: mintSenderSettings({ directory: join(f.dir, 'minter'), seedFile: join(f.dir, 'seed'), bitcoinApiUrlFile: join(f.dir, 'btc') }) });
  const http = await serve({ intake: { store: f.store }, mints: { mintSender: view }, files: f.files, web: { handle: async () => false } });
  t.after(async () => { await http.close(); view.close(); });
  const call = async (path, data, authenticated = true) => {
    const response = await fetch(http.url + '/internal/mint-sender/payouts' + path, { method: data ? 'POST' : 'GET', headers: {
      ...(authenticated ? { authorization: 'Bearer ' + view.token } : {}), ...(data ? { 'content-type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('', null, false)).status, 404);
  assert.equal((await call('/prepare', {}, false)).status, 404);
  assert.equal((await call('/record', {}, false)).status, 404);
  const page = await call(''); assert.equal(page.body.rows.length, 1);
  const record = page.body.rows[0];
  assert.equal((await call('/prepare', record)).status, 200);
  const oversized = await call('/record', { ...record, amount: '11', txid: hash('tx') });
  assert.equal(oversized.status, 400); assert.equal(oversized.body.error, 'payout_exceeds_owed');
  for (let i = 0; i < 2; i++) assert.equal((await call('/record', { ...record, txid: hash('tx') })).body.recorded, true);
  assert.equal(f.store.countUint('payoutPaid'), '1'); assert.equal((await call('')).body.queuedCount, '0');
});

test('manual payout CLI prepare and record remain compatible, including a repeated reference', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'payout-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const beneficiary = address(1), data = join(dir, 'store'), store = await Store.open(data);
  await store.put('payoutTotals', hash(beneficiary), { beneficiary, accrued: '10', paid: '0' }); await store.close();
  const cfg = join(dir, 'config.json');
  await writeFile(cfg, JSON.stringify({ version: 1, mode: 'regtest', network: 'test', data, gatewayKey: join(dir, 'key'), adapter: join(dir, 'adapter'),
    listen: { host: '127.0.0.1', port: 0 }, endpoints: { ethereum: 'http://127.0.0.1:1', trac: 'http://127.0.0.1:2' }, local: { tapSourceFile: join(dir, 'source') },
    committee: Array.from({ length: 5 }, () => ({ url: 'http://127.0.0.1:3' })) }));
  const run = (...args) => promisify(execFile)(process.execPath, [new URL('../scripts/payouts.mjs', import.meta.url).pathname, cfg, ...args]);
  assert.equal(JSON.parse((await run('prepare', beneficiary)).stdout).amount, '10');
  await run('record', beneficiary, '10', hash('manual'), 'manual-cli');
  await run('record', beneficiary, '10', hash('manual'), 'manual-cli');
  await run('rebuild-index');
  const reopened = await Store.open(data);
  try { assert.equal(reopened.get('payoutTotals', hash(beneficiary)).paid, '10'); assert.equal(reopened.countUint('payoutPayable'), '0'); }
  finally { await reopened.close(); }
});
