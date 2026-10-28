import { privateRegistry as readRegistry, registryPages } from './registry.mjs';
import { supportedNode } from '../node-version.mjs';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { TapReader } from '../service/prod/tap.mjs';
import { indexedAuthority } from '../service/prod/tap-index.mjs';
import { createRequire } from 'node:module';
import { loadTarget, validateTarget, need, privateBytes, privateJSON, secret, endpoint, request, rpc, tracRead, sha256 } from './target.mjs';
import { fundingRequirements } from './costs.mjs';
import { diskCheck } from './safety.mjs';
import { localBalances } from './local-balances.mjs';
import { productionPreflight } from './production-preflight.mjs';
import { payoutAddress } from '../rules/src/payout-bindings.mjs';
import { committeeAddress, calldata } from '../committee/signer/escrow.mjs';
const require = createRequire(new URL('../rules/package.json', import.meta.url));
const { bech32m } = require('@scure/base');
const atoms = value => { need(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'Use whole base units as a decimal string'); return BigInt(value); };
const hex32 = value => /^[0-9a-f]{64}$/.test(value);

export async function preflight(target, { fetchEndpoint = endpoint, ...options } = {}) {
  const checks = [];
  // Only fixed, locally authored messages leave this function. Discard upstream
  // error bodies, exception messages, paths, URLs, tokens and user-supplied IDs.
  const check = async (name, action, fix) => {
    try { const detail = await action(); checks.push({ ok: true, name, detail: typeof detail === 'string' ? detail : '' }); return detail; }
    catch { checks.push({ ok: false, name, detail: fix }); return undefined; }
  };
  if (!await check('Target schema', () => { validateTarget(target); return true; }, 'Use the exact slots and types in deploy/targets/schema.json.')) return { ok: false, checks };
  if (target.mode !== 'regtest') {
    return productionPreflight(target, options);
  }
  const t = target;
  await check('Local tools and disk', async () => {
    need(supportedNode(), 'Node version'); await diskCheck(t.paths.output);
    return 'Node 24.22.1 and at least 100 GiB free in the existing build workspace.';
  }, 'Use Node 24.22.1 or newer 24.x and keep at least 100 GiB free; do not wipe the running playground.');
  await check('Local chain, fee and quorum policy', () => {
    need(t.bitcoin.chain === 'regtest' && t.ethereum.chainId === '31337' && t.ethereum.signing === 'unlocked-local', 'chain');
    need(/^[a-zA-Z0-9._:-]{1,96}$/.test(t.network) && t.committee.threshold === 3 && t.committee.epoch === 1, 'policy');
    need(new Set(t.committee.members.map(m => m.id)).size === 5 && new Set(t.committee.members.map(m => m.identity)).size === 5, 'roster');
    need(t.committee.members.every(m => m.id && hex32(m.identity) && hex32(m.encryption)), 'identity'); committeeAddress(t.committee.publicKey);
    need([t.bitcoin.feeRate, t.bitcoin.estimateFeeRate].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000), 'fee');
    need(t.bitcoin.postage >= 330 && t.bitcoin.postage <= 1e6, 'fee');
    need(atoms(t.ethereum.estimateGasPriceGwei) > 0n, 'gas');
    need(t.bitcoin.checkpointHeight === 2016, 'checkpoint');
    for (const v of Object.values(t.funding)) need(atoms(v) > 0n, 'funding');
    return 'Bitcoin regtest, Ethereum 31337, five signers and three required signatures.';
  }, 'Correct chain IDs, funding amounts, fees and the distinct 3-of-5 roster.');

  await check('Addresses and public identities', () => {
    for (const key of ['fundingAddress', 'authorityHolderAddress', 'payerAddress', 'receiverAddress', 'treasuryAddress']) payoutAddress('tap', t.bitcoin[key], 'regtest');
    for (const key of ['tokenAddress', 'escrowAddress', 'adminAddress', 'treasuryAddress', 'payerAddress']) payoutAddress('ethereum', t.ethereum[key], 'regtest');
    need([t.trac.bootstrap, t.trac.msbBootstrap, t.trac.adminPublicKey, t.trac.hostAdminPublicKey, t.trac.writerPublicKey, t.trac.balance.viewKey].every(hex32), 'keys');
    need(t.trac.adminPublicKey !== t.trac.hostAdminPublicKey, 'separate roles');
    for (const role of ['host', 'writer']) {
      const decoded = bech32m.decode(t.trac.balance[role + 'Address']);
      need(decoded.prefix === 'trac' && Buffer.from(bech32m.fromWords(decoded.words)).toString('hex') === t.trac[role === 'host' ? 'hostAdminPublicKey' : 'writerPublicKey'], 'Trac address');
    }
    need(/^[0-9a-f]{64}i[0-9]+$/.test(t.bitcoin.authorityInscription), 'authority');
    return 'Checksums, network prefixes, public keys and separate Trac administrators agree.';
  }, 'Use valid addresses for this network and matching Trac public keys.');

  const fileSlots = [['Gateway signing key', t.gateway.keyFile],
    ['Gateway configuration', t.gateway.configFile], ['Registry', t.gateway.registryFile], ['Trac host key', t.trac.hostKeyFile],
    ['Trac writer key', t.trac.writerKeyFile], ['Trac runtime configuration', t.trac.runtimeConfigFile], ['Checkpoint', t.bitcoin.checkpointFile],
    ['Public manifest', t.release.publicManifestFile]];
  for (const [i, m] of t.committee.members.entries()) {
    fileSlots.push([`Signer ${i + 1} credentials`, m.credentialsFile], [`Signer ${i + 1} sidecar credentials`, m.sidecarCredentialsFile], [`Signer ${i + 1} encrypted share`, m.shareFile]);
  }
  for (const [name, file] of fileSlots) await check(name, async () => { await privateBytes(file); return 'Owned 0600 file, outside repositories, no symlinks.'; }, 'Provide a nonempty owned 0600 file outside repositories; do not copy its contents into the target.');
  await check('Private configuration matches the target', async () => {
    const c = await privateJSON(t.gateway.configFile), registry = await readRegistry(t.gateway.registryFile);
    need(c.network === t.network && c.mode === t.mode && c.epoch === t.committee.epoch, 'config');
    need(c.gatewayKey === t.gateway.keyFile && c.local.registry === t.gateway.registryFile, 'paths');
    need(c.local.escrow.address === t.ethereum.escrowAddress && c.local.escrow.token === t.ethereum.tokenAddress && c.local.escrow.chainId === t.ethereum.chainId, 'escrow');
    need(c.committee.length === 5 && c.committee.every((s, i) => s.id === t.committee.members[i].id && s.peer.identity === t.committee.members[i].identity), 'roster');
    need(registry.assets && !Array.isArray(registry.assets), 'registry');
    for (const page of registryPages(registry)) need(page.every(({ value: a }) => a.privilege === t.bitcoin.authorityInscription && a.tap.treasury === t.bitcoin.treasuryAddress && a.ethereum.treasury === t.ethereum.treasuryAddress), 'registry');
    need(hex32(await secret(t.gateway.keyFile)), 'keys');
    const publicConfig = await privateJSON(t.release.publicManifestFile);
    need(publicConfig.network === t.network && publicConfig.escrow?.address === t.ethereum.escrowAddress && publicConfig.escrow?.token === t.ethereum.tokenAddress, 'public config');
  }, 'Refresh target references and identity pins from the same running deployment.');

  let costs, required;
  await check('Measured launch costs and funding plan', async () => {
    const bytes = await privateBytes(t.paths.costsFile); need(await sha256(bytes) === t.paths.costsSHA256, 'cost hash'); costs = JSON.parse(bytes);
    required = fundingRequirements(costs, t);
    for (const [name, n] of Object.entries(required)) need(atoms(t.funding[name]) >= n, 'budget');
    return `Budgets cover measured launch fees, postage, cancellation liquidity and reserves; Bitcoin minimum ${required.bitcoinSats} sat. Gas and TNK use the local measured baseline.`;
  }, 'Pin an intact costs.mjs report and raise each sender budget to cover the measured costs and reserves.');

  const eps = {};
  for (const [name, spec] of Object.entries({ bitcoin: t.bitcoin.rpc, ethereum: t.ethereum.rpc, indexer: t.indexer.endpoint, trac: t.trac.endpoint, gateway: t.gateway.endpoint }))
    eps[name] = await check(`${name} endpoint files`, () => fetchEndpoint(spec), 'Provide valid 0600 loopback endpoint/authentication files.');
  await check('Endpoint references match the running configuration', async () => {
    const c = await privateJSON(t.gateway.configFile);
    for (const [name, key] of [['ethereum', 'ethereum'], ['trac', 'trac']]) need(eps[name]?.url === c.endpoints[key], 'endpoint mismatch');
    need(c.local.tapSourceFile === t.indexer.endpoint.urlFile && !c.endpoints.bitcoind && !c.endpoints.indexer, 'bitcoin_source');
    need(eps.gateway?.url === `http://127.0.0.1:${c.listen.port}`, 'gateway endpoint');
  }, 'Refresh endpoint file references from the same running local configuration.');
  let tip;
  if (eps.bitcoin) {
    await check('Bitcoin chain and funding wallet', async () => {
      const info = await rpc(eps.bitcoin, 'getblockchaininfo'); need(info.chain === t.bitcoin.chain && info.initialblockdownload === false, 'chain'); tip = info.blocks;
      const valid = await rpc(eps.bitcoin, 'validateaddress', [t.bitcoin.fundingAddress]); need(valid.isvalid, 'address');
      const wallet = '/wallet/' + encodeURIComponent(t.bitcoin.wallet);
      const owner = await rpc(eps.bitcoin, 'getaddressinfo', [t.bitcoin.fundingAddress], wallet); need(owner.ismine, 'wallet ownership');
      const coins = await rpc(eps.bitcoin, 'listunspent', [1, 9999999, [t.bitcoin.fundingAddress]], wallet);
      const balance = coins.filter(c => c.spendable && c.safe).reduce((n, c) => n + BigInt(Math.round(c.amount * 1e8)), 0n);
      need(required && balance >= atoms(t.funding.bitcoinSats), 'funds');
      return `Correct chain; confirmed spendable funding outputs cover the Bitcoin budget (${balance} sat).`;
    }, 'Check regtest identity, wallet ownership and one-confirmed spendable funds at the funding address.');
  }
  if (eps.indexer) await check('TAP indexer tip and deployed authority', async () => {
    const indexed = (await request(eps.indexer, { path: '/r/tap/getCurrentBlock' })).result;
    need(Number.isSafeInteger(tip) && Number(indexed) >= tip, 'indexer lag');
    const indexer = new TapReader({ sources: [{ request: path => request(eps.indexer, { path }) }], agreement: 1,
      bitcoin: { blockHash: height => rpc(eps.bitcoin, 'getblockhash', [height]) }, settings: options.lookupSettings });
    const active = await indexedAuthority(indexer, join(t.paths.output, 'preflight-tap-lookups.sqlite'), t.bitcoin.authorityInscription, options.lookupSettings);
    need(active?.ins === t.bitcoin.authorityInscription && await indexer.tap('getPrivilegeAuthCancelled/' + t.bitcoin.authorityInscription) === false, 'authority');
    const registry = await readRegistry(t.gateway.registryFile);
    for (const page of registryPages(registry)) for (const { value: a } of page) {
      const d = (await request(eps.indexer, { path: '/r/tap/getDeployment/' + encodeURIComponent(a.indexTick ?? a.tick) })).result;
      need(d?.ins === a.id && d.prv === t.bitcoin.authorityInscription && Number(d.dec) === 0, 'deployment');
    }
  }, 'Wait for indexing and check the active authority and every registry deployment.');
  if (eps.ethereum) {
    const chainOK = await check('Ethereum chain ID', async () => { need(BigInt(await rpc(eps.ethereum, 'eth_chainId')) === BigInt(t.ethereum.chainId), 'chain'); return true; }, 'Select the local Anvil chain with ID 31337.');
    if (chainOK) {
      await check('Ethereum contract code and authority', async () => {
        const call = (address, signature, args = []) => rpc(eps.ethereum, 'eth_call', [{ to: address, data: calldata(signature, args) }, 'latest']);
        for (const address of [t.ethereum.escrowAddress, t.ethereum.tokenAddress]) need((await rpc(eps.ethereum, 'eth_getCode', [address, 'latest'])).length > 2, 'code');
        for (const [fn, address] of [['token()', t.ethereum.tokenAddress], ['admin()', t.ethereum.adminAddress], ['committee()', committeeAddress(t.committee.publicKey)]])
          need('0x' + (await call(t.ethereum.escrowAddress, fn)).slice(-40) === address, 'immutable');
        need(BigInt(await call(t.ethereum.escrowAddress, 'committeeEpoch()')) === 0n, 'epoch');
        need(BigInt(await call(t.ethereum.tokenAddress, 'decimals()')) === 18n, 'decimals');
      }, 'Match deployed escrow/token code, committee, admin, initial epoch and 18 token decimals.');
      await check('Ethereum sender and TAP balances', async () => {
        need(required, 'costs');
        const accounts = await rpc(eps.ethereum, 'eth_accounts');
        for (const role of ['admin']) {
          const address = t.ethereum[role + 'Address']; need(accounts.includes(address), 'unlocked local signer');
          need(BigInt(await rpc(eps.ethereum, 'eth_getBalance', [address, 'latest'])) >= atoms(t.funding['ethereum' + role[0].toUpperCase() + role.slice(1) + 'Wei']), 'gas funds');
        }
        const balance = await rpc(eps.ethereum, 'eth_call', [{ to: t.ethereum.tokenAddress, data: calldata('balanceOf(address)', [['address', t.ethereum.payerAddress]]) }, 'latest']);
        need(BigInt(balance) >= atoms(t.funding.tapPayerAtoms), 'token funds');
      }, 'Fund every gas sender separately and fund the TAP payer; Anvil accounts must be unlocked locally.');
    }
  }
  if (eps.trac) {
    await check('Trac contract and network', async () => {
      const a = await tracRead(eps.trac, 'authority'), h = await tracRead(eps.trac, 'head'), c = await tracRead(eps.trac, 'kitContext');
      need(a.network === t.network && a.admin === t.trac.adminPublicKey && a.committee === t.committee.publicKey && a.epoch === 0 && !a.paused, 'authority');
      need(String(c.networkId) === t.trac.networkId && c.subnetBootstrap === t.trac.bootstrap && c.msbBootstrap === t.trac.msbBootstrap, 'context');
      need(Number.isSafeInteger(tip) && h.tip.height <= tip + 1 && h.tip.height >= tip - 6, 'lag');
    }, 'Check Trac network/bootstrap pins, authority, initial epoch and Bitcoin header progress.');
    await check('TNK funding in the existing local MSB store', async () => {
      need(required, 'costs'); const balances = await localBalances(t.trac.balance);
      for (const role of ['host', 'writer']) need(balances[t.trac.balance[role + 'Address']] >= atoms(t.funding['tnk' + role[0].toUpperCase() + role.slice(1) + 'Atoms']), 'TNK funds');
      return 'Both local funding accounts cover the measured registration baseline; read from the pinned stored MSB view without writing.';
    }, 'Check the pinned local MSB view, account identities and host/writer TNK budgets.');
  }
  if (eps.gateway) await check('Gateway readiness', async () => {
    const h = await request(eps.gateway, { path: '/health' }); need(h.ok && Number.isSafeInteger(h.tip) && h.tip >= tip - 6 && h.tip <= tip + 1, 'health');
  }, 'Restore gateway health and header progress before admitting requests.');
  for (const [i, m] of t.committee.members.entries()) await check(`Signer ${i + 1} and encrypted share readiness`, async () => {
    const signer = await fetchEndpoint(m.signer), sidecar = await fetchEndpoint(m.sidecar);
    const h = await request(signer, { path: '/health', body: {} }), s = await request(sidecar, { path: '/status', body: {} });
    need(h.id === m.id && h.network === t.network && h.epoch === t.committee.epoch && h.publicKey === t.committee.publicKey, 'signer');
    need(s.public === t.committee.publicKey && s.epoch === t.committee.epoch && !s.retired, 'share');
  }, 'Check both endpoint/authentication files and the member network, epoch and committed group key.');
  return { ok: checks.every(c => c.ok), checks };
}
export function renderReport(report) {
  return [...report.checks.map(c => `${c.ok ? 'PASS' : 'GAP'} ${c.name}${c.detail ? ': ' + c.detail : ''}`),
    report.ok ? `PASS: ${report.stage ?? 'local'} checks are green. ${report.admitted ? 'Post-deployment admission verified.' : 'Post-deployment admission has not been granted.'}` : 'STOP: fix every gap before launch.',
    'Read-only checks do not authorize deployment or publication.'].join('\n');
}
async function main() {
  const args = process.argv.slice(2);
  let filename, stage = 'preparation', online = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target') filename = args[++i];
    else if (args[i] === '--stage') stage = args[++i];
    else if (args[i] === '--online') online = true;
    else throw Error('Usage: node deploy/preflight.mjs [--target FILE] [--stage preparation|admission] [--online]');
  }
  const report = await preflight(await loadTarget(filename), { stage, online }); console.log(renderReport(report)); if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error('STOP: cannot read a valid target. Run refresh-regtest.mjs first, or use --target FILE. No private values are printed.'); process.exitCode = 1;
});
