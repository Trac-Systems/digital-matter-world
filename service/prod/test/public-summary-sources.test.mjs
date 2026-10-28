import test from 'node:test';
import assert from 'node:assert/strict';
import { installPublicSummarySources } from '../public-summary-sources.mjs';

test('public treasury and supply sources verify named snapshots and reject amount/domain/reorg substitutions', async () => {
  const hash = 'a'.repeat(64), ethereum = { chainId: '31337', token: '0x' + 'b'.repeat(40) };
  let amount = '900719925474099312345', changed = false, canonical = hash, ethCanonical = '0x' + hash, chain = '0x7a69', calls = [];
  const stamp = { tip: '10', tipHash: hash, tap: { height: '10', hash, revision: '3' } };
  const reads = { batchStamp: async () => structuredClone({ ...stamp, ...(changed ? { revision: '4' } : {}) }),
    client: { blockHash: async () => canonical }, tap: async path => { calls.push(path); return amount; },
    ethRPC: async (method, params) => {
      calls.push(method);
      if (method === 'eth_chainId') return chain;
      if (method === 'eth_getBlockByNumber') return { number: '0xa', hash: params[0] === 'latest' ? '0x' + hash : ethCanonical };
      if (method === 'eth_call') { assert.equal(params[1], '0xa'); assert.equal(params[0].to, ethereum.token); return '0x' + BigInt('900719925474099312346').toString(16); }
      throw Error('unexpected_source_method');
    } };
  installPublicSummarySources(reads, { ethereum });
  assert.equal((await reads.publicTreasuryAccount('tap', 'named-treasury')).balance, amount);
  assert.equal(calls.filter(x => x.startsWith('get')).join(), 'getBalance/named-treasury/tap');
  amount = null; assert.equal((await reads.publicTreasuryAccount('tap', 'named-treasury')).balance, '0');
  amount = 7; await assert.rejects(reads.publicTreasuryAccount('tap', 'named-treasury'), /public_treasury_amount/);
  amount = '7'; canonical = 'c'.repeat(64); await assert.rejects(reads.publicTreasuryAccount('tap', 'named-treasury'), /public_treasury_snapshot/);
  canonical = hash;
  reads.tap = async () => { changed = true; return '7'; }; await assert.rejects(reads.publicTreasuryAccount('tap', 'named-treasury'), /public_treasury_snapshot/);
  assert.equal((await reads.publicExternalSupply()).ethereum, '900719925474099312346');
  assert.equal((await reads.publicTreasuryAccount('ethereum', '0x' + 'c'.repeat(40))).balance, '900719925474099312346');
  ethCanonical = '0x' + 'd'.repeat(64); await assert.rejects(reads.publicExternalSupply(), /public_supply_reorg/);
  ethCanonical = '0x' + hash; chain = '0x1'; await assert.rejects(reads.publicExternalSupply(), /public_supply_chain/);
  assert.ok(!calls.includes('eth_getLogs'));
});
