import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { exportSnapshot, exportNotaryView, checkPublic } from './export.mjs';
import { capturePending } from '../host-157/capture-pending.mjs';
import { operatorExportBytes } from './reconcile.mjs';
import { terminalRecordsRoot } from '../../service/src/pending-financial.mjs';
import { legacyGatewayRows } from '../../service/src/pending-work.mjs';
import { inventory } from './snapshot.mjs';
import { Store } from '../../service/src/store.mjs';
import { initialState, rules as r } from '../../service/src/rules.mjs';
import { temp, fixtureHistory, network, gateway, agent, signEd } from '../../service/test/helpers.mjs';
import { harness, deployment } from '../../contract/tests/helpers/harness.mjs';
import { chain, parseHeader } from '../../contract/tests/helpers/chain.mjs';
import { REGTEST_PARAMS, workFor } from '../../contract/beacon/bitcoin.js';

async function fixture(t) {
  const directory = await temp('pm1-export-'), history = fixtureHistory(20), gatewayDirectory = join(directory, 'gateway');
  const store = await Store.open(gatewayDirectory); t.after(() => store.close());
  const old = harness({ ...deployment, network }); await old.advance(9); assert.equal(await old.batch([]), null); await old.advance(1);
  await store.put('meta', 'ruleState', initialState(11, history.hashAt(10), 9));
  await store.put('mints', r.hash('request'), { id: r.hash('request'), request: { nonce: r.hash('nonce') }, state: 'paid' });
  const contractFile = join(directory, 'notary.json'), headersFile = join(directory, 'headers.bin');
  await writeFile(contractFile, JSON.stringify({ options: old.options, records: [...old.db] }));
  await writeFile(headersFile, Buffer.from(Array.from({ length: 21 }, (_, h) => history.raw(h)).join(''), 'hex'));
  const operatorFiles = [];
  for (let i = 1; i <= 5; i++) {
    const path = join(directory, 'operator' + i + '.json');
    await writeFile(path, JSON.stringify({ version: 1, signer: 'operator' + i, reservations: [{ slot: 'mint/test', digest: r.hash('reserved') }] }));
    operatorFiles.push({ id: 'operator' + i, path });
  }
  return { directory, gatewayDirectory, store, contractFile, headersFile, operatorFiles, output: join(directory, 'export') };
}

test('host export reads a live gateway transaction without acquiring its writer, retains jobs and inventories every output', async t => {
  const f = await fixture(t), before = await inventory(f.gatewayDirectory);
  const result = await exportSnapshot(f); assert.equal(result.reconciled, false);
  assert.deepEqual(await inventory(f.gatewayDirectory), before);
  const descriptor = JSON.parse(await readFile(join(f.output, 'snapshot.json')));
  assert.equal(descriptor.accepted.n, 1); assert.equal(descriptor.height, 10); assert.equal(descriptor.gateway.rows, 2);
  const manifest = JSON.parse(await readFile(join(f.output, 'export-files.json'))), actual = await inventory(f.output);
  assert.deepEqual(manifest.files, actual.files.filter(f => f.path !== 'export-files.json'));
  const copy = await Store.open(join(f.output, 'gateway'));
  try { assert.deepEqual(copy.get('mints', r.hash('request')), f.store.get('mints', r.hash('request'))); }
  finally { await copy.close(); }
  await f.store.put('meta', 'still_running', true); assert.equal(f.store.get('meta', 'still_running'), true);
});

test('host export refuses private inputs, symlinks and incomplete signer coverage before claiming a snapshot', async t => {
  const f = await fixture(t), linked = join(f.directory, 'linked.json'); await symlink(f.contractFile, linked);
  await assert.rejects(exportSnapshot({ ...f, contractFile: linked }), /export_symlink/);
  await assert.rejects(exportSnapshot({ ...f, operatorFiles: f.operatorFiles.slice(0, 4) }), /export_operator_coverage/);
  for (const value of [{ secret: 'do not read' }, { nested: { privateKey: 'hidden' } }, { sourceURL: 'placeholder' }])
    assert.throws(() => checkPublic(value), /export_private_field/);
  const privateFile = join(f.directory, 'credentials.json'); await writeFile(privateFile, '{}');
  await assert.rejects(exportSnapshot({ ...f, contractFile: privateFile }), /export_input_path/);
  await f.store.put('meta', 'forbidden', { privateKey: 'fixture-only' });
  await assert.rejects(exportSnapshot(f), /export_private_field/);
  await assert.rejects(readFile(join(f.output, 'snapshot.json')), { code: 'ENOENT' });
});

test('notary view export pins an immutable read revision and never calls a runtime or sends', async () => {
  const directory = await temp('pm1-notary-'); let closed = false;
  const view = { version: 42, checkout: revision => {
    assert.equal(revision, 42);
    return { version: revision, async *createReadStream() {
      yield { key: 'bt/last', value: { n: 7, to: 100 } };
      yield { key: 'admin', value: 'runtime-administrator' };
      yield { key: 'tx/old-payment', value: 12 };
      yield { key: 'wl/old-writer', value: true };
      yield { key: 'ad/current', value: 'application-administrator' };
      yield { key: 's/key', value: 'application-committee' };
    }, close: async () => { closed = true; } };
  } };
  const output = join(directory, 'notary.json'), result = await exportNotaryView({ view, options: { network }, output });
  assert.equal(result.rows, 3); assert(closed);
  const exported = JSON.parse(await readFile(output)); assert.equal(exported.revision, 42);
  assert.deepEqual(exported.records, [['ad/current', 'application-administrator'], ['bt/last', { n: 7, to: 100 }], ['s/key', 'application-committee']]);
});

test('single host capture preserves a live WAL and the exact active external draft in the host state layout', async t => {
  const f = await fixture(t), root = join(f.directory, 'host-layout'), gatewayDirectory = join(root, 'owner', 'host-157', 'gateway-data');
  await mkdir(gatewayDirectory, { recursive: true });
  const writer = await Store.open(gatewayDirectory); t.after(() => writer.close());
  await writer.put('meta', 'ruleState', f.store.get('meta', 'ruleState'));
  const draft = { proposal: { batch: { v: 1, epoch: 0, n: 2, from: 10, to: 10, deadline: 16, root: r.hash('draft'), ops: [] } }, signature: 'public-signature' };
  const bytes = JSON.stringify(draft), external = r.hash(bytes);
  await mkdir(join(gatewayDirectory, 'drafts'));
  await writeFile(join(gatewayDirectory, 'drafts', external + '.json'), bytes);
  await writer.put('meta', 'draft', { version: 3, external, proposal: draft.proposal });
  const operatorFiles = [];
  for (let n = 1; n <= 5; n++) {
    const directory = join(root, 'operator' + n, 'host-157'); await mkdir(directory, { recursive: true });
    const path = join(directory, 'migration-public.json');
    await writeFile(path, await readFile(f.operatorFiles[n - 1].path)); operatorFiles.push({ id: 'operator' + n, path });
  }
  const before = await inventory(root), output = join(f.directory, 'host-capture');
  const result = await capturePending({ gatewayDirectory, contractFile: f.contractFile, headersFile: f.headersFile, operatorFiles, output });
  assert.equal(result.reconciled, false); assert.deepEqual(await inventory(root), before);
  assert.equal(await readFile(join(output, 'gateway', 'drafts', external + '.json'), 'utf8'), bytes);
  const manifest = JSON.parse(await readFile(join(output, 'export-files.json')));
  assert(manifest.files.some(file => file.path === 'gateway/drafts/' + external + '.json' && file.sha256 === external));
  assert.equal(manifest.files.filter(file => file.path.startsWith('operators/')).length, 5);
  await writer.put('meta', 'afterCapture', true); assert.equal(writer.get('meta', 'afterCapture'), true);
});

test('single capture verifies real regtest ancestry and five signed sources before marking its output reconciled', async t => {
  const directory = await temp('pm2-capture-reconcile-'), gatewayDirectory = join(directory, 'gateway-data');
  const store = await Store.open(gatewayDirectory); t.after(() => store.close());
  const genesis = '01000000' + '00'.repeat(32) + '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a' + 'dae5494dffff7f2002000000';
  const g = parseHeader(genesis), headers = [genesis, ...chain(10, g)], anchor = { height: '10', hash: parseHeader(headers[10]).hash };
  const old = harness({ ...deployment, network, beacon: { params: REGTEST_PARAMS,
    checkpoint: { height: 0, hash: g.hash, bits: g.bits, time: g.time, chainwork: workFor(g.bits).toString() } } });
  assert.equal(await old.run('hd', { headers: headers.slice(1, 10) }), null); assert.equal(await old.batch([]), null);
  assert.equal(await old.run('hd', { headers: headers.slice(10) }), null);
  await store.put('meta', 'ruleState', initialState(10, parseHeader(headers[9]).hash, 9));
  const gatewayRows = legacyGatewayRows(store), document = r.settingsRevision({ network, effectiveBatch: '2', effectiveBitcoinWindow: '10', values: { ...r.SETTINGS_PROFILE } });
  const bytes = Buffer.from(headers.join(''), 'hex'), notary = { options: old.options, records: [...old.db] };
  const headersFile = join(directory, 'headers.bin'), contractFile = join(directory, 'notary.json'), pinsFile = join(directory, 'pins.json');
  await writeFile(headersFile, bytes); await writeFile(contractFile, JSON.stringify(notary));
  const members = Array.from({ length: 5 }, (_, i) => ({ id: 'operator' + (i + 1), ...agent(3100 + i) })), operatorFiles = [];
  for (const member of members) {
    const body = { version: 1, signer: member.id, network, gateway, anchor, document, legacySettings: {}, headersHash: r.hash(bytes),
      gatewayRows: structuredClone(gatewayRows), notary: structuredClone(notary), reservations: [] };
    const path = join(directory, member.id + '.json');
    await writeFile(path, JSON.stringify({ ...body, signature: signEd(operatorExportBytes(body), member.secret) }));
    operatorFiles.push({ id: member.id, path });
  }
  const pins = { network, gateway, anchor, headersHash: r.hash(bytes), settingsHash: r.hashObject(document), legacySettings: {},
    notaryRoot: terminalRecordsRoot(old.db), gatewayRoot: r.hashObject(['dmw-legacy-gateway-v1', gatewayRows]), roster: members.map(m => ({ id: m.id, identity: m.address })) };
  await writeFile(pinsFile, JSON.stringify(pins));
  const output = join(directory, 'capture'), before = await inventory(gatewayDirectory);
  const result = await capturePending({ gatewayDirectory, headersFile, contractFile, operatorFiles, output, reconciliation: { pinsFile } });
  assert.equal(result.reconciled, true); assert.deepEqual(await inventory(gatewayDirectory), before);
  const descriptor = JSON.parse(await readFile(join(output, 'snapshot.json'))), proof = JSON.parse(await readFile(join(output, 'reconciliation.json')));
  assert.equal(descriptor.reconciliationHash, proof.hash); assert.equal(proof.operators.length, 5);
  const manifest = JSON.parse(await readFile(join(output, 'export-files.json')));
  assert.deepEqual(manifest.files, (await inventory(output)).files.filter(f => f.path !== 'export-files.json'));
});
