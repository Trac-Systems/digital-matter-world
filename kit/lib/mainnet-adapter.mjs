import { wireIdentities } from '../../rules/src/trac-address.js';
import { check, hex32 } from './check.mjs';
import { publicAddress, publicKey } from './keyring.mjs';
import { validatePlayerConfig } from './network.mjs';
import { productionTrac } from './trac.mjs';
import { headerSource } from './headers.mjs';
import { openPlayerRuntime } from './player-runtime.mjs';

async function collect(read, field) {
  const rows = [], seen = new Set(); let cursor;
  do {
    const page = await read(cursor);
    check(Array.isArray(page[field]) && (page.next === null || typeof page.next === 'string' && page.next.length > 0 && !seen.has(page.next)), 'Invalid public collection page');
    rows.push(...page[field]); cursor = page.next; seen.add(cursor);
  } while (cursor !== null);
  return wireIdentities(rows);
}
export async function create({ wallet, network, config, service, dryRun = true, openRuntime = openPlayerRuntime, pins, timeoutMs = 120000 }) {
  await validatePlayerConfig(config, { pins });
  check(config.mode === 'mainnet' && config.network === network, 'Production network required');
  // Capture the bounded HTTP transport before native modules can install hooks.
  const source = headerSource(config.headerSource, { fetchImpl: service.fetchImpl });
  let runtime;
  // Lazy connection lets MCP initialize/list tools immediately and lets rules,
  // address and public gateway reads work while P2P is still synchronizing.
  let connecting;
  const connect = () => connecting ??= (async () => {
    runtime = await openRuntime({ wallet, config });
    try {
      check(publicKey(runtime.peer.wallet) === publicKey(wallet), 'Runtime must belong to this signer');
      const trac = productionTrac(runtime.peer, { network, msb: runtime.bus, pins: config.trac });
      const health = await service.health(), tip = health.tip;
      check(Number.isSafeInteger(tip) && tip >= config.runtime.deployment.beacon.checkpoint.height, 'Gateway has no current mainnet tip');
      const hash = await source.hash(tip);
      check(hex32(hash), 'Public header source has no current mainnet tip hash');
      const end = Date.now() + timeoutMs;
      for (;;) {
        await runtime.peer.base.update();
        const head = await trac.head();
        if (head.tip.height >= tip && await trac.hashAt(tip) === hash) break;
        check(Date.now() < end, 'Trac synchronization timed out; retry with the same signer and stores');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const requireValidators = () => check(new Set(runtime.bus.network.validatorConnectionManager.connectedValidators()).size >= 3,
        'Paid transfer requires three connected validators');
      const preflight = trac.preflight.bind(trac);
      trac.preflight = async (...args) => {
        const feeBytes = runtime.bus.state.getFee();
        check(feeBytes, 'Wait for the current MSB fee before transferring');
        const fee = BigInt('0x' + Buffer.from(feeBytes).toString('hex'));
        const account = await runtime.bus.state.getNodeEntry(publicAddress(wallet));
        const balance = account ? BigInt('0x' + Buffer.from(account.balance).toString('hex')) : 0n;
        check(balance >= fee && account, `Transfer requires your own MSB account with at least ${fee} TNK atoms (10^18 atoms per TNK); free moves need 0 TNK`);
        check(runtime.peer.base.writable, 'Transfers require this peer to be admitted as a Trac writer; free mining, discovery and crafting do not');
        requireValidators();
        return preflight(...args);
      };
      const send = trac.submit.bind(trac);
      trac.submit = packet => { check(!dryRun, 'Dry-run runtime cannot submit transactions'); requireValidators(); return send(packet); };
      return trac;
    } catch (error) { await runtime.close(); runtime = null; throw error; }
  })();
  const methods = ['head', 'hashAt', 'balance', 'settings', 'mint', 'batchLast', 'batchRoot', 'record', 'preflight', 'prepare', 'submit', 'transactionStatus'];
  const trac = { network, ...Object.fromEntries(methods.map(method => [method, async (...args) => (await connect())[method](...args)])) };
  return { trac, source,
    candidates: async (asset, { block } = {}) => collect(cursor => service.mintRights(publicAddress(wallet), {
      asset, ...(block === undefined ? {} : { block }), limit: 200, sort: 'block', order: 'asc', cursor }), 'mintRights'),
    compounds: () => collect(cursor => service.compounds({ limit: 200, cursor }), 'compounds'),
    close: async () => { if (connecting) await connecting.catch(() => {}); await runtime?.close(); },
  };
}
