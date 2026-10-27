// Isolated Bitcoin + ord-tap. Real discovery/claim rules, contract reducer,
// deployment verification, pay-first service and permit policy; local HTTP adapters.
// A disposable single committee key stands in for the external threshold ceremony.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../kit/package.json', import.meta.url));
const { HDKey } = require('@scure/bip32');
const { mnemonicToSeedSync } = require('@scure/bip39');
const { schnorr, secp256k1 } = require('@noble/curves/secp256k1');
const btc = require('@scure/btc-signer');
import { createWallet, wipeWallet, publicAddress, publicKey } from '../../kit/lib/keyring.mjs';
import { localBitcoinWallet } from '../../kit/lib/bitcoin-wallet.mjs';
import { PlayerMint } from '../../kit/lib/player-mint.mjs';
import { Journal } from '../../kit/lib/journal.mjs';
import { ServiceClient } from '../../kit/lib/service-client.mjs';
import { buildInscription, hex, unhex, networkFor } from '../../kit/lib/inscription-core.mjs';
import { authority } from '../../local/protocol.mjs';
import { ORD } from '../../local/common.mjs';

import { rules, initialState } from '../../service/src/rules.mjs';
import { Store } from '../../service/src/store.mjs';
import { Provisioner } from '../../service/src/provisioning.mjs';
import { verifyDeployment } from '../../service/src/deployments.mjs';
import { Mints } from '../../service/src/mints.mjs';
import { FeeQuotes, createFeePolicy, mintFeeScope } from '../../service/src/fees.mjs';
import { installMintPayments } from '../../service/src/mint-payments.mjs';
import { Policy } from '../../committee/signer/policy.mjs';
import { attachPermit } from '../../committee/signer/adapter.mjs';
import { StateTransition } from '../../contract/state.js';
import { signMove, signOwnerRequest, signPaymentIntent } from '../../kit/lib/signing.mjs';
import { attestRoot, receiptSigners } from '../../service/test/helpers.mjs';
import { abiWord, calldata, committeeAddress, ethereumSignature, escrowSplitForItems, TYPES } from '../../committee/signer/escrow.mjs';
import { createEscrowReader } from '../../committee/signer/escrow-reader.mjs';
import { ethereumPayments } from '../../service/src/ethereum.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const portBase = Number(process.env.DMW_TEST_PORT_BASE ?? 59790);
const ports = { bitcoin: portBase, ord: portBase + 1, web: portBase + 2, ethereum: portBase + 3 };
const origin = `http://127.0.0.1:${ports.web}`, net = networkFor('regtest');
const until = async (fn, label, ms = 30000) => {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await sleep(150); }
  throw Error(`Timed out: ${label}${last ? ': ' + last.message : ''}`);
};

test('all-history discovery, 61 historical claims and contested draw, first-minter deployment and one-block paid mint', { timeout: 360000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dmw-history-')), children = [], wallets = [], journals = [];
  let server, store;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const journal of journals) journal.close();
    await store?.close();
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
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); await log.close(); return child;
  }
  await launch(process.env.DMW_BITCOIND ?? 'bitcoind', [`-datadir=${directory}/bitcoin`, '-regtest', '-server=1', '-txindex=1', '-listen=0', '-discover=0', '-dnsseed=0', '-fixedseeds=0', '-connect=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${ports.bitcoin}`, '-fallbackfee=0.00001', '-printtoconsole=0'], 'bitcoin');
  async function rpc(method, params = [], wallet = '') {
    const cookie = (await readFile(join(directory, 'bitcoin/regtest/.cookie'), 'utf8')).trim();
    const response = await fetch(`http://127.0.0.1:${ports.bitcoin}${wallet ? '/wallet/' + wallet : ''}`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(cookie).toString('base64'), 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const data = await response.json(); if (data.error) throw Object.assign(Error(method + ': ' + data.error.message), { code: data.error.code }); return data.result;
  }
  await until(() => rpc('getblockchaininfo'), 'own Bitcoin node');
  assert.equal((await rpc('getblockchaininfo')).chain, 'regtest');
  await rpc('setmocktime', [1470000000]);
  await rpc('createwallet', ['faucet']);
  const mining = await rpc('getnewaddress', ['', 'bech32m'], 'faucet');
  await rpc('setmocktime', [1470000000]);
  await rpc('generatetoaddress', [110, mining]);
  await rpc('setmocktime', [Math.floor(Date.now()/1000)]);
  await rpc('generatetoaddress', [1, mining]);
  const ord = process.env.DMW_ORD ?? ORD;
  await launch(ord, ['--regtest', '--bitcoin-data-dir', join(directory, 'bitcoin'), '--bitcoin-rpc-url', `http://127.0.0.1:${ports.bitcoin}`, '--data-dir', join(directory, 'ord'), '--index', join(directory, 'ord/index.redb'), '--index-addresses', '--index-sats', 'server', '--http', '--address', '127.0.0.1', '--http-port', String(ports.ord), '--polling-interval', '100ms'], 'ord');
  const tap = async path => {
    const response = await fetch(`http://127.0.0.1:${ports.ord}/r/tap/${path}`, { headers: { accept: 'application/json' } });
    if (response.status === 404) return null;
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
  const activate = async (who, payload) => {
    const id = await write(who, payload), input = await rpc('gettxout', [id.slice(0, 64), 0]);
    const tx = new btc.Transaction();
    tx.addInput({ txid: id.slice(0, 64), index: 0, witnessUtxo: { script: unhex(input.scriptPubKey.hex), amount: 1000n }, tapInternalKey: schnorr.getPublicKey(who.key) });
    tx.addOutputAddress(who.local.address, 700n, net); tx.sign(who.key); tx.finalize();
    await rpc('sendrawtransaction', [tx.hex]); await mine(); return id;
  };
  const privilege = await activate(committee, authority(committee.key, { privilege: true }));
  assert.ok((await tap('getPrivilegeAuthList')).some(a => a.ins === privilege));
  await write(committee, { p: 'tap', op: 'token-deploy', tick: 'tap', max: '1000', dec: '18' });
  for (const who of [kit, web]) {
    await write(who, { p: 'tap', op: 'token-mint', tick: 'tap', amt: '100' });
    const auth = await activate(who, authority(who.key));
    who.local.close(); who.local = localBitcoinWallet({ wallet: who.trac, network: 'regtest', source: who.source, authority: auth });
    assert.ok((await tap(`getAccountAuthList/${who.local.address}`)).some(a => a.ins === auth));
  }
  const network = 'dmw-history-regtest', owner = publicKey(kit.trac), committeeKey = hex(secp256k1.getPublicKey(committee.key));
  // Exercise the Ethereum payment gate and native token burn; the TAP quote
  // must still name the network-correct eater address.
  await launch(process.env.DMW_ANVIL ?? 'anvil', ['--host', '127.0.0.1', '--port', String(ports.ethereum), '--chain-id', '31337', '--accounts', '3', '--silent'], 'anvil');
  const ethRpc = async (method, params = []) => {
    const response = await fetch(`http://127.0.0.1:${ports.ethereum}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const data = await response.json(); if (data.error) throw Error(method + ': ' + data.error.message); return data.result;
  };
  await until(() => ethRpc('eth_chainId'), 'own Anvil');
  assert.equal(BigInt(await ethRpc('eth_chainId')), 31337n);
  const [ethPayer, ethTreasury] = await ethRpc('eth_accounts');
  const compiled = await launch(process.env.DMW_FORGE ?? 'forge', ['build', '--offline', '--threads', '1', '--root', join(root, 'eth'), '--out', join(directory, 'eth-out'), '--cache-path', join(directory, 'eth-cache')], 'forge');
  assert.equal(await new Promise(resolve => compiled.once('exit', resolve)), 0, 'Compile local escrow fixtures');
  const sendEth = async (to, data) => {
    const id = await ethRpc('eth_sendTransaction', [{ from: ethPayer, ...(to ? { to } : {}), data, gas: '0x989680' }]);
    const receipt = await until(() => ethRpc('eth_getTransactionReceipt', [id]), 'local Ethereum transaction');
    assert.equal(receipt.status, '0x1'); return receipt;
  };
  const tokenArtifact = JSON.parse(await readFile(join(directory, 'eth-out/LocalTap.sol/LocalTap.json')));
  const escrowArtifact = JSON.parse(await readFile(join(directory, 'eth-out/DmwEscrow.sol/DmwEscrow.json')));
  const token = (await sendEth(null, tokenArtifact.bytecode.object + abiWord('address', ethPayer).toString('hex'))).contractAddress;
  const escrow = { token, chainId: '31337', address: (await sendEth(null, escrowArtifact.bytecode.object + [token, committeeAddress(committeeKey), ethPayer].map(a => abiWord('address', a).toString('hex')).join(''))).contractAddress };
  await sendEth(token, calldata('mint(address,uint256)', [['address', ethPayer], ['uint256', '100000000000000000000']]));
  const ethReader = createEscrowReader({ rpc: ethRpc, ...escrow }), ethPayments = ethereumPayments({ rpc: ethRpc, escrow });
  const gatewaySecret = Buffer.from(rules.hash('history-disposable-gateway'), 'hex');
  const headers = [], raws = [];
  const history = { get: h => headers[h], raw: h => raws[h], field: (h, fld, dt) => rules.fieldValue(headers[h], fld, dt), get length() { return headers.length; } };
  async function loadHeaders() {
    const tip = await rpc('getblockcount');
    for (let h = headers.length; h <= tip; h++) {
      const raw = await rpc('getblockheader', [await rpc('getblockhash', [h]), false]);
      raws.push(raw); headers.push(rules.parseHeader(raw, h));
    }
    return tip;
  }
  const start = await loadHeaders(), genesis = headers[0];
  const ledger = new StateTransition(async () => null, { network, admin: owner, committee: committeeKey, beacon: {
    checkpoint: { height: 0, hash: genesis.hash, time: genesis.time, bits: genesis.bits, chainwork: '2', times: [genesis.time] },
    params: { interval: 2016, timespan: 1209600, confirmations: 1, branchDepth: 144, powLimitBits: 0x207fffff, retarget: false }
  } });
  let ingested = 0;
  async function syncLedger() {
    const tip = await loadHeaders();
    while (ingested < tip) {
      const end = Math.min(tip, ingested + 20);
      assert.equal(await ledger.transaction('hd', { headers: raws.slice(ingested + 1, end + 1) }, owner), null);
      ingested = end;
    }
    return (await ledger.head()).counted;
  }
  const ledgerOps = [];
  async function applyOps(ops) {
    const counted = await syncLedger(), settings = await ledger.settings(), budget = { assets: 0, kv: 0 };
    for (const op of ops) { assert.equal(await ledger.batchOp(op, counted, settings, budget), null); ledgerOps.push(op); }
  }
  async function signedBatch(batch) {
    const sig = secp256k1.sign(rules.batchDigest(network, batch), committee.key, { prehash: false, lowS: true }).toCompactHex();
    assert.equal(await ledger.transaction('bt', { ...batch, sig }, owner), null);
    assert.equal(await ledger.get('bt/' + batch.n), batch.root);
    ledgerOps.push(...batch.ops);
  }
  await syncLedger();
  await signedBatch({ v: 1, epoch: 0, n: 1, from: 1, to: start - 1, deadline: start + 6, root: rules.hash('empty-table-bootstrap'), ops: [] });
  let state = initialState(start, headers[start].hash, start - 1), patterns = [], sequence = 0, claimBlock, claimWindow, accepted;
  const proposal = { name: 'dmwfirstlight', pat: '[0-9]', fld: 4, dt: 'n' }, salt = rules.hash('history-discovery-salt');
  for (let offset = 0; offset < 16; offset++) {
    const tip = await loadHeaders(), tipHash = headers[tip].hash, entries = [];
    let type, payload;
    if (offset === 0) { type = 'discovery-commit'; payload = { commitment: rules.discoveryCommitment(proposal, salt, owner) }; }
    else if (offset === 2) { type = 'discovery-reveal'; payload = { proposal, salt }; }
    else if (patterns.length && claimBlock === undefined && rules.patternCount(patterns[0], headers[tip]) > 0) {
      type = 'claim'; claimBlock = 1; claimWindow = tip;
      payload = { window: tip, plots: Array.from({ length: 61 }, (_, i) => ({ block: i + 1, patterns: [0] })) };
    }
    if (type) {
      const move = await signMove(kit.trac, { network, type, payload, tip: { height: tip, hash: tipHash } }, { puzzleBits: 0 });
      entries.push({ move, receipt: rules.signReceipt(move, { tip, hash: tipHash, sequence: sequence++ }, gatewaySecret) });
    }
    if (type === 'claim') {
      const move = await signMove(web.trac, { network, type, payload: { window: tip, plots: [{ block: 61, patterns: [0] }] }, tip: { height: tip, hash: tipHash } }, { puzzleBits: 0 });
      entries.push({ move, receipt: rules.signReceipt(move, { tip, hash: tipHash, sequence: sequence++ }, gatewaySecret) });
    }
    const receiptRoot = rules.sealReceipts(entries.map(e => e.receipt), { network, tip, hash: tipHash }, gatewaySecret);
    const out = rules.processBlock({ height: tip, blockHash: headers[tip].hash, tip, tipHash, network, gateway: receiptRoot.gateway,
      history, hashAt: h => headers[h]?.hash, state, patterns, entries, receiptRoot, rootAttestations: entries.length ? await attestRoot(receiptRoot) : [],
      confirmed: tip, settings: { puzzleBits: 0, receiptSigners, claimsPerWindow: rules.CLAIM_DEFAULTS.claimsPerWindow } });
    for (const move of out.file.moves) assert.equal(move.reason, 'accepted');
    if (out.file.discoveries.length) accepted = out.file.discoveries[0].record;
    const counted = await syncLedger(), last = await ledger.batchLast();
    const built = rules.buildBatch({ network, epoch: 0, sequence: last.n + 1, lastTo: last.to, executionHeight: counted, files: [out.file] });
    await signedBatch(built.batch);
    assert.equal(await ledger.get('n/finds/batch/' + built.batch.n.toString(36)), rules.findsCommitment([out.file]));
    assert.equal(await ledger.get('n/receipt/batch/' + built.batch.n.toString(36)), built.batch.ops.at(-1).value);
    state = out.state; patterns = out.patterns;
    if (tip === claimWindow + 2) {
      assert.equal(rules.recordSize(state.finds), 61, 'all finds settle on deciding-block arrival');
      assert.equal(out.file.settlements.find(s => s.window === claimWindow).winners.find(w => w.block === 61).tickets, 2);
    }
    await mine();
  }
  assert.equal(patterns.length, 1); assert.equal(accepted.number, 0); assert.equal(accepted.discoverer, owner);
  const snapshot = { length: accepted.historyHeight + 1, get: history.get, field: history.field };
  assert.equal(accepted.rarity, rules.analyzePattern(proposal, snapshot).rarity);
  const find = rules.recordGet(state.finds, rules.findId(claimBlock, 0));
  assert.equal(find.finder, owner); assert.equal(find.source, 'claim');
  assert.ok(headers[claimBlock].time < Date.now()/1000 - 10*365*86400);
  assert.equal(rules.recordSize(state.finds), 61);
  const ownedUnits = Object.values(rules.recordObject(state.finds)).filter(f => f.finder === owner).reduce((n,f) => n+BigInt(f.count), 0n);
  assert.equal(await ledger.balance(await ledger.agent(owner), 'p0'), String(ownedUnits));
  t.diagnostic('Empty table accepted discovery 0; 61 historical pairs, including a block over ten years old and a two-agent contest, settled on the deciding block with grouped credits.');

  store = await Store.open(join(directory, 'service-store'));
  await store.put('meta', 'patterns', patterns);
  const registryPath = join(directory, 'registry.json');
  await writeFile(registryPath, JSON.stringify({ assets: {}, feePolicy: createFeePolicy('10000000000000000') }));
  const registry = () => readFile(registryPath, 'utf8').then(JSON.parse);
  const included = async id => {
    let tx; try { tx = await rpc('getrawtransaction', [id.slice(0, 64), true]); } catch { return null; }
    if (!tx.blockhash) return null;
    const block = await rpc('getblockheader', [tx.blockhash]);
    return { confirmations: block.confirmations, height: block.height, blockHash: tx.blockhash };
  };
  const content = async id => {
    const response = await fetch(`http://127.0.0.1:${ports.ord}/content/${id}`);
    assert.ok(response.ok); const text = await response.text(); try { return JSON.parse(text); } catch { return text; }
  };
  const reads = {
    registry, tap, content, included, counted: syncLedger,
    tip: async () => { const b = await rpc('getblockchaininfo'); return { tip: b.blocks, tipHash: b.bestblockhash }; },
    inscription: async id => {
      const response = await fetch(`http://127.0.0.1:${ports.ord}/inscription/${id}`, { headers: { accept: 'application/json' } });
      assert.ok(response.ok); return response.json();
    },
    authority: async () => ({ network, committee: committeeKey, epoch: 0 }),
    bindings: { bitcoinNetwork: 'regtest', resolve: () => ({ request: { address: kit.local.address } }) },
    bitcoinTransaction: id => rpc('getrawtransaction', [id, true]),
    pending: id => ledger.mint(id), agentAddress: n => ledger.address(n), paymentUsed: key => ledger.get('pay/' + key),
    balance: async (who, asset) => ledger.balance(await ledger.agent(who), asset), bitmap: async () => null,
    blockHold: async (asset, block) => store.get('holds', `${asset}/${block}`),
    isMinted: async (_id, tick, block) => !!await tap(`getDmtMintHolderByBlock/dmt-${tick}/${block}`),
    payer: async id => store.get('mints', id).payer,
  };
  reads.feeQuotes = new FeeQuotes({ network, secret: gatewaySecret, registry });
  reads.assetContext = async (asset, block, kind = 'tap') => {
    const entry = (await registry()).assets[asset]; assert.ok(entry, 'asset_unregistered');
    const { deployment } = await verifyDeployment(reads, entry);
    return { deployment: { id: entry.id, kind: 'dmt', tick: entry.tick, active: true, privilegePublicKey: committeeKey, decimals: Number(deployment.dec),
      remaining: await tap('getMintTokensLeft/' + entry.indexTick), limit: '0' },
      find, tier: accepted.tier, discoverer: kind === 'tap' ? kit.local.address : ethPayer,
      finderAddress: kind === 'tap' ? kit.local.address : ethPayer, treasury: kind === 'tap' ? committee.local.address : ethTreasury };
  };
  reads.mintFeeTerms = async id => {
    const row = store.get('mints', id);
    return reads.feeQuotes.accepted(row.feeAuthorization, mintFeeScope(row.request.asset, row.request.block, row.kind), id, row.request.expires);
  };
  const acceptances = new Map(); reads.pendingAcceptance = async id => acceptances.get(id);
  reads.escrowDeposit = (payer, id) => ethReader.deposit(payer, id);
  reads.escrowSettled = (payer, id) => ethPayments.settled('ethereum', id, payer);
  installMintPayments(reads, { request: id => store.get('mints', id), network, escrow });
  let signatures = 0;
  const policy = new Policy({ network, publicKey: committeeKey, reads, escrow });
  const signing = { signature: async (_key, proposed) => {
    const approved = await policy.approve(proposed), sig = secp256k1.sign(approved.digest, committee.key);
    if (proposed.kind === 'ethereum-payment-release') return { typedData: approved.typedData, ethereumSignature: ethereumSignature({ r: String(sig.r), s: String(sig.s), v: sig.recovery }) };
    signatures++; return { payload: attachPermit(approved.permit, { r: String(sig.r), s: String(sig.s), v: sig.recovery }) };
  } };
  const completedOps = new Map();
  const operations = { supportsMintBatches: true, ensure: async (key, op) => {
    if (completedOps.has(key)) return completedOps.get(key);
    await applyOps([op]);
    let result = true;
    if (op.op === 'rq') {
      const id = rules.pendingId(network, op.request);
      result = { id, created: await reads.counted(), expiry: op.request.expires }; acceptances.set(id, result);
    }
    completedOps.set(key, result); return result;
  } };
  const provisioner = new Provisioner({ store, reads, network, registryPath,
    policy: { confirmations: 1, privilege, authorityKey: committeeKey, tapTreasury: committee.local.address, ethereumTreasury: '0x' + '11'.repeat(20) } });
  const mints = new Mints({ store, network, reads, operations, committee: signing, payments: { mint: row => reads.mintPayment(row.id, row) } });
  mints.provisioner = provisioner;
  reads.mint = async id => {
    const row = store.get('mints', id), d = row.context.deployment;
    const winner = await tap(`getDmtMintHolderByBlock/dmt-${d.tick}/${row.request.block}`);
    if (!winner) return null;
    const payload = await content(winner.ins), inclusion = await included(winner.ins);
    assert.deepEqual(payload, row.permit);
    return { accepted: true, fail: false, confirmations: inclusion.confirmations, inscription: winner.ins,
      deployment: d.id, tick: d.tick, receiver: payload.prv.address, amount: row.request.amount, block: row.request.block,
      dta: payload.dta, permitHash: payload.prv.hash, committee: committeeKey };
  };
  const deploymentJob = async asset => {
    const definition = (store.get('meta', 'patterns') ?? []).find(p => rules.patternAsset(p) === asset);
    assert.ok(definition); return provisioner.request(asset, definition);
  };
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin), path = url.pathname.replace(/^\/api\/gateway/, '');
      let body; if (req.method === 'POST') { let text = ''; for await (const chunk of req) text += chunk; body = JSON.parse(text); }
      let value;
      if (/^\/mint\/deployment\/p[0-9a-z]+$/.test(path)) value = await deploymentJob(path.split('/').at(-1));
      else if (path === '/mint/deployment') value = await provisioner.submit(body.asset, body);
      else if (path === '/mint/quote') value = await mints.quote(body);
      else if (path === '/mint/payment') value = await mints.payment(body);
      else if (/^\/mint\/[0-9a-f]{64}$/.test(path)) { await mints.tick(); value = mints.public(path.split('/').at(-1)); }
      else if (/^\/web-api\/mint\/[0-9a-f]{64}$/.test(path)) { const id = path.split('/').at(-1); value = { ...mints.public(id), payer: store.get('mints', id).payer }; }
      else if (path.startsWith('/payout-bindings/')) {
        const who = [kit, web].find(w => path.includes(publicAddress(w.trac))); assert.ok(who);
        value = { binding: { request: { agent: publicAddress(who.trac), address: who.local.address } } };
      } else throw Error('route');
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(rules.publicIdentities(value)));
    } catch (error) { res.writeHead(error.status ?? 409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ports.web, '127.0.0.1', resolve); });
  const service = new ServiceClient({ origin, network });
  const journal = await Journal.open(join(directory, 'kit-journal'), 'kit'); journals.push(journal);
  const client = new PlayerMint({ service, journal, wallet: kit.local, owner: publicAddress(kit.trac) });
  const needed = await service.mintQuote({ asset: 'p0', block: claimBlock, amount: String(find.count) });
  assert.equal(needed.state, 'deployment_needed'); assert.equal(needed.payable, false); assert.equal(needed.requestId, null);
  assert.equal(needed.deployment.phase, 'element'); assert.equal(signatures, 0);
  assert.equal((await client.deploy({ asset: 'p0', maxFeeSats: '100000' })).state, 'dry-run');
  assert.equal((await rpc('getrawmempool')).length, 0);
  client.dryRun = false;
  const element = await client.deploy({ asset: 'p0', maxFeeSats: '100000' }); await mine(1);
  assert.equal(element.phase, 'element');
  assert.equal((await included(element.inscriptionId)).confirmations, 1);
  assert.equal(await content(element.inscriptionId), `${proposal.name}.${proposal.pat}.4.element`);
  const deploy = await client.deploy({ asset: 'p0', maxFeeSats: '100000' }); await mine(1);
  assert.equal(deploy.phase, 'deployment');
  assert.equal((await included(deploy.inscriptionId)).confirmations, 1);
  const registered = await service.deployment('p0');
  // GET may observe the indexed element before explicit registration; submit the saved deploy once.
  if (registered.state !== 'registered') await service.submitDeployment({ asset: 'p0', phase: 'deployment', inscription: deploy.inscriptionId });
  const entry = (await registry()).assets.p0;
  assert.equal(entry.elementId, element.inscriptionId); assert.equal(entry.privilege, privilege);
  assert.equal((await reads.inscription(element.inscriptionId)).address, kit.local.address);
  assert.equal((await reads.inscription(deploy.inscriptionId)).address, kit.local.address);
  assert.equal(signatures, 0);

  const counted = await reads.counted(), request = { owner, asset: 'p0', block: claimBlock, amount: String(find.count), receive: rules.hash(kit.local.address), nonce: rules.hash('first-mint'), until: counted + 12, expires: counted + 432 };
  const tapQuote = await service.mintQuote({ asset: 'p0', block: claimBlock, amount: request.amount });
  assert.equal(tapQuote.fees.find(f => f.role === 'burn').to, rules.tapBurnAddress('regtest'));
  const quote = await service.mintQuote({ asset: 'p0', block: claimBlock, amount: request.amount, kind: 'ethereum' });
  const body = { request, signature: signOwnerRequest(kit.trac, 'rq', network, request, counted), receiver: kit.local.address, payer: ethPayer, kind: 'ethereum', feeQuote: quote.feeQuote };
  body.authorization = signPaymentIntent(kit.trac, network, body);
  const reserved = await service.requestMint(body), id = reserved.requestId;
  await mints.tick(); const payable = mints.public(id);
  assert.equal(payable.state, 'awaiting_payment'); assert.equal(payable.fees.some(f => f.role === 'finder' || f.role === 'discoverer'), false);
  const split = escrowSplitForItems(payable.fees), amount = payable.payableAmount;
  await sendEth(token, calldata('approve(address,uint256)', [['address', escrow.address], ['uint256', amount]]));
  const expiry = String(BigInt((await ethRpc('eth_getBlockByNumber', ['latest', false])).timestamp) + 7200n);
  const depositData = calldata(`deposit(bytes32,uint256,(${TYPES.Split.map(f => f.type).join(',')}),uint256)`,
    [['bytes32', id], ['uint256', amount], ...TYPES.Split.map(({ name, type }) => [type, split[name]]), ['uint256', expiry]]);
  await sendEth(escrow.address, depositData);
  assert.equal((await ethReader.deposit(ethPayer, id)).confirmations, 1);
  await mints.tick();
  const release = mints.public(id).ethereumRelease; assert.ok(release, JSON.stringify(store.get('mints', id).lastError));
  const supplyBefore = BigInt(await ethRpc('eth_call', [{ to: token, data: calldata('totalSupply()') }, 'latest']));
  await sendEth(release.to, release.data);
  assert.equal((await ethPayments.settled('ethereum', id, ethPayer)).confirmations, 1);
  const supplyAfter = BigInt(await ethRpc('eth_call', [{ to: token, data: calldata('totalSupply()') }, 'latest']));
  assert.equal(supplyBefore - supplyAfter, BigInt(split.burnAmount));
  await mints.tick(); await mints.tick();
  const ready = await client.status(id); assert.equal(ready.state, 'permit_issued', JSON.stringify(store.get('mints', id).lastError));
  assert.equal(signatures, 1); assert.equal((await ledger.mint(id)).s, 1);
  assert.equal(await ledger.balance(await ledger.agent(owner), 'p0'), String(ownedUnits-BigInt(find.count)));
  const made = await client.inscribe({ id, maxFeeSats: '100000' }); await mine(1);
  const final = await client.status(id); assert.equal(final.state, 'minted');
  assert.equal((await included(made.inscriptionId)).confirmations, 1);
  assert.equal(await tap(`getBalance/${kit.local.address}/${entry.indexTick}`), request.amount);
  assert.equal(ledgerOps.filter(op => op.op === 'mc').length, 1);
  t.diagnostic('First minter paid real quoted fees through local Ethereum escrow with native TAP burn; production payment/permit policy passed, units consumed once and Bitcoin DMT mint indexed. Fixed mainnet TAP burn address unchanged.');

  assert.equal((await rpc('getnetworkinfo')).connections, 0);
});
