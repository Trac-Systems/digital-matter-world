import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { regtest } from './ord-regtest.mjs';
import { inscribe, sendInscription } from '../../local/inscriber.mjs';
import { authority, tokenMintPermit, redeem, testKey } from '../../local/protocol.mjs';
import { receiveAddress, waitIndexed } from '../../local/common.mjs';
import { harness, deployment as testDeployment } from '../../contract/tests/helpers/harness.mjs';
import { REGTEST_PARAMS, parseHeader, workFor } from '../../contract/beacon/bitcoin.js';
import { TapReader } from '../prod/tap.mjs';
import { installNamedReads } from '../prod/named-reads.mjs';
import { createBitcoin } from '../prod/bitcoin.mjs';
import { createAdapters } from '../local/adapter.mjs';
import { createReads } from '../local/reads.mjs';
import { createLocalReads } from '../../committee/signer/reads.mjs';
import { Store } from '../src/store.mjs';
import { History } from '../src/history.mjs';
import { createFeePolicy } from '../src/fees.mjs';
import { rules } from '../src/rules.mjs';
import { payerDigest } from '../src/mints.mjs';
import { agent, signEd } from './helpers.mjs';

test('gateway and committee read real TAP payments, a receiver-bound mint and reorgs through ord only', { timeout: 240000 }, async t => {
  const r = await regtest(); t.after(() => r.close());
  const ordPort = Number(new URL(r.manifest.ord.url).port), tracPort = ordPort + 1;
  const nativeFetch = globalThis.fetch, appRequests = [];
  const client = await createBitcoin({ kind: 'ord', urlFile: r.sourceFile }, { requestsPerSecond: 100 }, { network: 'regtest' });
  const genesis = parseHeader(await client.header(await client.blockHash(0)));
  const network = 'dmw-regtest-reader';
  const deployment = { ...testDeployment, network, beacon: { checkpoint: { height: 0, hash: genesis.hash, time: genesis.time, bits: genesis.bits, chainwork: workFor(genesis.bits).toString() }, params: REGTEST_PARAMS } };
  const state = harness(deployment), methods = {
    deployment: async () => deployment,
    head: () => state.state().head(),
    authority: async () => ({ committee: deployment.committee }),
    paymentUsed: async () => null,
    pending: async () => ({ s: 0 }),
    headers: async raws => { for (let i = 0; i < raws.length; i += 20) assert.equal(await state.run('hd', { headers: raws.slice(i, i + 20) }), null); return { ...await state.state().head(), accepted: parseHeader(raws.at(-1)).hash }; }
  };
  const server = createServer(async (req, res) => {
    try { const chunks = []; for await (const c of req) chunks.push(c); const { method, args } = JSON.parse(Buffer.concat(chunks)); assert.ok(methods[method], method); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result: await methods[method](...args) })); }
    catch { res.writeHead(503); res.end(JSON.stringify({ error: 'test_trac_read' })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(tracPort, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const gatewayStore = await Store.open(join(r.root, 'gateway')); t.after(() => gatewayStore.close());
  const registry = join(r.root, 'registry.json'), manifest = join(r.root, 'reader-manifest.json'), contexts = join(r.root, 'contexts');
  await mkdir(contexts); await writeFile(registry, JSON.stringify({ feePolicy: createFeePolicy('100'), assets: {} }));
  await writeFile(manifest, '{}'); // No Core endpoint or cookie is available to either reader.
  const config = { network, data: gatewayStore.directory, endpoints: { trac: `http://127.0.0.1:${tracPort}`, ethereum: `http://127.0.0.1:${tracPort+7}` }, committee: [], local: { manifest, registry, contexts, tapSourceFile: r.sourceFile, tracToken: 'test', escrow: { chainId: '31337', address: '0x' + '11'.repeat(20), token: '0x' + '22'.repeat(20) } } };
  globalThis.fetch = async (url, options) => {
    const u = new URL(url); assert.ok([ordPort, tracPort].includes(Number(u.port)), 'application attempted non-ord Bitcoin access');
    appRequests.push(u.pathname); return nativeFetch(url, options);
  };
  const adapter = await createAdapters({ config, store: gatewayStore, history: new History(gatewayStore) });
  const readConfig = join(r.root, 'committee-reader.json'); await writeFile(readConfig, JSON.stringify(config));
  const observer = await createReads({ config: readConfig, readerId: 'committee-1' });
  const committee = createLocalReads({ records: observer, indexer: observer });
  t.after(async () => { observer.close(); await adapter.close(); globalThis.fetch = nativeFetch; });
  let previous;
  const follow = async () => {
    for (let i = 0; i < 10; i++) {
      const rows = await adapter.observations(previous);
      for (const row of rows) { assert.ok(row.counted >= (previous?.counted ?? 0)); previous = row; await adapter.observed(row); }
      if (previous?.hash === (await adapter.reads.client.tip()).hash) break;
    }
    assert.equal((await committee.tip()).tipHash, previous.hash);
    const view = await observer.views.view(previous.tip, previous.hash);
    assert.equal(view.hashAt(previous.tip), previous.hash);
  };
  // Wallet/mining helpers belong only to the isolated producer. Restore the
  // guarded application transport immediately after each chain-producing step.
  const produce = async fn => { const saved = globalThis.fetch; globalThis.fetch = nativeFetch; try { return await fn(); } finally { globalThis.fetch = saved; } };
  const mine = n => produce(() => r.mine(n));
  const write = async (text, receiver = r.receiver, blocks = 1) => produce(async () => { const result = await inscribe(r.manifest, [{ text, receiver }]); if (blocks) await r.mine(blocks); return result.inscriptions[0].id; });
  const activate = async (text, receiver) => { const id = await write(text, receiver); await produce(async () => { await sendInscription(r.manifest, id, receiver); await r.mine(1); }); return id; };
  await follow();
  const plain = 'reader.[0-9].4.element', plainId = await write(plain);
  assert.equal(await observer.content(plainId), plain);
  assert.equal(await new TapReader({ sources: [client.source], agreement: 1, bitcoin: client }).content(plainId), plain);
  const key = testKey(), payer = r.receiver, receiver = await produce(() => receiveAddress(r.manifest)), treasury = await produce(() => receiveAddress(r.manifest));
  await write({ p: 'tap', op: 'token-deploy', tick: 'tap', max: '1000', dec: '18' });
  await write({ p: 'tap', op: 'token-mint', tick: 'tap', amt: '1000' });
  const auth = await activate(authority(key, { auth: ['tap'] }), payer);
  const privilege = await activate(authority(key, { privilege: true }), payer);
  const tick = 'reader-compound', tokenDeployment = await write({ p: 'tap', op: 'token-deploy', tick, max: '1000', dec: '0', prv: privilege });
  const who = agent(321), request = { owner: who.address, asset: 'c1', amount: '1', receive: rules.hash(receiver), nonce: rules.hash('reader-mint'), until: 1000, expires: 1432 };
  const id = rules.pendingId(network, request), fees = rules.mintFeeItems(rules.splitFee('1000000000000000000'), { treasury, finder: receiver }, id, payer, 'tap');
  const row = { id, request, signature: rules.signRequest('rq', network, request, who.secret), receiver, payer, kind: 'tap', quote: { fees }, paymentIds: [], context: { deployment: { id: tokenDeployment, kind: 'compound', tick, privilegePublicKey: null } } };
  row.authorization = signEd(payerDigest(network, row), who.secret);
  // ord enforces regtest address prefixes, so the fixed mainnet burn address
  // cannot execute here. Keep that quoted item missing; never substitute it.
  const payableFees = fees.filter(f => f.role !== 'burn');
  const pay = redeem(auth, [], key, { items: payableFees.map(f => ({ tick: f.ticker, amt: rules.formatTapAmount(f.amount), address: f.to, dta: f.dta })) });
  const payment = await write(pay, payer, 0); await writeFile(join(r.root, 'payment-raw.json'), JSON.stringify(await client.transaction(payment.slice(0,64)))); row.paymentIds = [payment]; await gatewayStore.put('mints', id, row); await follow();
  for (const reader of [adapter.reads, committee]) {
    const payment = await reader.mintPayment(id); assert.equal(payment.receipts.length, payableFees.length); assert.ok(payment.receipts.every(p => p.confirmations === 0)); assert.equal(rules.paymentProgress(payment.fees, payment.receipts).final, false);
  }
  await mine(1); await follow();
  await writeFile(join(r.root, 'indexed-payment.json'), JSON.stringify({fees, payload: await observer.content(payment), transfers: await observer.tap('getTransferredList/' + payment.slice(0,64) + '?offset=0&max=500'), redeems: await observer.tap('getAccountRedeemList/' + payer)}, null, 2));
  for (const reader of [adapter.reads, committee]) { const p = await reader.mintPayment(id); assert.equal(p.receipts.length, payableFees.length); assert.ok(p.receipts.every(p => p.confirmations === 1)); assert.equal(rules.paymentProgress(p.fees, p.receipts).final, false); }
  for (const reader of [adapter.reads, committee]) { const p = await reader.mintPayment(id); assert.equal(rules.paymentProgress(payableFees, p.receipts).final, true); assert.deepEqual(rules.paymentProgress(p.fees, p.receipts).missing.map(f => f.role), ['burn']); }
  const permit = tokenMintPermit({ tick, amt: '1', address: receiver, dta: id }, key);
  const { secp256k1 } = await import('../../local/node_modules/@noble/curves/secp256k1.js');
  row.context.deployment.privilegePublicKey = Buffer.from(secp256k1.getPublicKey(key)).toString('hex'); row.permit = permit;
  const mint = await write(permit, receiver, 1); row.mintInscription = mint; await gatewayStore.put('mints', id, row); await follow();
  for (const reader of [adapter.reads, committee]) { const result = await reader.mint(id); assert.equal(result.inscription, mint); assert.equal(result.receiver, receiver); assert.equal(result.confirmations, 1); }
  const namedIndexer = new TapReader({ sources: [client.source], bitcoin: client, sharedTransport: true, agreement: 1 });
  namedIndexer.history = (height, hash) => observer.views.view(height, hash);
  const named = installNamedReads({}, namedIndexer);
  await namedIndexer.at(undefined, async () => {
    assert.equal((await named.privilegeAuthority(privilege, { id: privilege, offset: 0 })).ins, privilege);
    assert.equal((await named.paymentAuthority(payer, auth, { id: auth, offset: 0 })).ins, auth);
    const transfers = await named.paymentTransfers(payment);
    assert.equal(transfers.length, payableFees.length);
    assert.deepEqual(await named.paymentTransfers(payment, transfers.map(({ index }) => ({ id: payment, offset: index }))), transfers);
    assert.equal((await named.mintedItem(mint)).ins, mint);
    assert.equal((await named.mintedItem(mint, { id: mint, offset: 0 })).ins, mint);
  });
  // Capture actual route shapes (including inscription metadata and witness tx).
  const info = await observer.inscription(mint), hash = await client.blockHash(info.height), paths = ['/r/blockheight', '/r/blockhash', '/r/blockhash/0', '/r/blockinfo/' + hash, '/block/' + hash, '/r/tx/' + mint.slice(0, 64), '/inscription/' + mint];
  const captured = Object.fromEntries(await Promise.all(paths.map(async path => [path, await client.source.request(path)])));
  captured['/content/' + mint] = await client.source.request('/content/' + mint, { format: 'rawText' });
  captured['/content/' + plainId] = await client.source.request('/content/' + plainId, { format: 'rawText' });
  await writeFile(join(r.root, 'captured-routes.json'), JSON.stringify(captured, null, 2));
  assert.equal((await client.rawBlock(hash)).toString('hex'), await produce(() => r.rpc('getblock', [hash, 0])));
  const old = { ...previous }, orphan = hash;
  await produce(async () => { await r.rpc('invalidateblock', [orphan]); for (let n = 0; n < 7; n++) await r.rpc('generateblock', [r.manifest.bitcoin.miningAddress, []]); await waitIndexed(r.manifest); });
  await follow(); assert.notEqual(previous.hash, old.hash); assert.ok(previous.counted >= old.counted);
  await namedIndexer.at(undefined, async () => {
    const currentMint = await named.mintedItem(mint);
    if (currentMint) assert.notEqual((await observer.included(mint)).blockHash, orphan);
  });
  for (const reader of [adapter.reads, observer]) assert.equal(await reader.included(mint, { tip: old.tip, tipHash: old.hash, height: old.counted }), null);
  // ord may re-index the same revealed mint if the producer re-mines it; either
  // outcome must be proved on the new branch, never on the previous one.
  for (const reader of [adapter.reads, committee]) { const result = await reader.mint(id); if (result) { const inclusion = await observer.included(result.inscription); assert.ok(inclusion); assert.notEqual(inclusion.blockHash, orphan); } }
  assert.ok(appRequests.some(p => p.startsWith('/r/blockinfo/')) && appRequests.some(p => p.startsWith('/r/tx/')) && appRequests.some(p => p.startsWith('/block/')));
  await writeFile(join(r.root, 'results.json'), JSON.stringify({ payment, mint, serviceAndCommittee: true, mempool: true, finality: 1, reorg: true, appBitcoinTransport: 'ord-only', limitation: 'regtest rejects the fixed mainnet burn address; the full quote correctly remains partly paid'  }, null, 2));
  console.log('ord integration evidence: ' + r.root);
});
