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
import { serveMcp } from '../lib/mcp.mjs';
import { runTool } from '../lib/tools.mjs';
import { explainError } from '../lib/errors.mjs';
import { setup } from '../lib/setup.mjs';
import { upgradeConfig } from '../lib/upgrade.mjs';
import { networkProfile, readNetworkJSON, validatePlayerConfig } from '../lib/network.mjs';
import { manifestTrust } from '../lib/header-manifest.mjs';
import { HistorySync } from '../lib/history-sync.mjs';
import { loadRegtestHistory } from '../lib/headers.mjs';
import { localBitcoinWallet, mempoolBitcoinSource } from '../lib/bitcoin-wallet.mjs';

const { values: opts, positionals: args } = parseArgs({ allowPositionals: true, options: {
  directory: { type: 'string' }, config: { type: 'string' }, live: { type: 'boolean', default: false },
  network: { type: 'string' }, 'network-file': { type: 'string' }, import: { type: 'boolean' }, 'skip-addresses': { type: 'boolean' },
  headers: { type: 'string' }, source: { type: 'string' }, independent: { type: 'string' }, output: { type: 'string' },
  start: { type: 'string' }, end: { type: 'string' }, patterns: { type: 'string' }, strategy: { type: 'string' }, help: { type: 'boolean' },
  cursor: { type: 'string' }, limit: { type: 'string' }
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
async function main() {
  check(supportedNode(), 'Use Node 24.22.1 or newer 24.x');
  const command = args[0] ?? 'help';
  let directory = opts.directory ?? process.env.DMW_SIGNER_DIRECTORY ?? defaultDirectory();
  if (opts.help || command === 'help') { process.stdout.write('dmw setup|upgrade|preflight|init|import|address|verify-history|download|backtest|status|once|action|read|mcp\n\ndmw setup --network mainnet [--import] [--directory DIR] [--skip-addresses]\ndmw upgrade --config FILE\ndmw preflight --network mainnet\ndmw read TOOL [ARGS.json] --config FILE [--limit 50] [--cursor TOKEN]\ndmw action TOOL [ARGS.json] --config FILE [--live]\nAll tool names and JSON arguments match MCP. Read commands never sign or send moves.\nActions default to dry-run; --live enables sends. Setup writes the pinned network config.\nPasswords and recovery words are accepted only through a hidden terminal prompt\nor DMW_SIGNER_PASSWORD / DMW_SIGNER_MNEMONIC in the local launch environment.\nSee kit/README.md for setup and MCP connection commands.\n'); return; }
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
  const wallet = await unlock({ directory, password }); let journal, adapter, server, historySync, bitcoinWallet;
  const shutdown = async () => { if (server) { const s = server; server = null; await s.close(); } await historySync?.close(); if (journal) { journal.close(); journal = null; } await adapter?.close?.(); bitcoinWallet?.close(); wipeWallet(wallet); };
  try {
    if (command === 'address') { print({ address: publicAddress(wallet) }); return; }
    const production=config.mode==='mainnet';
    check(production || config.localOnly===true && isAbsolute(config.adapter??''), 'Use a public production target or a trusted local adapter');
    // Own the bounded gateway transport before an adapter installs process-wide
    // fetch hooks (the playground's RPC guard intentionally rejects queries).
    const service = new ServiceClient({ origin: config.gateway, mode:production?'mainnet':'regtest', network: config.network, gateway: config.gatewayKey, receiptSigners: config.receiptSigners });
    // Native libraries log every replayed public message even with tx logs off.
    // Keep that unbounded/untrusted feed out of CLI output and MCP's streams.
    if (production) console.log = console.info = console.debug = () => {};
    const adapterModule=production?await import('../lib/mainnet-adapter.mjs'):await import(pathToFileURL(config.adapter));
    adapter=await adapterModule.create({wallet,network:config.network,localOnly:!production,config,service,dryRun:!opts.live});
    journal = await Journal.open(directory, `${config.network}/${publicKey(wallet)}`);
    const bitcoinNetwork = config.bitcoinNetwork ?? (config.powLimitBits === 0x207fffff ? 'regtest' : 'mainnet');
    bitcoinWallet = localBitcoinWallet({ wallet, network: bitcoinNetwork, authority: config.bitcoin?.authority,
      source: adapter.bitcoinSource ?? (bitcoinNetwork === 'mainnet' || config.bitcoin?.origin ? mempoolBitcoinSource({ network: bitcoinNetwork, ...config.bitcoin }) : undefined) });
    const agent = new Agent({ wallet, network: config.network, service, trac: adapter.trac, journal, bitcoinWallet, dryRun: !opts.live, puzzleBits: config.puzzleBits ?? 12,
      powLimitBits: config.powLimitBits ?? 0x1d00ffff, paymentOrigin: config.paymentOrigin, owner: config.owner, bitcoinNetwork: config.bitcoinNetwork });
    let name, input = {};
    if (command === 'read' || command === 'action') {
      check(args[1], 'Pass a tool name or action JSON file');
      if (command === 'action' && args[1].endsWith('.json')) {
        const action = JSON.parse(await readFile(args[1], 'utf8')); name = action.type; input = action.args ?? {};
      } else { name = args[1]; input = args[2] ? JSON.parse(await readFile(args[2], 'utf8')) : {}; }
      check(input && typeof input === 'object' && !Array.isArray(input), 'Tool arguments must be an object');
    }
    const strategyTool = ['mine_once', 'search_patterns', 'compound_idea', 'mint_idea', 'backtest'].includes(name);
    const historyTool = ['search_patterns', 'propose_pattern', 'reveal_pattern', 'backtest'].includes(name);
    const session = ['mcp', 'once'].includes(command);
    const source = adapter.source ?? (config.headerCookie ? regtestSource({ origin: opts.source ?? config.headerSource, cookiePath: config.headerCookie }) : headerSource(opts.source ?? config.headerSource, config.headerHTTPSettings));
    let history = adapter.history;
    if (!history && (session || historyTool)) {
      if (source.manifest && (production || config.headerSource || opts.source)) {
        historySync = new HistorySync({ output: opts.headers ?? config.headers ?? join(directory, 'headers.bin'), source,
          network: agent.bitcoinNetwork, manifestTrust: config.headerManifestTrust ?? manifestTrust(config.gatewayKey), chunkLimits: config.headerChunkLimits, independent: agent.bitcoinNetwork === 'mainnet' ? headerSource('https://blockstream.info') : null });
        historySync.start();
        if (command !== 'mcp') { await historySync.pending; history = historySync.available(); }
      } else if (opts.headers ?? config.headers) history = await (agent.bitcoinNetwork === 'regtest' ? loadRegtestHistory : loadHistory)(opts.headers ?? config.headers);
    }
    const strategies = (session || strategyTool) && (opts.strategy ?? config.strategy) ? await import(pathToFileURL(resolve(opts.strategy ?? config.strategy))) : {};
    const context = { agent, history, historySync, source, strategies, candidates: adapter.candidates, compounds: adapter.compounds };
    if (command === 'read' || command === 'action') {
      print(await runTool(context, name, { ...input, ...(opts.limit === undefined ? {} : { limit: Number(opts.limit) }), ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }) }, { readOnly: command === 'read' }));
      return;
    }
    if (command === 'status') print(await agent.status());
    else if (command === 'once') print(await agent.runOnce({ history, source, strategy: strategies.chooseClaims }));
    else if (command === 'mcp') {
      server = await serveMcp(context);
      await new Promise(resolve => { const end = () => resolve(); process.once('SIGTERM', end); process.once('SIGINT', end); process.stdin.once('end', end); server.server.onclose = end; });
    } else throw new Error('Unknown command; run dmw --help');
  } finally { await shutdown(); }
}
main().catch(error => { const out = args[0] === 'mcp' ? process.stderr : process.stdout; out.write(JSON.stringify({ error: explainError(error) }) + '\n'); process.exitCode = 1; });
