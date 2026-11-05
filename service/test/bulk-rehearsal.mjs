// Real disposable Bitcoin/TAP transport for the financial rehearsal. The wallet
// provider is local, but it signs and broadcasts actual commit/reveal transactions.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { bitcoin, mine } from '../../local/common.mjs';
import { authority, redeem, testKey } from '../../local/protocol.mjs';
import { buildInscription, fundingAddress, hex, unhex, networkFor } from '../../kit/lib/inscription-core.mjs';
import { TapWalletBulkMint } from '../../kit/lib/tap-wallet-deployer.mjs';
import { quoteBulkMint, makeBulkMint } from '../../kit/lib/bulk-mint.mjs';
import { btc } from '../src/mint-sender-keys.mjs';
import { MintSenderView } from '../src/mint-sender-view.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { SenderHTTP, MintSenderBitcoin, MintSenderGateway } from '../src/mint-sender-source.mjs';
import { MintRefundTap } from '../src/mint-refund-source.mjs';
import { MintSenderJournal } from '../src/mint-sender-journal.mjs';
import { BulkMintSender } from '../src/bulk-mint-sender.mjs';
import { rules as r } from '../src/rules.mjs';
import { bulkMemberId, bulkAllMask, BULK_CAPACITY_VALUES, BULK_LIMITS } from '../../rules/src/bulk-mint.js';
import { accountKey, readAccountLeaf } from '../../contract/account-tree.js';
import { AccountAvailability } from '../src/account-availability.mjs';
import { capacityKey, plotKey } from '../../contract/financial-capacity.js';
import { secp256k1 } from '../../contract/node_modules/@noble/curves/secp256k1.js';

export async function bulkRehearsalTransport({ stack, directory, inscription }) {
  assert.equal((await bitcoin(stack, 'getnetworkinfo')).connections, 0);
  const seed = randomBytes(32), privateKey = testKey(), publicKey = hex(secp256k1.getPublicKey(privateKey));
  const payer = fundingAddress(publicKey, 'regtest'), net = networkFor('regtest'), sent = [];
  const settings = mintSenderSettings({ enabled: true, directory: join(directory, 'sender'), seedFile: join(directory, 'sender-seed'),
    bitcoinApiUrlFile: join(directory, 'source.url'), bitcoinApiPath: '', timeoutMs: 30000, feeRate: 1 });
  const view = new MintSenderView({ seed, network: 'regtest', settings });
  await mkdir(settings.directory, { recursive: true, mode: 0o700 });
  const heartbeat = () => writeFile(join(settings.directory, 'health.json'), JSON.stringify({ keyId: view.keyId, policy: view.policy,
    ready: true, at: Date.now(), feeRate: 1, feeRateAt: Date.now() }), { mode: 0o600 });
  await heartbeat();
  const auth = await inscription(authority(privateKey), payer);
  const authTx = btc.Transaction.fromRaw(unhex(await bitcoin(stack, 'getrawtransaction', [auth.slice(0, 64)])), { allowUnknownOutputs: true });
  const activate = new btc.Transaction();
  activate.addInput({ txid: auth.slice(0, 64), index: 0, witnessUtxo: authTx.getOutput(0), tapInternalKey: unhex(publicKey).slice(1) });
  activate.addOutputAddress(payer, authTx.getOutput(0).amount - 300n, net); activate.sign(privateKey); activate.finalize();
  await bitcoin(stack, 'sendrawtransaction', [activate.hex]); await mine(stack);
  await inscription({ p: 'tap', op: 'token-mint', tick: 'tap', amt: '1000' }, payer);
  const funding = await bitcoin(stack, 'sendtoaddress', [payer, 0.04], 'faucet'); await mine(stack);
  const fundingTx = btc.Transaction.fromRaw(unhex(await bitcoin(stack, 'getrawtransaction', [funding])));
  const payerScript = hex(btc.p2tr(unhex(publicKey).slice(1)).script);
  const coinIndex = Array.from({ length: fundingTx.outputsLength }, (_, i) => i).find(i => hex(fundingTx.getOutput(i).script) === payerScript);
  const coin = { txid: funding, vout: coinIndex, value: String(fundingTx.getOutput(coinIndex).amount), script: payerScript, cardinal: true, confirmed: true };
  const push = async raw => {
    const tx = btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true, allowUnknownOutputs: true });
    try { await bitcoin(stack, 'sendrawtransaction', [raw]); } catch (e) { if (e.rpcCode !== -27) throw e; }
    sent.push({ txid: tx.id, inputs: Array.from({ length: tx.inputsLength }, (_, i) => ({ txid: hex(tx.getInput(i).txid), vout: tx.getInput(i).index })) });
    return tx.id;
  };
  let payments = 0;
  const provider = {
    getCapabilities: async () => ({ version: '1.0.49', singleTxTransferExtraOutputs: true }),
    requestAccounts: async () => [payer], getAccounts: async () => [payer], getNetwork: async () => 'regtest', getPublicKey: async () => publicKey,
    getCurrentAuthority: async () => ({ ins: auth, auth: [], addr: payer }), getAuthorityStatus: async () => ({ active: true }),
    getBitcoinUtxos: async () => {
      const out = await bitcoin(stack, 'gettxout', [coin.txid, coin.vout]);
      return out?.confirmations > 0 ? [{ txid: coin.txid, vout: coin.vout, satoshi: Number(coin.value),
        height: await bitcoin(stack, 'getblockcount') - out.confirmations + 1, inscriptions: [] }] : [];
    },
    singleTxTransfer: async (items, { extraOutputs }) => {
      assert.equal(++payments, 1, 'one wallet approval/redeem for the entire order'); assert.equal(extraOutputs.length, 1);
      const secret = testKey(), draft = buildInscription({ text: JSON.stringify(redeem(auth, [], privateKey, { items })),
        receiver: payer, publicKey, network: 'regtest', utxos: [coin], feeRate: 1, maxFeeSats: '90000', secret: secret.slice() });
      const commit = btc.Transaction.fromPSBT(unhex(draft.commitPsbt)), change = commit.getOutput(1).amount, extra = extraOutputs[0];
      commit.updateOutput(1, { script: btc.OutScript.encode(btc.Address(net).decode(extra.address)), amount: BigInt(extra.satoshis) });
      commit.addOutputAddress(payer, change - BigInt(extra.satoshis) - 43n, net); commit.sign(privateKey); commit.finalize();
      const original = btc.Transaction.fromRaw(unhex(draft.revealHex), { allowUnknownInputs: true });
      const leaf = btc.p2tr(btc.TAPROOT_UNSPENDABLE_KEY, { script: original.getInput(0).finalScriptWitness[1] }, net, true);
      const reveal = new btc.Transaction({ allowUnknownInputs: true });
      reveal.addInput({ txid: commit.id, index: 0, sequence: 0xfffffffd, witnessUtxo: commit.getOutput(0),
        tapInternalKey: leaf.tapInternalKey, tapMerkleRoot: leaf.tapMerkleRoot, tapLeafScript: leaf.tapLeafScript });
      reveal.addOutputAddress(payer, 546n, net); reveal.sign(secret); reveal.finalize(); secret.fill(0);
      await push(commit.hex); await push(reveal.hex); await mine(stack);
      return { inscriptionId: reveal.id + 'i0', commitTxid: commit.id, revealTxid: reveal.id };
    }
  };
  const api = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname; let value, text = false;
      if (path === '/fee-estimates') value = { 3: 1 };
      else if (path.startsWith('/block-height/')) { value = await bitcoin(stack, 'getblockhash', [Number(path.split('/').at(-1))]); text = true; }
      else if (/^\/tx\/[0-9a-f]{64}\/hex$/.test(path)) { value = await bitcoin(stack, 'getrawtransaction', [path.split('/')[2]]); text = true; }
      else if (/^\/tx\/[0-9a-f]{64}\/outspend\/\d+$/.test(path)) {
        const [, , txid, , n] = path.split('/'), vout = Number(n), out = await bitcoin(stack, 'gettxout', [txid, vout]);
        value = out ? { spent: false } : { spent: true, txid: (await bitcoin(stack, 'gettxspendingprevout', [[{ txid, vout }]]))[0]?.spendingtxid ?? sent.find(t => t.inputs.some(i => i.txid === txid && i.vout === vout))?.txid };
      } else if (/^\/tx\/[0-9a-f]{64}$/.test(path)) {
        try {
          const tx = await bitcoin(stack, 'getrawtransaction', [path.slice(4), true]);
          const block = tx.blockhash ? await bitcoin(stack, 'getblockheader', [tx.blockhash]) : null;
          value = { txid: tx.txid, status: { confirmed: (tx.confirmations ?? 0) > 0, block_height: block?.height, block_hash: tx.blockhash } };
        } catch (e) { if (e.rpcCode !== -5) throw e; res.writeHead(404).end(); return; }
      } else if (path === '/tx' && req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk; value = await push(raw); text = true;
      } else { res.writeHead(404).end(); return; }
      res.setHeader('content-type', text ? 'text/plain' : 'application/json'); res.end(text ? value : JSON.stringify(value));
    } catch (e) { console.error('regtest sender bridge:', e.message); res.writeHead(500).end('{}'); }
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const chain = new MintSenderBitcoin({ http: new SenderHTTP({ origin: 'http://127.0.0.1:' + api.address().port, settings }), network: 'regtest', settings });
  chain.tap = new MintRefundTap({ http: new SenderHTTP({ origin: stack.ord.url, settings }), bitcoin: chain, settings });
  await chain.verifyNetwork();
  const journal = new MintSenderJournal(settings.directory, { keyId: view.keyId, network: 'regtest' });
  const walletJournal = { get: async key => { try { return JSON.parse(await readFile(join(directory, 'bulk-wallet.json')))[key]; } catch (e) { if (e.code !== 'ENOENT') throw e; } },
    put: async (key, value) => writeFile(join(directory, 'bulk-wallet.json'), JSON.stringify({ [key]: value }), { mode: 0o600 }), lock: async (_key, fn) => fn() };
  const fetchImpl = (path, options) => {
    if (path.startsWith('/web-api/tap-reader/')) return fetch(stack.ord.url + '/r/tap/' + path.slice('/web-api/tap-reader/'.length), options);
    if (path === 'https://mempool.space/api/v1/fees/recommended') return Promise.resolve(Response.json({ halfHourFee: 1, fastestFee: 1 }));
    throw Error('unexpected_rehearsal_wallet_read');
  };
  return { view, payer, provider, walletJournal, heartbeat, fetchImpl, payments: () => payments, journal,
    sender: origin => new BulkMintSender({ seed, network: 'regtest', settings, journal, keyId: view.keyId, now: Date.now, log() {}, bitcoin: chain,
      gateway: new MintSenderGateway({ http: new SenderHTTP({ origin, settings }), token: view.token }) }),
    async close() { journal.close(); view.close(); privateKey.fill(0); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
  };
}

export async function runBulkRehearsal({ stack, directory, transport, entry, receiver, agent, service, getRuntime, getStore, contract, progress, sync, restart, parallelIntent, paySingle, inscription, pass }) {
  const started = performance.now(), elapsedMs = {}, mark = name => { elapsedMs[name] = Math.round(performance.now() - started); };
  const tap = async path => (await (await fetch(stack.ord.url + '/r/tap/' + path)).json()).result;
  const blocks = Array.from({ length: 64 }, (_, i) => String(100 + i));
  await progress(() => !!getStore().get('accountRecords', 'fd/asset/' + entry.asset));
  await transport.heartbeat();
  const actionId = 'bulk-regtest-64', quote = await quoteBulkMint(agent, { actionId, asset: entry.asset, deployment: entry.id, blocks, payer: transport.payer, receiver });
  assert.equal(quote.terms?.members.length, 64, JSON.stringify({ skipped: quote.skipped, deferred: quote.deferred }));
  mark('quoted');
  const accepted = await makeBulkMint(agent, { actionId, quoteId: quote.quoteId, maxPayableFeeAtoms: quote.terms.payableFeeAtoms, maxSetAsideSats: 100000 });
  const id = accepted.orderId;
  const parallel = await Promise.all(Array.from({ length: 3 }, (_, n) => agent.makeReal({ ...parallelIntent, actionId: 'bulk-interleaved-' + n, amount: '1' })));
  const ids = parallel.map(row => row.request.requestId);
  await progress(async () => (await getRuntime().bulkMints.status(id)).payable && ids.every(id => getRuntime().mints.public(id).payable));
  const reserveBatch = getStore().list('batches', { limit: 1000 }).find(({ value }) =>
    value.batch.ops.some(op => op.op === 'fp' && op.type === 'bulk-open' && op.id === id)).value.batch;
  const accountPacket = reserveBatch.ops.filter(op => op.op === 'ar' && op.actions.some(a => a.id === id));
  assert.equal(accountPacket.length, 1); assert.equal(accountPacket[0].accounts.length, 1);
  assert.deepEqual(accountPacket[0].actions.map(a => a.id).sort(), [id, ...ids].sort());
  pass('64-member kit bulk reservation and three same-owner reserve-n mints accepted while bulk pending');
  mark('reserved');
  const wallet = new TapWalletBulkMint({ provider: transport.provider, network: 'regtest', journal: transport.walletJournal,
    fetchImpl: transport.fetchImpl,
    readTip: () => bitcoin(stack, 'getblockcount'),
    readStatus: id => service.bulkMintStatus(id), readTerms: id => service.bulkMintTerms(id),
    reportPayment: async report => { await sync(); return service.request('/mint/bulk/payment', { value: report }); } });
  const totals = new Map();
  for (const g of [...quote.terms.groups, ...(quote.deployerPayment ? [quote.deployerPayment] : [])])
    totals.set(g.to, (totals.get(g.to) ?? 0n) + BigInt(g.amount));
  const paidBalances = new Map(await Promise.all([...totals.keys()].map(async to => [to, await tap('getBalance/' + to + '/tap')])));
  await wallet.connect(); const payment = await wallet.pay(id);
  for (const [to, amount] of totals) assert.equal(String(await tap('getBalance/' + to + '/tap') ?? '0'),
    String(BigInt(paidBalances.get(to) ?? '0') + amount));
  mark('paid');
  await progress(async () => (await getRuntime().bulkMints.status(id)).progress.issued === 64);
  mark('issued'); pass('one real bulk wallet redeem funds every group; all 64 member obligations issued');
  await progress(async () => (await getRuntime().bulkMints.status(id)).permit.readyCount > 0);
  const issued = await getRuntime().bulkMints.status(id); assert.equal(issued.progress.minted, 0);
  await restart();
  await wallet.pay(id); assert.equal(transport.payments(), 1);
  mark('restarted');
  pass('gateway store/runtime and all five HTTP signers restarted after issue; saved wallet receipt did not pay again');
  await progress(async () => (await getRuntime().bulkMints.status(id)).permit.complete);
  mark('permitsReady');
  const sender = transport.sender(service.origin);
  await sender.discover(); await sender.attempt(id);
  const sending = transport.journal.bulk(id); assert.ok(sending.plan, JSON.stringify({ state: sending.state, reason: sending.reason }));
  await mine(stack); await sync(); await sender.attempt(id);
  await progress(async () => (await getRuntime().bulkMints.status(id)).state === 'minted');
  await sender.process(id); assert.equal(transport.journal.bulk(id).state, 'minted');
  mark('bulkComplete');
  // Finish the interleaved single mints too, using their original reservations.
  for (const single of ids) {
    const fees = getStore().get('mints', single).quote.fees;
    // The caller owns the original rehearsal payer/authority.
    await paySingle(single, fees);
  }
  await progress(() => ids.every(id => getRuntime().mints.public(id).state === 'permit_issued'));
  const singleInscriptions = [];
  for (const single of ids) singleInscriptions.push(await inscription(getRuntime().mints.public(single).permit, receiver));
  await sync();
  for (const [i, single] of ids.entries()) await service.reportMintPayment({ id: single, inscription: singleInscriptions[i] });
  await progress(() => ids.every(id => getRuntime().mints.public(id).state === 'minted'));
  mark('singlesComplete');
  const publicResponse = await fetch(service.origin + '/web-api/mint/bulk/' + id); assert.equal(publicResponse.status, 200);
  const status = await publicResponse.json(); assert.equal(status.state, 'minted'); assert.equal(status.progress.minted, 64); assert.equal(status.progress.unresolved, 0);
  const t = quote.terms, store = getStore();
  const fund = contract.db.get('fp/' + id); assert.equal(fund.finishedMask, bulkAllMask(64).toString());
  assert.equal(contract.db.get('fd/' + t.generation).minted, t.totalAmount); assert.equal(contract.db.get('fd/' + t.generation).reserved, '0');
  assert.equal(contract.db.get(capacityKey(t.deployment)), '0');
  const head = store.get('accountRecords', 'ar/' + agent.owner), key = accountKey('balance', entry.asset);
  const balance = readAccountLeaf(head.root, new AccountAvailability(store).prove(head.root, [key]), key);
  assert.equal(balance?.available ?? '0', '0'); assert.equal(balance?.held ?? '0', '0');
  const supplyHead = store.get('accountRecords', 'ar/supply'), supplyKey = accountKey('supply', entry.asset);
  const supply = readAccountLeaf(supplyHead.root, new AccountAvailability(store).prove(supplyHead.root, [supplyKey]), supplyKey);
  assert.deepEqual(supply, { issued: t.totalAmount, burned: t.totalAmount });
  assert.equal(store.count('activeBulkOrders'), 0); assert.equal(store.count('financialAdmissionCount'), 0);
  for (const reveal of sending.plan.reveals) for (const m of reveal.members) {
    const indexed = await (await fetch(stack.ord.url + '/inscription/' + m.inscription, { headers: { accept: 'application/json' } })).json();
    assert.equal(indexed.address, receiver); assert.equal(indexed.satpoint, `${reveal.txid}:${m.output}:0`);
    assert.equal(contract.db.get('dc/' + bulkMemberId(id, m.index)).state, 'minted');
    assert.equal(contract.db.get(plotKey(t.asset, t.members[m.index].block, t.supplyScope)).state, 'minted');
  }
  assert.equal(await tap('getBalance/' + receiver + '/dmt-' + entry.tick), t.totalAmount);
  assert.equal(await tap('getMintTokensLeft/' + entry.indexTick), String(BigInt(contract.db.get('fd/' + t.generation).maximum) - BigInt(t.totalAmount)));
  assert.equal(await tap('getBalance/' + transport.payer + '/tap'), String(1000n * 10n ** 18n - BigInt(t.payableFeeAtoms) - BigInt(quote.deployerPayment?.amount ?? '0')));
  const transfers = await tap('getTransferredList/' + payment.paymentId.slice(0, 64) + '?offset=0&max=500');
  assert.equal(transfers.filter(row => row.ins === payment.paymentId && row.fail === false).length, t.groups.length + (quote.deployerPayment ? 1 : 0));
  assert.equal((await bitcoin(stack, 'getnetworkinfo')).connections, 0);
  const participatingSigners = [...new Set(store.list('ceremonies', { limit: 1000 })
    .filter(({ value }) => value.proposal?.orderId === id).flatMap(({ value }) => value.peers))];
  assert.equal(participatingSigners.length, 5);
  pass('64 ord-TAP receiver satpoints, all terminal plots, units/capacity/supply, public bulk completion and three interleaved single completions');
  const stages = {};
  for (const { value } of store.list('batches', { limit: 1000 })) {
    const ops = value.batch.ops, bulkOps = ops.filter(op => op.id === id || op.actions?.some(a => a.id === id));
    if (!bulkOps.length) continue;
    const stage = bulkOps.find(op => op.op === 'fp')?.type ?? 'account';
    const row = stages[stage] ??= { batches: 0, operations: 0, operationBytes: 0, batchBytes: 0, auditBytes: 0 };
    row.batchNumbers ??= []; row.batchNumbers.push(value.batch.n);
    row.batches++; row.operations += bulkOps.length; row.operationBytes += Buffer.byteLength(r.stableJSON(bulkOps)); row.batchBytes += Buffer.byteLength(r.stableJSON(value.batch));
    for (const p of value.publications) row.auditBytes += (await readFile(join(store.directory, 'static', p.audit.path.slice(1)))).length;
  }
  const values = getRuntime().settings.document.values;
  for (const [stage, row] of Object.entries(stages)) {
    // Conservative homogeneous-order packing: charge every order the measured
    // proofs and full audit envelope, and reserve the normal batch envelope.
    const candidates = {
      transitions: Math.floor(values.mintOperationBudget / row.batches),
      operations: Math.floor((values.batchOps - 2) / row.operations),
      bytes: Math.floor((values.batchBytes - values.batchEnvelopeReserveBytes) / row.operationBytes),
      audit: Math.floor(values.auditTotalBytes / row.auditBytes),
      members: ['bulk-open', 'bulk-consume', 'bulk-finish'].includes(stage) ? Math.floor(BULK_LIMITS.memberWork / 64) : Number.MAX_SAFE_INTEGER,
      groups: ['bulk-open', 'bulk-fund', 'bulk-consume'].includes(stage) ? Math.floor(BULK_LIMITS.groupWork / t.groups.length) : Number.MAX_SAFE_INTEGER
    };
    row.ordersPerBatch = Math.min(...Object.values(candidates)); row.capacityBounds = candidates;
    row.bindingLimits = Object.entries(candidates).filter(([, n]) => n === row.ordersPerBatch).map(([name]) => name);
  }
  const batchesPerOrder = Object.values(stages).reduce((sum, row) => sum + 1 / row.ordersPerBatch, 0);
  const blockoutOrders = Math.ceil(974000 / 64), blockoutBatches = Object.values(stages).reduce((sum, row) => sum + Math.ceil(blockoutOrders / row.ordersPerBatch), 0);
  const capacity = { method: 'conservative measured shape; all lifecycle stages share the same batch capacity', batchesPerOrder,
    mintsPerBitcoinBlock: 128 / batchesPerOrder, blockoutOrders, blockoutBatches, blockoutDays: blockoutBatches / (2 * 144),
    fits14Days: blockoutBatches <= 14 * 2 * 144 };
  const transactions = [sending.plan.commit, ...sending.plan.reveals].map(tx => btc.Transaction.fromRaw(unhex(tx.hex), { allowUnknownInputs: true, allowUnknownOutputs: true }));
  const bitcoinFootprint = { mintBytes: transactions.reduce((n, tx) => n + tx.hex.length / 2, 0),
    mintVbytes: transactions.reduce((n, tx) => n + tx.vsize, 0), mintWeight: transactions.reduce((n, tx) => n + tx.weight, 0),
    mintFeeSats: sending.plan.feeSats, fundingSats: t.mintFunding.satoshis, changeSats: sending.plan.changeSats };
  const measurement = { capacity, bitcoinFootprint, elapsedMs, participatingSigners, members: 64, units: t.totalAmount, paymentApprovals: transport.payments(), payment: payment.paymentId,
    groups: t.groups.length, commitTransactions: 1, revealTransactions: sending.plan.reveals.length, interleavedSingles: ids.length,
    restart: { issued: issued.progress.issued, finished: issued.progress.minted, readyPermits: issued.permit.readyCount }, settings: BULK_CAPACITY_VALUES, stages, status };
  await writeFile(join(directory, 'bulk-results.json'), JSON.stringify(measurement, null, 2)); return measurement;
}
