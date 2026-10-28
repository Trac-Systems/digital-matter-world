import { supportedNode } from '../node-version.mjs';
// Import references to an ALREADY RUNNING playground. No process lifecycle,
// transaction, mining, wallet creation or change to a running config occurs.
import { readFile, mkdir, open, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, DEFAULT_TARGET, REGTEST_TEMPLATE, need, loadTarget, privateDirectory, privateJSON, localOrigin, tracRead, sha256, validateTarget } from './target.mjs';
import { BUILD } from './safety.mjs';
import { localBalances } from './local-balances.mjs';
import { currentFee } from '../service/src/fees.mjs';
const require = createRequire(new URL('../contract/package.json', import.meta.url));
async function main() {
  need(process.argv.length === 2 && supportedNode(), 'Use Node 24.22.1 or newer 24.x with no arguments');
  const filename = DEFAULT_TARGET;
  let exists = false;
  try { const s = await lstat(filename); need(s.isFile() && !s.isSymbolicLink(), 'Local target must be a regular file'); exists = true; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const t = await loadTarget(exists ? filename : REGTEST_TEMPLATE);
  need(t.mode === 'regtest', 'Regtest only');
  const running = JSON.parse(await readFile(join(ROOT, 'playground/.data/manifest.json'), 'utf8'));
  need(running.state === 'ready', 'Playground must already be ready');
  const dir = await privateDirectory(running.directory);
  const c = await privateJSON(join(dir, 'gateway.json')), state = await privateJSON(join(dir, 'state.json')),
    stack = await privateJSON(join(dir, 'stack/manifest.json')), { group } = await privateJSON(join(dir, 'committee/group.json'));
  need(c.mode === 'regtest' && stack.bitcoin.network === 'regtest' && String(stack.ethereum.chainId) === '31337', 'Local chains required');
  t.paths.output = process.env.DMW_BUILD_ROOT ? join(BUILD, 'deploy') : t.paths.output || join(BUILD, 'deploy');
  t.paths.costsFile = process.env.DMW_COSTS_FILE ? resolve(process.env.DMW_COSTS_FILE) : t.paths.costsFile;
  need(t.paths.costsFile, 'Supply DMW_COSTS_FILE from a completed rehearsal on first refresh');
  const base = join(t.paths.output, 'target-regtest');
  await mkdir(base, { recursive: true, mode: 0o700 }); need(await realpath(base) === base, 'No symlinks');
  await privateDirectory(base);
  const put = async (name, text) => {
    const path = join(base, name), fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await fd.chmod(0o600); await fd.writeFile(text.trim() + '\n'); } finally { await fd.close(); }
    return path;
  };
  const ep = async (name, url, token = '', authFile = '') => ({ urlFile: await put(name + '.url', localOrigin(url)),
    tokenFile: token ? await put(name + '.token', token) : '', authFile });
  const live = { url: localOrigin(c.endpoints.trac), headers: { authorization: 'Bearer ' + c.local.tracToken } };
  const authority = await tracRead(live, 'authority'), context = await tracRead(live, 'kitContext'), deployment = await tracRead(live, 'deployment');
  need(authority.network === c.network && authority.committee === state.publicKey, 'Identity mismatch');
  t.network = c.network;
  t.bitcoin.rpc = await ep('bitcoin', stack.bitcoin.rpc, '', join(stack.root, 'bitcoin/regtest/.cookie'));
  if (process.env.DMW_WITNESS_ORIGIN) t.bitcoin.witnessRpc = await ep('bitcoin-witness', process.env.DMW_WITNESS_ORIGIN);
  t.bitcoin.fundingAddress = stack.bitcoin.inscriberAddress; t.bitcoin.treasuryAddress = state.addresses.treasury;
  t.bitcoin.authorityHolderAddress = state.addresses.payer; t.bitcoin.payerAddress = state.addresses.payer; t.bitcoin.receiverAddress = state.addresses.receiver;
  t.bitcoin.authorityInscription = state.privilege;
  t.bitcoin.checkpointFile = await put('checkpoint.json', JSON.stringify(deployment.beacon));
  t.indexer.endpoint = { urlFile:c.local.tapSourceFile, authFile:'', tokenFile:'' };
  t.ethereum.rpc = await ep('ethereum', c.endpoints.ethereum);
  Object.assign(t.ethereum, { tokenAddress: state.escrow.token, escrowAddress: state.escrow.address, adminAddress: stack.ethereum.accounts[0],
    treasuryAddress: state.ethTreasury, payerAddress: state.ethPayer });
  Object.assign(t.trac, { endpoint: await ep('trac', c.endpoints.trac, c.local.tracToken), networkId: String(context.networkId), bootstrap: context.subnetBootstrap,
    msbBootstrap: context.msbBootstrap, adminPublicKey: authority.admin, hostAdminPublicKey: deployment.admin,
    hostKeyFile: join(dir, 'trac/indexer/db/keypair.json'), writerKeyFile: join(dir, 'trac/writer/db/keypair.json'), runtimeConfigFile: join(dir, 'trac.json') });
  const { Wallet } = await import(require.resolve('trac-peer'));
  for (const role of ['host', 'writer']) {
    const wallet = new Wallet(); await wallet.ready; wallet.importFromFile(t.trac[role + 'KeyFile'], Buffer.alloc(0));
    t.trac.balance[role + 'Address'] = wallet.address;
    const publicKey = wallet.publicKey.toString('hex');
    if (role === 'host') need(publicKey === deployment.admin, 'Host key mismatch'); else t.trac.writerPublicKey = publicKey;
    if (Buffer.isBuffer(wallet.secretKey)) wallet.secretKey.fill(0);
  }
  t.trac.balance.storeDirectory = join(dir, 'trac/bus-client/development');
  const Storage = require('hypercore-storage'), storage = new Storage(t.trac.balance.storeDirectory, { readOnly: true });
  const candidates = [];
  try {
    await storage.ready(); for await (const { discoveryKey } of storage.createCoreStream()) {
      const info = await storage.getInfo(discoveryKey); if (info.head?.length > 1) candidates.push({ key: info.auth.key.toString('hex'), length: info.head.length });
    }
  } finally { await storage.close(); }
  let found = false;
  for (const v of candidates.sort((a, b) => b.length - a.length)) {
    try { await localBalances({ ...t.trac.balance, viewKey: v.key }); t.trac.balance.viewKey = v.key; found = true; break; } catch { /* not the balance view */ }
  }
  need(found, 'Local MSB funding view missing');
  t.committee.publicKey = state.publicKey;
  need(group.length === 5, 'Five members required');
  for (const [i, m] of group.entries()) {
    const sc = await privateJSON(join(m.directory, 'signer.json')), credentials = await privateJSON(sc.secrets);
    const sidecarCredentials = await privateJSON(join(m.directory, 'credentials.json'));
    t.committee.members[i] = { id: m.id, identity: m.identity, encryption: m.encryption, server: '127.0.0.1',
      signer: await ep('signer-' + (i + 1), c.committee[i].url, credentials.apiToken), sidecar: await ep('sidecar-' + (i + 1), m.url, sidecarCredentials.token),
      credentialsFile: sc.secrets, sidecarCredentialsFile: join(m.directory, 'credentials.json'), shareFile: join(m.directory, 'share.enc') };
  }
  Object.assign(t.gateway, { endpoint: await ep('gateway', `http://127.0.0.1:${c.listen.port}`), keyFile: c.gatewayKey,
    configFile: join(dir, 'gateway.json'), registryFile: c.local.registry });
  Object.assign(t.runtime, { data:c.data,contexts:c.local.contexts,readerData:join(c.data,'readers'),ownerInscriptionsFile:'',
    manifestFile:c.local.manifest,deploymentFile:await put('trac-deployment.json',JSON.stringify({network:c.network,admin:authority.admin,committee:authority.committee,beacon:deployment.beacon})),
    listenHost:c.listen.host,listenPort:c.listen.port,startTip:c.local.startTip });
  Object.assign(t.policy,{baseFeeAtoms:currentFee(await privateJSON(c.local.registry)).baseFee,pollMs:c.pollMs,puzzleBits:c.puzzleBits});
  Object.assign(t.public,{gateway:`http://127.0.0.1:${c.listen.port}`,headerSource:`http://127.0.0.1:${c.listen.port}`,paymentOrigin:`http://127.0.0.1:${c.listen.port}`,gatewayKey:state.gatewayKey});
  const settings=await privateJSON(join(dir,'settings.json'));
  Object.assign(t.local.playground,{dataDirectory:join(ROOT,'playground/.data'),ports:running.ports,historyHeight:state.seedBlocks,automine:settings.mining.enabled?1:0,bots:settings.bots.count});
  Object.assign(t.servers, { gateway: '127.0.0.1', bitcoinIndexer: '127.0.0.1', trac: '127.0.0.1', backupDirectory: base });
  t.local.signerPort = Number(new URL(c.committee[0].url).port);
  t.local.sidecarPort = Number(new URL(group[0].url).port);
  t.release.publicManifestFile = await put('public-manifest.json', JSON.stringify({ network: state.network, escrow: state.escrow }));
  t.paths.costsSHA256 = await sha256(await readFile(t.paths.costsFile));
  validateTarget(t);
  const fd = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await fd.chmod(0o600); await fd.writeFile(JSON.stringify(t, null, 2) + '\n'); } finally { await fd.close(); }
  console.log('Refreshed ignored deploy/targets/regtest.local.json and private endpoint files. The public template and running services are unchanged. Run preflight next.');
}
main().catch(() => { console.error('Refresh stopped. Check Node 24.22.1, the ready playground, private files and DMW_COSTS_FILE on first use. No private values are printed.'); process.exitCode = 1; });
