import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedPublicMintRow, winningMint } from '../src/mint-evidence.mjs';
import { permit, attachPermit } from '../../committee/signer/adapter.mjs';

test('a signer without a site mint row checks its completion from accepted records and the inscription', async () => {
  const network = 'dmw-test', id = 'aa'.repeat(32), receiver = 'bc1preceiver', ins = 'ee'.repeat(32) + 'i0';
  const d = { id: 'dd'.repeat(32) + 'i0', kind: 'dmt', tick: 'flor', privilegePublicKey: '02' + '11'.repeat(32) };
  const request = { asset: 'p0', block: '106409', amount: '1' }, plan = permit(network, request, d, receiver, id, 'cc'.repeat(32));
  const source = { publicMint: true, requestId: id, request, receiver, deployment: d };
  let inscribed = attachPermit(plan, { r: '1', s: '2', v: 0 });
  const reads = {
    financialRecord: async key => key === 'fi/source/' + id ? source : null,
    publicMintPermit: async () => ({ source, permit: plan }),
    tap: async path => path.startsWith('getDeployment/') ? { ins: d.id } : path === 'getDmtMintHolderByBlock/dmt-flor/106409' ? { ins } : null,
    content: async () => inscribed,
    mintedInscription: async () => ({ ins, fail: false, tick: 'dmt-flor', addr: receiver, amt: '1', dta: plan.payload.dta }),
    included: async () => ({ confirmations: 1 })
  };
  const recovered = (hash, sig) => hash === plan.digest && sig.r === '1' ? d.privilegePublicKey : null;
  const row = await acceptedPublicMintRow(reads, id, {});
  const minted = await winningMint(reads, row, null, recovered, {});
  assert.equal(minted.accepted, true); assert.equal(minted.permitHash, plan.digest); assert.equal(minted.inscription, ins);
  assert.equal(minted.receiver, receiver); assert.equal(minted.amount, '1'); assert.equal(String(minted.block), '106409');
  inscribed = { ...inscribed, dta: inscribed.dta + 'x' };
  await assert.rejects(winningMint(reads, await acceptedPublicMintRow(reads, id, {}), null, recovered, {}), /indexed_mint_binding/, 'another inscription never completes it');
  assert.equal(await acceptedPublicMintRow({ ...reads, financialRecord: async () => ({ ...source, publicMint: false }) }, id, {}), null, 'agent mints keep their own rows');
});

test('signers receive the site mint marker with a mint row', async () => {
  const { projectEvidence } = await import('../src/evidence-projection.mjs');
  const row = projectEvidence('mints', 'aa'.repeat(32), { id: 'aa'.repeat(32), publicMint: true, receiver: 'r', secretNote: 'x' });
  assert.deepEqual(row, { id: 'aa'.repeat(32), receiver: 'r', publicMint: true });
});
