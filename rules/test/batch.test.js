import { recordGet, recordSet, recordObject, recordSize } from '../src/index.js';
import { attest, receiptSigners } from './witness-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hash, stableJSON, merkleRoot, merkleProof, verifyMerkle, buildBatch, batchOperations, validateOp, completeRealOp,
  signRequest, discoveryOps, processBlock, solveMove, compound, patternProperties,
  signReceipt, sealReceipts, verifyReceipt, receiptProof, verifyReceiptProof, encodeBinary, decodeBinary,
  patternBlockPages, readBlockPage, findId, mintRight } from '../src/index.js';
const secret = new Uint8Array(32).fill(1), owner = bytesToHex(ed25519.getPublicKey(secret)), gatewaySecret = new Uint8Array(32).fill(9), gateway = bytesToHex(ed25519.getPublicKey(gatewaySecret));
const hashAt = h => hash(String(h)), history = { length: 2001, get: height => ({ height, nonce: height, bits: 1, hash: hashAt(height) }), field: height => String(height) };
const patterns = [{ number: 0, name: 'dmwany', pat: '[0-9]', fld: 4, dt: 'n', rarity: 101, historyHeight: 100 }];
function move(tip, p, t = 'claim') { return solveMove({ v: 1, network: 'local', a: owner, t, b: tip, h: hashAt(tip), p }, secret, 0); }
function step(state, tip, moves = [], overrides = {}) {
  const entries = moves.map((move, i) => ({ move, receipt: signReceipt(move, { tip, hash: hashAt(tip), sequence: (state.lastSequence ?? -1) + 1 + i }, gatewaySecret) }));
  const receiptRoot = sealReceipts(entries.map(e => e.receipt), { network: 'local', tip, hash: hashAt(tip) }, gatewaySecret);
  return processBlock({ height: tip - 5, blockHash: hashAt(tip - 5), tip, tipHash: hashAt(tip), network: 'local', gateway, history, patterns,
    entries, receiptRoot, rootAttestations: tip <= state.lastTip && !entries.length ? [] : attest(receiptRoot), state, hashAt, ...overrides, settings: { puzzleBits: 0, receiptSigners, ...overrides.settings } });
}
test('Merkle proofs bind binary bytes, positions, leaf count and duplicated last leaves', () => {
  const files = ['a', 'b', 'c', 'd', 'e'].map(s => encodeBinary({ s })), root = merkleRoot(files);
  for (let i = 0; i < files.length; i++) {
    const proof = merkleProof(files, i); assert.equal(verifyMerkle(files[i], proof, root), true);
    assert.equal(verifyMerkle(encodeBinary({ s: 'tampered' }), proof, root), false);
  }
  assert.notEqual(merkleRoot([]), merkleRoot([''])); assert.notEqual(merkleRoot(['a', 'b', 'c']), merkleRoot(['a', 'b', 'c', 'c']));
});
test('binary codec roundtrips exact canonical JSON and rejects malleable or truncated encodings', () => {
  const value = { hash: hash('x'), same: hash('x'), n: Number.MAX_SAFE_INTEGER, neg: -100, a: [null, true, false, '😀', '__proto__'] };
  const encoded = encodeBinary(value); assert.deepEqual(decodeBinary(encoded), value);
  assert.deepEqual(encodeBinary({ ...value }), encoded); assert.throws(() => decodeBinary(encoded.subarray(0, encoded.length - 1)));
  assert.throws(() => decodeBinary(new Uint8Array([...encoded, 0]))); assert.throws(() => decodeBinary(encoded, 1));
  assert.throws(() => encodeBinary({ n: -0 }));
});
test('signed batch includes headers and binds all audit bytes and operations', async () => {
  const file = step({ lastTip: 100 - 1, counted: 94 }, 100).file;
  file.ops.unshift({ op: 'mk', to: owner, asset: 'p0', amount: '3' });
  const args = { network: 'local', executionHeight: 95, epoch: 0, sequence: 1, lastTo: 94, files: [file] };
  const result = buildBatch({ ...args, headers: ['00'.repeat(80)] });
  const contract = await import('../../contract/signing.js'); assert.deepEqual(result.signingDigest, contract.batchDigest('local', result.batch));
  assert.equal(result.batch.hx.length, 1); assert.equal(result.batch.root, merkleRoot([encodeBinary(file)]));
  assert.throws(() => validateOp({ op: 'rq', id: 'p0' })); assert.throws(() => validateOp({ op: 'kv', key: 'ok', value: '😀'.repeat(65) }));
  assert.throws(() => completeRealOp(hash('pending'), hash('ins') + 'i10000000000'));
  assert.throws(() => buildBatch({ ...args, files: [{ ...file, previousHeight: 93 }] }), /continuity/);
  assert.throws(() => buildBatch({ ...args, operations: [] }), /file_ops/);
  const record = { number: 1, name: 'dmwtest', pat: '1', fld: 4, dt: 'n', rarity: 12, tier: 5, historyHeight: 100, discoverer: owner, fingerprint: hash('p'), historyHash: hash('h') };
  assert.equal(discoveryOps(record).length, 3);
});
test('batch construction refuses missing, unsupported and mixed observation versions', () => {
  const first = step({ lastTip: 100 - 1, counted: 94 }, 100), second = step(first.state, 101);
  const args = { network: 'local', executionHeight: 96, epoch: 0, sequence: 1, lastTo: 94 };
  const { v, ...unversioned } = first.file;
  for (const file of [unversioned, ...[null, 1, 2, 3, '4'].map(v => ({ ...first.file, v }))]) {
    for (const files of [[file], [file, second.file], [first.file, { ...second.file, v: file.v }]]) {
      assert.throws(() => buildBatch({ ...args, files }), /batch_file_version/);
      assert.throws(() => batchOperations(files, 1), /batch_file_version/);
    }
  }
  assert.doesNotThrow(() => buildBatch({ ...args, files: [first.file, second.file] }));
});
test('gateway receipts prove inclusion and bind gateway, tip, sequence, move and signature', () => {
  const m = move(100, { window: 100, plots: [{ block: 100, patterns: [0] }] });
  const r = signReceipt(m, { tip: 101, hash: hashAt(101), sequence: 0 }, gatewaySecret), view = { gateway, network: 'local', hashAt };
  assert.equal(verifyReceipt(r, m, view), true); assert.equal(verifyReceipt({ ...r, sequence: 1 }, m, view), false);
  assert.equal(verifyReceipt(r, { ...m, a: gateway }, view), false);
  assert.throws(() => signReceipt(m, { tip: 102, hash: hashAt(102), sequence: 1 }, gatewaySecret), /window/);
  const seal = sealReceipts([r], { network: 'local', tip: 101, hash: hashAt(101) }, gatewaySecret);
  assert.equal(verifyReceiptProof(r, receiptProof([r], 0), seal.root), true);
  assert.equal(verifyReceiptProof({ ...r, tip: 102 }, receiptProof([r], 0), seal.root), false);
});
test('tip claims H/H+1 settle only when H+2 counts and credit count units of one pattern asset', () => {
  const initial = { lastTip: 100 - 1 };
  const claim = move(100, { window: 100, plots: [{ block: 100, patterns: [0] }] });
  let r = step(initial, 100, [claim]); assert.equal(initial.rounds, undefined); assert.equal(recordSize(r.state.finds), 0);
  r = step(r.state, 101, [move(101, claim.p)]);
  for (let tip = 102; tip <= 106; tip++) { r = step(r.state, tip); assert.equal(recordSize(r.state.finds), 0); }
  r = step(r.state, 107); const found = recordGet(r.state.finds, findId(100, 0));
  assert.equal(found.findHeight, 102); assert.equal(found.count, 3); assert.equal(recordGet(r.state.balances, owner).p0, '3');
  assert.equal(r.file.settlements[0].winners.length, 1); assert.equal(r.file.settlements[0].winners[0].tickets, 1);
  assert.equal(mintRight({ find: found, owner, counted: 103 }).allowed, true);
  assert.deepEqual(decodeBinary(r.auditBytes), r.file); assert.ok(r.viewerBytes.length < 60000);
});
test('window-hash or deciding-hash mismatch voids the event without supply', () => {
  for (const changed of [100, 102]) {
    let r = step({ lastTip: 100 - 1 }, 100, [move(100, { window: 100, plots: [{ block: 100, patterns: [0] }] })]);
    for (let tip = 101; tip <= 106; tip++) r = step(r.state, tip);
    const revised = h => h === changed ? hash('reorg') : hashAt(h);
    r = step(r.state, 107, [], { hashAt: revised, blockHash: revised(102) });
    assert.equal(r.file.settlements[0].void, true); assert.equal(recordSize(r.state.finds), 0); assert.equal(recordGet(r.state.balances, owner), undefined);
  }
});
test('signed crafts consume fungible inputs, reuse compound types and retain first maker', () => {
  const table = [...patterns, { ...patterns[0], number: 1, name: 'dmwother' }];
  const inputs = table.map(p => ({ asset: `p${p.number}`, amount: '2', properties: patternProperties(p) })), output = compound('fusion', inputs, 96);
  const request = { owner, in: [['p0', '2'], ['p1', '2']], out: [[output.id, '2']], nonce: hash('craft'), until: 200 };
  const craft = move(100, { recipe: 'fusion', request, sig: signRequest('xc', 'local', request, secret) }, 'craft');
  const initial = { lastTip: 100 - 1, balances: { [owner]: { p0: '4', p1: '4' } } };
  const r = step(initial, 100, [craft], { patterns: table });
  const persisted = JSON.parse(JSON.stringify({ ...initial, balances: recordSet({}, owner, initial.balances[owner]) }));
  const replayed = step(persisted, 100, [craft], { patterns: table });
  assert.deepEqual(replayed.auditBytes, r.auditBytes);
  assert.deepEqual(recordObject(replayed.state.balances), recordObject(r.state.balances));
  assert.equal(r.file.moves[0].reason, 'accepted'); assert.equal(recordGet(r.state.balances, owner)[output.id], '2');
  assert.equal(recordGet(r.state.balances, owner).p0, '2'); assert.equal(initial.balances[owner].p0, '4');
  assert.equal(recordGet(r.state.types, output.id).firstMaker, owner);
  assert.equal(r.state.balances.base, initial.balances);
  assert.equal(recordGet(persisted.balances, owner).p0, '4');
});
test('paged block lists include every matching historic block plus mint, finder and permanent link data', () => {
  const pattern = { ...patterns[0], pat: '1' }, finds = { [findId(100, 0)]: { finder: owner, findHeight: 105 } };
  const pages = [...patternBlockPages({ pattern, history, finds, minted: { 'p0/100': hash('ins') + 'i0' }, links: { 100: { linkHeight: 90 } }, pageSize: 100 })];
  const rows = pages.flatMap(p => readBlockPage(p.bytes).rows);
  assert.equal(rows.length, Array.from({ length: history.length }, (_, h) => String(h)).filter(s => s.includes('1')).length);
  const row = rows.find(r => r.block === 100); assert.equal(row.finder, owner); assert.equal(row.minted, hash('ins') + 'i0');
  assert.deepEqual(row.link, { block: 100, linkHeight: 90 }); assert.equal(row.found, true);
});
test('a retreating raw tip never reopens a closed claim window or creates another window', () => {
  let r = step({ lastTip: 100 - 1 }, 100);
  r = step(r.state, 101); r = step(r.state, 102); r = step(r.state, 103);
  const lastTip = r.state.lastTip, claim = move(101, { window: 100, plots: [{ block: 100, patterns: [0] }] });
  assert.throws(() => step(r.state, 101, [claim], { height: 98, blockHash: hashAt(98) }), /receipt_root_conflict/);
  r = step(r.state, 101, [], { height: 98, blockHash: hashAt(98) }); assert.equal(r.state.lastTip, lastTip);
  assert.throws(() => signReceipt(claim, { tip: 101, highestTip: 103, hash: hashAt(101), sequence: 99 }, gatewaySecret), /window/);
});
test('a monotone counted clock ahead of a shorter tip does not settle unconfirmed events', () => {
  let r = step({ lastTip: 100 - 1 }, 100, [move(100, { window: 100, plots: [{ block: 100, patterns: [0] }] })]);
  for (let tip = 101; tip <= 106; tip++) r = step(r.state, tip);
  const forkHash = h => h > 101 ? null : hashAt(h);
  r = step(r.state, 101, [], { height: 103, confirmed: 96, blockHash: null, hashAt: forkHash });
  assert.equal(r.state.counted, 103); assert.equal(recordSize(r.state.finds), 0); assert.equal(r.file.settlements.length, 0);
  r = step(r.state, 107, [], { height: 103, confirmed: 103, blockHash: hashAt(103) }); assert.equal(recordGet(r.state.balances, owner).p0, '3');
});
test('audit and viewer limits refuse a block atomically when its output cannot fit', () => {
  const state = { lastTip: 100 - 1 }, before = stableJSON(state);
  assert.throws(() => step(state, 100, [], { settings: { puzzleBits: 0, auditMaxBytes: 1 } }), /audit_budget/);
  assert.throws(() => step(state, 100, [], { settings: { puzzleBits: 0, summaryMaxBytes: 1 } }), /summary_budget/);
  assert.equal(stableJSON(state), before);
});

test('batch epochs are mandatory safe integers and change the signed digest', () => {
  const file = step({ lastTip: 100 - 1, counted: 94 }, 100).file;
  const args = { network: 'local', executionHeight: 95, sequence: 1, lastTo: 94, files: [file] };
  for (const epoch of [undefined, null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildBatch({ ...args, epoch }), /batch_epoch/);
  }
  const first = buildBatch({ ...args, epoch: 0 }), next = buildBatch({ ...args, epoch: 2 });
  assert.equal(first.batch.epoch, 0); assert.equal(next.batch.epoch, 2);
  assert.notDeepEqual(first.signingDigest, next.signingDigest);
  assert.deepEqual(first.fileBytes, next.fileBytes);
});

test('window H settles on H+2 with one-block counted height', () => {
  let out = step({ lastTip: 99, counted: 99 }, 100, [move(100, { window: 100, plots: [{ block: 10, patterns: [0] }] })], { height: 100, confirmed: 100, blockHash: hashAt(100) });
  out = step(out.state, 101, [], { height: 101, confirmed: 101, blockHash: hashAt(101) });
  assert.equal(recordSize(out.state.finds), 0);
  out = step(out.state, 102, [], { height: 102, confirmed: 102, blockHash: hashAt(102) });
  assert.equal(recordGet(out.state.finds, findId(10, 0)).findHeight, 102);
  assert.equal(out.file.settlements[0].winners.length, 1);
});
