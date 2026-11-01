#!/usr/bin/env node
import { supportedNode } from '../../node-version.mjs';
import { encodeTracAddress, publicIdentities } from '../../rules/src/trac-address.js';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { ReadStream, WriteStream } from 'node:tty';
import { init, unlock, wipeWallet, publicAddress, publicKey, defaultDirectory, Agent, ServiceClient, Journal, loadHistory, historyProof, headerSource, regtestSource, downloadHeaders, backtest } from '../lib/index.mjs';
import { check } from '../lib/check.mjs';
import { readInteger } from '../lib/api-values.mjs';
import { serveMcp } from '../lib/mcp.mjs';
import { serveDashboard } from '../lib/dashboard.mjs';
import { dashboardJournal } from '../lib/dashboard-state.mjs';
import { runTool } from '../lib/tools.mjs';
import { explainError } from '../lib/errors.mjs';
import { setup } from '../lib/setup.mjs';
import { upgradeConfig } from '../lib/upgrade.mjs';
import { networkProfile, readNetworkJSON, validatePlayerConfig } from '../lib/network.mjs';
import { manifestTrust } from '../lib/header-manifest.mjs';
import { HistorySync } from '../lib/history-sync.mjs';
import { loadRegtestHistory } from '../lib/headers.mjs';
import { localBitcoinWallet, mempoolBitcoinSource } from '../lib/bitcoin-wallet.mjs';
import { dashboardProfile, findDashboardControl, reserveDashboardControl, dashboardControlHandler, forwardDashboardTool } from '../lib/dashboard-control.mjs';

const { values: opts, positionals: args } = parseArgs({ allowPositionals: true, options: {
  directory: { type: 'string' }, config: { type: 'string' }, live: { type: 'boolean', default: false },
  network: { type: 'string' }, 'network-file': { type: 'string' }, import: { type: 'boolean' }, 'skip-addresses': { type: 'boolean' },
  headers: { type: 'string' }, source: { type: 'string' }, independent: { type: 'string' }, output: { type: 'string' },
  start: { type: 'string' }, end: { type: 'string' }, patterns: { type: 'string' }, strategy: { type: 'string' }, help: { type: 'boolean' },
  'max-fee-sats': { type: 'string' }, retry: { type: 'boolean' }, 'fee-rate': { type: 'string' },
  cursor: { type: 'string' }, limit: { type: 'string' }, port: { type: 'string' }
} });
const print = value => process.stdout.write(JSON.stringify(publicIdentities(value)) + '\n');
async function secret(name, prompt) {
  const inherited = process.env[name]; delete process.env[name];
  if (inherited) return inherited;
  check(args[0] !== 'mcp', `Set ${name} in the local launch environment; MCP never reads passwords from its protocol stream`);
  // A filesystem ReadStream cannot disable the terminal driver's echo.
  // Use real TTY streams so readline enters raw mode before accepting secrets.
  const inputFd = openSync('/dev/tty', 'r'); let outputFd;
  try { outputFd = openSync('/dev/tty', 'w'); } catch (error) { closeSync(inputFd); throw error; }
  const input = new ReadStream(inputFd), output = new WriteStream(outputFd);
  const rl = createInterface({ input, output, terminal: true });
  output.write(prompt);
  rl._writeToOutput = () => {};
  try { return await new Promise((resolve, reject) => {
    rl.once('SIGINT', () => reject(Error('Private prompt cancelled')));
    rl.question('', resolve);
  }); }
  finally { output.write('\n'); rl.close(); input.destroy(); output.destroy(); }
}
async function ask(prompt) {
  if (opts['skip-addresses'] || !process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return await new Promise(resolve => rl.question(prompt, resolve)); } finally { rl.close(); }
}
async function mcpSession(server) {
  await new Promise(resolve => {
    const end = () => { process.off('SIGTERM', end); process.off('SIGINT', end); process.stdin.off('end', end); resolve(); };
    process.once('SIGTERM', end); process.once('SIGINT', end); process.stdin.once('end', end); server.server.onclose = end;
  });
}
// One readable log line per pass: the outcome, never the full signed receipt.
const huntSummary = r => JSON.stringify(Object.fromEntries(['state', 'claimState', 'phase', 'window', 'actionId', 'message', 'reason']
  .filter(k => r?.[k] !== undefined).map(k => [k, r[k]]).concat(Array.isArray(r?.plots) ? [['plots', r.plots.length], ['patterns', r.patterns]] : [])));
async function main() {
  check(supportedNode(), 'Use Node 24.22.1 or newer 24.x');
  const command = args[0] ?? 'help';
  const live = opts.live || command === 'dashboard';
  if (command === 'dashboard') check(opts.port === undefined || /^(0|[1-9][0-9]{0,4})$/.test(opts.port) && Number(opts.port) <= 65535, 'Invalid dashboard port');
  let directory = opts.directory ?? process.env.DMW_SIGNER_DIRECTORY ?? defaultDirectory();
  if (opts.help || command === 'help') { process.stdout.write('dmw setup|upgrade|preflight|init|import|address|verify-history|download|backtest|status|once|action|read|mcp|dashboard\n\ndmw setup --network mainnet [--import] [--directory DIR] [--skip-addresses]\ndmw upgrade --config FILE\ndmw preflight --network mainnet\ndmw read TOOL [ARGS.json] --config FILE [--limit 50] [--cursor TOKEN]\ndmw action TOOL [ARGS.json] --config FILE [--live]\ndmw deploy-ticker ASSET TICKER --config FILE [--live] [--max-fee-sats ATOMS]\ndmw dashboard --config /absolute/mainnet.json [--port PORT]\nDashboard clicks sign live mint requests; wallet payments require browser approval.\nWhile it runs, the dashboard keeps the agent claiming once per new Bitcoin block and reveals its saved patterns when due.\nCLI and MCP calls for the same signer and settings run inside the dashboard; each launch still needs the signer password.\nAll tool names and JSON arguments match MCP. Read commands never sign or send moves.\nActions default to dry-run; --live enables sends. Setup writes the pinned network config.\nPasswords and recovery words are accepted only through a hidden terminal prompt\nor DMW_SIGNER_PASSWORD / DMW_SIGNER_MNEMONIC in the local launch environment.\nSee kit/README.md for setup and MCP connection commands.\n'); return; }
  if (command === 'setup') {
    print(await setup({ network: opts.network ?? 'mainnet', networkFile: opts['network-file'], directory, configFile: opts.config,
      password: () => secret('DMW_SIGNER_PASSWORD', 'Keyring password (12+ characters): '),
      ...(opts.import ? { mnemonic: () => secret('DMW_SIGNER_MNEMONIC', 'Recovery words: ') } : {}), ask })); return;
  }
  if (command === 'upgrade') {
    print(await upgradeConfig({ configFile: opts.config, networkFile: opts['network-file'] })); return;
  }
  if (command === 'preflight') {
    const config = opts.config ? await validatePlayerConfig(await readNetworkJSON(opts.config)) : await networkProfile({ network: opts.network, networkFile: opts['network-file'] });
    print({ ready: true, network: config.network, gateway: config.gateway, checks: 'public pins and local configuration only; no network contact or signer unlock' }); return;
  }
  if (command === 'verify-history') { check(opts.headers, '--headers is required'); print(historyProof(await loadHistory(opts.headers))); return; }
  if (command === 'download') {
    check(opts.output, '--output is required');
    const pins = opts.config ? await validatePlayerConfig(await readNetworkJSON(opts.config)) : opts.network === 'regtest' ? null : await networkProfile();
    const source = headerSource(opts.source ?? pins?.headerSource ?? 'https://dmtworld.tap-protocol.com', pins?.headerHTTPSettings);
    print(await downloadHeaders({ output: opts.output, source,
      manifestTrust: pins?.headerManifestTrust ?? (pins && manifestTrust(pins.gatewayKey)), chunkLimits: pins?.headerChunkLimits,
      ...(opts.independent ? { independent: headerSource(opts.independent) } : {}),
      ...(opts.end ? { end: Number(opts.end) } : {}), ...(opts.network === 'regtest' ? { network: 'regtest', independent: opts.independent ? headerSource(opts.independent) : null } : {}),
      onProgress: (() => { let last = ''; return p => { const mark = `${p.phase ?? 'downloading'} ${Math.floor(100 * p.count / p.target)}%`; if (mark !== last) { last = mark; process.stderr.write(mark + '\n'); } }; })() })); return;
  }
  if (command === 'backtest') {
    check(opts.headers, '--headers is required'); const history = await loadHistory(opts.headers);
    const patterns = opts.patterns ? JSON.parse(await readFile(opts.patterns, 'utf8')) : [];
    const strategy = opts.strategy ? (await import(pathToFileURL(resolve(opts.strategy)))).chooseClaims : undefined;
    print(await backtest({ history, patterns, owner: encodeTracAddress('11'.repeat(32)), strategy, start: Number(opts.start ?? 1), end: Number(opts.end ?? history.length - 1),
      onProgress: p => process.stderr.write(JSON.stringify(p) + '\n') })); return;
  }
  let config;
  if (!['init', 'import', 'address'].includes(command)) {
    check(opts.config && isAbsolute(opts.config), 'Pass an absolute local --config file');
    config = await validatePlayerConfig(await readNetworkJSON(opts.config));
    directory = opts.directory ?? config.directory ?? process.env.DMW_SIGNER_DIRECTORY ?? defaultDirectory();
  }
  const password = await secret('DMW_SIGNER_PASSWORD', 'Keyring password (12+ characters): ');
  if (command === 'init' || command === 'import') { print(await init({ directory, password, ...(command === 'import' ? { mnemonic: await secret('DMW_SIGNER_MNEMONIC', 'Recovery words: ') } : {}) })); return; }
  const wallet = await unlock({ directory, password }); let journal, adapter, server, historySync, bitcoinWallet, controlLease;
  const shutdown = async () => { if (server) { const s = server; server = null; await s.close(); } await historySync?.close(); if (journal) { journal.close(); journal = null; } await adapter?.close?.(); bitcoinWallet?.close(); await controlLease?.release(); wipeWallet(wallet); };
  try {
    if (command === 'address') { print({ address: publicAddress(wallet) }); return; }
    let name, input = {};
    if (command === 'deploy-ticker') { check(args.length === 3, 'Usage: deploy-ticker <asset> <ticker>'); name = 'deploy_ticker'; input = { asset: args[1], ticker: args[2], ...(opts.retry ? { retry: true } : {}), ...(opts['max-fee-sats'] ? { maxFeeSats: opts['max-fee-sats'] } : {}), ...(opts['fee-rate'] ? { feeRate: Number(opts['fee-rate']) } : {}) }; }
    if (command === 'read' || command === 'action') {
      check(args[1], 'Pass a tool name or action JSON file');
      if (command === 'action' && args[1].endsWith('.json')) {
        const action = JSON.parse(await readFile(args[1], 'utf8')); name = action.type; input = action.args ?? {};
      } else { name = args[1]; input = args[2] ? JSON.parse(await readFile(args[2], 'utf8')) : {}; }
      check(input && typeof input === 'object' && !Array.isArray(input), 'Tool arguments must be an object');
    }
    const toolInput = { ...input, ...(opts.limit === undefined ? {} : { limit: Number(opts.limit) }), ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }) };
    const scope = `${config.network}/${publicKey(wallet)}`, profile = dashboardProfile(config, opts);
    if (['read', 'action', 'deploy-ticker', 'once', 'status', 'mcp'].includes(command)) {
      const control = await findDashboardControl({ directory, scope, profile });
      if (control) {
        const invoke = (name, input, extra) => forwardDashboardTool(control, wallet, { name, input, readOnly: command === 'read', live,
          waitForHistory: command !== 'mcp' && (command === 'once' || ['search_patterns', 'pattern_search_matches', 'propose_pattern', 'reveal_pattern', 'backtest'].includes(name)) }, extra);
        if (command === 'mcp') {
          process.stderr.write('Your dashboard is running; tool calls will run inside it.\n');
          server = await serveMcp({}, { invoke }); await mcpSession(server);
        } else {
          const result = await invoke(command === 'once' ? 'mine_once' : command === 'status' ? 'status' : name,
            ['once', 'status'].includes(command) ? {} : toolInput);
          process.stderr.write('Your dashboard is running; this command ran inside it.\n'); print(result);
        }
        return;
      }
    }
    if (command === 'dashboard') controlLease = await reserveDashboardControl({ directory, scope, owner: publicKey(wallet), profile });
    const production=config.mode==='mainnet';
    check(production || config.localOnly===true && isAbsolute(config.adapter??''), 'Use a public production target or a trusted local adapter');
    // Own the bounded gateway transport before an adapter installs process-wide
    // fetch hooks (the playground's RPC guard intentionally rejects queries).
    const service = new ServiceClient({ origin: config.gateway, mode:production?'mainnet':'regtest', network: config.network, gateway: config.gatewayKey, receiptSigners: config.receiptSigners });
    // Native libraries log every replayed public message even with tx logs off.
    // Keep that unbounded/untrusted feed out of CLI output and MCP's streams.
    if (production) console.log = console.info = console.debug = () => {};
    const adapterModule=production?await import('../lib/mainnet-adapter.mjs'):await import(pathToFileURL(config.adapter));
    adapter=await adapterModule.create({wallet,network:config.network,localOnly:!production,config,service,dryRun:!live});
    journal = await Journal.open(directory, scope);
    const bitcoinNetwork = config.bitcoinNetwork ?? (config.powLimitBits === 0x207fffff ? 'regtest' : 'mainnet');
    bitcoinWallet = localBitcoinWallet({ wallet, network: bitcoinNetwork, authority: config.bitcoin?.authority,
      source: adapter.bitcoinSource ?? (bitcoinNetwork === 'mainnet' || config.bitcoin?.origin ? mempoolBitcoinSource({ network: bitcoinNetwork, ...config.bitcoin }) : undefined) });
    const agentOptions = { wallet, network: config.network, service, trac: adapter.trac, journal, bitcoinWallet, dryRun: !live, puzzleBits: config.puzzleBits ?? 12,
      powLimitBits: config.powLimitBits ?? 0x1d00ffff, paymentOrigin: config.paymentOrigin, owner: config.owner, bitcoinNetwork: config.bitcoinNetwork, miningReads: config.miningReads };
    const agent = new Agent({ ...agentOptions, journal: command === 'dashboard' ? dashboardJournal(journal) : journal });
    const strategyTool = ['mine_once', 'search_patterns', 'compound_idea', 'mint_idea', 'backtest'].includes(name);
    const historyTool = ['search_patterns', 'pattern_search_matches', 'propose_pattern', 'reveal_pattern', 'backtest'].includes(name);
    const hunting = command === 'dashboard', session = ['mcp', 'once'].includes(command) || hunting;
    const source = adapter.source ?? (config.headerCookie ? regtestSource({ origin: opts.source ?? config.headerSource, cookiePath: config.headerCookie }) : headerSource(opts.source ?? config.headerSource, config.headerHTTPSettings));
    let history = adapter.history;
    if (!history && (session || historyTool)) {
      if (source.manifest && (production || config.headerSource || opts.source)) {
        historySync = new HistorySync({ output: opts.headers ?? config.headers ?? join(directory, 'headers.bin'), source,
          network: agent.bitcoinNetwork, manifestTrust: config.headerManifestTrust ?? manifestTrust(config.gatewayKey), chunkLimits: config.headerChunkLimits, independent: agent.bitcoinNetwork === 'mainnet' ? headerSource('https://blockstream.info') : null });
        historySync.start();
        if (command !== 'mcp' && !hunting) { await historySync.pending; history = historySync.available(); }
      } else if (opts.headers ?? config.headers) history = await (agent.bitcoinNetwork === 'regtest' ? loadRegtestHistory : loadHistory)(opts.headers ?? config.headers);
    }
    const strategies = (session || strategyTool) && (opts.strategy ?? config.strategy) ? await import(pathToFileURL(resolve(opts.strategy ?? config.strategy))) : {};
    const context = { agent, history, historySync, source, strategies, candidates: adapter.candidates, compounds: adapter.compounds };
    if (command === 'read' || command === 'action' || command === 'deploy-ticker') {
      print(await runTool(context, name, toolInput, { readOnly: command === 'read' }));
      return;
    }
    if (command === 'status') print(await agent.status());
    else if (command === 'once') print(await agent.runOnce({ history, source, strategy: strategies.chooseClaims }));
    else if (command === 'dashboard') {
      // Keep both launch modes immutable, including their PlayerMint helpers.
      // Forwarded calls retain the ordinary CLI journal's rate gates.
      const forwardAgents = { live: new Agent({ ...agentOptions, dryRun: false }), dry: new Agent({ ...agentOptions, dryRun: true }) };
      // Exclusive agent actions share one turn queue with mining and clicks;
      // their closures still use their own immutable launch mode and journal.
      for (const forwarded of Object.values(forwardAgents)) forwarded.exclusive = fn => agent.exclusive(fn);
      const control = dashboardControlHandler(controlLease, async ({ name, input, readOnly, live, waitForHistory }, extra) => {
        if (waitForHistory) await historySync?.pending;
        return runTool({ ...context, agent: live ? forwardAgents.live : forwardAgents.dry }, name, input, { readOnly, ...extra });
      });
      server = await serveDashboard(context, { port: Number(opts.port ?? 0), control });
      await controlLease.publish(Number(new URL(server.origin).port));
      const stopped = new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
      process.stdout.write(server.loginLink + '\n');
      let stop = false;
      // Local CLI and MCP calls share this process's stores through control.
      const hunt = hunting && (async () => {
        // A block's claim window opens with its publication, which can trail the tip.
        // Poll only the small publication pointer; one full pass per new publication.
        let done = null;
        while (!stop) {
          let tip = null;
          try { tip = readInteger((await agent.service.latest()).tip); } catch {}
          if (tip !== null && tip !== done) {
            try { const r = await runTool(context, 'mine_once', {}); if (r.claimState !== 'taken_syncing') done = tip;
              process.stdout.write(`${new Date().toISOString()} hunt tip ${tip}: ${huntSummary(r)}\n`); }
            catch (error) { process.stdout.write(`${new Date().toISOString()} hunt tip ${tip} failed: ${JSON.stringify(explainError(error)).slice(0, 300)}\n`); }
            // The agent's own saved pattern proposals are revealed as soon as their window opens.
            try { for (const row of (await agent.hunting({ limit: 200 })).items.filter(r => r.type === 'discovery' && r.phase === 'reveal_window')) {
              const r = await runTool(context, 'reveal_pattern', { actionId: row.actionId });
              process.stdout.write(`${new Date().toISOString()} reveal ${row.actionId}: ${huntSummary(r)}\n`); } }
            catch (error) { process.stdout.write(`${new Date().toISOString()} reveal failed: ${JSON.stringify(explainError(error)).slice(0, 300)}\n`); }
          }
          for (let i = 0; i < 20 && !stop; i++) await new Promise(resolve => setTimeout(resolve, 1000));
        }
      })();
      await stopped;
      // A mining pass in flight must not hold up shutdown; closing the stores ends it.
      stop = true; await Promise.race([hunt, new Promise(resolve => setTimeout(resolve, 3000).unref())]);
    } else if (command === 'mcp') {
      server = await serveMcp(context);
      await mcpSession(server);
    } else throw new Error('Unknown command; run dmw --help');
  } finally { await shutdown(); }
}
main().catch(error => { const out = args[0] === 'mcp' ? process.stderr : process.stdout; out.write(JSON.stringify({ error: explainError(error) }) + '\n'); process.exitCode = 1; })
  // The dashboard's mining pass may still wait on a gateway retry; its stores are closed, so end now.
  .finally(() => { if (args[0] === 'dashboard') process.exit(); });
