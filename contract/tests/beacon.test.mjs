import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { targetFromBits, bitsFromTarget, retargetBits, MAINNET_PARAMS, REGTEST_PARAMS, parseHeader, PRUNE_STEPS } from '../beacon/bitcoin.js';
import { BitcoinBeacon as Reference } from './helpers/reset-beacon.js';
import { addr, mine, checkpoint, beaconOptions, chain } from './helpers/chain.mjs';
import { harness, deployment } from './helpers/harness.mjs';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-retarget.json', import.meta.url)));
function beacons(options = beaconOptions) {
  options = { ...options, params: { ...(options.params ?? MAINNET_PARAMS), confirmations: 6 } };
  const reference = new Reference(options), h = harness({ ...deployment, beacon: options });
  const ingest = async (headers, poster = addr(1)) => {
    const result = reference.ingest(headers, poster);
    const error = await h.run('hd', { headers }, poster);
    assert.equal(error, result.error ?? (result.accepted === 0 ? 'header_known' : null));
    assert.deepEqual((await h.state().head()).tip, reference.tip());
    assert.equal((await h.state().head()).counted, reference.countedHeight());
    return error;
  };
  return { h, reference, ingest };
}
test('RESET fixture: mainnet full period, exact first retarget, six-confirmation count', async () => {
  const { h, reference, ingest } = beacons({ checkpoint: fixture.checkpoint });
  for (let i = 1; i < fixture.headers.length; i += 20) assert.equal(await ingest(fixture.headers.slice(i, i + 20)), null);
  assert.equal((await h.state().head()).tip.height, 32262); assert.equal((await h.state().head()).counted, 32257);
  for (let height = 30240; height <= 32262; height++) assert.equal(await h.state().beacon().hashAt(height), reference.hashAt(height));
  assert.equal((await h.state().beacon().raw(reference.hashAt(32255))).bits, 0x1d00ffff);
  assert.equal((await h.state().beacon().raw(reference.hashAt(32256))).bits, 0x1d00d86a);
});
test('RESET compact targets and fourfold retarget clamp', () => {
  for (const bits of [0, 0x1d80ffff, 0x23000001, 0x22000100, 0x21010000, 0x01000001]) assert.equal(targetFromBits(bits), null);
  for (const bits of [0x1d00ffff, 0x1d00d86a, 0x207fffff, 0x03012345]) assert.equal(bitsFromTarget(targetFromBits(bits)), bits);
  assert.equal(retargetBits(0x1c100000, 1), bitsFromTarget(targetFromBits(0x1c100000) / 4n));
  assert.equal(retargetBits(0x1c100000, 99999999), bitsFromTarget(targetFromBits(0x1c100000) * 4n));
  assert.equal(retargetBits(0x1d00ffff, 99999999), 0x1d00ffff);
});
test('RESET invalid proof, bits, parent, median time and mixed message are atomic', async () => {
  const { h, ingest } = beacons(), good = chain(2), original = structuredClone(h.db);
  const badPow = Buffer.from(good[0], 'hex'); badPow.writeUInt32LE(0x03000001, 72);
  for (const [hx, error] of [[badPow.toString('hex'), 'header_pow'], [mine(checkpoint.hash, 1600, 0x203fffff), 'header_bits'],
    [mine('f'.repeat(64), 1600), 'header_parent'], [mine(checkpoint.hash, 1000), 'header_time']]) {
    assert.equal(await ingest([hx]), error); assert.deepEqual(h.db, original);
  }
  assert.equal(await ingest([good[0], mine('f'.repeat(64), 2000)]), 'header_link'); assert.deepEqual(h.db, original);
  assert.equal(await ingest(Array(21).fill(good[0])), 'header_batch');
  for (const headers of [[], null, ['no'], ['AA'.repeat(80)]]) assert.ok(await ingest(headers));
});
test('RESET duplicates preserve first poster; twenty headers count each height once', async () => {
  const { h, reference, ingest } = beacons(), headers = chain(20);
  assert.equal(await ingest(headers), null); const before = structuredClone(h.db);
  assert.equal(await ingest(headers, addr(2)), 'header_known'); assert.deepEqual(h.db, before);
  assert.equal((await h.state().head()).counted, 15);
  for (let height = 1; height <= 20; height++) assert.equal((await h.state().beacon().raw(reference.hashAt(height))).poster, addr(1));
});
test('RESET median-time-past uses eleven ancestors', async () => {
  const { ingest } = beacons(); const headers = chain(11); await ingest(headers);
  const parent = parseHeader(headers.at(-1));
  assert.equal(await ingest([mine(parent.hash, 4600)]), 'header_time');
  assert.equal(await ingest([mine(parent.hash, 4601)]), null);
});
test('RESET pending reorg, equal-work first arrival, fork exactly at counted boundary', async () => {
  const { h, ingest } = beacons(), headers = chain(10); await ingest(headers);
  const hashes = await Promise.all(Array.from({ length: 6 }, (_, i) => h.state().beacon().hashAt(i)));
  const fork = chain(5, { ...parseHeader(headers[4]), height: 5 }, 601, 7);
  assert.equal(await ingest(fork, addr(2)), null); assert.equal((await h.state().head()).tip.hash, parseHeader(headers[9]).hash);
  const extension = chain(1, parseHeader(fork[4])); assert.equal(await ingest(extension, addr(2)), null);
  assert.equal((await h.state().head()).tip.hash, parseHeader(extension[0]).hash);
  assert.equal(await h.state().beacon().hashAt(6), parseHeader(fork[0]).hash);
  assert.deepEqual(await Promise.all(Array.from({ length: 6 }, (_, i) => h.state().beacon().hashAt(i))), hashes);
  assert.equal(await h.run('hd',{headers:chain(1, { ...parseHeader(headers[3]), height: 4 }, 602, 8)}), null);
});
test('RESET most cumulative work beats a longer chain; counted height never retreats', async () => {
  const params = { ...REGTEST_PARAMS, retarget: true, interval: 4, timespan: 120 };
  const { h, ingest } = beacons({ checkpoint, params });
  await ingest(chain(5, checkpoint, 400));
  const hard = chain(3, checkpoint, 1, 7); await ingest(hard, addr(2));
  const tip = parseHeader(hard[2]), bits = retargetBits(tip.bits, tip.time - checkpoint.time, params);
  const winning = mine(tip.hash, tip.time + 1, bits, 7); assert.equal(await ingest([winning]), null);
  assert.equal((await h.state().head()).tip.height, 4); assert.equal(await h.state().beacon().hashAt(5), null);
});
test('RESET pruning retention and permanent counted hashes survive restart', async () => {
  const { h, ingest } = beacons(), headers = chain(2050); await ingest(headers.slice(0, 20));
  const branch = chain(1, parseHeader(headers[17]), 601, 99); await ingest(branch);
  const branchHash = parseHeader(branch[0]).hash;
  for (let i = 20; i < headers.length; i += 20) await ingest(headers.slice(i, i + 20));
  assert.equal(await h.state().beacon().record(branchHash), null); assert.equal(h.db.has(`b/r/${branchHash}`), false);
  assert.ok([...h.db.keys()].filter(k => k.startsWith('b/r/')).length <= 2022);
  assert.equal(h.db.has(`b/r/${checkpoint.hash}`), false);
  assert.equal(await h.state().beacon().hashAt(1), parseHeader(headers[0]).hash);
  assert.equal((await h.state().head()).counted, 2045);
  assert.equal(await ingest(chain(1, parseHeader(headers.at(-1)))), null);
});
test('fork storm retention is bounded by height and cleanup has a fixed budget', async () => {
  const h = harness({...deployment,beacon:{checkpoint,params:{...REGTEST_PARAMS,interval:12}}});
  const headers=await h.advance(10), parent=parseHeader(headers[7]);
  for(let tag=1;tag<=300;tag++) assert.equal(await h.run('hd',{headers:chain(1,parent,601,tag)}),null);
  await h.advance(11); const before=h.metrics.deletes; await h.advance(1);
  assert.ok(h.metrics.deletes-before<=PRUNE_STEPS*3+20);
  const stale=[...h.db].find(([k,v])=>k.startsWith('b/r/')&&v[0]===9);
  assert.ok(stale); const record=await h.state().beacon().raw(stale[0].slice(4));
  assert.equal(await h.state().beacon().record(record.hash),null);
  assert.equal(await h.run('hd',{headers:chain(1,record,601,999)}),'header_parent');
  await h.advance(10); assert.equal(h.db.has(stale[0]),false);
});
for(const depth of [7,12,100,2016]) test('deep reorg recovery at counted depth '+depth,async()=>{
  const h=harness(); const main=await h.advance(depth+10), counted=(await h.state().head()).counted;
  assert.equal(await h.batch([{op:'mk',to:deployment.admin,asset:'a',amount:'7'}]),null);
  const anchorHeight=counted-depth, anchor=anchorHeight===0?checkpoint:parseHeader(main[anchorHeight-1]);
  const fork=chain(depth+1,anchor,601,91);
  for(let i=0;i<fork.length;i+=20) assert.equal(await h.run('hd',{headers:fork.slice(i,i+20)}),null);
  const head=await h.state().head(); assert.equal(head.counted,counted+1); assert.ok(head.revision>0);
  for(let height=anchorHeight+1;height<=head.tip.height;height++) assert.equal(await h.state().beacon().hashAt(height),parseHeader(fork[height-anchorHeight-1]).hash);
  assert.equal(h.db.get('v/1/a'),'7'); assert.equal((await h.state().batchLast()).n,1);
  assert.equal(await h.batch([]),null); await h.advance(1); assert.equal((await h.state().head()).counted,counted+2);
});
test('fork ancestor outside retained window refuses even if its descendants remain stored',async()=>{
  const h=harness({...deployment,beacon:{checkpoint,params:{...REGTEST_PARAMS,interval:12}}});
  const main=await h.advance(13); const fork=chain(12,parseHeader(main[0]),601,99);
  assert.equal(await h.run('hd',{headers:fork}),null); await h.advance(2);
  assert.equal(await h.run('hd',{headers:chain(1,parseHeader(fork.at(-1)))}),'header_reorg_window');
});
test('shorter heavier fork preserves deadline clock and exposes actual confirmation depth',async()=>{
  const params={...REGTEST_PARAMS,confirmations:2,retarget:true,interval:4,timespan:120};
  const h=harness({...deployment,beacon:{checkpoint,params}});await h.advance(6,400);
  assert.equal((await h.state().head()).counted,5);
  const fork=chain(3,checkpoint,1,82),parent=parseHeader(fork.at(-1)),bits=retargetBits(parent.bits,parent.time-checkpoint.time,params);
  assert.equal(await h.run('hd',{headers:[...fork,mine(parent.hash,parent.time+1,bits,82)]}),null);
  const head=await h.state().head();assert.equal(head.tip.height,4);assert.equal(head.counted,5);assert.equal(head.countedHash,null);assert.equal(head.confirmed,3);
  assert.equal(await h.state().beacon().hashAt(2),parseHeader(fork[1]).hash);
  await h.advance(3,1);assert.equal((await h.state().head()).counted,6);assert.equal((await h.state().head()).confirmed,6);
});

test('default beacon credits every included block immediately and preserves reorg recovery', async () => {
  assert.equal(MAINNET_PARAMS.confirmations, 1); assert.equal(REGTEST_PARAMS.confirmations, 1);
  const h = harness(); const main = await h.advance(3);
  assert.equal((await h.state().head()).counted, 3);
  const fork = chain(3, parseHeader(main[0]), 601, 97);
  assert.equal(await h.run('hd', { headers: fork }), null);
  const head = await h.state().head(); assert.equal(head.counted, 4); assert.equal(head.confirmed, 4);
  assert.equal(head.tip.hash, parseHeader(fork.at(-1)).hash); assert.ok(head.revision > 0);
});
