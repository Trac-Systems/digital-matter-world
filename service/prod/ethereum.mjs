import { HttpSource, jsonRpc, requireValue as check } from './http.mjs';
import { endpoint } from './config.mjs';
import { EscrowEvents, escrowEventSettings } from '../../committee/signer/escrow-events.mjs';
import { createEscrowReader } from '../../committee/signer/escrow-reader.mjs';
const quantity = value => '0x' + BigInt(value).toString(16);
export async function createEthereum(config, policy, options = {}) {
  const source = new HttpSource({ ...policy, ...await endpoint(config) }), call = jsonRpc(source);
  const verify = async () => check(BigInt(await call('eth_chainId')).toString() === config.chainId, 'ethereum_chain'); await verify();
  return { ...ethereumReader(config, call, options), verify };
}
// Construct the read functions without startup I/O (also used by diagnostics).
export function ethereumReader(config, call, { filename } = {}) {
  // Explicit per-call bounds. Lifetime discovery is checkpointed by EscrowEvents.
  const rpc = async (method, params = []) => {
    if (method !== 'eth_getLogs') return call(method, params);
    const filter = params[0]; check(filter.address?.toLowerCase() === config.address && /^0x[0-9a-f]+$/.test(filter.fromBlock) && /^0x[0-9a-f]+$/.test(filter.toBlock), 'ethereum_log_scope');
    const start = BigInt(filter.fromBlock), end = BigInt(filter.toBlock), span = BigInt(config.maxLogRange); check(end >= start && (end - start) / span + 1n <= BigInt(config.maxLogPages), 'ethereum_log_budget');
    const logs = [];
    for (let block = start; block <= end; block += span) { const to = block + span - 1n < end ? block + span - 1n : end; const page = await call(method, [{ ...filter, fromBlock: quantity(block), toBlock: quantity(to) }]); check(Array.isArray(page) && logs.length + page.length <= (config.eventSettings?.pageLogs ?? 10000), 'ethereum_log_limit'); logs.push(...page); }
    return logs;
  };
  const settings = escrowEventSettings({ blockRange: config.maxLogRange, ...config.eventSettings });
  const events = new EscrowEvents({ rpc, chainId: config.chainId, address: config.address, fromBlock: config.fromBlock, filename, ...settings });
  const reader = createEscrowReader({ rpc, ...config, events });
  const escrow = { deposit: (...args) => reader.deposit(...args), rotation: (...args) => reader.rotation(...args), events };
  Object.defineProperty(rpc, 'escrowEvents', { value: events });
  return { rpc, escrow, events, close: () => events.close() };
}
