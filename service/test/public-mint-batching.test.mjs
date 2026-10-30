import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '../../rules/node_modules/@noble/curves/ed25519.js';
import * as r from '../../rules/src/index.js';
import { replayFixture, withSignedClaim } from '../../rules/test/claims-never-close-fixture.mjs';
import { attest } from '../../rules/test/witness-fixture.mjs';
import { mine } from '../../contract/tests/helpers/chain.mjs';
import { Replay } from '../src/replay.mjs';
import { Store } from '../src/store.mjs';
import { installFinancialSources } from '../src/financial-sources.mjs';
import { accountOperationsRoot } from '../../rules/src/account-batch.js';
import { publicClaimBatch } from '../../committee/test/public-claim-batch-fixture.mjs';

test('gateway batches point reads while preserving every replay byte and root from serial execution', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'public-mint-batch-')), store = await Store.open(directory), replay = new Replay();
  t.after(async () => { await replay.close(); await store.close(); await rm(directory, { recursive: true }); });
  let input = withSignedClaim(replayFixture().input);
  input.settings = { ...input.settings, batchVersion: 2 };
  const headers = new Map(), raw = height => {
    const key = String(height);
    if (!headers.has(key)) headers.set(key, mine('00'.repeat(32), 1000 + Number(height)));
    return headers.get(key);
  }, hashAt = height => r.parseHeader(raw(height)).hash;
  const history = { length: '1201', raw, get: h => r.parseHeader(raw(h), h), hashAt };
  input.blockHash = hashAt(input.height); input.tipHash = hashAt(input.tip);
  const move = { ...input.entries[0].move, h: input.tipHash, p: { window: input.tip,
    plots: Array.from({ length: 65 }, (_, i) => ({ block: String(i + 1), patterns: ['7'] })) } };
  move.sig = r.bytesToHex(ed25519.sign(r.moveDigestV2(move), r.hashBytes('permanent-claim-sender')));
  const receipt = r.signReceiptV2(move, { tip: input.tip, hash: input.tipHash, sequence: '1', batch: input.batchSequence }, r.hashBytes('permanent-gateway'));
  input.entries = [{ move, receipt }];
  input.receiptRoot = r.sealReceiptSegment([receipt], { network: input.network, tip: input.tip, hash: input.tipHash, segment: '0', previous: null,
    ruleset: 'dmw-v2', settingsRevision: input.settings.document.revision, settingsHash: r.hashObject(input.settings.document) }, r.hashBytes('permanent-gateway'));
  input.rootAttestations = attest(input.receiptRoot); input.publicMintEvidence = [];
  const expected = r.processBlockV2({ ...input, history, hashAt }, { publicMintGet: () => null });
  assert.equal(expected.file.moves[0].reason, 'accepted');
  const { history: _history, hashAt: _hashAt, ...wire } = input, batches = [];
  const actual = await replay.run(wire, history, { store, staged: new Map(), namedStaged: new Map(), publicMintBatch: async pairs => {
    batches.push(pairs); return pairs.map(() => ({ value: null }));
  } });
  assert.equal(r.stableJSON(actual.file), r.stableJSON(expected.file));
  assert.deepEqual(actual.auditBytes, expected.auditBytes); assert.equal(actual.state.claimRoot, expected.state.claimRoot);
  const activation = publicClaimBatch().context.activation;
  const build = output => r.buildBatchV2({ network: input.network, epoch: '0', sequence: '3', lastTo: '1199',
    previousRoot: r.hash('prior-batch'), files: [output.file], executionHeight: input.height, executionHash: input.blockHash,
    settings: input.settings, activation, catalogRoot: output.state.catalogRoot, accountRoot: accountOperationsRoot(output.file.ops) });
  const before = build(expected), after = build(actual);
  assert.deepEqual(after.signingBytes, before.signingBytes); assert.deepEqual(after.signingDigest, before.signingDigest);
  assert.deepEqual(after.batch, before.batch); assert.deepEqual(after.fileBytes, before.fileBytes);
  assert.deepEqual(batches.map(pairs => pairs.length), [64, 1]);
  assert.equal(actual.file.publicMintEvidence.length, 65);
});

test('financial source bulk adapter validates keys and a scoped overlay cannot bypass its record reader', async () => {
  const document = r.settingsRevision({ network: 'bulk', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE } });
  let bulk = 0;
  const reads = installFinancialSources({ feeQuotes: {} }, { network: 'bulk', document, request: () => null, reservation: () => null,
    record: () => 'base', recordMany: keys => { bulk++; return keys.map(() => 'base'); } });
  assert.deepEqual(await reads.financialRecords(['fp/a', 'dc/plot/p2:7/1'], {}), ['base', 'base']);
  assert.equal(bulk, 1);
  await assert.rejects(reads.financialRecords(['not-allowed'], {}), /financial_record_key/);
  const scoped = reads.financialScope({ record: () => 'overlay', reservations: new Map() });
  assert.deepEqual(await scoped.financialRecords(['fp/a'], {}), ['overlay']); assert.equal(bulk, 1);
});
