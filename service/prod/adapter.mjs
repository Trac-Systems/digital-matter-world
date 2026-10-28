import { Links } from '../src/links.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { productionReads } from './reads.mjs';
import { readSecret } from './config.mjs';
import { MintOperations } from '../src/operations.mjs';
import { ethereumPayments } from '../src/ethereum.mjs';
import { check, atomicWrite, hash } from '../src/util.mjs';
import { FeeQuotes, issueFeeTerms } from '../src/fees.mjs';
import { HeaderRelay } from './header-relay.mjs';

export async function createAdapters({ config, store, history, runtime }) {
  const reads = await productionReads(config, store, { runtime }), { manifest, trac, ethRPC } = reads;
  try {
  const gatewaySecret = Buffer.from(await readSecret(config.gatewayKey), 'hex');
  try { reads.feeQuotes = new FeeQuotes({ network: config.network, secret: gatewaySecret, registry: reads.registry }); } finally { gatewaySecret.fill(0); }
  const feeTerms = kind => (id, until, counted) => issueFeeTerms(reads, kind, id, until, counted);
  await mkdir(config.prod.contexts, { recursive: true, mode: 0o700 });
  const operations = new MintOperations({ store, network: config.network, reads });
  const eth = ethereumPayments({ rpc: ethRPC, escrow: config.prod.ethereum });
  const payments = {
    mint: row => reads.mintPayment(row.id, row),
    ethereumDomainMatches: eth.ethereumDomainMatches,
    async settled(kind, id, payer) {
      if (kind === 'ethereum') return eth.settled(kind, id, payer);
      const consumed = await reads.tap('getLockConsume/' + id); if (!consumed) return null;
      const inclusion = await reads.included(consumed.ins); if (!inclusion) return null;
      const payload = await reads.content(id.split(':')[0]);
      return { requestId: payload.redeem.data, kind: consumed.action, confirmations: inclusion.confirmations };
    },
  };
  reads.publishContext = async (n, draft) => {
    const context = { last: draft.last, counted: draft.execution, state: draft.startState, patterns: draft.startPatterns,
      gateway: draft.items[0].input.gateway, settings: draft.settings, limits: draft.limits, headers: draft.headers,
      inputs: draft.items.map(i => ({ ...i.input, state: undefined, patterns: undefined, settings: undefined })) };
    await atomicWrite(join(config.prod.contexts, n + '.json'), JSON.stringify(context));
  };
  let newObservations = false;
  const transport = Object.fromEntries(['prepareMessage', 'sendMessage', 'prepareTransaction', 'sendTransaction', 'status'].map(method => [method, (...args) => trac(method, args)]));
  const links = new Links({ store, network: config.network, reads, terms: feeTerms('link') });
  const relay = new HeaderRelay({ reads, store });
  return { reads, transport, operations, payments, links,
    async pollClock() { const tip = await reads.tip(); return { ...tip, branch: await reads.views.view(tip.tip, tip.tipHash) }; },
    relayHeaders: (outbox, clock) => relay.tick(outbox, clock),
    async observations(previous, clock) {
      const queued = store.list('relayObservations', { limit: 64 }).map(r => r.value);
      if (queued.length) { newObservations = true; return queued; }
      const head = await trac('head'), tip = head.tip;
      check(clock ? clock.branch.hashAt(tip.height) === tip.hash : await reads.client.blockHash(tip.height) === tip.hash, 'bitcoin_beacon_disagreement');
      const branch = clock && clock.tip === tip.height && clock.tipHash === tip.hash ? clock.branch : await reads.views.view(tip.height, tip.hash);
      let common = Math.min(history.length - 1, tip.height);
      while (common >= 0 && history.hashAt(common) !== branch.hashAt(common)) common--;
      check(common >= 0 || history.length === 0, 'bitcoin_history_genesis');
      if (common >= 0 && common < history.length - 1) await history.setTip(common);
      const rows = [], end = Math.min(tip.height, common + config.prod.maxHeadersPerView);
      let height = common + 1;
      // Historical fill has no relay observations. Once startTip is reached,
      // persist each observation before moving on to the next header.
      const fillEnd = Math.min(end, config.prod.startTip - 1);
      while (height <= fillEnd) {
        const stop = Math.min(fillEnd + 1, height + 2048), raws = [];
        for (let n = height; n < stop; n++) raws.push(branch.raw(n));
        await history.appendMany(height, raws); height = stop;
      }
      for (; height <= end && rows.length < 64; height++) {
        await history.append(height, branch.raw(height));
        const observation = { chain: 'main', tip: height, hash: branch.hashAt(height), counted: head.counted, confirmed: Math.min(head.counted, height), headers: [], revision: 0 };
        await store.put('relayObservations', String(height).padStart(16, '0') + '/' + observation.hash, observation); rows.push(observation);
      }
      if (!rows.length && history.length === tip.height + 1 && (!previous || previous.tip !== tip.height || previous.hash !== tip.hash || previous.counted !== head.counted)) {
        const observation = { chain: 'main', tip: tip.height, hash: tip.hash, counted: head.counted, confirmed: Math.min(head.counted, tip.height), headers: [], revision: 0 };
        await store.put('relayObservations', String(tip.height).padStart(16, '0') + '/' + tip.hash, observation); rows.push(observation);
      }
      newObservations = rows.length > 0; return rows;
    },
    async observed(observation) {
      await store.put('relayObservations', String(observation.tip).padStart(16, '0') + '/' + observation.hash);
    },
    async afterObserve(intake) {
      if (intake.head && newObservations) await intake.seal();
      newObservations = false;
    },
    async close() { await reads.close(); }
  };
  } catch (error) { await reads.close(); throw error; }
}
