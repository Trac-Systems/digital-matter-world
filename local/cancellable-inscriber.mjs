import { open, mkdir, readFile, rename, unlink, readdir, realpath, lstat, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { BUILD, bitcoin, diskCheck, run } from './common.mjs';
import { sha256 } from './protocol.mjs';

const NETWORK = { ...btc.TEST_NETWORK, bech32: 'bcrt' };
const RBF = 0xfffffffd, DUST = 546n;
const hex = bytes => Buffer.from(bytes).toString('hex');
const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, ordered(value[k])])) : value;
const hashObject = value => sha256(JSON.stringify(ordered(value)));
const check = (ok, message) => { if (!ok) throw new Error(message); };
const absent = error => error.code === 'ENOENT';
const sats = amount => BigInt(Math.round(amount * 1e8));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
const identity = async pid => (await run('ps', ['-p', String(pid), '-o', 'lstart='])).stdout.trim();

async function syncDirectory(directory) { const fd = await open(directory, 'r'); try { await fd.sync(); } finally { await fd.close(); } }
async function durable(directory, name, data) {
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  const fd = await open(temporary, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify({ checksum: hashObject(data), data }) + '\n'); await fd.sync(); }
  finally { await fd.close(); }
  await rename(temporary, join(directory, name)); await syncDirectory(directory);
}
async function readRecord(directory, name) {
  const record = JSON.parse(await readFile(join(directory, name), 'utf8'));
  check(record.checksum === hashObject(record.data), 'Inscriber journal checksum mismatch');
  return record.data;
}
function pointer(value) {
  const result = [];
  for (let n = BigInt(value); n; n >>= 8n) result.push(Number(n & 255n));
  return Uint8Array.from(result);
}
function inscriptionScript(publicKey, text, offset) {
  const body = Buffer.from(text);
  const script = [publicKey, 'CHECKSIG', 0, 'IF', Buffer.from('ord'), Uint8Array.of(1), Buffer.from('text/plain;charset=utf-8'), Uint8Array.of(2), pointer(offset), 0];
  for (let i = 0; i < body.length; i += 520) script.push(body.subarray(i, i + 520));
  return btc.Script.encode([...script, 'ENDIF']);
}
function normalized(entries, defaults, maxBodyBytes) {
  check(Array.isArray(entries) && entries.length > 0 && entries.length <= 100, 'Expected 1..100 inscriptions');
  const result = entries.map((entry, i) => {
    const value = entry.text ?? entry.permit;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    check(typeof text === 'string' && Buffer.byteLength(text) > 0 && Buffer.byteLength(text) <= maxBodyBytes, 'Invalid inscription content size');
    const created = entry.created ?? defaults.created, expiry = entry.expiry ?? defaults.expiry;
    check(Number.isSafeInteger(created) && Number.isSafeInteger(expiry) && created >= 0 && expiry > created && expiry <= 0xffffffff, 'Expected accepted creation and expiry heights');
    check(typeof entry.receiver === 'string', 'Missing receiver');
    btc.Address(NETWORK).decode(entry.receiver);
    return { id: entry.id ?? hashObject([i, text, entry.receiver, created, expiry]), text, receiver: entry.receiver, created, expiry };
  });
  check(result.every(e => typeof e.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(e.id)), 'Invalid request ID');
  check(new Set(result.map(e => e.id)).size === result.length, 'Duplicate request ID');
  check(result.reduce((n, e) => n + Buffer.byteLength(e.text), 0) <= 80000, 'Batch content exceeds 80000 bytes');
  return result;
}
function timing(entries, counted) {
  check(Number.isSafeInteger(counted) && counted >= 0, 'Invalid counted height');
  return {
    counted,
    mayBroadcast: entries.every(e => counted >= e.created && 2 * (counted - e.created) <= e.expiry - e.created),
    cancelDue: entries.some(e => 4 * (counted - e.created) >= 3 * (e.expiry - e.created)),
  };
}
function transactionInfo(tx, fee) {
  check(tx.isFinal && tx.weight <= 400000, 'Transaction is incomplete or exceeds standard weight');
  return { txid: tx.id, hex: tx.hex, feeSats: String(fee), vsize: tx.vsize };
}

/** A single-writer, regtest-only adapter. Back up both its directory and its Core wallet. */
export class CancellableInscriber {
  static async open({ manifest, directory, countedHeight, feeRate = 2, cancelFeeRate = 20, postage = 10000, maxBodyBytes = 4096, quoteSats }) {
    check(typeof countedHeight === 'function', 'A countedHeight reader is required; raw Bitcoin height is not the service clock');
    check(typeof directory === 'string' && directory === resolve(directory) && directory.startsWith(BUILD + '/'), 'Use an absolute private directory under the shared build directory');
    check(Number.isSafeInteger(feeRate) && feeRate >= 1 && feeRate <= 1000 && Number.isSafeInteger(cancelFeeRate) && cancelFeeRate > feeRate && cancelFeeRate <= 10000, 'Invalid fee rates');
    check(Number.isSafeInteger(postage) && postage >= 546 && postage <= 1000000, 'Invalid postage');
    check(Number.isSafeInteger(maxBodyBytes) && maxBodyBytes >= 1 && maxBodyBytes <= 80000, 'Invalid body bound');
    check(quoteSats === undefined || typeof quoteSats === 'string' && /^[1-9][0-9]*$/.test(quoteSats), 'Invalid network fee quote');
    await diskCheck();
    check((await bitcoin(manifest, 'getblockchaininfo')).chain === 'regtest', 'Only Bitcoin regtest is supported');
    check((await bitcoin(manifest, 'getindexinfo')).txindex?.synced, 'A synced txindex is required');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    check(!(await lstat(directory)).isSymbolicLink() && await realpath(directory) === directory, 'Refusing symlinked journal directory');
    check(((await lstat(directory)).mode & 0o077) === 0, 'Journal directory must be private (0700)');
    const adapter = new CancellableInscriber();
    Object.assign(adapter, { manifest, directory, countedHeight, feeRate, cancelFeeRate, postage, maxBodyBytes, quoteSats, tail: Promise.resolve(), closed: false });
    adapter.wallet = 'dmw-inscriber-' + sha256(directory).slice(0, 20);
    const lockPath = join(directory, 'writer.lock');
    // Serialize stale-lock replacement. A crash during acquisition fails closed.
    const acquiring = join(directory, 'writer-acquire');
    await mkdir(acquiring, { mode: 0o700 });
    let lock;
    try {
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = JSON.parse(await readFile(lockPath, 'utf8'));
        check(Number.isSafeInteger(previous.pid) && previous.pid > 0 && typeof previous.identity === 'string', 'Invalid writer lock; manual recovery required');
        check(!alive(previous.pid) || await identity(previous.pid) !== previous.identity, 'Inscriber already has a live writer');
        await unlink(lockPath); lock = await open(lockPath, 'wx', 0o600);
      }
      try { await lock.writeFile(JSON.stringify({ pid: process.pid, identity: await identity(process.pid) })); await lock.sync(); }
      finally { await lock.close(); }
    } finally { await rmdir(acquiring); }
    await syncDirectory(directory);
    try {
      const owner = { version: 1, network: 'regtest', bitcoinRoot: manifest.root, wallet: adapter.wallet };
      const previous = await readRecord(directory, 'owner.json').catch(error => { if (!absent(error)) throw error; return null; });
      check(!previous || hashObject(previous) === hashObject(owner), 'Journal belongs to another chain run or wallet');
      if (!previous) await durable(directory, 'owner.json', owner);
      const loaded = await bitcoin(manifest, 'listwallets');
      if (!loaded.includes(adapter.wallet)) {
        const wallets = (await bitcoin(manifest, 'listwalletdir')).wallets;
        if (wallets.some(w => w.name === adapter.wallet)) await bitcoin(manifest, 'loadwallet', [adapter.wallet]);
        else await bitcoin(manifest, 'createwallet', [adapter.wallet, false, false, '', false, true]);
      }
      const info = await adapter.rpc('getwalletinfo');
      check(info.descriptors && info.private_keys_enabled, 'Dedicated wallet must own its descriptor keys');
      adapter.records = new Map();
      for (const name of await readdir(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const record = await readRecord(directory, name);
        check(record.id + '.json' === name, 'Journal ID mismatch');
        adapter.records.set(record.id, record);
      }
      return adapter;
    } catch (error) { await adapter.close(); throw error; }
  }
  rpc(method, params = []) { return bitcoin(this.manifest, method, params, this.wallet); }
  serial(fn) {
    const next = this.tail.then(() => { check(!this.closed, 'Inscriber is closed'); return fn(); });
    this.tail = next.catch(() => {}); return next;
  }
  async close() {
    await this.tail;
    if (this.closed) return;
    this.closed = true; await unlink(join(this.directory, 'writer.lock')); await syncDirectory(this.directory);
  }
  async receiveAddress() { return this.serial(() => this.rpc('getnewaddress', ['', 'bech32'])); }
  quote() { check(this.quoteSats !== undefined, 'Configure quoteSats from the service network-fee policy'); return this.quoteSats; }
  async persist(record) { await durable(this.directory, record.id + '.json', record); this.records.set(record.id, record); }
  handle(record) { check(record.prepared, 'Batch preparation is incomplete'); return structuredClone(record.prepared); }
  async load(id) { return this.serial(async () => this.handle(await this.read(id))); }
  async read(id) {
    check(typeof id === 'string' && /^[a-f0-9]{64}$/.test(id), 'Batch ID must be 64 lowercase hex characters');
    return readRecord(this.directory, id + '.json');
  }
  async checked(handle) {
    const record = await this.read(typeof handle === 'string' ? handle : handle.id);
    check(record.prepared && record.prepared.digest === hashObject({ ...record.prepared, digest: undefined }), 'Invalid prepared package digest');
    if (typeof handle !== 'string') check(hashObject(handle) === hashObject(record.prepared), 'Prepared handle differs from the durable package');
    return record;
  }
  prepareBatch(id, requests) { return this.prepare(requests, { id }); }
  prepare(entries, options = {}) {
    return this.serial(async () => {
      await diskCheck();
      const requests = normalized(entries, options, this.maxBodyBytes);
      const id = options.id ?? hashObject(requests);
      check(/^[a-f0-9]{64}$/.test(id), 'Batch ID must be 64 lowercase hex characters');
      let record = await this.read(id).catch(error => { if (!absent(error)) throw error; return null; });
      if (record) {
        check(hashObject(record.requests) === hashObject(requests), 'Batch ID already binds different requests');
        if (record.prepared) return this.handle(record);
      }
      check(timing(requests, await this.countedHeight()).mayBroadcast, 'Preparation outside first half of pending lifetime');
      if (!record) {
        const assigned = new Set([...this.records.values()].flatMap(r => r.requests.map(request => request.id)));
        check(requests.every(request => !assigned.has(request.id)), 'Request already assigned to another durable batch');
        const recovery = await this.rpc('getnewaddress', ['', 'bech32']);
        record = { version: 1, id, requests, recovery, keys: { internal: hex(randomBytes(32)), script: hex(randomBytes(32)) }, policy: { feeRate: this.feeRate, cancelFeeRate: this.cancelFeeRate, postage: this.postage }, broadcastIntent: false, cancelIntent: false };
        await this.persist(record);
      }
      await this.build(record);
      return this.handle(record);
    });
  }
  async build(record) {
    const { requests, recovery, policy } = record, n = requests.length;
    const internal = bytes(record.keys.internal), scriptKey = bytes(record.keys.script);
    const leaves = requests.map((request, i) => btc.p2tr(schnorr.getPublicKey(internal), { script: inscriptionScript(schnorr.getPublicKey(scriptKey), request.text, i * policy.postage) }, NETWORK, true));
    const recoveryScript = btc.OutScript.encode(btc.Address(NETWORK).decode(recovery));
    const revealTx = (commit, amounts, change, signing = false) => {
      const tx = new btc.Transaction({ allowUnknownInputs: true });
      leaves.forEach((leaf, i) => tx.addInput({ txid: commit, index: i, sequence: RBF, witnessUtxo: { script: leaf.script, amount: amounts[i] }, tapInternalKey: leaf.tapInternalKey, tapMerkleRoot: leaf.tapMerkleRoot, tapLeafScript: leaf.tapLeafScript }));
      requests.forEach(request => tx.addOutputAddress(request.receiver, BigInt(policy.postage), NETWORK));
      tx.addOutput({ script: recoveryScript, amount: change });
      if (signing) { leaves.forEach((_, i) => tx.signIdx(scriptKey, i)); tx.finalize(); }
      else leaves.forEach((leaf, i) => tx.updateInput(i, { finalScriptWitness: [new Uint8Array(64), leaf.tapLeafScript[0][1].slice(0, -1), btc.TaprootControlBlock.encode(leaf.tapLeafScript[0][0])] }, true));
      return tx;
    };
    const cancelTx = (commit, amounts, output, signing = false) => {
      const tx = new btc.Transaction();
      leaves.forEach((leaf, i) => tx.addInput({ txid: commit, index: i, sequence: RBF, witnessUtxo: { script: leaf.script, amount: amounts[i] }, tapInternalKey: leaf.tapInternalKey, tapMerkleRoot: leaf.tapMerkleRoot }));
      tx.addOutput({ script: recoveryScript, amount: output });
      if (signing) { leaves.forEach((_, i) => tx.signIdx(internal, i)); tx.finalize(); }
      else leaves.forEach((_, i) => tx.updateInput(i, { finalScriptWitness: [new Uint8Array(64)] }, true));
      return tx;
    };
    if (!record.plan) {
      const dummy = leaves.map(() => 1000000n), zero = '00'.repeat(32);
      const revealSize = revealTx(zero, dummy, DUST).vsize, cancelSize = cancelTx(zero, dummy, DUST).vsize;
      const incrementalRate = Math.max(1, Math.ceil((await bitcoin(this.manifest, 'getmempoolinfo')).incrementalrelayfee * 1e8 / 1000));
      const revealFee = BigInt(revealSize * policy.feeRate);
      const childFee = [BigInt(cancelSize * policy.cancelFeeRate), revealFee + BigInt(cancelSize * incrementalRate) + 1n].reduce((a, b) => a > b ? a : b);
      const total = BigInt(n * policy.postage) + revealFee + childFee + DUST;
      const amounts = Array.from({ length: n }, (_, i) => total / BigInt(n) + (i === n - 1 ? total % BigInt(n) : 0n));
      const reserved = new Set([...this.records.values()].flatMap(r => (r.plan?.inputs ?? []).map(i => `${i.txid}:${i.vout}`)));
      const coins = (await this.rpc('listunspent', [1, 9999999])).filter(c => c.spendable && c.solvable && c.safe && /^(0014[0-9a-f]{40}|5120[0-9a-f]{64})$/.test(c.scriptPubKey) && !reserved.has(`${c.txid}:${c.vout}`)).sort((a, b) => b.amount - a.amount);
      let inputs = [], sum = 0n, commitFee, parentFee;
      for (const coin of coins.slice(0, 16)) {
        inputs.push({ txid: coin.txid, vout: coin.vout, amount: String(sats(coin.amount)), script: coin.scriptPubKey }); sum += sats(coin.amount);
        const commitSize = 20 + inputs.length * 70 + (n + 1) * 43, parentSize = 20 + inputs.length * 70 + 43;
        commitFee = BigInt(commitSize * policy.feeRate);
        parentFee = [BigInt(parentSize * policy.cancelFeeRate), commitFee + revealFee + BigInt(parentSize * incrementalRate) + 1n].reduce((a, b) => a > b ? a : b);
        if (sum >= total + commitFee + DUST && sum >= parentFee + DUST) break;
      }
      check(inputs.length && sum >= total + commitFee + DUST && sum >= parentFee + DUST, 'Fund the dedicated wallet with confirmed cardinal BTC (at most 16 inputs per batch)');
      record.plan = { inputs, amounts: amounts.map(String), total: String(total), revealFee: String(revealFee), childFee: String(childFee), commitFee: String(commitFee), parentFee: String(parentFee) };
      await this.persist(record);
    }
    const plan = record.plan, inputs = plan.inputs, amounts = plan.amounts.map(BigInt), sum = inputs.reduce((v, i) => v + BigInt(i.amount), 0n), total = BigInt(plan.total);
    const existingLocks = new Set((await this.rpc('listlockunspent')).map(i => `${i.txid}:${i.vout}`));
    const toLock = inputs.filter(i => !existingLocks.has(`${i.txid}:${i.vout}`)).map(({ txid, vout }) => ({ txid, vout }));
    if (toLock.length) check(await this.rpc('lockunspent', [false, toLock]), 'Cannot reserve funding inputs');
    const walletTx = async outputs => {
      const tx = new btc.Transaction();
      for (const input of inputs) tx.addInput({ txid: input.txid, index: input.vout, sequence: RBF, witnessUtxo: { script: bytes(input.script), amount: BigInt(input.amount) } });
      for (const output of outputs) tx.addOutput(output);
      const psbt = await this.rpc('walletprocesspsbt', [Buffer.from(tx.toPSBT()).toString('base64')]);
      const signed = await bitcoin(this.manifest, 'finalizepsbt', [psbt.psbt]);
      check(signed.complete, 'Wallet did not sign all funding inputs');
      return btc.Transaction.fromRaw(bytes(signed.hex));
    };
    const commit = await walletTx([...leaves.map((leaf, i) => ({ script: leaf.script, amount: amounts[i] })), { script: recoveryScript, amount: sum - total - BigInt(plan.commitFee) }]);
    const reveal = revealTx(commit.id, amounts, total - BigInt(n * policy.postage) - BigInt(plan.revealFee), true);
    const cancelCommit = await walletTx([{ script: recoveryScript, amount: sum - BigInt(plan.parentFee) }]);
    const cancelReveal = cancelTx(commit.id, amounts, total - BigInt(plan.childFee), true);
    const prepared = { version: 1, id: record.id, cancellable: true, commit: transactionInfo(commit, plan.commitFee), reveal: transactionInfo(reveal, plan.revealFee), cancelCommit: transactionInfo(cancelCommit, plan.parentFee), cancelReveal: transactionInfo(cancelReveal, plan.childFee), inscriptions: requests.map((r, i) => ({ requestId: r.id, id: `${reveal.id}i${i}`, receiver: r.receiver, contentHash: sha256(r.text) })), windows: requests.map(({ id, created, expiry }) => ({ id, created, expiry })) };
    for (const raws of [[commit.hex, reveal.hex], [cancelCommit.hex], [commit.hex, cancelReveal.hex]]) {
      const checks = await bitcoin(this.manifest, 'testmempoolaccept', [raws]);
      check(checks.length === raws.length && checks.every(c => c.allowed), 'Prepared transaction failed Bitcoin policy/signature validation: ' + JSON.stringify(checks.map(c => ({ txid: c.txid, allowed: c.allowed, reason: c['reject-reason'] ?? c['package-error'] }))));
    }
    prepared.digest = hashObject(prepared); record.prepared = prepared;
    await this.persist(record);
  }
  async observed(tx) {
    const raw = await bitcoin(this.manifest, 'getrawtransaction', [tx.txid, true]).catch(error => { if (error.rpcCode === -5) return null; throw error; });
    let mempool = false;
    if (raw && !(raw.confirmations > 0)) mempool = Boolean(await bitcoin(this.manifest, 'getmempoolentry', [tx.txid]).catch(error => { if (error.rpcCode === -5) return null; throw error; }));
    return { txid: tx.txid, known: Boolean(raw), mempool, confirmations: Math.max(0, raw?.confirmations ?? 0) };
  }
  async observe(record) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const tip = await bitcoin(this.manifest, 'getbestblockhash');
      const [commit, reveal, cancelCommit, cancelReveal] = await Promise.all(['commit', 'reveal', 'cancelCommit', 'cancelReveal'].map(key => this.observed(record.prepared[key])));
      if (tip !== await bitcoin(this.manifest, 'getbestblockhash')) continue;
      const cancelConfirmations = reveal.confirmations ? 0 : Math.max(cancelCommit.confirmations, cancelReveal.confirmations);
      return { id: record.id, commit, reveal, cancelCommit, cancelReveal, broadcast: record.broadcastIntent || commit.mempool || commit.confirmations > 0 || reveal.mempool || reveal.confirmations > 0, cancellationRequested: record.cancelIntent, cancelConfirmations, safeToReturn: cancelConfirmations >= 6, state: reveal.confirmations ? 'minted' : cancelConfirmations ? 'cancelled' : record.cancelIntent ? 'cancelling' : record.broadcastIntent ? 'broadcast' : 'prepared', ...timing(record.requests, await this.countedHeight()), inscriptions: record.prepared.inscriptions };
    }
    throw new Error('Chain tip changed repeatedly while reading transaction status');
  }
  status(handle) { return this.serial(async () => this.observe(await this.checked(handle))); }
  async send(tx) {
    const seen = await this.observed(tx);
    if (seen.mempool || seen.confirmations) return;
    const id = await bitcoin(this.manifest, 'sendrawtransaction', [tx.hex]);
    check(id === tx.txid, 'Broadcast transaction identity mismatch');
  }
  broadcast(handle, { commitOnly = false } = {}) {
    return this.serial(async () => {
      const record = await this.checked(handle);
      check(!record.cancelIntent, 'Cancellation is permanent; refusing mint rebroadcast');
      let status = await this.observe(record);
      if (status.reveal.confirmations || status.reveal.mempool) return status;
      check(status.mayBroadcast, 'Broadcast outside first half of pending lifetime');
      check(!status.cancelConfirmations, 'Batch already cancelled');
      record.broadcastIntent = true; await this.persist(record);
      await this.send(record.prepared.commit);
      if (!commitOnly) {
        check(timing(record.requests, await this.countedHeight()).mayBroadcast, 'Reveal broadcast outside first half of pending lifetime');
        await this.send(record.prepared.reveal);
      }
      return this.observe(record);
    });
  }
  cancel(handle) {
    return this.serial(async () => {
      const record = await this.checked(handle);
      record.cancelIntent = true; await this.persist(record);
      let status = await this.observe(record);
      if (status.reveal.confirmations || status.cancelConfirmations) return { ...status, tooLate: status.reveal.confirmations > 0, commitAlreadyConfirmed: status.commit.confirmations > 0 };
      const sendChild = () => this.send(record.prepared.cancelReveal);
      if (status.commit.confirmations) await sendChild();
      else {
        try { await this.send(record.prepared.cancelCommit); }
        catch (error) {
          status = await this.observe(record);
          if (status.reveal.confirmations) return { ...status, tooLate: true, commitAlreadyConfirmed: true };
          if (!status.commit.confirmations) throw error;
          await sendChild();
        }
      }
      status = await this.observe(record);
      return { ...status, tooLate: false, commitAlreadyConfirmed: status.commit.confirmations > 0 };
    });
  }
}
