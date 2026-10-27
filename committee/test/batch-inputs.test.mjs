import { paidMintPlan } from '../signer/pay-first.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { Policy } from '../signer/policy.mjs';
import { rebuildBatch, rules } from '../signer/adapter.mjs';
import { createLocalReads } from '../signer/reads.mjs';
import { observationFixture, requestInput, hashAt, owner, network } from '../../rules/test/observation-fixture.mjs';
const proposalFor = built => ({ network, kind: 'batch', batch: built.batch, files: built.fileBytes.map(b => Buffer.from(b).toString('hex')) });
async function setup(op = 'rq') {
  const f = fixture(), input = requestInput(f.publicKey), id = rules.pendingId(network, input.request), pending = { id, created: 90, expiry: input.request.expires };
  const authorization = { id, request: input.request, receiver: input.receiver,
    deployment: { id: input.evidence.context.deployment.id, kind: 'dmt', tick: 'dmwtest', privilegePublicKey: f.publicKey },
    permit: { hash: rules.hash('original-permit'), dta: 'original-data' } };
  const mint = { accepted: true, fail: false, confirmations: 1, inscription: rules.hash('indexed-mint') + 'i0', deployment: authorization.deployment.id,
    tick: 'dmwtest', receiver: input.receiver, amount: '3', dta: 'original-data', permitHash: authorization.permit.hash, committee: f.publicKey, block: 10 };
  const cancellation = { requestId: id, txid: rules.hash('cancel'), input: { txid: rules.hash('commit'), vout: 0 }, height: 95, blockHash: hashAt(95), confirmations: 1, preventsMint: true };
  const independent = structuredClone({ context: input.evidence.context, bitmap: null, minted: false, hold: op === 'rq' ? null : { id, expiry: pending.expiry }, balance: '30', nonceUsed: false,
    pending: { s: 0, o: 1, asset: input.request.asset, amount: input.request.amount, receive: input.request.receive, e: pending.expiry, block: 10 }, accepted: pending, authorization, mint, cancellation });
  if (op !== 'rq') {
    Object.assign(f.proposal.request,input.request);f.proposal.signature=input.sig;f.proposal.receiver=input.receiver;
    f.data.context={...f.data.context,...input.evidence.context};
    f.data.acceptance={...pending};f.reprice({consumed:false});
    if(op==='mp')delete f.data.pending.h;
    independent.pending=structuredClone(f.data.pending);independent.context=structuredClone(f.data.context);
    f.data.hold={id,expiry:pending.expiry};
    const plan=await paidMintPlan({reads:f.reads,network,publicKey:f.publicKey,request:input.request,signature:input.sig,receiver:input.receiver,final:op==='mc'});
    independent.payment=structuredClone(plan.payment);
    independent.authorization={...rules.mintAuthorization(plan.details),fees:plan.fees,paymentHash:rules.paymentCommitment(plan.progress.allocations)};
    input.op=op;input.evidence={pending,reservation:independent.pending,payment:independent.payment,authorization:independent.authorization,balance:'30'};
  }
  const observations = observationFixture(); observations.add(100, 95, { mintOperations: [input] });
  const built = observations.build(), calls = [];
  const read = (name, value) => async (...args) => { calls.push({ name, args }); return structuredClone(value()); };
  const reads = { ...f.reads, counted: async () => 95, batchContext: async () => observations.context(),
    batchStamp: async () => ({ counted: 95, tip: 100, tipHash: hashAt(100), revision: 0, last: { n: 0, to: 94 } }),
    balance: read('balance', () => independent.balance), nonceUsed: read('nonce', () => independent.nonceUsed),
    assetContext: read('context', () => independent.context), bitmap: read('bitmap', () => independent.bitmap), isMinted: read('minted', () => independent.minted),
    blockHold: read('hold', () => independent.hold), pending: read('pending', () => independent.pending), pendingAcceptance: read('acceptance', () => independent.accepted),
    mintPayment: read('payment', () => independent.payment), mintAuthorization: read('authorization', () => independent.authorization), mint: read('mint', () => independent.mint),
    cancellation: read('cancellation', () => independent.cancellation), mintCommit: read('commit', () => ({ requestId: id, input: independent.cancellation.input })) };
  const policy = new Policy({ network, publicKey: f.publicKey, reads });
  return { policy, reads, independent, input, built, proposal: proposalFor(built), observations, calls };
}

for (const op of ['rq', 'mp', 'mc']) test(`three separate signers rederive ${op} from their own contract/indexer reads`, async () => {
  for (let i = 0; i < 3; i++) {
    const f = await setup(op); assert.equal((await f.policy.approve(f.proposal)).digest, Buffer.from(f.built.signingDigest).toString('hex'));
    assert.ok(f.calls.length >= 3); assert.equal(f.calls.some(c => c.name === (op === 'rq' ? 'context' : 'payment')), true);
  }
});
for (const [op, field, bad, reason] of [
  ['rq', 'balance', '31', /mint_balance_read/], ['rq', 'nonceUsed', true, /batch_nonce/], ['rq', 'minted', true, /mint_status_read/],
  ['rq', 'hold', { id: rules.hash('other'), expiry: 600 }, /mint_hold_read/],
  ['mp', 'payment', null, /payment_binding/], ['mc', 'pending', null, /pending_missing/],
]) test(`independent ${field} disagreement refuses ${op} despite matching gateway replay`, async () => {
  const f = await setup(op); f.independent[field] = bad;
  await assert.rejects(f.policy.approve(f.proposal), reason);
});
test('Bitmap holder at request observation is independently read, never copied from the file', async () => {
  const f = await setup(), input = structuredClone(f.input);
  input.evidence.context.link = { block: 10, linkHeight: 89 }; input.evidence.bitmap = { agent: owner, address: 'regtest-holder' };
  const observations = observationFixture(); observations.add(100, 95, { mintOperations: [input] });
  f.reads.batchContext = async () => observations.context(); f.independent.context = structuredClone(input.evidence.context);
  f.independent.bitmap = { agent: rules.hash('different-holder'), address: 'regtest-other' };
  await assert.rejects(f.policy.approve(proposalFor(observations.build())), /mint_bitmap_read/);
});
test('signer refuses confirmation waits above one block',async()=>{
  const f=await setup('mc');
  assert.throws(()=>new Policy({network,publicKey:f.policy.publicKey,reads:f.reads,confirmations:12}),/policy_config/);
});
test('contract clock changes during financial evidence verification abort signing', async () => {
  const f = await setup(); let calls = 0; f.reads.counted = async () => ++calls === 1 ? 95 : 96;
  await assert.rejects(f.policy.approve(f.proposal), /batch_clock_changed/);
});
test('mint balance is independently projected after an earlier free credit in a recovery batch', async () => {
  const f = await setup(), input = structuredClone(f.input), observations = observationFixture(); input.evidence.balance = '33';
  for (let tip = 100; tip <= 108; tip++) observations.add(tip, tip - 5, {
    moves: tip === 100 ? [{ window: 100, plots: [{ block: 100, patterns: [0] }] }] : [], mintOperations: tip === 108 ? [input] : [] });
  f.reads.batchContext = async () => observations.context(); f.reads.counted = async () => 103;
  f.reads.batchStamp = async () => ({ counted: 103, tip: 108, tipHash: hashAt(108), revision: 0, last: { n: 0, to: 94 } });
  const proposal = proposalFor(observations.build()); await f.policy.approve(proposal);
  assert.equal(f.calls.filter(c => c.name === 'balance').length, 1);
  f.independent.balance = '29'; await assert.rejects(f.policy.approve(proposal), /mint_balance_read/);
});

test('a same-height reorg during verification refuses signing', async () => {
  const f = await setup(); let n = 0;
  const original = f.reads.batchStamp;
  f.reads.batchStamp = async () => ({ ...await original(), revision: n++ });
  await assert.rejects(f.policy.approve(f.proposal), /batch_snapshot_changed/);
});
for (const scenario of ['stall', 'offline', 'reorg-3-before', 'reorg-3-after', 'reorg-8-before', 'reorg-8-after']) test(`committee independently replays ${scenario} observation coverage`, async () => {
  const f = fixture(), observations = observationFixture();
  const claim = { window: 100, plots: [{ block: 100, patterns: [0] }] };
  observations.add(100, 95, { moves: [claim] });
  if (scenario === 'stall') {
    for (let i = 0; i < 50; i++) observations.add(100, 95);
    for (let tip = 101; tip <= 150; tip++) observations.add(tip);
  } else if (scenario === 'offline') {
    for (let tip = 101; tip < 200; tip++) observations.add(tip);
  } else {
    const [, d, timing] = scenario.split('-'), depth = Number(d), old = timing === 'after' ? 108 : depth === 3 ? 105 : 107;
    for (let tip = 101; tip <= old; tip++) observations.add(tip);
    const fork = h => h <= old - depth ? hashAt(h) : rules.hash(`fork-${h}`);
    observations.add(old, old - 5, { hashAt: fork });
    for (let tip = old + 1; tip <= old + 9; tip++) observations.add(tip, tip - 5, { hashAt: fork });
  }
  f.data.counted = observations.context().counted; f.reads.batchContext = async () => observations.context(); const built = observations.build();
  const approved = await f.policy.approve(proposalFor(built)); assert.equal(approved.batch.root, built.batch.root);
  const replayed = rebuildBatch(network, proposalFor(built), { ...observations.context(), authority: f.data.authority });
  assert.deepEqual(replayed.state, observations.state);
});
