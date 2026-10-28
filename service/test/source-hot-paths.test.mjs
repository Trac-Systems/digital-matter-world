import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { HttpSource } from '../prod/http.mjs';
import { TapReader } from '../prod/tap.mjs';
import { BitcoinSource } from '../prod/bitcoin.mjs';
import { EvidenceStore, signEvidence } from '../prod/evidence.mjs';
import { Store } from '../src/store.mjs';
import { Mints, payerDigest } from '../src/mints.mjs';
import { MintOperations } from '../src/operations.mjs';
import { PublicViews } from '../src/public-views.mjs';
import { configFixture } from '../prod/test/helpers.mjs';
import { agent, signEd } from './helpers.mjs';
import { bindingFixture } from './bindings-fixture.mjs';
import { authority } from '../../local/protocol.mjs';
import { rules } from '../src/rules.mjs';
import { hash, heightKey } from '../src/util.mjs';
import { createFeePolicy } from '../src/fees.mjs';
const block = JSON.parse(await readFile(new URL('../prod/test/fixtures/ord-regtest.json', import.meta.url)));
let active;
mock.module('../prod/bitcoin.mjs', { exports: {
  createBitcoin: async () => active.client,
  BitcoinViews: class { async view() { return active.history; } close() {} }
} });
mock.module('../prod/tap.mjs', { exports: { createTap: async () => active.indexer } });
mock.module('../prod/ethereum.mjs', { exports: { createEthereum: async () => ({ rpc: () => assert.fail('unexpected Ethereum read'), escrow: {} }) } });
mock.module('../prod/trac.mjs', { exports: { configuredTrac: async () => active.trac } });
const { createAdapters } = await import('../prod/adapter.mjs');

async function finish(t, promise) {
  let done = false, value, error;
  promise.then(v => { value = v; done = true; }, e => { error = e; done = true; });
  for (let i = 0; i < 100000 && !done; i++) { await turn(); t.mock.timers.tick(1); }
  assert.equal(done, true, 'bounded paced operation'); if (error) throw error; return value;
}
async function fixture(t, linked) {
  let store, adapter;
  t.after(async () => { await adapter?.close(); await store?.close(); });
  const { config, root, file } = await configFixture(t); store = await Store.open(join(root, 'store'));
  const who = agent(52), bindings = bindingFixture(store, { network: config.network, bitcoinNetwork: 'mainnet' });
  config.committee = bindings.config; config.data = store.directory;
  const address = (await bindings.bind(who, 'tap')).request.address;
  const txid = Object.keys(block.transactions)[1], element = txid + 'i0', deployment = txid + 'i1', privilege = txid + 'i2';
  const auth = authority(Buffer.alloc(32, 5), { privilege: true });
  const { secp256k1 } = await import('../../committee/node_modules/@noble/curves/secp256k1.js');
  const key = Buffer.from(secp256k1.getPublicKey(Buffer.alloc(32, 5))).toString('hex');
  const entry = { id: deployment, kind: 'dmt', tick: 'paced', indexTick: 'dmt-paced', privilege, authorityKey: key,
    elementId: element, elementName: 'paced', dt: 'n', pattern: { number: 0, pat: '[0-9]', fld: 4, dt: 'n' }, receiver: address,
    sourceLocators: { element: { id: element, offset: 800001 }, authority: { id: privilege, offset: 15001 } }, tap: { treasury: address } };
  await writeFile(config.prod.registry, JSON.stringify({ feePolicy: createFeePolicy('100'), assets: { p0: entry } }));
  const find = { block: 10, pattern: 0, asset: 'p0', count: 1, finder: who.address, findHeight: 100, window: 1, source: 'claim' }, id = rules.findId(10, 0);
  const audit = rules.encodeBinary({ v: 4, observation: 1, height: 100, settlements: [{ window: 1, winners: [{ ...find, id, winner: who.address }] }] });
  const auditRoot = rules.merkleRoot([audit]);
  await mkdir(join(store.directory, 'static', 'blocks'), { recursive: true }); await writeFile(join(store.directory, 'static', 'blocks', 'paced.bin'), audit);
  await store.transact([{ space: 'meta', id: 'patterns', value: [entry.pattern] }, { space: 'finds', id, value: find },
    { space: 'findProvenance', id, value: 1 }, { space: 'batches', id: heightKey(1), value: { batch: { n: 1, to: 100, root: auditRoot }, publications: [{ audit: { path: '/blocks/paced.bin' } }] } }]);
  const state = { hash: block.hash, cancelled: false }, calls = [];
  const source = new HttpSource({ url: 'https://source.invalid', requestsPerSecond: 2, retries: 0, maxBytes: 16_000_000, fetchImpl: async url => {
    const u = new URL(url), path = u.pathname; calls.push({ path: path + u.search, at: Date.now() });
    let value;
    if (path === '/r/blockheight') value = block.height;
    else if (path.startsWith('/r/blockhash')) value = state.hash;
    else if (path === '/r/blockinfo/' + block.hash) value = block.info;
    else if (path === '/block/' + block.hash) value = block.block;
    else if (path.startsWith('/r/tx/')) value = block.transactions[path.slice(6)];
    else if (path.startsWith('/inscription/')) value = { id: path.slice(13), height: block.height, address };
    else if (path.startsWith('/content/')) {
      value = path.endsWith(element) ? 'paced.[0-9].4.element' : path.endsWith(privilege) ? JSON.stringify(auth)
        : JSON.stringify({ p: 'tap', op: 'dmt-deploy', tick: 'paced', elem: element, dt: 'n', prv: privilege });
      return new Response(value);
    } else {
      assert.ok(path.startsWith('/r/tap/'), path);
      const method = path.slice(7);
      if (method === 'getCurrentBlock') value = block.height;
      else if (method === 'getDeployment/dmt-paced') value = { ins: deployment, prv: privilege, tick: 'dmt-paced', elem: element, dt: 'n', dec: 0 };
      else if (method === 'getDmtElementsList') { assert.equal(u.search, '?offset=800001&max=1'); value = [{ ins: element, tick: 'paced', pat: '[0-9]', fld: 4 }]; }
      else if (method === 'getPrivilegeAuthList') { assert.equal(u.search, '?offset=15001&max=1'); value = [{ ins: privilege }]; }
      else if (method.startsWith('getPrivilegeAuthCancelled/')) value = state.cancelled;
      else if (method === 'getMintTokensLeft/dmt-paced') value = '1000';
      else if (method.startsWith('getDmtMintHolderByBlock/')) { value = null; if (state.reorgAtClose) state.hash = 'ef'.repeat(32); }
      else if (method === 'getBitmap/10') value = { bm: 10, ins: txid + 'i3', ownr: address };
      else assert.fail('unbounded or unexpected source read: ' + method);
      value = { result: value };
    }
    return Response.json(value);
  } });
  const client = new BitcoinSource({ source, network: 'regtest' });
  const history = { length: block.height + 1, hashAt: n => n === block.height ? block.hash : n >= 0 && n < block.height ? hash('block/' + n) : null };
  const stamp = { counted: 105, tip: block.height, tipHash: block.hash, revision: 1, last: { n: 1, to: 100 } };
  const trac = async (method, args = []) => {
    if (method === 'head') return { tip: { height: block.height, hash: block.hash }, counted: 105 };
    if (method === 'root') return auditRoot;
    if (method === 'record') return linked ? { block: 10, linkHeight: 99 } : null;
    if (method === 'balance') return '100';
    if (['pending', 'acceptance', 'hold'].includes(method)) return null;
    if (method === 'nonceUsed') return false;
    if (method === 'authority') return { committee: key };
    if (method === 'stamp') return stamp;
    if (method === 'batchLast') return stamp.last;
    if (method === 'settings') return {};
    if (method === 'deployment') return { beacon: { checkpoint: { height: block.height, hash: block.hash }, params: { interval: 2016, branchDepth: 6, confirmations: 6 } } };
    assert.fail('unexpected Trac read: ' + method);
  }; trac.close = async () => {};
  const indexer = new TapReader({ sources: [source], bitcoin: client, agreement: 1, sharedTransport: true });
  active = { client, indexer, history, trac };
  adapter = await createAdapters({ config, store, history }); const reads = adapter.reads;
  const operations = new MintOperations({ store, reads, network: config.network });
  const mints = new Mints({ store, reads, operations, network: config.network });
  mints.provisioner = { request() { assert.fail('registered deployment must not reprovision'); } };
  const request = { owner: who.address, asset: 'p0', block: 10, amount: '1', receive: hash(address), nonce: hash('paced/' + linked), until: 115, expires: 537 };
  const body = { request, signature: rules.signRequest('rq', config.network, request, who.secret), receiver: address, payer: address, kind: 'tap' };
  body.authorization = signEd(payerDigest(config.network, body), who.secret);
  return { ...adapter, config, root, file, store, operations, mints, body, calls, state, stamp, entry };
}

test('warm production quote, request, admission, idle poll and signer refresh have fixed paced source costs', async t => {
  for (const linked of [false, true]) {
    const f = await fixture(t, linked);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const measure = async (name, run, bound) => {
      const start = f.calls.length, at = Date.now(); await finish(t, run());
      const n = f.calls.length - start, ms = f.calls.length > start ? f.calls.at(-1).at - at : 0;
      assert.ok(n <= bound, `${name}: ${n} calls`); assert.ok(ms <= bound * 500 + 250, `${name}: ${ms} ms`);
      t.diagnostic(JSON.stringify({ name, linked, calls: n, pacedMs: ms })); return n;
    };
    const input = { asset: 'p0', block: 10, kind: 'tap' };
    await measure('idleAdmission', () => f.operations.inputs({ counted: 105, last: f.stamp.last, files: [], view: { tip: block.height, tipHash: block.hash }, limit: 1 }), 0);
    await finish(t, f.mints.quote(input)); // cold verification warms immutable evidence
    await measure('quote', () => f.mints.quote(input), linked ? 9 : 7);
    f.state.reorgAtClose = true;
    await assert.rejects(finish(t, f.mints.request(f.body)), /tap_snapshot_changed/);
    assert.equal(f.store.get('mints', rules.pendingId(f.config.network, f.body.request)), null, 'failed closing stamp cannot acknowledge or persist a mint request');
    f.state.reorgAtClose = false; f.state.hash = block.hash;
    await measure('request', () => f.mints.request(f.body), linked ? 10 : 8);
    const row = f.store.get('mints', rules.pendingId(f.config.network, f.body.request));
    await finish(t, f.operations.ensure('rq/' + row.id, row.op));
    await measure('admission', async () => {
      const inputs = await f.operations.inputs({ counted: 105, last: f.stamp.last, files: [], view: { tip: block.height, tipHash: block.hash }, limit: 1 });
      assert.equal(inputs.length, 1);
    }, linked ? 10 : 8);
    const views = new PublicViews({ store: f.store, reads: f.reads, history: active.history, network: f.config.network });
    await measure('idlePoll', async () => {
      const clock = await f.pollClock(); await f.relayHeaders({ maxJobs: 256 }, clock);
      assert.deepEqual(await f.observations({ tip: block.height, hash: block.hash, counted: 105 }, clock), []);
      assert.equal((await views.status(clock)).bitcoinTip, block.height);
    }, 3);
    const gateway = agent(75), member = agent(76), evidence = new EvidenceStore({ config: { network: f.config.network, epoch: 1, member: 'one', directory: f.root },
      identity: member.secret, gateway: gateway.address, clock: () => f.reads.tip(), stamp: async () => f.stamp,
      source: { request: async (_path, { body }) => {
        const { signature, ...challenge } = body, payload = { ...challenge, observedAt: Date.now(), stamp: f.stamp, rows: [], contexts: {}, archives: {} };
        return { payload, signature: signEvidence(payload, gateway.secret) };
      } } });
    await measure('signerRefreshAndTip', () => f.reads.withAction(async () => { await evidence.refresh(); await f.reads.tip(); }), 3);
    f.state.cancelled = true;
    await assert.rejects(finish(t, f.mints.quote(input)), /privilege_cancelled/);
    assert.equal((await f.mints.request(f.body)).id, row.id, 'accepted exact retries remain available even when verification is unavailable');
    t.mock.timers.reset();
  }
});
