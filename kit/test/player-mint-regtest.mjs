// Explicit integration check: isolated regtest + ord-tap + a fixture of the
// player mint API. The fixture pays a subset of the fee items as address
// transfers; the full fee split is covered by the playground rehearsal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm, rmdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { chromium } from 'playwright';
import { createWallet, wipeWallet, publicAddress } from '../lib/keyring.mjs';
import { localBitcoinWallet } from '../lib/bitcoin-wallet.mjs';
import { PlayerMint } from '../lib/player-mint.mjs';
import { runTool } from '../lib/tools.mjs';
import { Journal } from '../lib/journal.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { buildInscription, signCommit, hex, unhex, networkFor, transferItems } from '../lib/inscription-core.mjs';
import { authority, tokenMintPermit, redeem, sha256 } from '../../local/protocol.mjs';

import { tapPaymentLock, splitFee, TAP_BURN } from '../../rules/src/index.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const ports = { bitcoin: 59730, ord: 59731, web: 59732, cdp: 9481 };
const origin = `http://127.0.0.1:${ports.web}`, net = networkFor('regtest');
const until = async (fn, label, ms = 30000) => {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await sleep(150); }
  throw Error(`Timed out: ${label}${last ? ': ' + last.message : ''}`);
};

test('isolated fresh browser wallet activates authority, pays fees, inscribes mints, and verifies native lock burns', { timeout: 240000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dmw-player-mint-')), children = [], wallets = [], journals = [];
  let server, browser, browserLocked = false;
  const browserLock = join(root, '.local/browser.lock');
  t.after(async () => {
    await browser?.close();
    if (browserLocked) await rmdir(browserLock);
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const journal of journals) journal.close();
    for (const child of children.toReversed()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
      await ended; clearTimeout(timeout);
    }
    for (const wallet of wallets) { wallet.local.close(); wipeWallet(wallet.trac); wallet.key.fill(0); }
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(directory, 'bitcoin')); await mkdir(join(directory, 'ord'));
  async function launch(command, args, name) {
    const log = await open(join(directory, name + '.log'), 'w', 0o600);
    const child = spawn(command, args, { stdio: ['ignore', log.fd, log.fd] }); children.push(child);
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); await log.close();
  }
  await launch(process.env.DMW_BITCOIND ?? 'bitcoind', [`-datadir=${directory}/bitcoin`, '-regtest', '-server=1', '-txindex=1', '-listen=0', '-discover=0', '-dnsseed=0', '-fixedseeds=0', '-connect=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${ports.bitcoin}`, '-fallbackfee=0.00001', '-printtoconsole=0'], 'bitcoin');
  async function rpc(method, params = [], wallet = '') {
    const cookie = (await readFile(join(directory, 'bitcoin/regtest/.cookie'), 'utf8')).trim();
    const response = await fetch(`http://127.0.0.1:${ports.bitcoin}${wallet ? '/wallet/' + wallet : ''}`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(cookie).toString('base64'), 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const data = await response.json(); if (data.error) throw Object.assign(Error(method + ': ' + data.error.message), { code: data.error.code }); return data.result;
  }
  await until(() => rpc('getblockchaininfo'), 'own Bitcoin node');
  assert.equal((await rpc('getblockchaininfo')).chain, 'regtest');
  await rpc('createwallet', ['faucet']);
  const mining = await rpc('getnewaddress', ['', 'bech32m'], 'faucet');
  await rpc('generatetoaddress', [110, mining]);
  const ord = process.env.DMW_ORD ?? 'ord';
  await launch(ord, ['--regtest', '--bitcoin-data-dir', join(directory, 'bitcoin'), '--bitcoin-rpc-url', `http://127.0.0.1:${ports.bitcoin}`, '--data-dir', join(directory, 'ord'), '--index', join(directory, 'ord/index.redb'), '--index-addresses', '--index-sats', 'server', '--http', '--address', '127.0.0.1', '--http-port', String(ports.ord), '--polling-interval', '100ms'], 'ord');
  const tap = async path => {
    const response = await fetch(`http://127.0.0.1:${ports.ord}/r/tap/${path}`, { headers: { accept: 'application/json' } });
    assert.ok(response.ok, `TAP read ${path}: ${response.status}`); return (await response.json()).result;
  };
  const indexed = async () => { const height = await rpc('getblockcount'); await until(async () => Number(await tap('getCurrentBlock')) >= height, 'own TAP indexer'); };
  const mine = async (n = 1) => { await rpc('generatetoaddress', [n, mining]); await indexed(); };
  await indexed();
  async function player(name) {
    const trac = await createWallet(), seed = mnemonicToSeedSync(trac.mnemonic), hd = HDKey.fromMasterSeed(seed), child = hd.derive("m/86'/1'/0'/0/0"), key = child.privateKey.slice();
    seed.fill(0); child.wipePrivateData(); hd.wipePrivateData();
    const funding = new Map(); let local;
    const source = {
      async utxos(address) {
        const list = [];
        for (const coin of funding.values()) {
          const output = await rpc('gettxout', [coin.txid, coin.vout]);
          if (output?.confirmations > 0) list.push({ ...coin, confirmed: true, cardinal: true });
        }
        return list;
      },
      feeRate: async () => 2,
      async broadcast(raw, txid) {
        try { assert.equal(await rpc('sendrawtransaction', [raw]), txid); }
        catch (error) { if (!/already|in block chain/.test(error.message)) throw error; }
        const tx = btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true });
        if (tx.outputsLength === 2 && hex(tx.getOutput(1).script) === hex(btc.p2tr(schnorr.getPublicKey(key)).script)) {
          const out = tx.getOutput(1); funding.set(`${txid}:1`, { txid, vout: 1, value: String(out.amount), script: hex(out.script) });
        }
        return txid;
      },
    };
    local = localBitcoinWallet({ wallet: trac, network: 'regtest', source });
    const txid = await rpc('sendtoaddress', [local.address, 0.01], 'faucet'); await mine();
    const tx = await rpc('getrawtransaction', [txid, true]);
    const out = tx.vout.find(o => o.scriptPubKey.address === local.address);
    funding.set(`${txid}:${out.n}`, { txid, vout: out.n, value: String(Math.round(out.value * 1e8)), script: out.scriptPubKey.hex });
    const result = { name, trac, key, local, source }; wallets.push(result); return result;
  }
  const kit = await player('kit'), web = await player('web'), committee = await player('fixture-committee');
  const write = async (who, payload, { receiver = who.local.address, postage = 1000 } = {}) => {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const plan = who.local.signCommit(buildInscription({ text, receiver, publicKey: who.local.publicKey, network: 'regtest', utxos: await who.source.utxos(), feeRate: 2, maxFeeSats: '100000', postage }));
    await who.source.broadcast(plan.commitHex, plan.commitTxid); await who.source.broadcast(plan.revealHex, plan.revealTxid); await mine();
    return plan.inscriptionId;
  };
  const selfSend = async (who, id) => {
    const input = await rpc('gettxout', [id.slice(0, 64), 0]);
    const tx = new btc.Transaction();
    tx.addInput({ txid: id.slice(0, 64), index: 0, witnessUtxo: { script: unhex(input.scriptPubKey.hex), amount: 1000n }, tapInternalKey: schnorr.getPublicKey(who.key) });
    tx.addOutputAddress(who.local.address, 700n, net); tx.sign(who.key); tx.finalize();
    await rpc('sendrawtransaction', [tx.hex]); await mine(); return tx.id;
  };
  const activate = async (who, payload) => { const id = await write(who, payload); await selfSend(who, id); return id; };
  const privilege = await activate(committee, authority(committee.key, { privilege: true }));
  assert.ok((await tap('getPrivilegeAuthList')).some(a => a.ins === privilege));
  await write(committee, { p: 'tap', op: 'token-deploy', tick: 'tap', max: '1000', dec: '18' });
  for (const who of [kit, web]) {
    await write(who, { p: 'tap', op: 'token-mint', tick: 'tap', amt: '100' });
    if (who === web) continue; // The browser must onboard a fresh global authority.
    const auth = await activate(who, authority(who.key));
    who.local.close(); who.local = localBitcoinWallet({ wallet: who.trac, network: 'regtest', source: who.source, authority: auth });
    assert.ok((await tap(`getAccountAuthList/${who.local.address}`)).some(a => a.ins === auth));
  }
  const asset = 'cmintproof', tick = `dmw${asset}`;
  // The first player deploys the compound with the fixture committee authority.
  const deployPayload = { p: 'tap', op: 'token-deploy', tick, max: '1000', dec: '0', prv: privilege };
  const deployJob = { asset, kind: 'compound', state: 'awaiting_player_deploy', phase: 'deployment', tickerAttempt: 0,
    definition: { firstMaker: publicAddress(kit.trac) }, content: deployPayload, inscriptionText: JSON.stringify(deployPayload),
    attempts: [{ phase: 'deployment', attempt: 0, id: 'd'.repeat(64), text: deployPayload }] };
  const webAsset = 'cwebproof', webDeployPayload = { ...deployPayload, tick: 'dmwcwebproof' };
  const webDeployJob = { ...deployJob, asset: webAsset, definition: { firstMaker: publicAddress(web.trac) }, content: webDeployPayload,
    inscriptionText: JSON.stringify(webDeployPayload), attempts: [{ phase: 'deployment', attempt: 0, id: 'e'.repeat(64), text: webDeployPayload }] };
  const deploymentJobs = new Map([[asset, deployJob], [webAsset, webDeployJob]]);
  let deployId;
  const statuses = new Map(), consumed = new Map();
  for (const [who, n] of [[kit, 1], [web, 2]]) {
    const id = String(n).repeat(64), fee = { role: 'treasury', to: committee.local.address, ticker: 'tap', amount: '1000000000000000000', tt: 'a', dta: `dmw-pay-v2|${id}|treasury` };
    who.id = id; statuses.set(id, { requestId: id, receiver: who.local.address, payer: who.local.address, asset, actualTicker: tick, amount: String(n + 1), fees: [fee], missing: [fee], payBy: { rail: 'tap', untilBlock: 1000 }, state: 'awaiting_payment' });
  }
  async function statusFor(id) {
    const row = statuses.get(id); assert.ok(row, 'fixture request exists');
    const height = await rpc('getblockcount');
    const transfers = await tap(`getAccountSentList/${row.receiver}/tap`);
    const receipt = transfers.find(r => r.dta === row.fees[0].dta && !r.fail && r.taddr === committee.local.address && r.amt === row.fees[0].amount);
    if (receipt) {
      row.state = 'partly_paid';
      if (height - receipt.blck + 1 >= 1) {
        row.missing = []; row.state = 'permit_issued';
        if (!row.mintContent) {
          consumed.set(id, (consumed.get(id) ?? 0) + 1);
          row.mintContent = tokenMintPermit({ tick, amt: row.amount, address: row.receiver, dta: id }, committee.key);
        }
      }
    }
    const minted = (await tap(`getTickerMintList/${tick}`)).find(r => r.dta === id && !r.fail && r.addr === row.receiver);
    if (minted) { row.state = 'minted'; row.inscription = minted.ins; }
    return structuredClone(row);
  }
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin), match = /^(?:\/api\/gateway)?\/mint\/([0-9a-f]{64})$/.exec(url.pathname);
      const requestedJob = deploymentJobs.get(url.pathname.replace(/^\/(?:api\/gateway\/)?mint\/deployment\//, ''));
      if (requestedJob) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(requestedJob)); return; }
      const boundPlayer = [kit, web].find(w => url.pathname.replace(/^\/api\/gateway/, '') === `/payout-bindings/${publicAddress(w.trac)}/tap`);
      if (boundPlayer) {
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ binding: { request: { agent: publicAddress(boundPlayer.trac), address: boundPlayer.local.address } } })); return;
      }
      if (req.method === 'POST' && url.pathname === '/mint/deployment') {
        let body = ''; for await (const chunk of req) body += chunk; const value = JSON.parse(body);
        const job = deploymentJobs.get(value.asset), who = value.asset === asset ? kit : web; assert.ok(job); assert.equal(value.phase, 'deployment');
        const tx = await rpc('getrawtransaction', [value.inscription.slice(0, 64), true]);
        if ((tx.confirmations ?? 0) < 1) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'deployment_confirmations' })); return; }
        assert.equal((await tap(`getDeployment/${job.content.tick}`)).ins, value.inscription); assert.equal(tx.vout[0].scriptPubKey.address, who.local.address);
        Object.assign(job, { state: 'registered', entry: { id: value.inscription } });
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(job)); return;
      }
      if (req.method === 'POST' && url.pathname === '/mint/payment') {
        let body = ''; for await (const chunk of req) body += chunk; const { id, paymentId } = JSON.parse(body);
        assert.match(paymentId, /^[0-9a-f]{64}i0$/); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(await statusFor(id))); return;
      }
      const checkout = /^(?:\/api\/gateway)?\/web-api\/mint\/([0-9a-f]{64})$/.exec(url.pathname);
      if (checkout) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(await statusFor(checkout[1]))); return; }
      if (match) { const { payer, ...publicStatus } = await statusFor(match[1]); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(publicStatus)); return; }
      if (req.method === 'POST' && url.pathname === '/mint/quote') {
        let body = ''; for await (const chunk of req) body += chunk;
        const { requestId } = JSON.parse(body); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(await statusFor(requestId))); return;
      }
      if (['/', '/deployment'].includes(url.pathname)) {
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><html><body><script type="module">import { playerMintFlow } from "/js/inscribe/flow.js"; import {store} from "/js/api.js"; store.player={address:"' + publicAddress(web.trac) + '"}; playerMintFlow(' + JSON.stringify(url.pathname === '/deployment' ? { asset: webAsset, compound: true } : { id: web.id }) + ');</script></body></html>'); return;
      }
      if (url.pathname === '/rules/src/trac-address.js') { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(join(root, 'rules/src/trac-address.js'))); return; }
      const path = resolve(root, 'playground/console', '.' + url.pathname);
      assert.ok(path.startsWith(join(root, 'playground/console') + '/'));
      res.setHeader('content-type', extname(path) === '.js' ? 'text/javascript' : 'text/plain'); res.end(await readFile(path));
    } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ports.web, '127.0.0.1', resolve); });
  const service = new ServiceClient({ origin, network: 'player-mint-regtest-fixture' });
  const journal = await Journal.open(join(directory, 'kit-journal'), 'kit'); journals.push(journal);
  let client = new PlayerMint({ service, journal, wallet: kit.local, owner: publicAddress(kit.trac) });
  assert.equal((await client.deploy({ asset, maxFeeSats: '100000' })).state, 'dry-run');
  client.dryRun = false;
  const deployment = await client.deploy({ asset, maxFeeSats: '100000' }); deployId = deployment.inscriptionId;
  assert.equal(deployment.deploymentState, 'awaiting_verification'); await mine();
  assert.equal((await client.deploy({ asset, maxFeeSats: '100000' })).deploymentState, 'registered');
  assert.equal((await tap(`getDeployment/${tick}`)).prv, privilege);
  assert.equal((await service.quote({ requestId: kit.id })).state, 'awaiting_payment');
  client.dryRun = true;
  assert.equal((await client.pay({ id: kit.id, maxFeeSats: '100000' })).state, 'dry-run');
  assert.equal((await rpc('getrawmempool')).length, 0);
  client.dryRun = false;
  const payment = await client.pay({ id: kit.id, maxFeeSats: '100000' }); await mine();
  const kitReady = await client.poll(kit.id, { timeoutMs: 1000, intervalMs: 100 });
  assert.equal(kitReady.state, 'permit_issued');
  const made = await client.inscribe({ id: kit.id, maxFeeSats: '100000' }); await mine();
  assert.equal((await client.status(kit.id)).state, 'minted');
  assert.equal(await tap(`getBalance/${kit.local.address}/${tick}`), '2');
  assert.equal(consumed.get(kit.id), 1);
  t.diagnostic('Kit player: real TAP payment indexed, fixture permit issued, player commit/reveal indexed.');

  const lockDeadline = Date.now() + 120000;
  while (!browserLocked) {
    try { await mkdir(browserLock); browserLocked = true; }
    catch (error) { if (error.code !== 'EEXIST' || Date.now() >= lockDeadline) throw error; t.diagnostic('Waiting for the shared browser lock.'); await sleep(30000); }
  }
  browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${ports.cdp}`, '--remote-debugging-address=127.0.0.1'] });
  const page = await browser.newPage(); let paymentCalls = 0, psbtSigns = 0, pushes = 0, loseRevealReply = false;
  const pushedReveals = []; let deferredPayment, webAuthority;
  await page.exposeBinding('walletCall', async (_, method, args) => {
    if (method === 'requestAccounts' || method === 'getAccounts') return [web.local.address];
    if (method === 'getNetwork') return 'regtest';
    if (method === 'getCurrentAuthority') return (await tap(`getAccountAuthList/${web.local.address}`)).find(a => a.auth.length === 0) ?? null;
    if (method === 'getAuthorityStatus') return { currentAuthority: null, readyToTap: null, pendingAuthority: null };
    if (method === 'getPublicKey') return hex(secp256k1.getPublicKey(web.key, true));
    if (method === 'createGlobalTapAuthority') {
      webAuthority = await write(web, authority(web.key));
      const reveal = await rpc('getrawtransaction', [webAuthority.slice(0, 64), true]);
      return { orderId: 'fixture-authority', paymentTxid: reveal.vin[0].txid, txid: webAuthority.slice(0, 64), inscriptionId: webAuthority, pending: false };
    }
    if (method === 'getInscriptions') return { list: webAuthority ? [{ inscriptionId: webAuthority }] : [], total: webAuthority ? 1 : 0 };
    if (method === 'sendInscription') {
      assert.deepEqual(args, [web.local.address, webAuthority]);
      const txid = await selfSend(web, webAuthority);
      web.local.close(); web.local = localBitcoinWallet({ wallet: web.trac, network: 'regtest', source: web.source, authority: webAuthority });
      return txid;
    }
    if (method === 'getBitcoinUtxos') return (await web.source.utxos()).map(c => ({ txid: c.txid, vout: c.vout, satoshi: Number(c.value), scriptPk: c.script, height: 1, inscriptions: [], isSpent: false }));
    if (method === 'singleTxTransfer') {
      paymentCalls++; assert.deepEqual(args[0], transferItems(await statusFor(web.id)));
      assert.ok((await tap(`getAccountAuthList/${web.local.address}`)).some(a => a.auth.length === 0), 'No authority found');
      const payload = web.local.redeem(await statusFor(web.id));
      const plan = web.local.signCommit(buildInscription({ text: typeof payload === 'string' ? payload : JSON.stringify(payload), receiver: web.local.address, publicKey: web.local.publicKey, network: 'regtest', utxos: await web.source.utxos(), feeRate: 2, maxFeeSats: '100000' }));
      await web.source.broadcast(plan.commitHex, plan.commitTxid);
      deferredPayment = plan;
      return { txid: plan.commitTxid };
    }
    if (method === 'signPsbt') {
      psbtSigns++; const tx = btc.Transaction.fromPSBT(unhex(args[0]));
      assert.deepEqual(args[1], { autoFinalized: true, inputForSigns: Array.from({ length: tx.inputsLength }, (_, index) => ({ index, address: web.local.address })) });
      tx.sign(web.key); tx.finalize(); return hex(tx.toPSBT(0));
    }
    if (method === 'pushPsbt' || method === 'pushTx') {
      pushes++; const tx = method === 'pushPsbt' ? btc.Transaction.fromPSBT(unhex(args[0])) : btc.Transaction.fromRaw(unhex(args[0]), { allowUnknownInputs: true });
      const result = await web.source.broadcast(tx.hex, tx.id);
      if (method === 'pushTx') {
        pushedReveals.push(result);
        if (loseRevealReply) { loseRevealReply = false; throw Error('Simulated lost reveal reply'); }
      }
      return result;
    }
    throw Error('Unsupported provider method: ' + method);
  });
  await page.addInitScript(() => {
    window.tapprotocol = Object.fromEntries(['requestAccounts', 'getAccounts', 'getNetwork', 'getPublicKey', 'getBitcoinUtxos', 'singleTxTransfer', 'signPsbt', 'pushPsbt', 'pushTx', 'getCurrentAuthority', 'getAuthorityStatus', 'createGlobalTapAuthority', 'getTapActionOrderResult', 'getInscriptions', 'sendInscription'].map(method => [method, (...args) => window.walletCall(method, args)]));
  });
  await page.route('https://mempool.space/api/v1/fees/recommended', route => route.fulfill({ json: { halfHourFee: 2 } }));
  await page.goto(origin + '/deployment');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Connect wallet and get quote', exact: true }).click();
  await page.getByRole('button', { name: 'Inscribe compound deploy', exact: true }).click();
  await page.getByRole('button', { name: 'Inscribe', exact: true }).click();
  await until(() => pushes === 2, 'browser compound commit and reveal'); await mine();
  const webDeployId = pushedReveals[0] + 'i0';
  const registered = await runTool({ agent: { service, address: publicAddress(web.trac), dryRun: false } }, 'register_deployment', { asset: webAsset, inscription: webDeployId });
  assert.equal(registered.state, 'registered'); assert.equal((await tap('getDeployment/dmwcwebproof')).prv, privilege);
  await page.goto(origin); await page.getByRole('button', { name: 'Pay missing items', exact: true }).click();
  await page.getByRole('button', { name: 'Pay from my wallet', exact: true }).click();
  await until(() => !!deferredPayment, 'browser wallet funding response');
  assert.equal((await statusFor(web.id)).state, 'awaiting_payment');
  await web.source.broadcast(deferredPayment.revealHex, deferredPayment.revealTxid); await mine();
  await until(async () => (await statusFor(web.id)).state === 'permit_issued', 'indexed browser fee item and permanent permit');
  await mine(5);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Inscribe mint', exact: true }).click();
  await page.waitForTimeout(500);
  const errors = await page.locator('.note.bad').allTextContents();
  assert.deepEqual(errors, [], 'browser inscription preparation: ' + errors.join('; '));
  loseRevealReply = true;
  await page.getByRole('button', { name: 'Inscribe', exact: true }).click();
  await page.getByText('Simulated lost reveal reply', { exact: true }).waitFor();
  assert.equal(pushes, 4);
  await page.reload();
  await page.getByRole('button', { name: 'Inscribe mint', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await until(() => pushes === 6, 'browser resumes same commit and reveal');
  assert.equal(pushedReveals[1], pushedReveals[2]); await mine();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('Minted on Bitcoin', { exact: true }).waitFor();
  assert.equal(await tap(`getBalance/${web.local.address}/${tick}`), '3');
  assert.equal(paymentCalls, 1); assert.equal(psbtSigns, 2); assert.equal(consumed.get(web.id), 1);
  await page.reload(); await page.getByText('Minted on Bitcoin', { exact: true }).waitFor();
  assert.equal(paymentCalls, 1); assert.equal(psbtSigns, 2);
  await browser.close(); browser = null; await rmdir(browserLock); browserLocked = false;
  assert.equal((await rpc('getnetworkinfo')).connections, 0);
  // Native burn allocations use ord-tap's canonical literal even on regtest.
  const kitAuth = (await tap(`getAccountAuthList/${kit.local.address}`)).find(a => a.auth.length === 0).ins;
  const preimage = '31'.repeat(32), hash = sha256(Buffer.from(preimage, 'hex'));
  const lock = tapPaymentLock({ split: splitFee('2000000000000000000', { kind: 'link' }), destinations: { treasury: committee.local.address }, payer: kit.local.address, hash, expiry: (await rpc('getblockcount')) + 100, kind: 'link', bitcoinNetwork: 'regtest' });
  assert.equal(lock.al[0].to, TAP_BURN);
  const lockInscription = await write(kit, redeem(kitAuth, [lock], kit.key, { data: 'link-proof' }));
  assert.ok(await tap('getLock/' + lockInscription + ':0'), 'ord-tap accepts the global authority and native burn lock');
  const claim = await write(kit, redeem(kitAuth, [{ op: 'claim', lock: lockInscription + ':0', preimage }], kit.key));
  const consumedLock = await tap('getLockConsume/' + lockInscription + ':0');
  assert.equal(consumedLock.ins, claim); assert.equal(consumedLock.action, 'claim');
  assert.equal(consumedLock.al[0].to, TAP_BURN);
  const proof = { fixture: 'player mint API; fresh global authority; deferred address fee items; native lock burn and claim; real regtest indexing',
    compoundDeploy: deployId, kit: { payment: payment.inscriptionId, mint: made.inscriptionId, units: '2' },
    web: { compoundDeploy: webDeployId, recoveredLostRevealReply: true, mint: (await statusFor(web.id)).inscription, units: '3', paymentCalls, psbtSigns }, processesStoppedByTestCleanup: true };
  t.diagnostic(JSON.stringify(proof));
});
