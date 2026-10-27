import { rules } from './src/rules.mjs';
import { evidencePublisher } from './prod/evidence.mjs';
import { createOperator } from './src/operator.mjs';
import { createWeb } from './src/web.mjs';
import { WebCheckout } from './src/web-checkout.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './src/store.mjs';
import { Files } from './src/files.mjs';
import { Intake } from './src/intake.mjs';
import { History } from './src/history.mjs';
import { HeaderFiles } from './src/header-files.mjs';
import { Pipeline } from './src/pipeline.mjs';
import { Committee } from './src/committee.mjs';
import { Outbox } from './src/transport.mjs';
import { Mints } from './src/mints.mjs';
import { Feeds } from './src/feeds.mjs';
import { serve } from './src/http.mjs';
import { loadConfig } from './src/config.mjs';
import { PublicIndex } from './src/public-index.mjs';
import { PublicViews } from './src/public-views.mjs';
import { cachePublicReads } from './src/public-cache.mjs';
import { createPublicAPI } from './src/public-api.mjs';
import { diskCheck, check, atomicWrite } from './src/util.mjs';
import { Bindings } from './src/bindings.mjs';
import { WorkerStatus } from './src/worker-status.mjs';

export async function start(config) {
  check(process.version === 'v23.11.0', 'node_version'); await diskCheck();
  const store = await Store.open(config.data), history = new History(store), files = new Files(join(config.data, 'static'));
  let pipeline, http, adapters, timer, safetyTimer, safetyWork = Promise.resolve(), closed = false, work = Promise.resolve();
  const close = async () => { if (closed) return; closed = true; clearTimeout(timer); clearTimeout(safetyTimer); await safetyWork.catch(() => {}); await http?.close(); await work.catch(() => {}); await pipeline?.close(); await adapters?.close?.(); await store.close(); };
  try {
    const secret = Buffer.from((await readFile(config.gatewayKey, 'utf8')).trim(), 'hex'); check(secret.length === 32, 'gateway_key');
    const module = await import(pathToFileURL(config.adapter).href);
    adapters = await module.createAdapters({ config, store, history, files });
    const intake = new Intake({ store, network: config.network, secret, hashAt: history.hashAt, puzzleBits: config.puzzleBits ?? 12, discoveryMaxHeight: config.discoveryMaxHeight ?? 2000000 });
    const committee = new Committee({ store, network: config.network, signers: config.committee, epoch: config.epoch ?? 1 });
    const outbox = new Outbox({ store, transport: adapters.transport });
    const feeds = new Feeds({ store, files, history, reads: adapters.reads });
    await adapters.attachFeeds?.(feeds);
    pipeline = new Pipeline({ store, files, history, intake, committee, outbox, reads: adapters.reads, operations: adapters.operations, links: adapters.links, patterns: config.patterns ?? [], settings: { claimsPerWindow: config.claimsPerWindow ?? rules.CLAIM_DEFAULTS.claimsPerWindow, puzzleBits: config.puzzleBits ?? 12, receiptSigners: config.committee.map(s => s.peer) }, limits: config.batchLimits ?? {} });
    const mints = adapters.payments && adapters.operations ? new Mints({ store, network: config.network, committee, reads: adapters.reads, payments: adapters.payments, operations: adapters.operations }) : null;
    const publicIndex = new PublicIndex({ store, files, history, reads: adapters.reads });
    const publicViews = new PublicViews({ store, history, reads: adapters.reads, mints, network: config.network, claimsPerWindow: config.claimsPerWindow });
    const publicAPI = createPublicAPI({ views: publicViews, files });
    const bindings = new Bindings({ store, network: config.network, bitcoinNetwork: config.mode === 'regtest' ? 'regtest' : 'mainnet', rosterHistory: config.rosterHistory, members: config.committee.map(s => s.peer), committee });
    const operator = await createOperator({ config, store, files, reads: adapters.reads, committee });
    if (mints) mints.provisioner = operator.provisioner;
    const web = createWeb(new WebCheckout({ store, config, reads: adapters.reads,
      post: (path, body) => { check(path === '/link/request', 'web_post_path'); return adapters.links.request(body); } }));
    const publicCache = cachePublicReads(publicViews, web.checkout);
    const evidence = config.mode === 'prod' ? evidencePublisher({ config, store, reads: adapters.reads, secret }) : undefined;
    const headers = new HeaderFiles({ history, files, network: config.mode === 'prod' ? 'mainnet' : 'regtest' });
    // Pay for the first verified status before accepting browser requests.
    // A failed source remains an error and is retried by the ordinary poll.
    await publicCache.status.refresh().catch(() => {});
    http = await serve({ evidence, web, operator, intake, files, headers, mints, links: adapters.links, publicAPI, bindings, ...config.listen });
    await atomicWrite(join(config.data, 'process.json'), JSON.stringify({ pid: process.pid }));
    const workerStatus = new WorkerStatus(store), recordError = (e, worker) => workerStatus.failed(e, worker);
    const publicTasks = [['public_status', () => publicCache.status.refresh()], ['public_catalog', () => publicCache.catalog.refresh()],
      ['public_records', () => publicCache.records.refresh()], ['public_pages', () => publicViews.readIndex.sync()]];
    const poll = async () => {
      if (closed) return;
      try {
        await diskCheck();
        // Relay before reading observations: a reorg can temporarily leave the
        // contract tip off the source branch, but must not stop header delivery.
        await adapters.relayHeaders?.(outbox);
        await outbox.tick();
        // The adapter verifies the local chain and provides every intermediate
        // tip, including the actual confirmed height after a reorganization.
        for await (const observation of await adapters.observations(intake.head)) {
          check(observation.chain === (config.mode === 'prod' ? 'main' : 'regtest'), 'configured_chain_required');
          const sealed = await intake.observe(observation);
          if (sealed) await files.json(`receipts/${sealed.id}.json`, sealed.receiptRoot, { immutable: true });
          if (sealed?.count) await committee.attestRoot(sealed.receiptRoot).then(() => workerStatus.succeeded('witness'), e => recordError(e, 'witness'));
          await adapters.observed?.(observation);
        }
        await adapters.afterObserve?.(intake);
        await workerStatus.succeeded('observations');
        for (const [name, task] of [['pipeline', () => pipeline.tick()], ['outbox', () => outbox.tick()], ['mints', () => mints?.tick()], ['feeds', () => feeds.tick()], ['public_reads', () => publicIndex.tick()], ['operator', () => operator?.tick()]]) { try { await task(); await workerStatus.succeeded(name); } catch (e) { await recordError(e, name); } }
      } catch (e) {
        await recordError(e, 'observations');
      }
      // Refresh even when observation processing or public audit replay failed.
      // Each projection fails independently, so a catalog error cannot stall status.
      for (const [name, task] of publicTasks) await workerStatus.run(name, task);
      if (!closed) timer = setTimeout(() => { work = poll(); }, config.pollMs ?? 1000);
    };
    work = poll(); return { ...http, close, intake, pipeline, mints, adapters, store, operator };
  } catch (e) { await close(); throw e; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let service;
  try {
    let config;
    if (process.argv[2] === '--target') {
      const { loadTarget } = await import('../deploy/target.mjs');
      const { renderTargetRuntime } = await import('../deploy/runtime.mjs');
      config = await renderTargetRuntime(await loadTarget(process.argv[3]));
    } else config = await loadConfig(process.argv[2]);
    service = await start(config);
    process.once('SIGTERM', () => void service.close()); process.once('SIGINT', () => void service.close());
    console.log('Gateway ready. PID:', process.pid);
  } catch (error) { await service?.close(); console.error(error.message === 'feePolicy is required in the operator registry' ? error.message : 'Gateway startup failed; verify the private target, configuration and adapter.'); process.exitCode = 1; }
}
