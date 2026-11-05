// Isolated Bitcoin + ord-tap acceptance, following kit/test/player-mint-regtest.
// The committee API is a fixture; TAP payments, signatures and mint indexing are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, open, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { authority, tokenMintPermit, redeem } from '../../local/protocol.mjs';
import { buildInscription, signCommit, hex, unhex, networkFor, transferItems } from '../../kit/lib/inscription-core.mjs';
import { requestKey, btc, fundingQuote } from '../src/mint-sender-keys.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { senderKeyId, senderToken, MintSenderView, readSenderJSON } from '../src/mint-sender-view.mjs';
import { SenderHTTP, MintSenderBitcoin } from '../src/mint-sender-source.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)), net = networkFor('regtest');
async function until(fn, label, ms = 45000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { try { if (await fn()) return; } catch {} await sleep(100); }
  throw Error('regtest_timeout_' + label);
}
async function freePort() {
  const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port;
  await new Promise(r => s.close(r)); return p;
}
test('one payment approval funds the order and set-aside; independent server mint is accepted by TAP', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(root, '.mb1-regtest-')), children = [], keys = [];
  let api, view;
  t.after(async () => {
    try {
      view?.close();
      if (api) { api.closeAllConnections(); await new Promise(r => api.close(r)); }
      for (const child of children.toReversed()) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const ended = new Promise(r => child.once('exit', r)); child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await ended; clearTimeout(timer);
      }
    } finally { for (const key of keys) key.fill(0); await rm(directory, { recursive: true, force: true }); }
  });
  await mkdir(join(directory, 'bitcoin')); await mkdir(join(directory, 'ord'));
  const bitcoinPort = await freePort(), ordPort = await freePort();
  async function launch(command, args, label, env = process.env) {
    const log = await open(join(directory, label + '.log'), 'w', 0o600);
    const child = spawn(command, args, { env, stdio: ['ignore', log.fd, log.fd] }); children.push(child);
    try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }
    finally { await log.close(); }
    return child;
  }
  await launch(process.env.DMW_BITCOIND ?? 'bitcoind', [`-datadir=${directory}/bitcoin`, '-regtest', '-server=1', '-txindex=1', '-listen=0', '-discover=0', '-dnsseed=0', '-fixedseeds=0', '-connect=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${bitcoinPort}`, '-fallbackfee=0.00001', '-printtoconsole=0'], 'bitcoin');
  async function rpc(method, params = [], wallet = '') {
    const cookie = (await readFile(join(directory, 'bitcoin/regtest/.cookie'), 'utf8')).trim();
    const res = await fetch(`http://127.0.0.1:${bitcoinPort}${wallet ? '/wallet/' + wallet : ''}`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(cookie).toString('base64'), 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
    const data = await res.json(); if (data.error) throw Object.assign(Error('regtest_rpc_' + method + '_' + data.error.code), { rpcCode: data.error.code }); return data.result;
  }
  await until(() => rpc('getblockchaininfo'), 'bitcoin'); assert.equal((await rpc('getblockchaininfo')).chain, 'regtest');
  await rpc('createwallet', ['faucet']); const mining = await rpc('getnewaddress', ['', 'bech32m'], 'faucet');
  await rpc('generatetoaddress', [110, mining]);
  await launch(process.env.DMW_ORD ?? 'ord', ['--regtest', '--bitcoin-data-dir', join(directory, 'bitcoin'), '--bitcoin-rpc-url', `http://127.0.0.1:${bitcoinPort}`, '--data-dir', join(directory, 'ord'), '--index', join(directory, 'ord/index.redb'), '--index-addresses', '--index-sats', 'server', '--http', '--address', '127.0.0.1', '--http-port', String(ordPort), '--polling-interval', '100ms'], 'ord');
  async function tap(path) {
    const res = await fetch(`http://127.0.0.1:${ordPort}/r/tap/${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    assert.ok(res.ok); return (await res.json()).result;
  }
  const indexed = async () => { const h = await rpc('getblockcount'); await until(async () => Number(await tap('getCurrentBlock')) >= h, 'indexer'); };
  const mine = async (n = 1) => { await rpc('generatetoaddress', [n, mining]); await indexed(); };
  await indexed();
  const seed = randomBytes(32); keys.push(seed);
  function wallet(id) { const k = requestKey(seed, id, 'regtest'); keys.push(k.privateKey); return { ...k, coins: new Map() }; }
  const payer = wallet('11'.repeat(32)), committee = wallet('22'.repeat(32)), order = wallet('33'.repeat(32));
  const coinFrom = (tx, vout) => ({ txid: tx.id, vout, value: String(tx.getOutput(vout).amount), script: hex(tx.getOutput(vout).script), cardinal: true, confirmed: true });
  for (const who of [payer, committee]) {
    const id = await rpc('sendtoaddress', [who.address, 0.02], 'faucet'); await mine();
    const tx = btc.Transaction.fromRaw(unhex(await rpc('getrawtransaction', [id])));
    const script = hex(btc.p2tr(unhex(who.publicKey).slice(1), undefined, net).script);
    for (let n = 0; n < tx.outputsLength; n++) if (hex(tx.getOutput(n).script) === script) who.coins.set(`${id}:${n}`, coinFrom(tx, n));
  }
  async function utxos(who) {
    const result = []; for (const coin of who.coins.values()) { const out = await rpc('gettxout', [coin.txid, coin.vout]); if (out) result.push({ ...coin, confirmed: out.confirmations > 0 }); } return result;
  }
  async function push(raw, id, who) {
    try { assert.equal(await rpc('sendrawtransaction', [raw]), id); } catch (error) { if (error.rpcCode !== -27) throw error; }
    const tx = btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true });
    if (who) for (let i = 0; i < tx.outputsLength; i++) if (hex(tx.getOutput(i).script) === hex(btc.p2tr(unhex(who.publicKey).slice(1)).script)) who.coins.set(`${id}:${i}`, coinFrom(tx, i));
  }
  async function write(who, payload, receiver = who.address) {
    const plan = signCommit(buildInscription({ text: JSON.stringify(payload), receiver, publicKey: who.publicKey, network: 'regtest', utxos: await utxos(who), feeRate: 2, maxFeeSats: '100000', postage: 1000 }), who.privateKey);
    await push(plan.commitHex, plan.commitTxid, who); await push(plan.revealHex, plan.revealTxid); await mine(); return plan.inscriptionId;
  }
  async function activate(who, privileged = false) {
    const ins = await write(who, authority(who.privateKey, { privilege: privileged }));
    const tx = new btc.Transaction(); tx.addInput({ txid: ins.slice(0, 64), index: 0, witnessUtxo: { script: btc.p2tr(unhex(who.publicKey).slice(1)).script, amount: 1000n }, tapInternalKey: unhex(who.publicKey).slice(1) });
    tx.addOutputAddress(who.address, 700n, net); tx.sign(who.privateKey); tx.finalize(); await push(tx.hex, tx.id); await mine(); return ins;
  }
  const privilege = await activate(committee, true);
  await write(committee, { p: 'tap', op: 'token-deploy', tick: 'tap', max: '1000', dec: '18' });
  await write(payer, { p: 'tap', op: 'token-mint', tick: 'tap', amt: '100' });
  const auth = await activate(payer);
  assert.ok((await tap('getPrivilegeAuthList')).some(a => a.ins === privilege));
  assert.ok((await tap('getAccountAuthList/' + payer.address)).some(a => a.ins === auth));
  const tick = 'dmwservermint';
  await write(committee, { p: 'tap', op: 'token-deploy', tick, max: '1000', dec: '0', prv: privilege });
  const id = 'aa'.repeat(32), settings = mintSenderSettings({ enabled: true, directory: join(directory, 'sender'), seedFile: join(directory, 'seed'), bitcoinApiUrlFile: join(directory, 'bitcoin.url'), bitcoinApiPath: '', pollMs: 50, fundingPollMs: 50, healthMs: 500 });
  const funding = fundingQuote(seed, id, 'regtest', settings), keyId = senderKeyId(seed, 'regtest'), token = senderToken(seed, 'regtest');
  const fee = { role: 'treasury', to: committee.address, ticker: 'tap', amount: '1000000000000000000', tt: 'a', dta: `dmw-pay-v2|${id}|treasury` };
  const deployer = { ...fee, role: 'deployer', to: order.address, amount: '50000000000000000', dta: `dmw-pay-v2|${id}|deployer` }, fees = [fee, deployer];
  let permit, reported, extraCoin, approvals = 0, mintBroadcasts = 0;
  async function status() {
    const receipts = await tap('getAccountSentList/' + payer.address + '/tap');
    const paid = fees.every(f => receipts.some(r => r.dta === f.dta && !r.fail && r.taddr === f.to && r.amt === f.amount));
    if (paid && !permit) permit = tokenMintPermit({ tick, amt: '2', address: payer.address, dta: id }, committee.privateKey);
    const minted = reported && (await tap('getTickerMintList/' + tick)).find(r => r.ins === reported && r.dta === id && !r.fail && r.addr === payer.address);
    return { requestId: id, receiver: payer.address, payer: payer.address, fees, missing: paid ? [] : fees, amount: '2', actualTicker: tick,
      state: minted ? 'minted' : paid ? 'permit_issued' : 'awaiting_payment', payBy: { rail: 'tap', untilBlock: 10000 },
      payable: !paid, ...(permit ? { mintContent: permit } : {}), ...(reported ? { sentInscription: reported } : {}), ...(minted ? { inscription: reported } : {}) };
  }
  api = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname; let data, text = false;
      if (path === '/internal/mint-sender/requests') {
        assert.equal(req.headers.authorization, 'Bearer ' + token);
        data = { keyId, rows: [{ ...await status(), counted: await rpc('getblockcount'), fundingAddress: funding.address }], next: null };
      } else if (path === '/mint/' + id) data = await status();
      else if (path === '/mint/payment' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk; const input = JSON.parse(body);
        assert.equal(input.id, id); assert.match(input.inscription, /^[0-9a-f]{64}i0$/); assert.ok(permit);
        reported = input.inscription; data = await status();
      } else if (path === '/block-height/0') { data = await rpc('getblockhash', [0]); text = true; }
      else if (path === '/fee-estimates') data = { 3: 2 };
      else if (path === '/address/' + funding.address + '/utxo') {
        const out = extraCoin && await rpc('gettxout', [extraCoin.txid, extraCoin.vout]);
        data = out ? [{ txid: extraCoin.txid, vout: extraCoin.vout, value: Number(extraCoin.value), status: { confirmed: out.confirmations > 0 } }] : [];
      } else if (path === '/tx' && req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk; data = await rpc('sendrawtransaction', [raw]); text = true; mintBroadcasts++;
      } else if (/^\/tx\/[0-9a-f]{64}\/hex$/.test(path)) { data = await rpc('getrawtransaction', [path.split('/')[2]]); text = true; }
      else if (/^\/tx\/[0-9a-f]{64}$/.test(path)) {
        try { const tx = await rpc('getrawtransaction', [path.slice(4), true]); data = { txid: tx.txid, status: { confirmed: (tx.confirmations ?? 0) > 0 } }; }
        catch (e) { if (e.rpcCode !== -5) throw e; res.writeHead(404).end(); return; }
      } else { res.writeHead(404).end(); return; }
      res.setHeader('content-type', text ? 'text/plain' : 'application/json'); res.end(text ? data : JSON.stringify(data));
    } catch { res.writeHead(500).end('{}'); }
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r)); const origin = 'http://127.0.0.1:' + api.address().port;
  const bitcoin = new MintSenderBitcoin({ http: new SenderHTTP({ origin, settings }), network: 'regtest', settings });
  const credentials = join(directory, 'credentials'); await mkdir(credentials, { mode: 0o700 });
  await writeFile(join(credentials, 'tap-source.url'), `http://127.0.0.1:${ordPort}`, { mode: 0o400 });
  await writeFile(join(credentials, 'mint-bitcoin.url'), origin, { mode: 0o400 });
  await writeFile(join(credentials, 'mint-sender.seed'), seed, { mode: 0o400 });
  const configFile = join(directory, 'runtime.json');
  await writeFile(configFile, JSON.stringify({ mode: 'regtest', data: join(directory, 'gateway'), listen: { host: '127.0.0.1', port: api.address().port },
    local: { tapSourceFile: join(credentials, 'tap-source.url') }, mintSender: settings }), { mode: 0o600 });
  view = new MintSenderView({ seed: seed.slice(), network: 'regtest', settings });
  const environment = { ...process.env, CREDENTIALS_DIRECTORY: credentials };
  const init = await launch(process.execPath, [join(root, 'service/minter.mjs'), '--initialize', configFile], 'initialize', environment);
  const initCode = await new Promise(r => init.once('exit', r)); assert.equal(initCode, 0);
  await launch(process.execPath, [join(root, 'service/minter.mjs'), configFile], 'sender', environment);
  const snapshot = () => readSenderJSON(join(settings.directory, 'status', id + '.json'))?.mintSender;
  await until(() => view.ready(), 'sender_heartbeat');
  const publicPlan = view.decorate({ id, kind: 'tap', payer: payer.address, receiver: payer.address }, await status());
  const { refundReserveSats, ...publicFunding } = funding;
  assert.equal(refundReserveSats, 0); assert.deepEqual(publicPlan.mintFunding, publicFunding);
  // Simulate the wallet extra-output capability: the ONE wallet-approved order payment also carries the set-aside.
  const [input] = (await utxos(payer)).sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  const payment = new btc.Transaction(); payment.addInput({ txid: input.txid, index: input.vout, witnessUtxo: { script: unhex(input.script), amount: BigInt(input.value) }, tapInternalKey: unhex(payer.publicKey).slice(1) });
  payment.addOutputAddress(order.address, 20000n, net); payment.addOutputAddress(funding.address, BigInt(funding.satoshis), net);
  payment.addOutputAddress(payer.address, BigInt(input.value) - 20000n - BigInt(funding.satoshis) - 500n, net);
  approvals++; payment.sign(payer.privateKey); payment.finalize(); await push(payment.hex, payment.id, payer);
  extraCoin = coinFrom(payment, 1); order.coins.set(payment.id + ':0', coinFrom(payment, 0));
  await until(() => snapshot()?.state === 'funded', 'unconfirmed_set_aside');
  assert.equal((await bitcoin.utxos(funding.address))[0].confirmed, false);
  assert.equal(snapshot().commitTxid, undefined); assert.equal(permit, undefined); assert.equal(mintBroadcasts, 0);
  // The order's inscriber delivers the TAP transfer; no client mint inscription call exists.
  const transfer = redeem(auth, [], payer.privateKey, { items: transferItems({ requestId: id, fees, missing: fees }, 'regtest'), data: id });
  const paid = signCommit(buildInscription({ text: JSON.stringify(transfer), receiver: payer.address, publicKey: order.publicKey, network: 'regtest', utxos: await utxos(order), feeRate: 2, maxFeeSats: '100000', allowUnconfirmed: true }), order.privateKey);
  await push(paid.commitHex, paid.commitTxid); await push(paid.revealHex, paid.revealTxid); await mine();
  assert.equal((await status()).state, 'permit_issued');
  await until(() => snapshot()?.state === 'sent', 'server_reveal'); assert.equal(mintBroadcasts, 2); assert.equal(approvals, 1);
  const first = snapshot();
  await sleep(150); assert.equal(mintBroadcasts, 2, 'already present transactions are not broadcast twice');
  await mine(); await until(() => snapshot()?.state === 'minted', 'server_minted'); assert.equal((await status()).state, 'minted');
  assert.equal(await tap('getBalance/' + payer.address + '/' + tick), '2');
  assert.equal(await tap('getBalance/' + order.address + '/tap'), deployer.amount);
  assert.equal((await rpc('getrawtransaction', [first.commitTxid, true])).vin[0].txid, payment.id);
  assert.equal((await rpc('getrawtransaction', [first.commitTxid, true])).vin[0].vout, 1);
  const commit = btc.Transaction.fromRaw(unhex(await rpc('getrawtransaction', [first.commitTxid])));
  assert.equal(hex(commit.getOutput(1).script), hex(btc.p2tr(unhex(payer.publicKey).slice(1)).script));
  assert.equal((await rpc('getnetworkinfo')).connections, 0);
  t.diagnostic(JSON.stringify({ paymentTxid: payment.id, setAsideVout: 1, approvals, clientMintCalls: 0, senderMint: first.inscriptionId, state: 'minted', realTapBalance: '2', processesStoppedByCleanup: true }));
});
