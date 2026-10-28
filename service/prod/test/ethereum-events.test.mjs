import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EscrowEvents, ESCROW_EVENTS } from '../../../committee/signer/escrow-events.mjs';
import { temporary } from './helpers.mjs';
const address = '0x' + '11'.repeat(20), payer = '0x' + '22'.repeat(20), request = '33'.repeat(32), txid = '0x' + '44'.repeat(32);
const hash = n => '0x' + BigInt(n + 1).toString(16).padStart(64, '0');
function fixture() {
  const state = { calls: [], reorg: false, at: 3, tip: 200001, status: '0x1', kind: 'deposit', index: '0x0' };
  const canonical = n => state.reorg && n >= 3 ? hash(n + 1000000) : hash(n);
  const event = () => ({ address, removed: false, transactionHash: txid, blockNumber: '0x' + state.at.toString(16), blockHash: hash(state.at), logIndex: state.index, data: '0x00', topics: [ESCROW_EVENTS[state.kind], '0x' + request, '0x' + payer.slice(2).padStart(64, '0')] });
  const rpc = async (method, args) => {
    state.calls.push([method, args]);
    if (method === 'eth_getBlockByNumber') return { number: args[0], hash: canonical(Number(BigInt(args[0]))) };
    if (method === 'eth_getTransactionReceipt') return { transactionHash: txid, status: state.status, blockNumber: event().blockNumber, blockHash: event().blockHash, logs: [event()] };
    if (method === 'eth_getLogs') return !state.reorg && Number(BigInt(args[0].fromBlock)) <= state.at && Number(BigInt(args[0].toBlock)) >= state.at ? [event()] : [];
    throw Error(method);
  };
  return { state, rpc };
}
test('an old named receipt bypasses a 200,000-block horizon and is revalidated after restart', async t => {
  const filename = join(await temporary(t), 'events.sqlite'), f = fixture(), options = { filename, rpc: f.rpc, chainId: '1', address, blockRange: 2, pagesPerTick: 1 };
  let index = new EscrowEvents(options);
  assert.equal((await index.find('deposit', payer, request, '0x30d41', txid)).transactionHash, txid);
  assert.equal(f.state.calls.filter(c => c[0] === 'eth_getLogs').length, 0);
  index.close(); index = new EscrowEvents(options); t.after(() => index.close());
  assert.equal((await index.find('deposit', payer, request, '0x30d41')).transactionHash, txid);
  f.state.reorg = true; await assert.rejects(index.find('deposit', payer, request, '0x30d41'), /escrow_event_reorg/);
});

test('release and refund receipts reject failure and follow a re-included transaction', async () => {
  for (const kind of ['release', 'refund']) {
    const f=fixture();f.state.kind=kind;
    const index=new EscrowEvents({rpc:f.rpc,chainId:'1',address});
    try {
      f.state.status='0x0';await assert.rejects(index.find(kind,payer,request,'0x20',txid),/escrow_event_receipt/);
      f.state.status='0x1';await index.find(kind,payer,request,'0x20',txid);
      f.state.at=8;f.state.index='0x4';
      const moved=await index.find(kind,payer,request,'0x20');assert.equal(moved.blockNumber,'0x8');assert.equal(moved.logIndex,'0x4');
      assert.equal(index.db.prepare('SELECT count(*) AS n FROM escrow_events').get().n,1);
      assert.equal(f.state.calls.filter(call=>call[0]==='eth_getLogs').length,0);
    } finally { index.close(); }
  }
});
test('event discovery persists bounded canonical pages and rolls back a changed branch', async t => {
  const filename = join(await temporary(t), 'events.sqlite'), f = fixture(); f.state.at = 7;
  const options = { filename, rpc: f.rpc, chainId: '1', address, blockRange: 2, pagesPerTick: 1 };
  for (let i = 0; i < 3; i++) {
    const index = new EscrowEvents(options); await assert.rejects(index.find('deposit', payer, request, '0x10'), /ethereum_index_catching_up/); index.close();
  }
  const index = new EscrowEvents(options); t.after(() => index.close());
  assert.equal((await index.find('deposit', payer, request, '0x10')).blockNumber, '0x7');
  assert.equal(f.state.calls.filter(c => c[0] === 'eth_getLogs').length, 4);
  f.state.reorg = true;
  for (let i = 0; i < 12; i++) await index.advance('0x10');
  await assert.rejects(index.find('deposit', payer, request, '0x10'), /escrow_deposit_event/);
});
