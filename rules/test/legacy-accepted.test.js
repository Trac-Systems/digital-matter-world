import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { legacyRules, rulesForBatch, merkleRoot } from '../src/index.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/legacy-accepted-1-42.json', import.meta.url)));
const pins = fixture.pins;
test('public accepted batch fixtures 1–42 replay every observation with byte-identical historical roots', () => {
  const files = fixture.batches.flatMap(b => b.audits.map(a => legacyRules.decodeBinary(Buffer.from(a, 'base64'))));
  const hashes = new Map();
  for (const f of files) { hashes.set(f.height, f.hash); hashes.set(f.tip, f.tipHash); for (const { move } of f.moves) hashes.set(move.b, move.h); }
  const hashAt = height => hashes.get(height) ?? null;
  const history = { length: Math.max(...hashes.keys()) + 1, get: height => {
    assert.ok(hashes.has(height), `fixture is missing header ${height}`); return { height, hash: hashAt(height) };
  }, field: () => { throw Error('unexpected historical discovery scan'); } };
  let state = { lastTip: files[0].tip - 1, highestTip: files[0].tip - 1, counted: files[0].previousHeight,
    balances: {}, finds: {}, types: {}, usedNonces: {}, linkPayments: {}, rounds: [] }, patterns = [];
  for (const { batch, audits } of fixture.batches) {
    const rules = rulesForBatch({ network: pins.network, batch });
    const replayed = audits.map(encoded => {
      const original = Buffer.from(encoded, 'base64'), file = rules.decodeBinary(original);
      hashes.set(file.height, file.hash); hashes.set(file.tip, file.tipHash);
      const moves = new Map(file.moves.map(m => [rules.moveId(m.move), m.move]));
      const output = rules.processBlock({ height: file.height, blockHash: file.hash, tip: file.tip, tipHash: file.tipHash,
        confirmed: file.confirmed, network: pins.network, gateway: pins.gatewayIdentity, history, hashAt, patterns, state,
        entries: file.receipts.map(receipt => ({ receipt, move: moves.get(receipt.move) })), receiptRoot: file.receiptRoot,
        rootAttestations: file.rootAttestations, mintOperations: file.mintOperations, linkOperations: file.linkOperations,
        settings: { puzzleBits: pins.puzzleBits, receiptSigners: pins.receiptSigners } });
      assert.deepEqual(Buffer.from(output.auditBytes), original, `batch ${batch.n}, observation ${file.observation}`);
      state = output.state; patterns = output.patterns;
      return output.auditBytes;
    });
    assert.equal(merkleRoot(replayed), batch.root, `batch ${batch.n} root`);
    const rebuilt = rules.buildBatch({ network: pins.network, epoch: batch.epoch, sequence: batch.n, lastTo: batch.from - 1,
      executionHeight: batch.deadline - 6, deadline: batch.deadline, files: replayed.map(bytes => rules.decodeBinary(bytes)) });
    assert.deepEqual(rebuilt.batch, batch);
  }
  assert.equal(fixture.batches.length, 42); assert.equal(state.counted, 973439);
  assert.equal(patterns.length, 0); assert.equal(state.discoveryQueue.length, 2);
});
