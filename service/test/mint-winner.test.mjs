import test from 'node:test';
import assert from 'node:assert/strict';
import { winningMint } from '../src/mint-evidence.mjs';

test('a copied valid permit settles the actual official winner and rejects substituted evidence', async () => {
  const original = 'aa'.repeat(32) + 'i0', winning = 'bb'.repeat(32) + 'i1', dep = 'cc'.repeat(32) + 'i0';
  const permit = { p: 'tap', op: 'dmt-mint', tick: 'dmwexample', dep, blk: '10', dta: 'request', prv: { address: 'receiver', hash: 'digest', sig: {} } };
  const row = { permit, receiver: 'receiver', request: { block: 10, amount: '3' }, context: { deployment: { id: dep, kind: 'dmt', tick: permit.tick, privilegePublicKey: 'committee' } } };
  let payload = permit, minted = { ins: winning, fail: false, tick: 'dmt-dmwexample', addr: 'receiver', amt: '3', dta: 'request' };
  const reads = { mintedInscription: async () => minted, tap: async path => path.startsWith('getDeployment') ? { ins: dep } : path.startsWith('getDmtMintHolder') ? { ins: winning } : [minted],
    included: async id => { assert.equal(id, winning); return { confirmations: 1 }; }, content: async () => payload };
  assert.equal((await winningMint(reads, row, { id: original }, () => 'committee')).inscription, winning);
  payload = { ...permit, dep: original }; await assert.rejects(winningMint(reads, row, { id: original }, () => 'committee'), /indexed_mint_binding/);
  payload = permit; minted = { ...minted, addr: 'outsider' }; await assert.rejects(winningMint(reads, row, { id: original }, () => 'committee'));
});
