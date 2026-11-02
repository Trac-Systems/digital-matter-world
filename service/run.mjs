import { mintSenderSettings } from './src/mint-sender-settings.mjs';
import { Inflight, ordInflightReads } from './src/inflight.mjs';
// An unconfirmed reveal for the in-flight display: one GET by txid from a public explorer; 404 means unknown.
const mempoolTransaction = async txid => {
  const response = await fetch(`https://mempool.space/api/tx/${txid}/hex`, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (response.status === 404) return null;
  if (!response.ok) throw Object.assign(new Error('mempool_unavailable'), { status: 503 });
  return (await response.text()).trim();
};
import { MintSenderView } from './src/mint-sender-view.mjs';
import { readMintSeed } from './src/mint-sender-keys.mjs';
import { supportedNode } from '../node-version.mjs';
import { rules } from './src/rules.mjs';
import { evidencePublisher } from './prod/evidence.mjs';
import { closureTimeouts } from '../rules/src/closure-timeouts.js';
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
import { PublicReadPool } from './src/public-read-pool.mjs';
import { publicReadSettings } from './src/public-read-settings.mjs';
import { configurePublicIdentities } from './src/public-identities.mjs';
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
import { takenReadResources } from './src/taken-index.mjs';
import { startupListener } from './src/startup-listener.mjs';
import { phase, withLifecycle, bindLifecycle } from './src/lifecycle.mjs';

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

export async function start(config, { background = false } = {}) {
  const controller = new AbortController();
  return withLifecycle({ signal: controller.signal, onPhase: config.onPhase }, async () => {
    const service = await startGateway(config, controller);
    if (!background) {
      try { await service.ready; } catch (error) { await service.close(); throw error; }
    }
    return service;
  });
}
async function startGateway(config, controller) {
  check(supportedNode(), 'node_version');
  const resources = config.v2 ? runtimeResources(config.v2.resources, config.v2.document) : null;
  const takenReads = takenReadResources(config.takenReads);
  const publicReads = publicReadSettings(config.listen?.publicReads);
  configurePublicIdentities(publicReads);
  config = configuredResources(config);
  const http = await phase('gateway.listen', () => startupListener(config.listen));
  let store, pipeline, adapters, scheduler, evidence, committee, operator, mintSender, readPool, closed = false, closing;
  const service = { ...http };
  const close = () => closing ??= (async () => {
    closed = true; scheduler?.stop();
    controller.abort(Error('gateway_stopping')); committee?.close();
    const replayStopped = pipeline?.replay.close();
    const stoppedHTTP = http.close();
    const stoppedReads = readPool?.close();
    await service.ready.catch(() => {});
    try {
      await phase('gateway.pollers_close', () => scheduler?.close());
      await stoppedHTTP; await stoppedReads; await readPool?.close();
      await operator?.provisioner?.close();
      await replayStopped;
      await phase('gateway.pipeline_close', () => pipeline?.close());
    } finally {
      evidence?.close(); mintSender?.close();
      try { await phase('gateway.adapters_close', () => adapters?.close?.()); }
      finally { await phase('gateway.store_close', () => store?.close({ checkpoint: true })); }
    }
  })();
  service.close = bindLifecycle(close);
  const initialize = async () => {
    await diskCheck(); controller.signal.throwIfAborted();
    store = await phase('gateway.store_open', () => Store.open(config.data, { ...(resources?.store ?? config.storeSettings), takenChangeRows: takenReads.changeRows }));
    service.store = store;
    controller.signal.throwIfAborted();
    const history = new History(store, resources?.history), files = new Files(join(config.data, 'static'));
    const secret = Buffer.from((await readFile(config.gatewayKey, 'utf8')).trim(), 'hex'); check(secret.length === 32, 'gateway_key');
    const module = await import(pathToFileURL(config.adapter).href);
    adapters = await phase('gateway.adapters', () => module.createAdapters({ config, store, history, files }));
    controller.signal.throwIfAborted();
    committee = new Committee({ store, network: config.network, signers: config.committee, epoch: config.epoch ?? 1, assetRecoveryVersion: config.assetRecoveryVersion, batchRetryMs: config.batchRetryMs, ...resources?.committee });
    check(config.v2 || (await adapters.reads.settings?.())?.ruleset !== 'dmw-v2', 'activation_config_required');
    const v2 = config.v2 ? await phase('gateway.v2', () => createV2Runtime({ config, store, secret, history, reads: adapters.reads, committee, deferRecovery: true })) : null;
    controller.signal.throwIfAborted();
    const intake = v2?.intake ?? new Intake({ store, network: config.network, secret, hashAt: history.hashAt, puzzleBits: config.puzzleBits ?? 12 });
    const outbox = new Outbox({ store, transport: adapters.transport, resources: config.assetResources, ...resources?.outbox });
    const feeds = new Feeds({ store, files, history, reads: adapters.reads, settings: resources?.feeds, pagesPerTick: resources?.feeds.feedPagesPerTick });
    await adapters.attachFeeds?.(feeds);
    pipeline = new Pipeline({ pipelineDepth: config.pipelineDepth ?? 1, replay: new Replay(resources?.replay), archiveWritePage: resources?.archiveWritePage, store, files, history, intake, committee, outbox, reads: adapters.reads, financial: v2?.financial,
      operations: v2 ? null : adapters.operations, links: v2 ? null : adapters.links, patterns: config.patterns ?? [], settings: v2?.settings ?? { claimsPerWindow: config.claimsPerWindow ?? rules.CLAIM_DEFAULTS.claimsPerWindow, puzzleBits: config.puzzleBits ?? 12, receiptSigners: config.committee.map(s => s.peer) }, limits: config.batchLimits ?? {} });
    v2?.recovery?.attach({ files, outbox, pipeline }); pipeline.recovery = v2?.recovery;
    const mints = v2 ? v2.mints : adapters.payments && adapters.operations ? new Mints({ store, network: config.network, committee, reads: adapters.reads, payments: adapters.payments, operations: adapters.operations, resources: config.assetResources }) : null;
    if (mints && config.mintSender) {
      const settings = mintSenderSettings(config.mintSender);
      if (settings.seedFile) mints.mintSender = mintSender = new MintSenderView({ seed: await readMintSeed(settings.seedFile), network: config.mode === 'regtest' ? 'regtest' : 'mainnet', settings });
    }
    if (v2?.bulkMints) v2.bulkMints.senderView = mintSender;
    const links = v2 ? v2.links : adapters.links;
    const publicIndex = new PublicIndex({ store, files, history, reads: adapters.reads });
    const publicViews = new PublicViews({ store, history, reads: adapters.reads, mints, network: config.network, claimsPerWindow: config.claimsPerWindow });
    const publicAPI = createPublicAPI({ views: publicViews, files, settings: { ...resources?.feeds, takenPageRows: takenReads.pageRows } });
    const bindings = new Bindings({ store, bindingCacheEntries: publicReads.bindingCacheEntries, network: config.network, bitcoinNetwork: config.mode === 'regtest' ? 'regtest' : 'mainnet', rosterHistory: config.rosterHistory, members: config.committee.map(s => s.peer), committee });
    operator = await createOperator({ config, store, files, reads: adapters.reads, committee });
    if (mints) mints.provisioner = operator.provisioner;
    if (operator.provisioner) { operator.provisioner.financial = v2?.financial; if (mintSender) operator.provisioner.mintSender = mintSender; }
    // Wallet-reported broadcasts, checked against the ord source and shown until the state moves on.
    const inflight = adapters.reads.client ? new Inflight({ store, provisioner: operator.provisioner, mints, links, bitcoin: ordInflightReads(adapters.reads.client, { mempoolTransaction: config.mode === 'regtest' ? null : mempoolTransaction }), settings: config.inflight }) : undefined;
    const web = createWeb(new WebCheckout({ store, config, reads: adapters.reads, mints, bulkMints: v2?.bulkMints, links, inflight,
      post: (path, body) => { check(path === '/link/request' && links, 'link_adapter_unavailable'); return links.request(body); } }));
    const publicCache = cachePublicReads(publicViews, web.checkout);
    evidence = config.mode === 'prod' ? evidencePublisher({ config, store, reads: adapters.reads, secret,
      snapshotLifetimeMs: () => closureTimeouts(v2?.settings.document, config.v2?.resources)?.evidenceMs }) : undefined;
    const headers = new HeaderFiles({ history, files, network: config.mode === 'prod' ? 'mainnet' : 'regtest', chunkSettings: config.headerChunkSettings, secret, signingEpoch: config.headerSigningEpoch });
    controller.signal.throwIfAborted();
    readPool = await PublicReadPool.open({ directory: store.directory, filesDirectory: files.directory,
      version2: !!v2, publicAPI, mints, settings: publicReads, bulkReads: !!v2?.bulkMints, financialActions: !!v2?.financialActions,
      storeSettings: { storePageRows: store.storePageRows, defaultPageRows: store.defaultPageRows },
      apiSettings: { ...resources?.feeds, takenPageRows: takenReads.pageRows },
      bindingsOptions: { network: bindings.network, bitcoinNetwork: bindings.bitcoinNetwork,
        members: bindings.members, rosterHistory: bindings.rosterHistory },
      headerOptions: { network: headers.network, chunkSettings: config.headerChunkSettings }, checkout: true, operator: !!operator });
    controller.signal.throwIfAborted();
    await serve({ readPool, listener: http, evidence, web, operator, inflight, intake, files, headers, mints, bulkMints: v2?.bulkMints, links, financialActions: v2?.financialActions, custody: v2?.custody, submittedBitmaps: adapters.reads.submittedBitmaps, publicAPI, bindings, ...config.listen, ...resources?.http });
    await atomicWrite(join(config.data, 'process.json'), JSON.stringify({ pid: process.pid }));
    controller.signal.throwIfAborted();
    const workerStatus = new WorkerStatus(store), recordError = (e, worker) => workerStatus.failed(e, worker);
    const publicRegistry = v2 && adapters.reads.registry ? new PublicRegistry({ store, registry: adapters.reads.registry, rows: resources?.feeds.feedEventRows }) : null;
    const publicSummaries = v2 ? new PublicSummaries({ store, reads: adapters.reads, rows: resources?.feeds.ownerRefreshRows, refreshMs: resources?.feeds.ownerRefreshMs }) : null;
    const publicTasks = [['public_registry', () => publicRegistry?.tick()], ['public_summaries', () => publicSummaries?.tick()], ['public_status', () => phase('gateway.public_status', () => publicCache.status.refresh())], ['public_catalog', () => publicCache.catalog.refresh()],
      ['public_records', () => publicCache.records.refresh()], ['public_pages', () => publicViews.readIndex?.sync()]];
    const poll = () => closed ? undefined : observeOnce({ v2, adapters, outbox, intake, files, committee, workerStatus, chain: config.mode === 'prod' ? 'main' : 'regtest' });
    scheduler = new AssetScheduler({ intervalMs: config.pollMs ?? 1000, onError: recordError, onSuccess: name => workerStatus.succeeded(name) });
    scheduler.add('observations', poll);
    scheduler.add('header_chunks', () => headers.tick());
    scheduler.add('provisioning', () => operator?.provisioner?.tick());
    scheduler.add('bulk_mints', () => v2?.bulkMints?.tick());
    scheduler.add('financial_deployments', () => mints?.deploymentTick?.());
    scheduler.add('receipt_recovery', () => v2?.recoverReceipts());
    for (const [name, task] of [['pipeline', () => pipeline.tick()], ['recovery', () => v2?.recovery?.tick()], ['outbox', () => outbox.tick()], ['mints', () => mints?.tick()], ['links', () => links?.tick?.()], ['custody', () => v2?.custody?.tick()],
      ['feeds', () => feeds.tick()], ['public_reads', () => v2 ? undefined : publicIndex.tick()], ['operator', () => operator?.tick()], ['bindings', () => bindings.tick()], ...publicTasks]) scheduler.add(name, task);
    Object.assign(service, { intake, pipeline, mints, readPool, recovery: v2?.recovery, adapters, store, operator });
    return service;
  };
  service.ready = initialize();
  // A failed initialization never leaves a partial application listening.
  service.ready.catch(() => { void close().catch(() => {}); });
  return service;
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
    service = await start(config, { background: true });
    const shutdown = () => { void service.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    await service.ready;
    console.log('Gateway initialized. PID:', process.pid);
  } catch (error) { await service?.close(); console.error(error.message === 'feePolicy is required in the operator registry' ? error.message : 'Gateway startup failed; verify the private target, configuration and adapter.'); process.exitCode = 1; }
}
