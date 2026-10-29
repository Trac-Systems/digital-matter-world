import test from 'node:test';
import assert from 'node:assert/strict';
import { Policy } from '../signer/policy.mjs';
import { readPublicWinner, verifyPublicMintEvidence } from '../signer/public-claims.mjs';
import { hash } from '../../rules/src/core.js';
import { publicPlotId } from '../../rules/src/public-mint.js';
import { publicClaimBatch, publicScanBatch } from './public-claim-batch-fixture.mjs';

function fixture() {
  const id = hash('public-winner'), digest = hash('permit'), asset = 'p2:7', block = '12', publicKey = '02' + hash('committee');
  const at = { revision: '1', counted: '1200', last: { n: '5', to: '1200' } };
  const source = { publicMint: true, owner: null, requestId: id, asset, receiver: 'tap-wallet', request: { asset, block },
    deployment: { privilegePublicKey: publicKey } };
  const funding = { publicMint: true, owner: null, state: 'consumed', permitHash: digest, consumedRoot: hash('paid') }, permit = { digest };
  const records = new Map([[`dc/plot/${asset}/${block}`, id], ['fp/' + id, funding],
    ['fp/public/' + publicPlotId(asset, block), { winner: { id, source, permitHash: digest } }]]);
  const reads = { batchStamp: async () => structuredClone(at), financialRecord: async key => records.get(key) ?? null,
    publicMintPermit: async () => ({ source, funding, permit }) };
  const policy = new Policy({ network: 'permanent-claims', publicKey, reads });
  const proposal = { kind: 'mint', network: 'permanent-claims', version: 'public-v1', id, receiver: source.receiver };
  return { id, asset, block, records, reads, policy, proposal, source, funding, digest };
}

test('signer accepts a public permit only for the accepted public plot and consumed payment', async () => {
  const f = fixture(), approved = await f.policy.approve(f.proposal);
  assert.equal(approved.digest, f.digest);
  assert.ok(approved.slots.includes(`mint/block/${f.asset}/${f.block}`));
});

test('signer refuses an agent-first payment, a different public winner, and a forged public funding record', async () => {
  for (const alter of [
    f => f.records.delete(`dc/plot/${f.asset}/${f.block}`),
    f => { const other = hash('other'); f.records.set(`dc/plot/${f.asset}/${f.block}`, other); f.records.set('fp/' + other, f.funding); },
    f => { f.funding.owner = hash('agent'); },
    f => { f.funding.state = 'open'; },
    f => { f.records.set('fp/public/' + publicPlotId(f.asset, f.block), { winner: { id: f.id, permitHash: hash('wrong') } }); }
  ]) {
    const f = fixture(); alter(f); await assert.rejects(f.policy.approve(f.proposal), /public_(minted|permit_binding)/);
  }
});

test('signer rechecks both public-plot presence and absence rather than trusting supplied claim evidence', async () => {
  const f = fixture(), row = { asset: f.asset, block: f.block, id: f.id };
  assert.equal(await readPublicWinner(f.reads, f.asset, f.block), f.id);
  await verifyPublicMintEvidence([{ publicMintEvidence: [row] }], f.reads);
  await assert.rejects(verifyPublicMintEvidence([{ publicMintEvidence: [{ ...row, id: null }] }], f.reads), /public_mint_evidence_read/);
  f.records.delete(`dc/plot/${f.asset}/${f.block}`);
  await verifyPublicMintEvidence([{ publicMintEvidence: [{ ...row, id: null }] }], f.reads);
  await assert.rejects(verifyPublicMintEvidence([{ publicMintEvidence: [row] }], f.reads), /public_mint_evidence_read/);
  f.records.set(`dc/plot/${f.asset}/${f.block}`, f.id); f.records.delete('fp/' + f.id);
  await assert.rejects(readPublicWinner(f.reads, f.asset, f.block), /public_mint_evidence_missing/);
});

test('signer independently replays a signed agent claim refused as public_minted', async () => {
  const f = publicClaimBatch();
  assert.equal(f.output.file.moves[0].reason, 'public_minted');
  assert.equal((await f.policy.approve(f.proposal)).batch.root, f.proposal.batch.root);
});

test('signer refuses a rebuilt batch that hides an earlier public mint behind forged absence evidence', async () => {
  const f = publicClaimBatch({ supplied: null, independent: hash('old-public-winner') });
  assert.equal(f.output.file.moves[0].reason, 'accepted');
  await assert.rejects(f.policy.approve(f.proposal), /public_mint_evidence_read/);
});

test('signer replay worker can point-read old public plots independently when evidence is not supplied', async () => {
  const f = publicClaimBatch({ remote: true });
  assert.equal((await f.policy.approve(f.proposal)).batch.root, f.proposal.batch.root);
});

test('signer replays both agent-first refunds and public winners against independent payment evidence', async () => {
  for (const agentFirst of [true, false]) {
    const f = await publicScanBatch({ agentFirst });
    assert.equal(f.output.file.financialOperations[0].evidence.claim.claimed, agentFirst);
    assert.equal((await f.policy.approve(f.proposal)).batch.root, f.proposal.batch.root);
  }
});

test('signer refuses a scan whose payment evidence carries a different claim decision than its replayed operation', async () => {
  const f = await publicScanBatch({ forgedEvidence: true });
  await assert.rejects(f.policy.approve(f.proposal), /financial_effects/);
});
