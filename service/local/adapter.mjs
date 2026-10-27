import { Links } from '../src/links.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { localReads } from './reads.mjs';
import { MintOperations } from '../src/operations.mjs';
import { ethereumPayments } from '../src/ethereum.mjs';
import { check, atomicWrite } from '../src/util.mjs';
import { FeeQuotes } from '../src/fees.mjs';

export async function createAdapters({ config, store, history }) {
  const reads = await localReads(config, store), { client, trac, ethRPC } = reads;
  if (config.gatewayKey) reads.feeQuotes = new FeeQuotes({ network: config.network, secret: Buffer.from((await readFile(config.gatewayKey, 'utf8')).trim(), 'hex'), registry: reads.registry });
  const feeTerms = kind => async (id, until, counted) => {
    const policy = (await reads.registry())[kind]; check(policy, kind + '_unconfigured');
    const scope = `${kind}/${id}`, quote = await reads.feeQuotes.issue(scope, counted);
    return { ...policy, baseFee: quote.baseFee, feeAuthorization: await reads.feeQuotes.accept(quote, scope, id, until, counted) };
  };
  await mkdir(config.local.contexts, { recursive: true, mode: 0o700 });
  const operations = new MintOperations({ store, network: config.network, reads });
  const eth = ethereumPayments({ rpc: ethRPC, escrow: config.local.escrow });
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
    await atomicWrite(join(config.local.contexts, n + '.json'), JSON.stringify(context));
  };
  let newObservations = false;
  const transport = Object.fromEntries(['prepareMessage', 'sendMessage', 'prepareTransaction', 'sendTransaction', 'status'].map(method => [method, (...args) => trac(method, args)]));
  const links = new Links({ store, network: config.network, reads, terms: feeTerms('link') });
  return { reads, transport, operations, payments, links,
    async observations(previous) {
      const faults = config.local.faults ? JSON.parse(await readFile(config.local.faults, 'utf8')) : {};
      const revision = faults.observation ?? 0; check(Number.isSafeInteger(revision) && revision >= 0, 'observation_revision');
      const info = await client.tip(); check(client.network === 'regtest', 'local_chain_required');
      const queued = store.list('relayObservations', { limit: 256 }).map(r => r.value);
      if (queued.length) { newObservations = true; return queued; }
      if (history.length === 0) await history.append(0, await client.header(await client.blockHash(0)));
      let head = await trac('head'), intent = store.get('meta', 'relayIntent');
      const checkpoint = (await trac('deployment')).beacon.checkpoint;
      // Seed historical reads through the deployment boundary without submitting
      // pre-checkpoint headers to the beacon. Resume a partially seeded archive.
      if (history.length <= checkpoint.height) {
        check(await client.blockHash(checkpoint.height) === checkpoint.hash, 'relay_checkpoint');
        for (let h = history.length; h <= checkpoint.height; h++) await history.append(h, await client.header(await client.blockHash(h)));
      }
      if (intent && intent.tip <= checkpoint.height) {
        check(history.hashAt(intent.tip) === intent.hash, 'relay_checkpoint_intent');
        await store.put('meta', 'relayIntent'); intent = null;
      }
      let cursor = store.get('meta', 'relayCursor') ?? head.tip;
      const rows = [];
      const relayOne = async item => {
        await store.put('meta', 'relayIntent', item);
        if (head.tip.hash !== item.hash) head = await trac('headers', [item.raws]);
        check((head.accepted ?? head.tip.hash) === item.hash, 'relay_acknowledgement');
        cursor = { height: item.tip, hash: item.hash };
        const canonical = head.tip.hash === item.hash;
        const observation = { chain: 'regtest', tip: item.tip, hash: item.hash, counted: head.counted, confirmed: Math.min(head.counted, item.tip), headers: [], revision: item.revision };
        const key = String(item.tip).padStart(16, '0') + '/' + item.hash;
        await store.transact([{ space: 'meta', id: 'relayIntent' }, { space: 'meta', id: 'relayCursor', value: cursor }, ...(canonical && item.tip >= (config.local.startTip ?? 1) ? [{ space: 'relayObservations', id: key, value: observation }] : [])]);
        if (canonical && item.tip >= (config.local.startTip ?? 1)) rows.push(observation);
      };
      if (intent) { await relayOne(intent); if (rows.length) { newObservations = true; return rows; } }
      let common = Math.min(cursor.height, info.height);
      while (common > 0 && history.hashAt(common) !== await client.blockHash(common)) common--;
      if (common < history.length - 1) await history.setTip(common);
      let raws = [];
      for (let height = common + 1; height <= info.height && rows.length < 64; height++) {
        const hash = await client.blockHash(height), raw = await client.header(hash);
        await history.append(height, raw); raws.push(raw);
        if (raws.length === 20 || height >= (config.local.startTip ?? 1) - 1 || height === info.height) { await relayOne({ tip: height, hash, raws, revision }); raws = []; }
      }
      if (!rows.length && head.tip.hash === info.hash && (!previous || previous.tip !== info.height || previous.hash !== info.hash || previous.counted !== head.counted || previous.revision !== revision)) {
        const observation = { chain: 'regtest', tip: info.height, hash: info.hash, counted: head.counted, confirmed: Math.min(head.counted, info.height), headers: [], revision };
        await store.put('relayObservations', String(info.height).padStart(16, '0') + '/' + info.hash, observation); rows.push(observation);
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
    async close() { reads.close(); }
  };
}
