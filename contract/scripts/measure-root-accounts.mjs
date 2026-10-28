import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Hypercore from 'hypercore';
import Hyperbee from 'hyperbee';
import { accountTree, accountKey } from '../account-tree.js';
import { applyRootAccounts } from '../root-accounts.js';
import { canonicalJSON, bytesToHex, sha256, utf8ToBytes } from '../signing.js';
import { person } from '../tests/helpers/harness.mjs';
import { BitcoinBeacon as ResetBeacon } from '../tests/helpers/reset-beacon.js';
import { beaconOptions, chain, addr } from '../tests/helpers/chain.mjs';
const bytes = value => Buffer.byteLength(canonicalJSON(value));
const digest = value => bytesToHex(sha256(utf8ToBytes(canonicalJSON(value))));
const owners = Array.from({ length: 500 }, (_, i) => person(1000 + i).address), results = [];
const scratch = await mkdtemp(join(tmpdir(), 'r4-account-measure-'));
try {
  const resetCore = new Hypercore(join(scratch, 'reset')), resetView = new Hyperbee(resetCore, { keyEncoding: 'utf-8', valueEncoding: 'json' });
  await resetView.ready(); const reset = new ResetBeacon(beaconOptions), headers = chain(2201);
  for (let i = 0; i < 2200; i += 20) reset.ingest(headers.slice(i, Math.min(2200, i + 20)), addr(1));
  await resetView.put('beacon/state', reset.exportState({ compact: true })); const before = resetCore.byteLength;
  reset.ingest(headers.slice(-1), addr(1)); await resetView.put('beacon/state', reset.exportState({ compact: true }));
  const resetViewBytes = resetCore.byteLength - before; await resetView.close(); await resetCore.close();
  for (const assets of [1, 4, 100]) {
    const viewCore = new Hypercore(join(scratch, 'view-' + assets)), input = new Hypercore(join(scratch, 'input-' + assets));
    const view = new Hyperbee(viewCore, { keyEncoding: 'utf-8', valueEncoding: 'json' }); await view.ready(); await input.ready();
    const db = new Map(), supply = new Map(), names = Array.from({ length: assets }, (_, i) => 'p' + i.toString(36));
    const balanceKeys = names.map(n => accountKey('balance', n)), supplyKeys = names.map(n => accountKey('supply', n));
    const emptyProof = { empty: true }; let offset = 0, batches = 0, touches = 0, proofBytes = 0, logicalWrites = 0, maxOperationBytes = 0;
    const start = performance.now();
    while (offset < owners.length) {
      const supplyProof = accountTree(supply).prove(supplyKeys);
      const op = { op: 'ar', v: 2, availability: digest([assets, offset]), actions: [], accounts: [],
        supply: { revision: db.get('ar/supply')?.revision ?? '0', proof: supplyProof } };
      while (offset + op.accounts.length < owners.length) {
        const owner = owners[offset + op.accounts.length];
        op.accounts.push({ owner, revision: '0', proof: emptyProof }); op.actions.push({ type: 'credits', owner, assets: names.map(name => [name, '1']) });
        if (bytes(op) > 96000 || op.actions.length > 512 || op.accounts.length * assets > 4096) { op.accounts.pop(); op.actions.pop(); break; }
      }
      assert.ok(op.accounts.length); maxOperationBytes = Math.max(maxOperationBytes, bytes(op));
      const writes = new Map(), store = { get: async k => db.get(k), put: (k, v) => writes.set(k, v) };
      const result = await applyRootAccounts(store, op, { network: 'dmw-root-measurement', height: 100 });
      assert.equal(result.accounts, op.accounts.length); assert.equal(result.writes, op.accounts.length + 2);
      const batch = view.batch();
      for (const [k, v] of writes) { db.set(k, v); await batch.put(k, v); logicalWrites += Buffer.byteLength(k) + bytes(v); }
      await batch.flush(); await input.append(Buffer.from(canonicalJSON(op)));
      for (const name of names) supply.set(accountKey('supply', name), { issued: String(offset + op.accounts.length), burned: '0' });
      assert.equal(db.get('ar/supply').root, accountTree(supply).root);
      proofBytes += op.accounts.reduce((n, p) => n + bytes(p.proof), 0) + bytes(supplyProof);
      touches += op.accounts.length * assets; offset += op.accounts.length; batches++;
    }
    assert.equal(db.size, 502);
    results.push({ accounts: 500, assetsPerAccount: assets, touches, boundedOperations: batches, maxOperationBytes, proofBytes,
      contractRecords: db.size, logicalWriteBytes: logicalWrites, viewLogBytes: viewCore.byteLength, operationInputLogBytes: input.byteLength,
      resetViewBytes, viewToResetRatio: viewCore.byteLength / resetViewBytes, elapsedMs: Math.round(performance.now() - start) });
    await view.close(); await viewCore.close(); await input.close();
  }
  const report = { node: process.version, method: '500 distinct synthetic owners, 1/4/100 named asset leaves each; real sparse multiproof verification and real Hyperbee/Hypercore byteLength. Each operation stays below 96,000 bytes, 512 actions and 4,096 account leaves. The input core contains canonical ar operation JSON, not a live Trac input log. Runtime/system logs, signed outer envelopes, replication and filesystem overhead are NOT measured; full peer comparison remains an integration gate.', results };
  await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} finally { await rm(scratch, { recursive: true, force: true }); }
