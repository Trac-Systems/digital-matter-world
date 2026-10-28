import test from 'node:test';
import assert from 'node:assert/strict';
import { createEthereum } from '../ethereum.mjs';
import { signLegacy, rlp } from '../../../deploy/ethereum-signing.mjs';
import { keccak, abiWord, calldata, TYPES, hashSplit, escrowRelease } from '../../../committee/signer/escrow.mjs';
import { createRequire } from 'node:module';
const { secp256k1 } = createRequire(new URL('../../../local/package.json', import.meta.url))('@noble/curves/secp256k1');
import { Store } from '../../src/store.mjs';
import { temporary, MemoryStore, configFixture } from './helpers.mjs';
const address = '0x' + '22'.repeat(20), transaction = { to: address, data: '0xabcdef' };
const config = { chainId: '1', address, maxGas: 500000, maxGasPriceWei: '100000000000' };
function rpcFixture(store) {
  const state = { sends: [], nonce: '0x0', gasPrice: '0x10', chain: '0x1', receipt: null, known: false, fail: false };
  const rpc = async (method, args) => {
    if (method === 'eth_chainId') return state.chain;
    if (method === 'eth_getTransactionCount') return state.nonce;
    if (method === 'eth_gasPrice') return state.gasPrice;
    if (method === 'eth_estimateGas') return '0x10000';
    if (method === 'eth_getTransactionReceipt') return state.receipt;
    if (method === 'eth_getTransactionByHash') return state.known ? {} : null;
    if (method === 'eth_getBlockByNumber') return { hash: '0x' + 'aa'.repeat(32) };
    if (method === 'eth_sendRawTransaction') { assert.ok(store.list('ethereumTransactions').some(r => r.value.raw === args[0])); state.sends.push(args[0]); if (state.fail) throw Error('ambiguous'); return '0x' + keccak(Buffer.from(args[0].slice(2), 'hex')).toString('hex'); }
    throw Error('unexpected RPC');
  };
  return { state, rpc };
}
test('EIP-155 zero-value release signature recovers the expected signer from fixed RLP bytes', () => {
  const raw = signLegacy({ nonce: '9', gasPrice: '20000000000', gas: '21000', to: '0x3535353535353535353535353535353535353535', data: '0x', chainId: '1' }, Buffer.from('46'.repeat(32), 'hex'));
  const encoded = Buffer.from(raw.slice(2), 'hex'), fields = []; let offset = 2;
  while (offset < encoded.length) { const prefix = encoded[offset++]; if (prefix < 128) fields.push(Buffer.from([prefix])); else { const n = prefix - 128; fields.push(encoded.subarray(offset, offset + n)); offset += n; } }
  assert.equal(fields.length, 9); assert.equal(fields[4].length, 0); assert.equal(fields[5].length, 0);
  const digest = keccak(Buffer.from('e4098504a817c80082520894' + '35'.repeat(20) + '8080018080', 'hex'));
  const signature = secp256k1.Signature.fromCompact(Buffer.concat(fields.slice(7))).addRecoveryBit(Number(BigInt('0x' + fields[6].toString('hex')) - 37n));
  assert.equal(signature.recoverPublicKey(digest).toHex(), Buffer.from(secp256k1.getPublicKey(Buffer.from('46'.repeat(32), 'hex'))).toString('hex'));
  assert.equal(rlp([0n, 1n]).toString('hex'), 'c28001');
});
test('service Ethereum adapter exposes reads only', async () => {
  const exports = await import('../ethereum.mjs');
  assert.equal(exports.durableSender, undefined); assert.equal(exports.signLegacy, undefined);
});
test('Ethereum event queries are scoped and paged with a finite total budget', async t => {
  const { config } = await configFixture(t), calls = [];
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_url, options) => { const r = JSON.parse(options.body); calls.push(r); return Response.json({ id: r.id, result: r.method === 'eth_chainId' ? '0x1' : [] }); };
  const client = await createEthereum(config.prod.ethereum, { requestsPerSecond: 100 });
  await client.rpc('eth_getLogs', [{ address, fromBlock: '0x0', toBlock: '0xc8' }]); assert.equal(calls.filter(r => r.method === 'eth_getLogs').length, 3);
  await assert.rejects(client.rpc('eth_getLogs', [{ address, fromBlock: '0x0', toBlock: '0xffff' }]), /ethereum_log_budget/);
  await assert.rejects(client.rpc('eth_getLogs', [{ address: '0x' + 'aa'.repeat(20), fromBlock: '0x0', toBlock: '0x1' }]), /ethereum_log_scope/);
});

test('configured escrow reader verifies deposits and rejects shallow inclusion and event reorgs', async t => {
  const { config } = await configFixture(t), c = config.prod.ethereum, payer = '0x' + '44'.repeat(20), id = '55'.repeat(32);
  const split = { treasury: '0x' + '66'.repeat(20), treasuryAmount: '60', finder: '0x' + '00'.repeat(20), finderAmount: '0', landowner: '0x' + '00'.repeat(20), landownerAmount: '0', discoverer: '0x' + '00'.repeat(20), discovererAmount: '0', burnAmount: '40' };
  const deposit = { payer, status: 1, amount: '100', expiry: '100000', splitHash: hashSplit(split), split }, encode = pairs => '0x' + Buffer.concat(pairs.map(([type, value]) => Buffer.from(abiWord(type, value)))).toString('hex');
  const splitFields = TYPES.Split.map(({ name, type }) => [type, split[name]]), blockHash = '0x' + '77'.repeat(32), inclusionHash = '0x' + '88'.repeat(32);
  const digest = escrowRelease(c, id, deposit, '0').digest;
  const getters = new Map([
    ['token()', encode([['address', c.token]])], ['committee()', encode([['address', payer]])], ['committeeEpoch()', encode([['uint256', '0']])], ['rotationNonce()', encode([['uint256', '0']])],
    ['pendingCommittee()', encode([['address', '0x' + '00'.repeat(20)], ['uint256', '0'], ['uint256', '0'], ['uint256', '0']])],
    ['getDeposit(address,bytes32)', encode([['address', payer], ['uint256', '1'], ['uint256', '100'], ['uint256', '100000'], ['bytes32', deposit.splitHash], ...splitFields])],
    ['releaseDigest(address,bytes32)', '0x' + digest]
  ].map(([signature, value]) => [calldata(signature, []).slice(0, 10), value]));
  const state = { inclusion: '0x5', reorg: false };
  const txid = '0x' + '99'.repeat(32);
  const event = () => ({ address: c.address, removed: false, blockNumber: state.inclusion, blockHash: inclusionHash, transactionHash: txid, logIndex: '0x0', topics: ['0x' + keccak(Buffer.from('Deposited(bytes32,address,uint256,uint256,bytes32,(address,uint256,address,uint256,address,uint256,address,uint256,uint256))')).toString('hex'), '0x' + id, encode([['address', payer]])], data: encode([['uint256', '100'], ['uint256', '100000'], ['bytes32', deposit.splitHash], ...splitFields]) });
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_url, options) => {
    const r = JSON.parse(options.body); let result;
    if (r.method === 'eth_chainId') result = '0x1';
    else if (r.method === 'eth_call') result = getters.get(r.params[0].data.slice(0, 10));
    else if (r.method === 'eth_getBlockByNumber') result = r.params[0] === 'latest' || r.params[0] === '0xa' ? { number: '0xa', hash: blockHash, timestamp: '0x3e8' } : { hash: state.reorg ? blockHash : inclusionHash };
    else if (r.method === 'eth_getLogs') result = [event()];
    else if (r.method === 'eth_getTransactionReceipt') result = { transactionHash: txid, status: '0x1', blockNumber: state.inclusion, blockHash: inclusionHash, logs: [event()] };
    else throw Error('unrecorded RPC');
    return Response.json({ id: r.id, result });
  };
  const client = await createEthereum(c, { requestsPerSecond: 100 }); t.after(() => client.close()); const { escrow } = client;
  assert.equal((await escrow.deposit(payer, id)).confirmations, 6);
  state.inclusion = '0x6'; assert.equal((await escrow.deposit(payer,id, { depositTxid: txid })).confirmations,5);
  state.inclusion = '0x5'; state.reorg = true; await assert.rejects(escrow.deposit(payer, id), /escrow_event_reorg/);
});
