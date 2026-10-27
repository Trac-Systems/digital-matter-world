import { open, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, unlock, publicAddress, wipeWallet } from './keyring.mjs';
import { check, privateDirectory } from './check.mjs';
import { networkProfile, readNetworkJSON, validateOwner, validatePlayerConfig } from './network.mjs';

const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code !== 'ENOENT') throw e; return false; } };
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
export function nextCommands(configFile) {
  const cli = fileURLToPath(new URL('../bin/dmw.mjs', import.meta.url));
  const command = `${quote(process.execPath)} ${quote(cli)}`, config = `--config ${quote(configFile)}`;
  return [`${command} preflight ${config}`, `${command} mcp ${config}`, ...['rules', 'address', 'status', 'world'].map(tool => `${command} read ${tool} ${config}`),
    `${command} once ${config}`];
}
export async function setup({ network = 'mainnet', networkFile, directory, configFile, password, mnemonic, ask = async () => '' } = {}) {
  // Validate before creating a signer or asking for any secret.
  const profile = await networkProfile({ network, networkFile });
  directory = resolve(directory); configFile = resolve(configFile ?? join(directory, `${network}.json`));
  const previous = await exists(configFile) ? await readNetworkJSON(configFile) : null;
  if (previous) {
    await validatePlayerConfig(previous);
    check(previous.directory === directory && previous.network === profile.network, 'Existing setup belongs to a different signer/network');
  }
  password = typeof password === 'function' ? await password() : password;
  const keyExists = await exists(join(directory, 'keystore.json'));
  check(!keyExists || !mnemonic, 'A signer already exists; import into a new directory');
  if (!keyExists) {
    const words = typeof mnemonic === 'function' ? await mnemonic() : mnemonic;
    await init({ directory, password, ...(words ? { mnemonic: words } : {}) });
  }
  const wallet = await unlock({ directory, password });
  try {
    if (previous) return { address: publicAddress(wallet), signer: 'reused', config: configFile, network: previous.network, dryRun: true, next: nextCommands(configFile) };
    const owner = { receiver: {}, payer: {} };
    for (const [group, rail, label] of [['receiver', 'bitcoin', 'Bitcoin receiver'], ['receiver', 'ethereum', 'Ethereum receiver'],
      ['payer', 'tap', 'Bitcoin TAP payer'], ['payer', 'ethereum', 'Ethereum payer']]) {
      const value = (await ask(`${label} (optional; Enter to skip): `)).trim();
      if (value) owner[group][rail] = value;
    }
    validateOwner(owner, network === 'mainnet' ? 'mainnet' : 'regtest');
    const config = { ...profile, directory, bitcoinNetwork: network === 'mainnet' ? 'mainnet' : 'regtest', owner };
    await validatePlayerConfig(config);
    await privateDirectory(dirname(configFile));
    const fd = await open(configFile, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(config, null, 2) + '\n'); await fd.sync(); } finally { await fd.close(); }
    return { address: publicAddress(wallet), signer: keyExists ? 'reused' : mnemonic ? 'imported' : 'created', config: configFile, network: config.network,
      dryRun: true, next: nextCommands(configFile), live: 'Append --live only when you authorize real moves. MCP cannot enable it. Owner wallet payments remain manual.' };
  } finally { wipeWallet(wallet); }
}
