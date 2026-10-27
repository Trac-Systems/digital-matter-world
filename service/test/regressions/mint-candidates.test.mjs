import test from 'node:test';
import assert from 'node:assert/strict';
import { Mints } from '../../src/mints.mjs';
import { Store } from '../../src/store.mjs';
import { temp } from '../helpers.mjs';
import { fixture, network } from '../../../committee/test/fixture.mjs';
import { ethereumFixture } from '../../../committee/test/ethereum-fixture.mjs';
import { expectedEscrowSplit } from '../../../committee/signer/escrow.mjs';

for (const kind of ['tap', 'ethereum']) for (const [linked, found] of [[false, false], [true, false], [true, true]]) {
  test(`${kind} ${linked ? 'linked' : 'unlinked'} ${found ? 'winner' : 'no-finder'} quote and paid permit agree on direct recipients`, async () => {
    const store = await Store.open(await temp('mint-candidate-')), f = kind === 'tap' ? fixture() : ethereumFixture();
    f.data.context.link = linked ? { block: 10, linkHeight: 90 } : null;
    f.data.bitmap = linked ? { agent: f.proposal.request.owner, address: kind === 'tap' ? 'regtest-holder' : f.data.context.landownerAddress } : null;
    if (!found) { f.data.context.find = { block: 10, asset: 'p0', count: 3, finder: null, findHeight: null, settledAt: 90 }; f.data.context.finderAddress = null; }
    if (found) f.reprice();
    const mints = new Mints({ store, network, reads: f.reads });
    try {
      if (!found) {
        await assert.rejects(mints.quote({ asset: 'p0', block: 10, kind }), /mint_no_find/);
        await assert.rejects(f.policy.approve(f.proposal), /block_count/);
        return;
      }
      const quote = await mints.quote({ asset: 'p0', block: 10, kind });
      assert.equal(quote.split.finder, found ? '30' : '0'); assert.equal(quote.split.burn, found ? '20' : linked ? '50' : '65');
      if (kind === 'ethereum') {
        const split = expectedEscrowSplit(quote.split, quote.destinations);
        assert.equal(split.landownerAmount, linked ? '15' : '0'); assert.equal(split.treasuryAmount, '35');
        if (!found) assert.equal(split.finder, '0x' + '00'.repeat(20));
      }
      const approved = await f.policy.approve(f.proposal);
      assert.deepEqual(approved.details.commissions, []);
      assert.equal(approved.permit.address, f.proposal.receiver);
      assert.equal(f.data.payment.fees.filter(x => x.role === 'landowner').length, linked ? 1 : 0);
      assert.equal(store.count('commissionOwed'), 0);
    } finally { await store.close(); }
  });
}
