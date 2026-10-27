import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, batchFixture, network } from './fixture.mjs';
import { rules, attachPermit } from '../signer/adapter.mjs';
import { sha256, hex } from '../signer/crypto.mjs';
import { secp256k1 } from '@noble/curves/secp256k1';
import { mintPermit, tokenMintPermit } from '../../local/protocol.mjs';

test('replays the rules from independent inputs and compares canonical binary files and batch', async () => {
  const f = fixture(), b = batchFixture(); f.reads.batchContext = async () => b.context;
  assert.equal((await f.policy.approve(b.proposal)).digest, hex(b.built.signingDigest));
  b.proposal.batch.root = '0'.repeat(64); await assert.rejects(f.policy.approve(b.proposal), /batch_mismatch/);
});
test('refuses mutated per-block bytes and uncounted batches', async () => {
  const f = fixture(), b = batchFixture(); f.reads.batchContext = async () => b.context;
  b.proposal.files[0] += '00'; await assert.rejects(f.policy.approve(b.proposal), /file_mismatch/);
  b.proposal.files[0] = hex(b.built.fileBytes[0]); b.context.counted = 94; await assert.rejects(f.policy.approve(b.proposal), /batch_uncounted/);
});
for (const kind of ['dmt', 'compound']) test(`${kind} permit matches the proven TAP byte format and decimal recoverable signature`, async () => {
  const f = fixture(kind), approval = await f.policy.approve(f.proposal), p = approval.permit;
  const key = new Uint8Array(32).fill(2), sig = secp256k1.sign(p.digest, key, { prehash: false, lowS: true });
  const attached = attachPermit(p, { r: sig.r.toString(), s: sig.s.toString(), v: sig.recovery });
  const expected = kind === 'dmt' ? mintPermit({ tick: p.payload.tick, blk: 10, dep: p.payload.dep, address: p.address, dta: p.payload.dta, salt: p.salt }, key) : tokenMintPermit({ tick: p.payload.tick, amt: p.payload.amt, address: p.address, dta: p.payload.dta, salt: p.salt }, key);
  assert.deepEqual(attached, expected); assert.ok(p.payload.dta.includes(`dmw-mint-v1|${network}|${f.id}|`));
});
const refusals = [
 ['wrong network', f => f.proposal.network = 'other', /network/],
 ['wrong receiver', f => f.proposal.receiver = 'otherParty', /receiver_binding/],
 ['forged owner request', f => f.proposal.signature = '0'.repeat(128), /owner_signature/],
 ['missing pending record', f => f.data.pending = null, /pending_missing/],
 ['unconsumed units', f => f.data.pending.s = 0, /units_not_consumed/],
 ['wrong consumed commitment', f => f.data.pending.permitHash = sha256('other'), /units_not_consumed/],
 ['pending amount mismatch', f => f.data.pending.amount = '4', /pending_binding/],
 ['pending block mismatch', f => f.data.pending.block = 11, /pending_binding/],
 ['pending receiver mismatch', f => f.data.pending.receive = '0'.repeat(64), /pending_binding/],
 ['missing acceptance height', f => f.data.acceptance = null, /pending_missing/],
 ['wrong privilege key', f => f.data.context.deployment.privilegePublicKey = '03' + '0'.repeat(64), /deployment/],
 ['inactive deployment', f => f.data.context.deployment.active = false, /deployment/],
 ['no find', f => f.data.context.find = null, /block_count/],
 ['partial block amount', f => f.data.context.find.count = 4, /block_count/],
 ['missing current Bitmap holder', f => f.data.context.link = { block: 10, linkHeight: 90 }, /bitmap_missing/],
 ['another request holds block', f => f.data.hold.id = sha256('other'), /block_pending/],
 ['wrong payment request', f => f.data.payment.requestId = sha256('other'), /payment_binding/],
 ['unconfirmed item', f => f.data.payment.receipts[0].confirmations = 0, /payment_incomplete/],
 ['used item', f => f.data.payment.receipts[0].used = f.data.payment.receipts[0].amount, /payment_incomplete/],
 ['missing item', f => f.data.payment.receipts.pop(), /payment_incomplete/],
 ['wrong payer', f => f.data.payment.payer = 'otherParty', /payment_binding/],
 ['redirected fee', f => f.data.payment.fees[0].to = 'otherParty', /payment_split/],
 ['burn redirected from its exact address', f => f.data.payment.receipts.at(-1).to = 'another-address', /payment_incomplete/],
 ['redirected receipt', f => f.data.payment.receipts[0].to = 'otherParty', /payment_incomplete/],
];
for (const [name, mutate, error] of refusals) test(`refuses ${name}`, async () => { const f = fixture(); mutate(f); await assert.rejects(f.policy.approve(f.proposal), error); });
test('consumed permit is identical after arbitrary delay and after an indexed mint', async () => {
  const f=fixture(), first=await f.policy.approve(f.proposal);
  f.data.counted=1000000;f.data.minted=true;f.data.context.deployment.remaining='0';
  assert.deepEqual((await f.policy.approve(f.proposal)).permit,first.permit);
});
test('large compound amounts remain exact decimal strings', async () => {
  const f=fixture('compound');f.proposal.request.amount='9007199254740993';
  f.proposal.signature=rules.signRequest('rq',network,f.proposal.request,f.secret);f.reprice();
  assert.equal((await f.policy.approve(f.proposal)).permit.payload.amt,'9007199254740993');
});
test('request cannot override independent reads, authority or consume requirement', async()=>{
  const f=fixture();f.data.pending.s=0;
  await assert.rejects(f.policy.approve({...f.proposal,consumed:false,reads:{},publicKey:'forged'}),/units_not_consumed/);
});

test('batch approval checks current Trac key and epoch independently of replay inputs', async () => {
  const f = fixture(), b = batchFixture(); f.reads.batchContext = async () => b.context;
  for (const epoch of [undefined, -1, '0', 1]) {
    await assert.rejects(f.policy.approve({ ...b.proposal, batch: { ...b.proposal.batch, epoch } }), /batch_epoch/);
  }
  f.data.authority.committee = '02' + '00'.repeat(32);
  await assert.rejects(f.policy.approve(b.proposal), /batch_authority/);
  f.data.authority.committee = f.publicKey; f.data.authority.epoch = 2;
  await assert.rejects(f.policy.approve(b.proposal), /batch_epoch/);
  b.proposal.batch.epoch = 2;
  const approval = await f.policy.approve(b.proposal);
  assert.equal(approval.batch.epoch, 2); assert.deepEqual(approval.slots, ['batch/2/1']);
  // Replay limits cannot replace the authority read or the proposal sequence.
  b.context.limits = { epoch: 0, sequence: 999 };
  assert.equal((await f.policy.approve(b.proposal)).batch.epoch, 2);
  let calls = 0;
  f.reads.authority = async () => ({ ...f.data.authority, epoch: ++calls === 1 ? 2 : 3 });
  await assert.rejects(f.policy.approve(b.proposal), /batch_authority_changed/);
});

test('pending record and acceptance must preserve the owner-signed expiry and actual admission bounds', async () => {
  const f = fixture();
  f.data.pending.e++; f.data.acceptance.expiry++;
  await assert.rejects(f.policy.approve(f.proposal), /pending_acceptance/);
  f.data.pending.e--; f.data.acceptance.expiry--;
  for (const created of [527, -1]) {
    f.data.acceptance.created = created;
    await assert.rejects(f.policy.approve(f.proposal), /pending_acceptance/);
  }
  f.data.acceptance.created = 200; f.data.counted = 366;
  assert.equal((await f.policy.approve(f.proposal)).details.pending.expiry, 532);
  f.data.counted = 367;
  assert.ok(await f.policy.approve(f.proposal));
});

test('admission deadline is checked at acceptance; permits use the signed pending lifetime', async () => {
  const f = fixture('compound'); f.proposal.request.until = 100;
  f.proposal.signature = rules.signRequest('rq', network, f.proposal.request, f.secret);
  const id = rules.pendingId(network, f.proposal.request);
  f.reprice();
  f.data.counted = 200;
  assert.equal((await f.policy.approve(f.proposal)).details.id, id);
  f.data.acceptance.created = 101;
  await assert.rejects(f.policy.approve(f.proposal), /pending_acceptance/);
});

test('regtest policy accepts the re-encoded eater and refuses mainnet burn fees', async () => {
  const f = fixture('dmt', undefined, '100', 'regtest');
  assert.equal(f.data.payment.fees.at(-1).to, rules.tapBurnAddress('regtest'));
  assert.ok(await f.policy.approve(f.proposal));
  f.data.payment.fees.at(-1).to = rules.TAP_BURN;
  await assert.rejects(f.policy.approve(f.proposal), /payment_split/);
});
