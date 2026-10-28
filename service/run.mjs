import { supportedNode } from '../node-version.mjs';
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
import { Replay } from './src/replay.mjs';
import { Pipeline } from './src/pipeline.mjs';
import { Committee } from './src/committee.mjs';
import { Outbox } from './src/transport.mjs';
import { Mints } from './src/mints.mjs';
import { Feeds } from './src/feeds.mjs';
import { serve } from './src/http.mjs';
import { loadConfig } from './src/config.mjs';
import { PublicRegistry } from './src/public-registry.mjs';
import { PublicSummaries } from './src/public-summaries.mjs';
import { PublicIndex } from './src/public-index.mjs';
import { PublicViews } from './src/public-views.mjs';
import { cachePublicReads } from './src/public-cache.mjs';
import { createPublicAPI } from './src/public-api.mjs';
import { diskCheck, check, atomicWrite } from './src/util.mjs';
import { Bindings } from './src/bindings.mjs';
import { WorkerStatus } from './src/worker-status.mjs';
import { AssetScheduler } from './src/asset-scheduler.mjs';
import { createV2Runtime } from './src/v2-runtime.mjs';
import { runtimeResources, configuredResources } from './src/r3-settings.mjs';

// Let the scheduler record observation failures and clear them only after success.
export async function observeOnce({ checkDisk = diskCheck, v2, adapters, outbox, intake, files, committee, workerStatus, chain }) {
  await checkDisk();
  if (v2?.recovery?.active()) return;
  // Relay before reading observations: a reorg can temporarily leave the
  // contract tip off the source branch, but must not stop header delivery.
  await adapters.relayHeaders?.(outbox);
  await outbox.tick();
  // The adapter verifies the local chain and provides every intermediate
  // tip, including the actual confirmed height after a reorganization.
  for await (const observation of await adapters.observations(intake.head)) {
    check(observation.chain === chain, 'configured_chain_required');
    const sealed = await intake.observe(observation);
    if (sealed) await files.json(files.receiptName(sealed.receiptRoot, sealed), sealed.receiptRoot, { immutable: true });
    if (sealed?.count) await committee.attestRoot(sealed.receiptRoot).then(() => workerStatus.succeeded('witness'), e => workerStatus.failed(e, 'witness'));
    await adapters.observed?.(observation);
  }
  await adapters.afterObserve?.(intake);
  await v2?.refresh();
}

export async function start(config) {
  check(supportedNode(), 'node_version'); await diskCheck();
  const resources = config.v2 ? runtimeResources(config.v2.resources, config.v2.document) : null;
  config = configuredResources(config);
  const store = await Store.open(config.data, resources?.store ?? config.storeSettings), history = new History(store, resources?.history), files = new Files(join(config.data, 'static'));
  let pipeline, http, adapters, scheduler, evidence, closed = false;
  const close = async () => { if (closed) return; closed = true; await scheduler?.close(); await http?.close(); await pipeline?.close(); await adapters?.close?.(); evidence?.close(); await store.close(); };
  try {
    const secret = Buffer.from((await readFile(config.gatewayKey, 'utf8')).trim(), 'hex'); check(secret.length === 32, 'gateway_key');
    const module = await import(pathToFileURL(config.adapter).href);
    adapters = await module.createAdapters({ config, store, history, files });
    const committee = new Committee({ store, network: config.network, signers: config.committee, epoch: config.epoch ?? 1, assetRecoveryVersion: config.assetRecoveryVersion, ...resources?.committee });
    check(config.v2 || (await adapters.reads.settings?.())?.ruleset !== 'dmw-v2', 'activation_config_required');
    const v2 = config.v2 ? await createV2Runtime({ config, store, secret, history, reads: adapters.reads, committee }) : null;
    const intake = v2?.intake ?? new Intake({ store, network: config.network, secret, hashAt: history.hashAt, puzzleBits: config.puzzleBits ?? 12 });
    const outbox = new Outbox({ store, transport: adapters.transport, resources: config.assetResources, ...resources?.outbox });
    const feeds = new Feeds({ store, files, history, reads: adapters.reads, settings: resources?.feeds, pagesPerTick: resources?.feeds.feedPagesPerTick });
    await adapters.attachFeeds?.(feeds);
    pipeline = new Pipeline({ pipelineDepth: config.pipelineDepth ?? 1, replay: new Replay(resources?.replay), archiveWritePage: resources?.archiveWritePage, store, files, history, intake, committee, outbox, reads: adapters.reads, financial: v2?.financial,
      operations: v2 ? null : adapters.operations, links: v2 ? null : adapters.links, patterns: config.patterns ?? [], settings: v2?.settings ?? { claimsPerWindow: config.claimsPerWindow ?? rules.CLAIM_DEFAULTS.claimsPerWindow, puzzleBits: config.puzzleBits ?? 12, receiptSigners: config.committee.map(s => s.peer) }, limits: config.batchLimits ?? {} });
    v2?.recovery?.attach({ files, outbox, pipeline }); pipeline.recovery = v2?.recovery;
    const mints = v2 ? v2.mints : adapters.payments && adapters.operations ? new Mints({ store, network: config.network, committee, reads: adapters.reads, payments: adapters.payments, operations: adapters.operations, resources: config.assetResources }) : null;
    const links = v2 ? v2.links : adapters.links;
    const publicIndex = new PublicIndex({ store, files, history, reads: adapters.reads });
    const publicViews = new PublicViews({ store, history, reads: adapters.reads, mints, network: config.network, claimsPerWindow: config.claimsPerWindow });
    const publicAPI = createPublicAPI({ views: publicViews, files, settings: resources?.feeds });
    const bindings = new Bindings({ store, network: config.network, bitcoinNetwork: config.mode === 'regtest' ? 'regtest' : 'mainnet', rosterHistory: config.rosterHistory, members: config.committee.map(s => s.peer), committee });
    const operator = await createOperator({ config, store, files, reads: adapters.reads, committee });
    if (mints) mints.provisioner = operator.provisioner;
    const web = createWeb(new WebCheckout({ store, config, reads: adapters.reads, mints, links,
      post: (path, body) => { check(path === '/link/request' && links, 'link_adapter_unavailable'); return links.request(body); } }));
    const publicCache = cachePublicReads(publicViews, web.checkout);
    evidence = config.mode === 'prod' ? evidencePublisher({ config, store, reads: adapters.reads, secret }) : undefined;
    const headers = new HeaderFiles({ history, files, network: config.mode === 'prod' ? 'mainnet' : 'regtest', chunkSettings: config.headerChunkSettings, secret, signingEpoch: config.headerSigningEpoch });
    // Pay for the first verified status before accepting browser requests.
    // A failed source remains an error and is retried by the ordinary poll.
    await publicCache.status.refresh().catch(() => {});
    http = await serve({ evidence, web, operator, intake, files, headers, mints, links, financialActions: v2?.financialActions, custody: v2?.custody, submittedBitmaps: adapters.reads.submittedBitmaps, publicAPI, bindings, ...config.listen, ...resources?.http });
    await atomicWrite(join(config.data, 'process.json'), JSON.stringify({ pid: process.pid }));
    const workerStatus = new WorkerStatus(store), recordError = (e, worker) => workerStatus.failed(e, worker);
    const publicRegistry = v2 && adapters.reads.registry ? new PublicRegistry({ store, registry: adapters.reads.registry, rows: resources?.feeds.feedEventRows }) : null;
    const publicSummaries = v2 ? new PublicSummaries({ store, reads: adapters.reads, rows: resources?.feeds.ownerRefreshRows, refreshMs: resources?.feeds.ownerRefreshMs }) : null;
    const publicTasks = [['public_registry', () => publicRegistry?.tick()], ['public_summaries', () => publicSummaries?.tick()], ['public_status', () => publicCache.status.refresh()], ['public_catalog', () => publicCache.catalog.refresh()],
      ['public_records', () => publicCache.records.refresh()], ['public_pages', () => publicViews.readIndex?.sync()]];
    const poll = () => closed ? undefined : observeOnce({ v2, adapters, outbox, intake, files, committee, workerStatus, chain: config.mode === 'prod' ? 'main' : 'regtest' });
    scheduler = new AssetScheduler({ intervalMs: config.pollMs ?? 1000, onError: recordError, onSuccess: name => workerStatus.succeeded(name) });
    scheduler.add('observations', poll);
    scheduler.add('header_chunks', () => headers.tick());
    for (const [name, task] of [['pipeline', () => pipeline.tick()], ['recovery', () => v2?.recovery?.tick()], ['outbox', () => outbox.tick()], ['mints', () => mints?.tick()], ['links', () => links?.tick?.()], ['custody', () => v2?.custody?.tick()],
      ['feeds', () => feeds.tick()], ['public_reads', () => v2 ? undefined : publicIndex.tick()], ['operator', () => operator?.tick()], ['bindings', () => bindings.tick()], ...publicTasks]) scheduler.add(name, task);
    return { ...http, close, intake, pipeline, mints, recovery: v2?.recovery, adapters, store, operator };
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
