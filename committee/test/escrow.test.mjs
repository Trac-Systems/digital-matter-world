import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ethereumFixture, localAddress } from './ethereum-fixture.mjs';
import { network } from './fixture.mjs';
import { rules } from '../signer/adapter.mjs';
import { escrowRelease, escrowRotation, hashSplit, expectedEscrowSplit, ethereumSignature, committeeAddress } from '../signer/escrow.mjs';

test('release uses exactly the contract domain and six deposit/epoch fields', () => {
  const f = ethereumFixture(), { deposit, committeeEpoch } = f.data.escrow;
  const original = escrowRelease(f.policy.escrow, f.id, deposit, committeeEpoch);
  assert.deepEqual(original.typedData.domain, { name: 'DmwEscrow', version: '1', chainId: '31337', verifyingContract: f.policy.escrow.address });
  assert.deepEqual(Object.keys(original.typedData.types), ['EIP712Domain', 'Release']);
  assert.deepEqual(original.typedData.message, { requestId: '0x' + f.id, payer: deposit.payer, amount: '100', splitHash: deposit.splitHash, expiry: '10000', committeeEpoch: '0' });
  for (const mutation of [{ payer: localAddress('99') }, { amount: '101' }, { expiry: '10001' }, { split: { ...deposit.split, finder: localAddress('99') } }]) {
    const d = { ...deposit, ...mutation }; d.splitHash = hashSplit(d.split);
    assert.notEqual(original.digest, escrowRelease(f.policy.escrow, f.id, d, committeeEpoch).digest);
  }
  for (const domain of [{ ...f.policy.escrow, chainId: '31338' }, { ...f.policy.escrow, address: localAddress('99') }]) assert.notEqual(original.digest, escrowRelease(domain, f.id, deposit, committeeEpoch).digest);
  assert.notEqual(original.digest, escrowRelease(f.policy.escrow, '01'.repeat(32), deposit, committeeEpoch).digest);
  assert.notEqual(original.digest, escrowRelease(f.policy.escrow, f.id, deposit, '1').digest);
  assert.throws(() => escrowRelease(f.policy.escrow, f.id, { ...deposit, splitHash: '00'.repeat(32) }, committeeEpoch), /split_hash/);
});
const releaseProposal = f => ({network,kind:'ethereum-payment-release',id:f.id});
const held = f => { f.data.pending.s=0;f.data.pending.h=true;return f; };
for(const kind of ['dmt','compound'])test(`Ethereum ${kind}: release is available before mint and requires held units`,async()=>{
  const f=held(ethereumFixture({kind}));
  const signed=await f.policy.approve(releaseProposal(f));assert.equal(signed.digest,f.data.escrow.releaseDigest);
  assert.equal(f.data.mint,null);await assert.rejects(f.policy.approve(f.proposal),/units_not_consumed/);
  f.data.pending.h=false;await assert.rejects(f.policy.approve(releaseProposal(f)),/pending_not_held/);
});
const refusals=[
 ['wrong chain',f=>f.data.escrow.chainId='31338',/escrow_domain/],
 ['wrong escrow',f=>f.data.escrow.address=localAddress('99'),/escrow_domain/],
 ['wrong token',f=>f.data.escrow.token=localAddress('99'),/escrow_domain/],
 ['inactive committee',f=>f.data.escrow.committee=localAddress('99'),/escrow_committee/],
 ['unfunded deposit',f=>f.data.escrow.deposit.status=0,/escrow_expired/],
 ['released deposit',f=>f.data.escrow.deposit.status=2,/escrow_expired/],
 ['refunded deposit',f=>f.data.escrow.deposit.status=3,/escrow_expired/],
 ['unconfirmed deposit',f=>f.data.escrow.confirmations=0,/escrow_funded/],
 ['wrong request',f=>f.data.escrow.requestId='01'.repeat(32),/escrow_funded/],
 ['expired deposit',f=>f.data.escrow.timestamp=f.data.escrow.deposit.expiry,/escrow_expired/],
 ['wrong payer',f=>f.data.escrow.deposit.payer=localAddress('99'),/escrow_funded/],
 ['wrong amount',f=>f.data.escrow.deposit.amount='101',/escrow_split/],
 ['redirected recipient',f=>f.data.escrow.deposit.split.finder=localAddress('99'),/escrow_split/],
 ['wrong burn',f=>f.data.escrow.deposit.split.burnAmount='19',/escrow_split/],
];
for(const [name,mutate,error] of refusals)test(`Ethereum release refuses ${name}`,async()=>{
  const f=held(ethereumFixture());f.data.payment.split=structuredClone(f.data.payment.split);mutate(f);f.refresh();
  await assert.rejects(f.policy.approve(releaseProposal(f)),error);
});
test('stored split hash and independently read release digest must agree',async()=>{
  const f=held(ethereumFixture());f.data.escrow.deposit.splitHash='0x'+'00'.repeat(32);
  await assert.rejects(f.policy.approve(releaseProposal(f)),/escrow_split_hash/);f.refresh();f.data.escrow.releaseDigest='00'.repeat(32);
  await assert.rejects(f.policy.approve(releaseProposal(f)),/escrow_release_digest/);
});
test('all beneficiaries are paid directly and compound uses maker in finder slot', () => {
  const destinations = { treasury: localAddress('11'), firstMaker: localAddress('22'), finder: localAddress('33'), landowner: localAddress('44'), discoverer: localAddress('55') };
  const fees = rules.splitFee('100', { kind: 'find', linked: true, discovered: true });
  const split = expectedEscrowSplit(fees, destinations);
  assert.equal(split.treasuryAmount, '30'); assert.equal(split.discovererAmount, '5'); assert.equal(split.finderAmount, '30'); assert.equal(split.landownerAmount, '15'); assert.equal(split.landowner, destinations.landowner); assert.equal(split.burnAmount, '20');
  const compound = expectedEscrowSplit(rules.splitFee('100', { kind: 'compound' }), destinations, true);
  assert.equal(compound.finder, destinations.firstMaker); assert.equal(compound.landowner, localAddress('00'));
});
test('rotation binds independently approved successor, nonce, epoch and inclusive deadline', async () => {
  const f = ethereumFixture(), approval = { newCommittee: localAddress('99'), nonce: '0', committeeEpoch: '0', deadline: '1000' };
  const proposal = { network, kind: 'ethereum-rotation', ...approval };
  await assert.rejects(f.policy.approve(proposal), /rotation_not_authorized/);
  f.data.rotation = approval;
  const signed = await f.policy.approve(proposal);
  assert.deepEqual(Object.keys(signed.typedData.types), ['EIP712Domain', 'RotateCommittee']);
  assert.deepEqual(signed.typedData.message, approval);
  for (const changes of [{ newCommittee: localAddress('88') }, { nonce: '1' }, { committeeEpoch: '1' }, { deadline: '1001' }]) {
    await assert.rejects(f.policy.approve({ ...proposal, ...changes }), /rotation_not_authorized/);
    const m = { ...approval, ...changes };
    assert.notEqual(signed.digest, escrowRotation(f.policy.escrow, m.newCommittee, m.nonce, m.committeeEpoch, m.deadline).digest);
  }
  f.data.escrow.rotationNonce = '1'; await assert.rejects(f.policy.approve(proposal), /rotation_stale/);
  f.data.escrow.rotationNonce = '0'; f.data.escrow.committeeEpoch = '1'; await assert.rejects(f.policy.approve(proposal), /rotation_stale/);
  f.data.escrow.committeeEpoch = '0'; f.data.escrow.timestamp = '1001'; await assert.rejects(f.policy.approve(proposal), /rotation_expired/);
});
test('Ethereum signatures serialize 65 bytes and normalize high S with recovery bit', () => {
  const f = ethereumFixture(), key = new Uint8Array(32).fill(2), digest = f.data.escrow.releaseDigest;
  const sig = secp256k1.sign(digest, key, { prehash: false, lowS: true });
  const low = ethereumSignature({ r: sig.r.toString(), s: sig.s.toString(), v: sig.recovery });
  assert.equal(low.length, 132);
  assert.equal(low, ethereumSignature({ r: sig.r.toString(), s: (secp256k1.CURVE.n - sig.s).toString(), v: sig.recovery ^ 1 }));
  assert.equal(committeeAddress(secp256k1.Signature.fromCompact(low.slice(2, 130)).addRecoveryBit(parseInt(low.slice(130), 16) - 27).recoverPublicKey(digest).toHex(true)), f.data.escrow.committee);
  assert.throws(() => ethereumSignature({ r: '0', s: '1', v: 0 }), /ethereum_signature/);
});

test('release reads bind payer and request and self-paid roles are zero',async()=>{
  const f=held(ethereumFixture());let args;f.reads.escrowDeposit=async(...a)=>{args=a;return structuredClone(f.data.escrow);};
  const signed=await f.policy.approve(releaseProposal(f));assert.deepEqual(args,[f.data.payer,f.id]);
  assert.deepEqual(signed.slots,[`ethereum/release/31337/${f.policy.escrow.address}/${f.data.payer}/${f.id}`]);
  const fees=rules.splitFee('100',{kind:'compound'}),maker=localAddress('11');
  const split=expectedEscrowSplit(fees,{firstMaker:maker,treasury:localAddress('22')},true,maker.toUpperCase().replace('0X','0x'));
  assert.equal(split.finderAmount,'0');assert.equal(split.finder,localAddress('00'));assert.equal(split.burnAmount,'35');
});

test('committee cannot sign over pending admin recovery, including at or after maturity', async () => {
  const f = ethereumFixture(), approval = { newCommittee: localAddress('99'), nonce: '0', committeeEpoch: '0', deadline: '10000' };
  f.data.rotation = approval;
  const proposal = { network, kind: 'ethereum-rotation', ...approval };
  f.data.escrow.pendingCommittee = { successor: localAddress('88'), executableAt: '2000', nonce: '0', adminOrigin: true };
  for (const timestamp of ['1000', '1999', '2000', '2001']) {
    f.data.escrow.timestamp = timestamp;
    await assert.rejects(f.policy.approve(proposal), /admin_recovery_pending/);
  }
  f.data.escrow.pendingCommittee.adminOrigin = false;
  assert.ok(await f.policy.approve(proposal));
  delete f.data.escrow.pendingCommittee.adminOrigin;
  await assert.rejects(f.policy.approve(proposal), /rotation_origin/);
});
