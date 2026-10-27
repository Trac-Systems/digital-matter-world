import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { CancellableInscriber } from '../cancellable-inscriber.mjs';
import { bitcoin, mine, ordJson, receiveAddress, save, waitFor, ROOT } from '../common.mjs';
import { authority, mintPermit, sha256, testKey } from '../protocol.mjs';
import { sendInscription } from '../inscriber.mjs';

export async function proveCancellable(manifest, t) {
  const directory = manifest.root + '/cancellable-inscriber';
  let countedOverride, adapter;
  const config = { manifest, directory, countedHeight: () => countedOverride ?? bitcoin(manifest, 'getblockcount'), quoteSats: '100000' };
  const cases = [], evidence = { directory, cases };
  const check = async (name, fn) => {
    const wrapped = async () => { await fn(); cases.push(name); };
    if (t) await t.test(name, wrapped); else { console.log(name); await wrapped(); }
  };
  const tap = async path => (await ordJson(manifest, '/r/tap/' + path)).result;
  const key = testKey(), alice = await receiveAddress(manifest), bob = await receiveAddress(manifest);
  const tick = 'can' + sha256(directory).slice(0, 10), ticker = 'dmt-' + tick;
  const requests = async entries => {
    const created = await bitcoin(manifest, 'getblockcount');
    return entries.map((e, i) => ({ ...e, id: sha256(JSON.stringify([e, i])), created, expiry: created + 1000 }));
  };
  const prepared = async entries => adapter.prepareBatch(sha256(JSON.stringify(entries)), entries);
  const finish = async package_ => { await adapter.broadcast(package_); await mine(manifest); };
  let deployment;
  const mints = async blocks => requests(blocks.map((blk, i) => ({ permit: mintPermit({ tick, blk, dep: deployment, address: i % 2 ? bob : alice }, key), receiver: i % 2 ? bob : alice })));
  const noMints = async (package_, blocks) => {
    for (const block of blocks) assert.equal(await tap(`getDmtMintHolderByBlock/${ticker}/${block}`), null);
    for (const inscription of package_.inscriptions) await assert.rejects(ordJson(manifest, '/inscription/' + inscription.id), error => error.status === 404);
    const seen = await adapter.status(package_);
    assert.equal(seen.reveal.confirmations, 0); assert.equal(seen.reveal.mempool, false);
  };
  const confirmCancellation = async (package_, blocks) => {
    await mine(manifest); let status = await adapter.status(package_);
    assert.equal(status.cancelConfirmations, 1); assert.equal(status.safeToReturn, false);
    await mine(manifest, 4); status = await adapter.status(package_);
    assert.equal(status.cancelConfirmations, 5); assert.equal(status.safeToReturn, false);
    await mine(manifest); status = await adapter.status(package_);
    assert.equal(status.cancelConfirmations, 6); assert.equal(status.safeToReturn, true);
    await noMints(package_, blocks);
    await mine(manifest, 10); await noMints(package_, blocks);
    assert.equal((await adapter.status(package_)).cancelConfirmations, 16);
    // The losing bytes remain invalid even if somebody tries to send them again.
    const rejected = await bitcoin(manifest, 'testmempoolaccept', [[package_.reveal.hex]]);
    assert.equal(rejected[0].allowed, false);
  };
  try {
    adapter = await CancellableInscriber.open(config);
    assert.equal(adapter.quote({ asset: 'local' }), '100000');
    await assert.rejects(CancellableInscriber.open(config), /live writer/);
    await bitcoin(manifest, 'sendtoaddress', [await adapter.receiveAddress(), 1], 'faucet'); await mine(manifest);
    const existing = (await tap('getDmtElementsList')).find(e => e.pat === '[0-9]' && e.fld === 4);
    const setupEntries = [{ permit: authority(key, { privilege: true }), receiver: alice }];
    if (!existing) setupEntries.push({ text: `${tick}.[0-9].4.element`, receiver: alice });
    const setup = await prepared(await requests(setupEntries)); await finish(setup);
    const privilege = setup.inscriptions[0].id, element = existing?.ins ?? setup.inscriptions[1].id;
    await sendInscription(manifest, privilege, alice); await mine(manifest);
    const deploy = await prepared(await requests([{ permit: { p: 'tap', op: 'dmt-deploy', tick, elem: element, dt: 'n', prv: privilege }, receiver: alice }]));
    await finish(deploy); deployment = deploy.inscriptions[0].id;
    assert.equal((await tap(`getDeployment/${ticker}`)).prv, privilege);
    Object.assign(evidence, { ticker, deployment, privilege, alice, bob });

    await check('cancellable prepare signs and journals 100 DMT mints without broadcasting; all receivers index correctly', async () => {
      const entries = await mints(Array.from({ length: 100 }, (_, i) => i + 1));
      const before = await bitcoin(manifest, 'getrawmempool');
      const package_ = await prepared(entries); evidence.normal = package_;
      assert.equal(package_.cancellable, true); assert.equal(package_.inscriptions.length, 100);
      assert.deepEqual(await bitcoin(manifest, 'getrawmempool'), before);
      assert.deepEqual(await adapter.prepareBatch(package_.id, entries), package_);
      const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
      assert.equal((await adapter.status(sorted(package_))).state, 'prepared', 'Service storage may reorder object keys');
      assert.equal((await stat(`${directory}/${package_.id}.json`)).mode & 0o777, 0o600);
      const commit = await bitcoin(manifest, 'decoderawtransaction', [package_.commit.hex]);
      const cancel = await bitcoin(manifest, 'decoderawtransaction', [package_.cancelCommit.hex]);
      const reveal = await bitcoin(manifest, 'decoderawtransaction', [package_.reveal.hex]);
      const child = await bitcoin(manifest, 'decoderawtransaction', [package_.cancelReveal.hex]);
      assert(commit.vin.every(v => v.sequence < 0xfffffffe));
      assert.deepEqual(commit.vin.map(v => [v.txid, v.vout]), cancel.vin.map(v => [v.txid, v.vout]));
      assert.deepEqual(reveal.vin.map(v => [v.txid, v.vout]), child.vin.map(v => [v.txid, v.vout]));
      assert(BigInt(package_.cancelCommit.feeSats) > BigInt(package_.commit.feeSats) + BigInt(package_.reveal.feeSats));
      assert(BigInt(package_.cancelReveal.feeSats) > BigInt(package_.reveal.feeSats));
      assert(reveal.vin.every(v => v.txinwitness.length === 3));
      assert(child.vin.every(v => v.txinwitness.length === 1));
      await assert.rejects(adapter.prepareBatch(package_.id, entries.map((e, i) => i ? e : { ...e, receiver: bob })), /different requests/);
      await assert.rejects(adapter.prepareBatch(sha256('duplicate-request-batch'), entries), /already assigned/);
      await assert.rejects(adapter.broadcast({ ...package_, cancellable: false }), /differs/);
      await assert.rejects(adapter.prepare([...entries, entries[0]]), /1..100/);
      const broadcast = await adapter.broadcast(package_);
      assert.equal(broadcast.commit.mempool, true); assert.equal(broadcast.reveal.mempool, true);
      await mine(manifest);
      for (const [i, entry] of entries.entries()) {
        const row = await tap(`getDmtMintHolderByBlock/${ticker}/${i + 1}`);
        assert.equal(row?.ins, package_.inscriptions[i].id);
        assert.equal((await ordJson(manifest, '/inscription/' + row.ins)).address, entry.receiver);
      }
      assert.equal((await tap(`getTickerMintList/${ticker}`)).filter(r => !r.fail).length, 100);
      assert.equal((await adapter.status(package_)).reveal.confirmations, 1);
      assert.equal((await adapter.cancel(package_)).tooLate, true);
      assert.equal((await adapter.status(package_)).cancelConfirmations, 0);
    });

    await check('cancellation replaces an unconfirmed commit and its live reveal; restart preserves cancellation and six-confirmation gate', async () => {
      const blocks = [101, 102], package_ = await prepared(await mints(blocks)); evidence.beforeCommit = package_;
      await adapter.broadcast(package_);
      const status = await adapter.cancel(package_);
      assert.equal(status.commitAlreadyConfirmed, false); assert.equal(status.cancelCommit.mempool, true);
      assert.equal(status.commit.mempool, false); assert.equal(status.reveal.mempool, false); assert.equal(status.cancelConfirmations, 0);
      await adapter.close(); adapter = await CancellableInscriber.open(config);
      await assert.rejects(adapter.broadcast(package_), /Cancellation is permanent/);
      assert.equal((await adapter.cancel(package_)).cancelCommit.txid, package_.cancelCommit.txid);
      await confirmCancellation(package_, blocks);
    });

    await check('confirmed commit can be cancelled by a key-path output spend before the reveal broadcasts', async () => {
      const blocks = [103, 104], package_ = await prepared(await mints(blocks)); evidence.afterCommit = package_;
      await adapter.broadcast(package_, { commitOnly: true }); await mine(manifest);
      assert.equal((await adapter.status(package_)).commit.confirmations, 1);
      const status = await adapter.cancel(package_);
      assert.equal(status.commitAlreadyConfirmed, true); assert.equal(status.cancelReveal.mempool, true); assert.equal(status.cancelCommit.mempool, false);
      await confirmCancellation(package_, blocks);
    });

    await check('key-path cancellation also replaces an already broadcast but unconfirmed reveal', async () => {
      const blocks = [105, 106], package_ = await prepared(await mints(blocks)); evidence.liveReveal = package_;
      await adapter.broadcast(package_, { commitOnly: true }); await mine(manifest);
      assert.equal((await adapter.broadcast(package_)).reveal.mempool, true);
      const status = await adapter.cancel(package_);
      assert.equal(status.cancelReveal.mempool, true); assert.equal(status.reveal.mempool, false);
      await confirmCancellation(package_, blocks);
    });

    await check('counted-height admission prevents broadcasts after half lifetime and signals cancellation at three quarters', async () => {
      const entries = await mints([107, 108]);
      entries.forEach(e => { e.expiry = e.created + 8; });
      countedOverride = entries[0].created + 4;
      const package_ = await prepared(entries); evidence.deadline = package_;
      countedOverride++;
      await assert.rejects(adapter.broadcast(package_), /first half/);
      assert.equal((await adapter.status(package_)).commit.known, false);
      await assert.rejects(adapter.prepare(entries, { id: sha256('late-prepare') }), /first half/);
      countedOverride++;
      assert.equal((await adapter.status(package_)).cancelDue, true);
      await adapter.cancel(package_); countedOverride = undefined;
      await confirmCancellation(package_, [107, 108]);
    });

    await check('SIGKILL after durable prepare resumes identical signed bytes from disk and confirms all resumed mints', async () => {
      const entries = await mints([109, 110, 111]);
      const id = sha256(JSON.stringify(entries));
      const filename = manifest.root + '/prepare-worker.json';
      await save(filename, { manifest: manifest.root + '/manifest.json', directory, requests: entries, id });
      await adapter.close(); adapter = null;
      const child = spawn(process.execPath, [`${ROOT}/local/test/fixtures/prepare-worker.mjs`, filename], { stdio: ['ignore', 'pipe', 'pipe'] });
      evidence.crashProcessPid = child.pid;
      await save(manifest.root + '/cancellable-processes.json', { processes: [{ pid: child.pid, role: 'prepare-crash-test' }] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const exited = once(child, 'exit');
      let ready;
      try {
        ready = await waitFor(() => {
          if (child.exitCode !== null) throw Object.assign(new Error('Prepare worker failed: ' + stderr), { fatal: true });
          return stdout.includes('\n') ? JSON.parse(stdout.split('\n')[0]) : false;
        }, 'durable prepare before crash');
        assert.equal(ready.ready, true); assert.equal(ready.pid, child.pid);
      } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
      adapter = await CancellableInscriber.open(config);
      const package_ = await adapter.load(id); evidence.resumed = package_;
      assert.equal(package_.digest, ready.digest);
      assert.deepEqual(await adapter.prepareBatch(id, entries), package_);
      assert.equal((await adapter.status(package_)).broadcast, false);
      for (const key of ['commit', 'reveal', 'cancelCommit', 'cancelReveal']) assert.equal((await adapter.status(package_))[key].known, false);
      await finish(package_);
      for (const [i, block] of [109, 110, 111].entries()) assert.equal((await tap(`getDmtMintHolderByBlock/${ticker}/${block}`))?.ins, package_.inscriptions[i].id);
      assert.equal((await adapter.status(package_)).reveal.confirmations, 1);
      evidence.crashProcessStopped = true;
    });
    evidence.status = {};
    for (const key of ['normal', 'beforeCommit', 'afterCommit', 'liveReveal', 'deadline', 'resumed']) if (evidence[key]) evidence.status[key] = await adapter.status(evidence[key]);
    await save(manifest.root + '/cancellable-proof.json', evidence);
    return evidence;
  } finally { if (adapter) await adapter.close(); }
}
