import { createRequire } from 'node:module';
import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { credentialDirectoryOk, credentialFileOk } from './systemd-credential.mjs';
import { check } from './util.mjs';
import { refundRedeemBytes } from './mint-refund-payload.mjs';
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
export function refundReserve(settings, { payer, feeRate, feeRateAt, now = Date.now() } = {}) {
  if (settings.refundReserveMode !== 'dynamic' || typeof payer !== 'string' || !Number.isFinite(feeRate) || feeRate < 1 ||
      feeRate > settings.maxFeeRate || !Number.isSafeInteger(feeRateAt) || feeRateAt < 0 || feeRateAt > now || now - feeRateAt > settings.refundFeeRateMaxAgeMs)
    return settings.refundReserveSats;
  const bytes = refundRedeemBytes(payer);
  check(bytes <= settings.refundContentBytes, 'mint_refund_content');
  // The shared builder accepts up to 1000 sat/vB. At that rate this envelope
  // already exceeds the largest allowed reserve (maxFundingSats <= 100000),
  // so higher headroom-adjusted rates have the same clamped result.
  const cost = inscriptionBudget(settings, bytes, Math.min(1000, feeRate * settings.refundFeeHeadroom), 1);
  return Math.min(settings.refundReserveMaxSats, Math.max(settings.refundReserveMinSats, cost));
}
export function boundRefundReserve(record, settings) {
  if (record.refundReserveSats === undefined) return Math.min(settings.maxFeeSats, settings.refundReserveSats);
  check(Number.isSafeInteger(record.refundReserveSats) && record.refundReserveSats >= 0, 'mint_sender_refund_binding');
  return record.refundReserveSats;
}
export function fundingAmount(settings, quote = {}) {
  const reserve = settings.refundsEnabled ? quote.refundReserveSats ?? refundReserve(settings, quote) : 0;
  if (settings.refundsEnabled) check(Number.isSafeInteger(reserve) && reserve >= settings.postageSats + settings.dustSats, 'mint_sender_refund_reserve');
  const satoshis = inscriptionBudget(settings) + (settings.refundsEnabled ? reserve : 0);
  check(satoshis <= settings.maxFundingSats, 'mint_sender_funding_cap');
  return satoshis;
}
export function fundingQuote(seed, id, network, settings, quote = {}) {
  const key = requestKey(seed, id, network);
  try {
    const refundReserveSats = settings.refundsEnabled ? quote.refundReserveSats ?? refundReserve(settings, quote) : 0;
    return { address: key.address, satoshis: fundingAmount(settings, { refundReserveSats }), refundReserveSats, feeRate: settings.feeRate, label: 'your mint inscription' };
  }
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
