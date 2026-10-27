import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Journal } from '../signer/journal.mjs';
import { endorseBinding, verifyPayoutSnapshot } from '../signer/bindings.mjs';
import { bindingFixture } from '../../service/test/bindings-fixture.mjs';
import { agent, temp } from '../../service/test/helpers.mjs';
import { bindingId } from '../../rules/src/payout-bindings.mjs';
import { Store } from '../../service/src/store.mjs';
import { fixture } from './fixture.mjs';
import { mintFeeScope } from '../../service/src/fees.mjs';

test('each signer verifies both wallet proofs and persists its nonce across restart', async () => {
  let now = Date.now(); const f = bindingFixture(null, { now: () => now }), who = agent(41), directory = await temp('binding-signer-');
  const config = { network: 'dmw-regtest', id: f.members[0].id }, secrets = { identity: Buffer.alloc(32, 180).toString('hex') };
  const filename = join(directory, 'signed.log'), key = 'ab'.repeat(32);
  let journal = await new Journal(filename, key, config.network, config.id).load();
  const endorse = record => endorseBinding(record, { config, secrets, journal, bitcoinNetwork: 'regtest', now });
  const record = rail => { const packet = f.packet(who, rail, who.secret.toString('hex'), '1'); return { ...packet, id: bindingId(config.network, 'regtest', packet.request), acceptedAt: now }; };
  try {
    for (const rail of ['tap', 'ethereum']) {
      const r = record(rail);
      await assert.rejects(endorse({ ...r, agentSignature: '00'.repeat(64) }), /binding_agent_signature/);
      await assert.rejects(endorse({ ...r, walletSignature: 'bad' }), /binding_wallet_signature/);
      await endorse(r); assert.equal((await endorse(r)).signer, config.id);
    }
    assert.equal(journal.records.length, 2);
    await journal.close(); journal = await new Journal(filename, key, config.network, config.id).load(); now += 100;
    const conflicting = f.packet(who, 'tap', agent(42).secret.toString('hex'), '1');
    await assert.rejects(endorse({ ...conflicting, id: bindingId(config.network, 'regtest', conflicting.request), acceptedAt: now }), /binding_nonce/);
    const replacement = f.packet(who, 'tap', agent(42).secret.toString('hex'), '2');
    await endorse({ ...replacement, id: bindingId(config.network, 'regtest', replacement.request), acceptedAt: now });
    assert.equal(journal.records.length, 3);
  } finally { await journal.close(); }
});

test('permanent mint approval keep the signed quote payout after two wallet replacements', async () => {
  const store = await Store.open(await temp('binding-release-')); let now = Date.now();
  const f = fixture(), b = bindingFixture(store, { now: () => now }), who = { address: f.proposal.request.owner, secret: Buffer.from(f.secret) };
  try {
    const first = await b.bind(who, 'tap', who.secret.toString('hex'), '1');
    const payouts = { finder: first.id, discoverer: first.id }, scope = mintFeeScope('p0', 10, 'tap');
    f.reads.feeQuotes.now = () => now;
    const quote = await f.reads.feeQuotes.issue(scope, 100, payouts);
    const auth = await f.reads.feeQuotes.accept(quote, scope, f.id, f.proposal.request.expires, 100);
    f.reads.mintFeeTerms = async id => ({ ...await f.reads.feeQuotes.accepted(auth, scope, id, f.proposal.request.expires), payoutSnapshot: quote });
    f.reads.assetContext = async (_asset, _block, _view, snapshot) => ({ ...f.data.context, payouts,
      finderAddress: b.bindings.resolve(who.address, 'tap', snapshot, 'finder').request.address,
      discoverer: b.bindings.resolve(who.address, 'tap', snapshot, 'discoverer').request.address });
    f.reads.verifyPayoutSnapshot = (snapshot, roles) => verifyPayoutSnapshot(snapshot, roles, { bindings: b.bindings, journal: b.journals[0] });
    f.data.context.finderAddress=first.request.address;f.data.context.discoverer=first.request.address;f.reprice();
    now += 10; await b.bind(who, 'tap', agent(42).secret.toString('hex'), '2');
    assert.throws(() => verifyPayoutSnapshot({ ...quote, issuedAt: now }, payouts, { bindings: b.bindings, journal: b.journals[0] }), /binding_rollback/);
    const approved = await f.policy.approve(f.proposal);
    assert.deepEqual(approved.details.commissions, []);
    assert.equal(f.data.payment.fees.find(f=>f.role==='finder').to, first.request.address);
    now += 10; await b.bind(who, 'tap', agent(43).secret.toString('hex'), '3');
    f.confirmed(approved.details);
    assert.deepEqual((await f.policy.approve(f.proposal)).permit, approved.permit);
    assert.deepEqual(approved.details.commissions, []);
  } finally { await store.close(); }
});
