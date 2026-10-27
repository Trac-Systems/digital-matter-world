import { check } from '../src/util.mjs';
import { calldata } from '../../committee/signer/escrow.mjs';

// These projections also run in the read-only operator diagnostic. No stores,
// writers, background loops or network clients are opened here.
export async function publicTreasury({ registry, tap, ethRPC, ethereum }) {
  const data = await registry();
  check(data.assets && typeof data.assets === 'object' && !Array.isArray(data.assets), 'treasury_registry', 503);
  const bitcoinAddresses = [...new Set([data.link?.treasury, ...Object.values(data.assets).map(a => a.tap?.treasury)].filter(Boolean))];
  const ethereumAddresses = [...new Set(Object.values(data.assets).map(a => a.ethereum?.treasury).filter(Boolean))];
  const tapAccounts = await Promise.all(bitcoinAddresses.map(async address => {
    const value = await tap('getBalance/' + encodeURIComponent(address) + '/tap');
    // ord-tap's {result:null} means this address has no balance record. Only
    // that documented absence is zero; malformed/provider failures stay errors.
    check(value === null || typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'treasury_tap_balance', 503);
    return { address, balance: value ?? '0' };
  }));
  const tokenAmount = async (signature, args) => {
    const value = await ethRPC('eth_call', [{ to: ethereum.token, data: calldata(signature, args) }, 'latest']);
    check(typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value), 'treasury_ethereum_amount', 503);
    return BigInt(value).toString();
  };
  const ethereumAccounts = await Promise.all(ethereumAddresses.map(async address => ({ address, balance: await tokenAmount('balanceOf(address)', [['address', address]]) })));
  const sum = accounts => accounts.reduce((n, row) => n + BigInt(row.balance), 0n).toString();
  return { treasury: { bitcoin: bitcoinAddresses[0] ?? null, ethereum: ethereumAddresses[0] ?? null,
    tap: sum(tapAccounts), erc20: sum(ethereumAccounts), tapAccounts, ethereumAccounts },
    outstandingSupply: { ethereum: await tokenAmount('totalSupply()', []) } };
}

export async function publicEscrow({ escrow, ethRPC, ethereum }, payer, id) {
  const snapshot = await escrow.deposit(payer, id), payerTopic = '0x' + payer.slice(2).toLowerCase().padStart(64, '0');
  const logs = await ethRPC('eth_getLogs', [{ address: snapshot.address, fromBlock: ethereum.fromBlock, toBlock: snapshot.blockNumber, topics: [null, '0x' + id, payerTopic] }]);
  check(Array.isArray(logs) && logs.length <= 3, 'escrow_event_count', 503);
  const transactions = [];
  for (const log of logs) {
    check(log.removed === false && log.address.toLowerCase() === snapshot.address && log.topics[1]?.toLowerCase() === '0x' + id && log.topics[2]?.toLowerCase() === payerTopic, 'escrow_event_binding', 503);
    check((await ethRPC('eth_getBlockByNumber', [log.blockNumber, false]))?.hash === log.blockHash, 'escrow_event_reorg', 503);
    transactions.push({ txid: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash, logIndex: log.logIndex, topic: log.topics[0] });
  }
  return { ...snapshot, transactions };
}

export async function bitmapOwner({ tap, indexer, bindings }, block) {
  const bitmap = await tap('getBitmap/' + block);
  check(bitmap && bitmap.bm === block && typeof bitmap.ownr === 'string', 'bitmap_missing');
  const inscription = await indexer.inscription(bitmap.ins);
  check(inscription.address === bitmap.ownr, 'bitmap_owner');
  const owners = bindings.owners(bitmap.ownr);
  check(owners.length === 1 && /^[0-9a-f]{64}$/.test(owners[0]), 'bitmap_agent_binding');
  return { agent: owners[0], address: bitmap.ownr };
}
