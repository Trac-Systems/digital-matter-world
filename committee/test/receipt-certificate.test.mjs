import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Policy } from '../signer/policy.mjs';
import { rules } from '../signer/adapter.mjs';
import { fixture, batchFixture } from './fixture.mjs';
import { attest, receiptSigners } from '../../rules/test/witness-fixture.mjs';
import { gatewaySecret, secret, owner, hashAt } from '../../rules/test/observation-fixture.mjs';
const recorded = JSON.parse(await readFile(new URL('./fixtures/receipt-certificate-43.json', import.meta.url)));

// Isolate the post-replay certificate boundary with the recorded public files
// and signatures. The synthetic cases below run the full deterministic replay.
function recordedPolicy(files = structuredClone(recorded.files), certificates = structuredClone(recorded.certificates)) {
  const { network, batch, receiptSigners } = recorded, publicKey = 'test-authority';
  const digest = Buffer.from(rules.batchDigest(network, batch)).toString('hex');
  const context = { counted: 973449, last: { n: 42, to: 973439 }, inputs: [], settings: { receiptSigners } };
  const reads = { authority: async () => ({ network, committee: publicKey, epoch: batch.epoch }), counted: async () => context.counted,
    batchContext: async () => context, receiptCertificate: async (tip, hash) => certificates[`${tip}/${hash}`] ?? null,
    preflight: async (_batch, at) => ({ ok: true, ...at, digest }) };
  const policy = new Policy({ network, publicKey, reads, replayBatch: async () => ({ files, batch, digest }) });
  return { files, certificates, reads, proposal: { network, kind: 'batch', batch }, policy, digest };
}

test('batch 43: six empty precursors resolve to the exact later certified seals', async () => {
  const f = recordedPolicy();
  assert.equal(f.files.length, 16);
  assert.equal(Object.keys(f.certificates).length, 10);
  for (const c of Object.values(f.certificates)) assert.ok(rules.verifyRootAttestations(c.seal, c.attestations, recorded.receiptSigners));
  for (const file of f.files) assert.ok(rules.verifyReceiptRoot(file.receiptRoot, file.receipts, { network: recorded.network, gateway: file.receiptRoot.gateway, tip: file.tip, hash: file.tipHash }));
  const conflicts = f.files.filter(file => {
    const c = f.certificates[`${file.tip}/${file.tipHash}`];
    return c && file.receiptReference !== c.seal.root && rules.stableJSON(file.receiptRoot) !== rules.stableJSON(c.seal);
  });
  assert.deepEqual(conflicts.map(f => f.tip), [973440, 973442, 973443, 973444, 973445, 973446]);
  assert.equal((await f.policy.approve(f.proposal)).digest, '7af3d23b9b3f9bd12924c48ebda0bc29b8de3c98ad3ce579c93976b572e340e1');
});

for (const tip of [973440, 973442, 973443, 973444, 973445, 973446]) test(`batch 43 refuses omission of certified receipts at ${tip}`, async () => {
  const f = recordedPolicy();
  f.files.splice(f.files.findIndex(file => file.tip === tip && file.receipts.length), 1);
  await assert.rejects(f.policy.approve(f.proposal), /receipt_certificate_read/);
});
for (const [name, mutate] of [
  ['nonempty conflicting precursor', f => f.files[1].receipts.push(f.files[2].receipts[0])],
  ['attested conflicting precursor', f => f.files[1].rootAttestations = f.files[2].rootAttestations],
  ['wrong existing reference', f => f.files[1].receiptReference = '0'.repeat(64)],
  ['different later block hash', f => f.files[2].tipHash = '0'.repeat(64)],
  ['different later seal', f => f.files[2].receiptRoot.sig = '0'.repeat(128)],
  ['unattested later seal', f => f.files[2].rootAttestations = []],
  ['bad independent certificate signature', f => Object.values(f.certificates).forEach(c => c.attestations[0].sig = '0'.repeat(128))],
  ['missing independent certificate', f => delete f.certificates[`${f.files[2].tip}/${f.files[2].tipHash}`]],
]) test(`batch 43 refuses ${name}`, async () => {
  const f = recordedPolicy(); mutate(f);
  await assert.rejects(f.policy.approve(f.proposal), /receipt_certificate_read/);
});

function replayFixture({ includeSeal = true, prefix = true, suffix = true, prior = false, conflicting = false } = {}) {
  const f = fixture(), b = batchFixture(), { network } = b.context;
  b.context.settings = { puzzleBits: 0, receiptSigners };
  const move = rules.solveMove({ v: 1, network, a: owner, t: 'claim', b: 100, h: hashAt(100), p: { window: 100, plots: [{ block: 100, patterns: [0] }] } }, secret, 0);
  const receipt = rules.signReceipt(move, { tip: 100, hash: hashAt(100), sequence: 1 }, gatewaySecret);
  const seal = rules.sealReceipts([receipt], { network, tip: 100, hash: hashAt(100) }, gatewaySecret);
  const certified = { ...b.context.inputs[0], entries: [{ move, receipt }], receiptRoot: seal, rootAttestations: attest(seal) };
  const empty = { ...b.context.inputs[0], rootAttestations: [] };
  if (prior) b.context.state.receiptSeals = rules.recordSet(undefined, `100/${hashAt(100)}`, seal.root);
  b.context.inputs = [...(prefix ? [empty] : []), ...(includeSeal ? [certified] : []), ...(suffix ? [empty] : [])];
  let state = b.context.state; const files = b.context.inputs.map(input => {
    const output = rules.processBlock({ ...b.context, ...input, state }); state = output.state; return output.file;
  });
  const built = rules.buildBatch({ network, epoch: 0, sequence: 1, lastTo: 94, executionHeight: 95, files });
  const proposal = { network, kind: 'batch', batch: built.batch, files: built.fileBytes.map(v => Buffer.from(v).toString('hex')) };
  let certificate = { seal, attestations: attest(seal) };
  if (conflicting) {
    const other = rules.sealReceipts([{ ...receipt, sequence: 2 }], { network, tip: 100, hash: hashAt(100) }, gatewaySecret);
    certificate = { seal: other, attestations: attest(other) };
  }
  f.reads.batchContext = async () => b.context;
  f.reads.receiptCertificate = async () => certificate;
  return { ...f, proposal, files, built };
}
test('full replay accepts empty / certified / empty without changing bytes or digest', async () => {
  const f = replayFixture();
  assert.equal(f.files[0].receiptReference, null);
  assert.equal(f.files[2].receiptReference, f.files[1].receiptRoot.root);
  assert.equal((await f.policy.approve(f.proposal)).digest, Buffer.from(f.built.signingDigest).toString('hex'));
});
test('full replay refuses empty-only omission even though the certificate is valid', async () => {
  const f = replayFixture({ includeSeal: false });
  await assert.rejects(f.policy.approve(f.proposal), /receipt_certificate_read/);
});
test('full replay keeps the existing reference to an already applied certified root', async () => {
  const f = replayFixture({ includeSeal: false, prior: true });
  assert.ok(await f.policy.approve(f.proposal));
});
test('full replay refuses a receipt-bearing file conflicting with the independent certificate', async () => {
  const f = replayFixture({ conflicting: true, prefix: false });
  await assert.rejects(f.policy.approve(f.proposal), /receipt_certificate_read/);
});
