import { ordinalCodec } from '../../rules/src/integers-v2.js';
import { Links } from '../src/links.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { productionReads } from './reads.mjs';
import { readSecret } from './config.mjs';
import { MintOperations } from '../src/operations.mjs';
import { ethereumPayments } from '../src/ethereum.mjs';
import { check, atomicWrite, hash, heightKey } from '../src/util.mjs';
import { FeeQuotes, issueFeeTerms } from '../src/fees.mjs';
import { HeaderRelay } from './header-relay.mjs';

export async function createAdapters({ config, store, history, runtime }) {
  const reads = await productionReads(config, store, { runtime }), { manifest, trac, ethRPC } = reads, clock = ordinalCodec(!!config.v2);
  try {
  const gatewaySecret = Buffer.from(await readSecret(config.gatewayKey), 'hex');
  try { reads.feeQuotes = new FeeQuotes({ network: config.network, secret: gatewaySecret, registry: reads.registry }); } finally { gatewaySecret.fill(0); }
  const feeTerms = kind => (id, until, counted) => issueFeeTerms(reads, kind, id, until, counted);
  await mkdir(config.prod.contexts, { recursive: true, mode: 0o700 });
  const operations = new MintOperations({ store, network: config.network, reads, resources: config.assetResources });
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
      gateway: draft.items[0]?.input.gateway ?? draft.proposal.batch.renewal?.cutoff.gateway, settings: draft.settings, limits: draft.limits, headers: draft.headers,
      ...(draft.activation ? { activation: draft.activation, previousRoot: draft.previousRoot } : {}),
      inputs: draft.items.map(i => ({ ...i.input, state: undefined, patterns: undefined, settings: undefined })) };
    const bytes = JSON.stringify(context), digest = hash(bytes);
    await atomicWrite(join(config.prod.contexts, digest + '.json'), bytes);
    if (!config.v2) await atomicWrite(join(config.prod.contexts, n + '.json'), bytes);
    await store.put('evidenceContexts', String(n), { path: digest + '.json', hash: digest });
  };
  let newObservations = false;
  const observationPage = config.v2?.resources.values.relayObservationPage ?? 64;
  const transport = Object.fromEntries(['prepareMessage', 'sendMessage', 'prepareTransaction', 'sendTransaction', 'status'].map(method => [method, (...args) => trac(method, args)]));
  const links = new Links({ store, network: config.network, reads, terms: feeTerms('link'), resources: config.assetResources });
  const relay = new HeaderRelay({ reads, store });
  return { reads, transport, operations, payments, links,
    relayHeaders: outbox => relay.tick(outbox),
    async observations(previous) {
      const queued = store.list('relayObservations', { limit: observationPage }).map(r => r.value);
      if (queued.length) { newObservations = true; return queued; }
      const head = await trac('head'), tip = head.tip;
      check(await reads.client.blockHash(tip.height) === tip.hash, 'bitcoin_beacon_disagreement');
      const branch = await reads.views.view(tip.height, tip.hash);
      let common = clock.min(clock.add(history.length, -1), tip.height);
      while (clock.compare(common, 0) >= 0 && history.hashAt(common) !== branch.hashAt(common)) common = clock.add(common, -1);
      check(clock.compare(common, 0) >= 0 || clock.compare(history.length, 0) === 0, 'bitcoin_history_genesis');
      if (clock.compare(common, 0) >= 0 && clock.compare(common, clock.add(history.length, -1)) < 0) await history.setTip(common);
      const rows = [], end = clock.min(tip.height, clock.add(common, config.prod.maxHeadersPerView));
      let height = clock.add(common);
      // Historical fill has no relay observations. Once startTip is reached,
      // persist each observation before moving on to the next header.
      const fillEnd = clock.min(end, clock.add(config.prod.startTip, -1));
      while (clock.compare(height, fillEnd) <= 0) {
        const stop = clock.min(clock.add(fillEnd), clock.add(height, config.v2?.resources.values.headerAppendRows ?? 2048)), raws = [];
        for (let n = height; clock.compare(n, stop) < 0; n = clock.add(n)) raws.push(branch.raw(n));
        await history.appendMany(height, raws); height = stop;
      }
      for (; clock.compare(height, end) <= 0 && rows.length < observationPage; height = clock.add(height)) {
        await history.append(height, branch.raw(height));
        const observation = { chain: 'main', tip: height, hash: branch.hashAt(height), counted: clock.value(head.counted), confirmed: clock.min(head.counted, height), headers: [], revision: clock.zero };
        await store.put('relayObservations', heightKey(height) + '/' + observation.hash, observation); rows.push(observation);
      }
      if (!rows.length && clock.compare(history.length, clock.add(tip.height)) === 0 && (!previous || clock.compare(previous.tip, tip.height) !== 0 || previous.hash !== tip.hash || clock.compare(previous.counted, head.counted) !== 0)) {
        const observation = { chain: 'main', tip: clock.value(tip.height), hash: tip.hash, counted: clock.value(head.counted), confirmed: clock.min(head.counted, tip.height), headers: [], revision: clock.zero };
        await store.put('relayObservations', heightKey(tip.height) + '/' + tip.hash, observation); rows.push(observation);
      }
      newObservations = rows.length > 0; return rows;
    },
    async observed(observation) {
      await store.put('relayObservations', heightKey(observation.tip) + '/' + observation.hash);
    },
    async afterObserve(intake) {
      if (intake.head && newObservations) await intake.seal();
      newObservations = false;
    },
    async close() { await reads.close(); }
  };
  } catch (error) { await reads.close(); throw error; }
}
