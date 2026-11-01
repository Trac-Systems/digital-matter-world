// Disposable, network-isolated Bitcoin + ord-tap acceptance. Gateway/committee
// transport is a fixture; payment transfers, DMT signatures and satpoints are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, open, rm, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { authority, redeem, mintPermit, testKey } from '../../local/protocol.mjs';
import { buildInscription, signCommit, hex, unhex, networkFor } from '../../kit/lib/inscription-core.mjs';
import { requestKey, btc } from '../src/mint-sender-keys.mjs';
import { quoteBulkFunding } from '../src/bulk-mint-funding.mjs';
import { SenderHTTP, MintSenderBitcoin, MintSenderGateway } from '../src/mint-sender-source.mjs';
import { MintRefundTap } from '../src/mint-refund-source.mjs';
import { MintSenderJournal } from '../src/mint-sender-journal.mjs';
import { BulkMintSender } from '../src/bulk-mint-sender.mjs';
import { senderKeyId } from '../src/mint-sender-view.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { rules } from '../src/rules.mjs';
import { bulkOrderId, bulkMembersRoot, bulkFeeRoot, bulkPermitPlans, bulkWalletItems, validateBulkFees } from '../../rules/src/bulk-mint.js';
import { tapBurnAddress } from '../../rules/src/tap-burn.js';

async function until(fn, label, ms = 60000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (e) { last = e; } await sleep(100); }
  throw Error(`bulk_regtest_timeout_${label}`, { cause: last });
}
async function port() {
  const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port;
  await new Promise(r => s.close(r)); return p;
}

test('real ord 16/64 bulk orders: one redeem, all transfers/reveals, receiver satpoints and terminal reports', { timeout: 240000 }, async t => {
  const ord = process.env.DMW_ORD;
  try { await access(ord); } catch { throw Error('Set DMW_ORD to the ord-tap binary for required bulk acceptance'); }
  const directory = await mkdtemp(join(tmpdir(), 'bulk-regtest-')), children = [], keys = [], journals = [];
  let api;
  t.after(async () => {
    try {
      for (const j of journals) j.close();
      if (api) { api.closeAllConnections(); await new Promise(r => api.close(r)); }
      for (const child of children.toReversed()) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const ended = new Promise(r => child.once('exit', r)); child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await ended; clearTimeout(timer);
      }
    } finally { keys.forEach(k => k.fill(0)); await rm(directory, { recursive: true, force: true }); }
  });
  await mkdir(join(directory, 'bitcoin')); await mkdir(join(directory, 'ord'));
  const bitcoinPort = await port(), ordPort = await port();
  async function launch(command, args, label) {
    const log = await open(join(directory, label + '.log'), 'w', 0o600), child = spawn(command, args, { stdio: ['ignore', log.fd, log.fd] }); children.push(child);
    try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); } finally { await log.close(); }
  }
  await launch(process.env.DMW_BITCOIND ?? 'bitcoind', [`-datadir=${directory}/bitcoin`, '-regtest', '-server=1', '-txindex=1', '-listen=0', '-discover=0', '-dnsseed=0', '-fixedseeds=0', '-connect=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${bitcoinPort}`, '-fallbackfee=0.00001', '-printtoconsole=0'], 'bitcoin');
  async function rpc(method, params = [], wallet = '') {
    const cookie = (await readFile(join(directory, 'bitcoin/regtest/.cookie'), 'utf8')).trim();
    const response = await fetch(`http://127.0.0.1:${bitcoinPort}${wallet ? '/wallet/' + wallet : ''}`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(cookie).toString('base64'), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(method === 'generatetoaddress' ? 60000 : 10000) }).catch(error => { throw Error('regtest_transport_' + method, { cause: error }); });
    const value = await response.json(); if (value.error) throw Object.assign(Error(`regtest_rpc_${method}_${value.error.code}`), { rpcCode: value.error.code, detail: value.error.message }); return value.result;
  }
  await until(() => rpc('getblockchaininfo'), 'bitcoin'); assert.equal((await rpc('getblockchaininfo')).chain, 'regtest');
  await rpc('createwallet', ['faucet']); const mining = await rpc('getnewaddress', ['', 'bech32m'], 'faucet'); await rpc('generatetoaddress', [250, mining]);
  await launch(ord, ['--regtest', '--bitcoin-data-dir', join(directory, 'bitcoin'), '--bitcoin-rpc-url', `http://127.0.0.1:${bitcoinPort}`, '--data-dir', join(directory, 'ord'), '--index', join(directory, 'ord/index.redb'), '--index-addresses', '--index-sats',
    'server', '--http', '--address', '127.0.0.1', '--http-port', String(ordPort), '--polling-interval', '100ms'], 'ord');
  const ordOrigin = `http://127.0.0.1:${ordPort}`;
  async function ordRead(path) {
    const response = await fetch(ordOrigin + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok, path); return response.json();
  }
  const tap = async path => (await ordRead('/r/tap/' + path)).result;
  const indexed = async () => { const h = await rpc('getblockcount'); await until(async () => Number(await tap('getCurrentBlock')) >= h, 'indexer'); };
  const mine = async () => { await rpc('generatetoaddress', [1, mining]); await indexed(); };
  await indexed(); const seed = randomBytes(32); keys.push(seed); const net = networkFor('regtest');
  const wallet = id => { const key = requestKey(seed, id, 'regtest'); keys.push(key.privateKey); return { ...key, coins: new Map() }; };
  const payer = wallet('11'.repeat(32)), committee = wallet('22'.repeat(32)), receiver = wallet('33'.repeat(32));
  const coinFrom = (tx, vout) => ({ txid: tx.id, vout, value: String(tx.getOutput(vout).amount), script: hex(tx.getOutput(vout).script), cardinal: true, confirmed: true });
  for (const who of [payer, committee]) {
    const txid = await rpc('sendtoaddress', [who.address, 0.04], 'faucet'); await mine();
    const tx = btc.Transaction.fromRaw(unhex(await rpc('getrawtransaction', [txid])));
    for (let i = 0; i < tx.outputsLength; i++) if (hex(tx.getOutput(i).script) === hex(btc.p2tr(unhex(who.publicKey).slice(1)).script)) who.coins.set(`${tx.id}:${i}`, coinFrom(tx, i));
  }
  async function utxos(who) {
    const result = []; for (const coin of who.coins.values()) { const out = await rpc('gettxout', [coin.txid, coin.vout]); if (out) result.push({ ...coin, confirmed: out.confirmations > 0 }); } return result;
  }
  async function push(raw, who) {
    const tx = btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true });
    try { assert.equal(await rpc('sendrawtransaction', [raw]), tx.id); } catch (error) { if (error.rpcCode !== -27) throw error; }
    if (who) for (let i = 0; i < tx.outputsLength; i++) if (hex(tx.getOutput(i).script) === hex(btc.p2tr(unhex(who.publicKey).slice(1)).script)) who.coins.set(`${tx.id}:${i}`, coinFrom(tx, i));
    return tx;
  }
  async function write(who, content) {
    const plan = signCommit(buildInscription({ text: typeof content === 'string' ? content : JSON.stringify(content), receiver: who.address, publicKey: who.publicKey, network: 'regtest', utxos: await utxos(who), feeRate: 1, maxFeeSats: '90000', postage: 1000 }), who.privateKey);
    await push(plan.commitHex, who); await push(plan.revealHex); await mine(); return plan.inscriptionId;
  }
  async function activate(who, privileged = false) {
    const id = await write(who, authority(who.privateKey, { privilege: privileged }));
    const tx = new btc.Transaction(); tx.addInput({ txid: id.slice(0, 64), index: 0, witnessUtxo: { script: btc.p2tr(unhex(who.publicKey).slice(1)).script, amount: 1000n }, tapInternalKey: unhex(who.publicKey).slice(1) });
    tx.addOutputAddress(who.address, 700n, net); tx.sign(who.privateKey); tx.finalize(); await push(tx.hex); await mine(); return id;
  }
  const privilege = await activate(committee, true);
  await write(committee, { p: 'tap', op: 'token-deploy', tick: 'tap', max: '10000', dec: '18' });
  await write(payer, { p: 'tap', op: 'token-mint', tick: 'tap', amt: '1000' });
  const auth = await activate(payer), ticker = 'bulkbatch';
  const element = await write(committee, `${ticker}.[0-9].4.element`);
  const deployment = await write(committee, { p: 'tap', op: 'dmt-deploy', tick: ticker, elem: element, dt: 'n', prv: privilege });
  const base = JSON.parse(await readFile(new URL('../../rules/test/fixtures/bulk-v1.json', import.meta.url)));
  const orders = new Map(), sent = [], finishes = [];
  const settings = mintSenderSettings({ enabled: true, directory: join(directory, 'sender'), seedFile: join(directory, 'seed'), bitcoinApiUrlFile: join(directory, 'source'), timeoutMs: 10000, bitcoinApiPath: '' });
  const keyId = senderKeyId(seed, 'regtest');
  async function publicState(order) {
    if (!order.paymentId) return 'awaiting_payment';
    const transfers = await tap('getTransferredList/' + order.paymentId.slice(0, 64) + '?offset=0&max=500');
    const paid = order.terms.groups.every((g, i) => transfers.some(r => r.ins === order.paymentId && !r.fail && r.int && r.addr === payer.address && r.taddr === g.to && r.tick === 'tap' && r.amt === g.amount && r.dta === `dmw-bulk-pay-v1|${order.id}|${i}`));
    if (!paid) return 'awaiting_payment';
    if (!order.report) return 'permit_issued';
    const txs = new Map(await Promise.all([...new Set(order.report.members.map(m => m.inscription.slice(0, 64)))].map(async id => [id, await tap('getMintedList/' + id + '?offset=0&max=500')])));
    for (const member of order.report.members) {
      const rows = txs.get(member.inscription.slice(0, 64));
      if (!rows.some(r => r.ins === member.inscription && r.fail === false && r.addr === receiver.address && r.amt === '3' && r.tick === 'dmt-' + ticker && r.dta === order.manifest.members[member.index].mintContent.dta)) return 'minting';
      const prior = order.terminal.get(member.index);
      assert.ok(!prior || prior === member.inscription); order.terminal.set(member.index, member.inscription);
    }
    return 'minted';
  }
  async function item(order) {
    return { orderId: order.id, termsHash: rules.hashObject(order.terms), state: await publicState(order), payer: payer.address, receiver: receiver.address,
      fundingAddress: order.terms.mintFunding.address, fundingSats: order.terms.mintFunding.satoshis, paymentId: order.paymentId, count: order.terms.members.length, permitRoot: order.manifest.permitRoot };
  }
  api = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1'), path = url.pathname; let result, text = false;
      if (path === '/internal/mint-sender/bulk') {
        assert.equal(req.headers.authorization, 'Bearer test-token'); result = { keyId, rows: await Promise.all([...orders.values()].map(item)), next: null };
      } else if (path.startsWith('/internal/mint-sender/bulk/')) {
        assert.equal(req.headers.authorization, 'Bearer test-token'); const order = orders.get(path.split('/').at(-1));
        result = { keyId, item: await item(order), terms: order.terms, permit: order.manifest };
      } else if (path === '/mint/bulk/finish') {
        let body = ''; for await (const chunk of req) body += chunk;
        const report = JSON.parse(body), order = orders.get(report.orderId); assert.equal(report.members.length, order.terms.members.length);
        order.report = report; finishes.push(report); result = { orderId: order.id, state: await publicState(order) };
      } else if (path === '/fee-estimates') result = { 3: 1 };
      else if (path.startsWith('/block-height/')) { result = await rpc('getblockhash', [Number(path.split('/').at(-1))]); text = true; }
      else if (/^\/tx\/[0-9a-f]{64}\/hex$/.test(path)) { result = await rpc('getrawtransaction', [path.split('/')[2]]); text = true; }
      else if (/^\/tx\/[0-9a-f]{64}\/outspend\/\d+$/.test(path)) {
        const [, , txid, , index] = path.split('/'), out = await rpc('gettxout', [txid, Number(index)]);
        if (out) result = { spent: false };
        else {
          const spender = await rpc('gettxspendingprevout', [[{ txid, vout: Number(index) }]]);
          result = { spent: true, txid: spender[0]?.spendingtxid ?? sent.find(r => r.inputs.some(i => i.txid === txid && i.vout === Number(index)))?.txid };
        }
      } else if (/^\/tx\/[0-9a-f]{64}$/.test(path)) {
        try {
          const tx = await rpc('getrawtransaction', [path.slice(4), true]), block = tx.blockhash ? await rpc('getblockheader', [tx.blockhash]) : null;
          result = { txid: tx.txid, status: { confirmed: (tx.confirmations ?? 0) > 0, block_height: block?.height, block_hash: tx.blockhash } };
        } catch (e) { if (e.rpcCode !== -5) throw e; res.writeHead(404).end(); return; }
      } else if (path === '/tx' && req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const tx = await push(raw), inputs = Array.from({ length: tx.inputsLength }, (_, i) => ({ txid: hex(tx.getInput(i).txid), vout: tx.getInput(i).index }));
        sent.push({ txid: tx.id, inputs, raw }); result = tx.id; text = true;
      } else { res.writeHead(404).end(); return; }
      res.setHeader('content-type', text ? 'text/plain' : 'application/json'); res.end(text ? result : JSON.stringify(result));
    } catch (error) { t.diagnostic(error.message + (error.detail ? ': ' + error.detail : '')); res.writeHead(500).end('{}'); }
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r)); const origin = 'http://127.0.0.1:' + api.address().port;
  const bitcoin = new MintSenderBitcoin({ http: new SenderHTTP({ origin, settings }), network: 'regtest', settings });
  bitcoin.tap = new MintRefundTap({ http: new SenderHTTP({ origin: ordOrigin, settings }), bitcoin, settings });
  const gateway = new MintSenderGateway({ http: new SenderHTTP({ origin, settings }), token: 'test-token' });
  const journal = new MintSenderJournal(settings.directory, { keyId, network: 'regtest' }); journals.push(journal);
  const sender = new BulkMintSender({ seed, network: 'regtest', settings, journal, keyId, gateway, bitcoin, now: Date.now, log() {} });
  for (const n of [16, 64]) await t.test(`${n} actual indexed envelopes`, async () => {
    const terms = structuredClone(base.terms); terms.bitcoinNetwork = 'regtest'; terms.nonce = n.toString(16).padStart(64, '0');
    terms.deployment = deployment; terms.ticker = ticker; terms.receiver = receiver.address; terms.payer = payer.address;
    terms.members = Array.from({ length: n }, (_, i) => ({ block: String((n === 16 ? 100 : 116) + i), amount: '3' }));
    terms.membersRoot = bulkMembersRoot(terms.members); terms.totalAmount = String(n * 3);
    const destinations = { finder: receiver.address, treasury: committee.address, burn: tapBurnAddress('regtest') };
    terms.groups = Object.values(destinations).map(to => ({ to, ticker: 'tap', tt: 'a', amount: String(BigInt(n) * 10n ** 18n) }))
      .sort((a, b) => Buffer.compare(Buffer.from(rules.stableJSON(['tap', 'a', a.to])), Buffer.from(rules.stableJSON(['tap', 'a', b.to]))));
    const fees = terms.members.map((_, member) => ({ member, grossFeeAtoms: '3000000000000000000', shares: Object.entries(destinations).map(([role, to]) => ({ role, group: terms.groups.findIndex(g => g.to === to), beneficiary: null, gross: '1000000000000000000', payable: '1000000000000000000' })), deferred: { legacyDeploy: '0', deployer: '0' } }));
    terms.feeRoot = bulkFeeRoot(fees); terms.payableFeeAtoms = terms.grossFeeAtoms = String(BigInt(n) * 3n * 10n ** 18n);
    terms.feeQuote.deploymentId = deployment; terms.feeQuote.scope = rules.stableJSON(['mint-bulk-v1', terms.asset, deployment, terms.membersRoot]);
    const id = bulkOrderId(terms.network, terms.owner, terms.nonce), key = requestKey(seed, id, 'regtest'); keys.push(key.privateKey);
    const quoted = await quoteBulkFunding({ orderId: id, network: terms.network, bitcoinNetwork: 'regtest', members: terms.members, deployment: { kind: 'dmt', id: deployment, tick: ticker }, receiver: receiver.address, payer: payer.address, settings, feeRate: 1, address: key.address });
    assert.equal(quoted.fits, true); terms.mintFunding = quoted.mintFunding; validateBulkFees(terms, fees);
    const permits = bulkPermitPlans(terms, base.receiptRoot);
    const manifest = { v: 1, orderId: id, termsHash: rules.hashObject(terms), membersRoot: terms.membersRoot, paymentHash: permits.paymentHash, permitRoot: permits.permitRoot, count: n, readyCount: n, complete: true, offset: 0, next: null,
      members: permits.plans.map((p, index) => ({ index, memberId: p.memberId, ...terms.members[index], permitHash: p.digest,
        mintContent: mintPermit({ tick: ticker, blk: terms.members[index].block, dep: deployment, address: receiver.address, dta: p.payload.dta, salt: p.salt }, committee.privateKey) })) };
    const order = { id, terms, manifest, paymentId: null, approvals: 0, terminal: new Map() }; orders.set(id, order);
    const paymentPayload = redeem(auth, [], payer.privateKey, { items: bulkWalletItems(terms), data: id });
    const secret = testKey(); keys.push(secret);
    const draft = buildInscription({ text: JSON.stringify(paymentPayload), receiver: payer.address, publicKey: payer.publicKey, network: 'regtest', utxos: await utxos(payer), feeRate: 1, maxFeeSats: '90000', secret: secret.slice() });
    const commit = btc.Transaction.fromPSBT(unhex(draft.commitPsbt)), originalChange = commit.getOutput(1).amount;
    commit.updateOutput(1, { script: btc.p2tr(unhex(key.publicKey).slice(1)).script, amount: BigInt(terms.mintFunding.satoshis) });
    commit.addOutputAddress(payer.address, originalChange - BigInt(terms.mintFunding.satoshis) - 43n, net); commit.sign(payer.privateKey); commit.finalize();
    const originalReveal = btc.Transaction.fromRaw(unhex(draft.revealHex), { allowUnknownInputs: true }), script = originalReveal.getInput(0).finalScriptWitness[1];
    const leaf = btc.p2tr(btc.TAPROOT_UNSPENDABLE_KEY, { script }, net, true), reveal = new btc.Transaction({ allowUnknownInputs: true });
    reveal.addInput({ txid: commit.id, index: 0, sequence: 0xfffffffd, witnessUtxo: commit.getOutput(0), tapInternalKey: leaf.tapInternalKey, tapMerkleRoot: leaf.tapMerkleRoot, tapLeafScript: leaf.tapLeafScript });
    reveal.addOutputAddress(payer.address, 546n, net); reveal.sign(secret); reveal.finalize();
    order.approvals++; await push(commit.hex, payer); await push(reveal.hex); await mine(); order.paymentId = reveal.id + 'i0';
    assert.equal(await publicState(order), 'permit_issued');
    const bound = await bitcoin.bulkFunding({ terms, orderId: id, paymentId: order.paymentId });
    assert.equal(bound.txid, commit.id); assert.equal(bound.vout, 1); assert.equal(bound.value, String(terms.mintFunding.satoshis));
    const changedAmount = structuredClone(terms); changedAmount.mintFunding.satoshis++; changedAmount.mintFunding.maxFeeSats = String(BigInt(changedAmount.mintFunding.maxFeeSats) + 1n);
    await assert.rejects(bitcoin.bulkFunding({ terms: changedAmount, orderId: id, paymentId: order.paymentId }), /bulk_funding_output/);
    const changedAddress = structuredClone(terms); changedAddress.mintFunding.address = receiver.address;
    await assert.rejects(bitcoin.bulkFunding({ terms: changedAddress, orderId: id, paymentId: order.paymentId }), /bulk_funding_output/);
    await assert.rejects(bitcoin.bulkFunding({ terms, orderId: id, paymentId: reveal.id + 'i1' }), /bulk_redeem_binding/);
    const cardinal = bitcoin.tap.cardinal.bind(bitcoin.tap); bitcoin.tap.cardinal = async () => [];
    assert.equal(await bitcoin.bulkFunding({ terms, orderId: id, paymentId: order.paymentId }), null); bitcoin.tap.cardinal = cardinal;
    await sender.discover(); const sentBefore = sent.length; await sender.process(id);
    assert.equal(journal.bulk(id).state, 'sent'); assert.equal(order.approvals, 1); assert.equal(sent.length - sentBefore, 1 + Math.ceil(n / 16));
    await mine(); await until(async () => await publicState(order) === 'minted', 'mints');
    await sender.process(id); assert.equal(journal.bulk(id).state, 'minted');
    assert.equal(order.terminal.size, n); await publicState(order); assert.equal(order.terminal.size, n, 'terminal writes are idempotent');
    const plan = journal.bulk(id).plan; assert.equal(plan.funding.txid, commit.id); assert.equal(plan.funding.vout, 1);
    for (const batch of plan.reveals) for (const member of batch.members) {
      const inscription = await ordRead('/inscription/' + member.inscription);
      assert.equal(inscription.address, receiver.address); assert.equal(inscription.satpoint, `${batch.txid}:${member.output}:0`);
      assert.equal(inscription.id, member.inscription);
    }
    const transfers = await tap('getTransferredList/' + reveal.id + '?offset=0&max=500'); assert.equal(transfers.filter(r => r.ins === order.paymentId && !r.fail).length, 3);
    t.diagnostic(JSON.stringify({ members: n, approvals: order.approvals, recipientTransfers: 3, reveals: plan.reveals.length, terminalMembers: finishes.at(-1).members.length, feeSats: plan.feeSats, setAsideSats: terms.mintFunding.satoshis, satpoints: 'all receiver outputs at offset zero' }));
  });
  assert.equal(await tap('getBalance/' + receiver.address + '/dmt-' + ticker), '240');
  assert.equal((await rpc('getnetworkinfo')).connections, 0);
});
