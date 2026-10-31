import { createRequire } from 'node:module';
import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { credentialDirectoryOk, credentialFileOk } from './systemd-credential.mjs';
import { check } from './util.mjs';
import { buildInscription, fundingAddress, hex, networkFor } from '../../kit/lib/inscription-core.mjs';
const require = createRequire(new URL('../../kit/package.json', import.meta.url));
const { HDKey } = require('@scure/bip32');
export const btc = require('@scure/btc-signer');
export const validRequestId = id => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);
export function requestKey(seed, id, network, branch = 0) {
  check(validRequestId(id) && [0, 1].includes(branch), 'mint_sender_request');
  networkFor(network);
  // All 256 request-id bits are retained; no truncated index collisions.
  const path = `m/86'/${network === 'mainnet' ? 0 : 1}'/0'/${branch}/` + id.match(/.{4}/g).map(v => parseInt(v, 16)).join('/');
  const root = HDKey.fromMasterSeed(seed), child = root.derive(path);
  try { return { privateKey: child.privateKey.slice(), publicKey: hex(child.publicKey), address: fundingAddress(child.publicKey, network), path }; }
  finally { child.wipePrivateData(); root.wipePrivateData(); }
}
// Dedicated float account: branch 2 never overlaps request funding (0) or reveal (1).
export function refundFloatKey(seed, network) {
  networkFor(network);
  const path = `m/86'/${network === 'mainnet' ? 0 : 1}'/0'/2/0`;
  const root = HDKey.fromMasterSeed(seed), child = root.derive(path);
  try { return { privateKey: child.privateKey.slice(), publicKey: hex(child.publicKey), address: fundingAddress(child.publicKey, network), path }; }
  finally { child.wipePrivateData(); root.wipePrivateData(); }
}
// Separate from refund branch 2 and request branches 0/1.
export function payoutFloatKey(seed, network) {
  networkFor(network);
  const path = `m/86'/${network === 'mainnet' ? 0 : 1}'/0'/3/0`;
  const root = HDKey.fromMasterSeed(seed), child = root.derive(path);
  try { return { privateKey: child.privateKey.slice(), publicKey: hex(child.publicKey), address: fundingAddress(child.publicKey, network), path }; }
  finally { child.wipePrivateData(); root.wipePrivateData(); }
}
export function validDestination(address, network) {
  try { const decoded = btc.Address(networkFor(network)).decode(address); return ['tr', 'wpkh', 'wsh', 'pkh', 'sh'].includes(decoded.type); }
  catch { return false; }
}
export function inscriptionBudget(settings, contentBytes = settings.contentBytes, feeRate = settings.feeRate, margin = settings.feeMargin) {
  // Use the shared builder to measure the largest configured permit envelope.
  const key = new Uint8Array(32); key[31] = 1;
  const pub = btc.utils.pubSchnorr(key), payer = btc.p2tr(pub), max = '1000000000';
  const plan = buildInscription({ text: 'x'.repeat(contentBytes), receiver: payer.address, publicKey: pub,
    network: 'mainnet', utxos: [{ txid: '00'.repeat(32), vout: 0, value: max, script: hex(payer.script), cardinal: true, confirmed: true }],
    feeRate, maxFeeSats: max, postage: settings.postageSats, secret: key });
  return settings.postageSats + settings.dustSats + Math.ceil(Number(plan.feeSats) * margin);
}
export function refundBudget(settings) {
  return inscriptionBudget(settings, settings.refundContentBytes, settings.maxRefundFeeRate, 1);
}
export function fundingAmount(settings) {
  if (settings.refundsEnabled) check(settings.refundReserveSats >= refundBudget(settings), 'mint_sender_refund_reserve');
  const satoshis = inscriptionBudget(settings) + (settings.refundsEnabled ? settings.refundReserveSats : 0);
  check(satoshis <= settings.maxFundingSats, 'mint_sender_funding_cap');
  return satoshis;
}
export function fundingQuote(seed, id, network, settings) {
  const key = requestKey(seed, id, network);
  try { return { address: key.address, satoshis: fundingAmount(settings), feeRate: settings.feeRate, label: settings.refundsEnabled ? 'mint inscription and possible refund' : 'your mint inscription' }; }
  finally { key.privateKey.fill(0); }
}
export async function readMintSeed(filename, { credentialsDirectory = process.env.CREDENTIALS_DIRECTORY, rootOwned = process.platform === 'linux' } = {}) {
  let fd;
  try {
    check(isAbsolute(filename ?? ''), 'mint_sender_seed');
    const credential = credentialsDirectory !== undefined;
    if (credential) {
      check(isAbsolute(credentialsDirectory) && await realpath(credentialsDirectory) === credentialsDirectory && credentialDirectoryOk(await lstat(credentialsDirectory)), 'mint_sender_seed');
      filename = join(credentialsDirectory, 'mint-sender.seed');
    }
    check(await realpath(filename) === filename, 'mint_sender_seed');
    fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await fd.stat();
    check(credential ? credentialFileOk(st) : st.isFile() && (st.mode & 0o777) === 0o600 && (rootOwned ? st.uid === 0 : [0, process.getuid()].includes(st.uid)), 'mint_sender_seed');
    check(st.size === 32, 'mint_sender_seed');
    return new Uint8Array(await fd.readFile());
  } catch { throw Error('mint_sender_seed_unavailable'); }
  finally { await fd?.close(); }
}
