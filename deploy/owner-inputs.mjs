import { isIP } from 'node:net';
import { need } from './target.mjs';
import { TRAC_MAINNET } from '../service/prod/mainnet.mjs';

// This is an inventory of owner-supplied inputs, not an execution preflight.
// It reads no keys, opens no network and never grants launch admission.
export function ownerInputReport(w) {
  need(w.format === 'dmw-mainnet-inputs-v1' && w.operations?.layout === 'single-host', 'owner_input_format');
  const t = w.target, c = w.files.tracRuntime, owner = w.operations.owner;
  need(t.network === 'dmw-mainnet' && t.trac.networkId === String(TRAC_MAINNET.networkId) &&
    t.trac.msbBootstrap === TRAC_MAINNET.msbBootstrap && c.msbBootstrap === t.trac.msbBootstrap &&
    c.msbChannel === TRAC_MAINNET.msbChannel && c.validators === 'auto' &&
    t.committee.threshold === 3 && t.committee.members.length === 5 &&
    !t.bitcoin.witnessRpc.urlFile && !t.indexer.independentEndpoint.urlFile, 'single_host_defaults');
  const checks = [
    { name: 'Server IP and SSH access', ok: isIP(owner.serverIP ?? '') > 0 && !!owner.sshAccess?.trim(), detail: 'Supply access to the one Ubuntu host.' },
    { name: 'DNS pointing', ok: owner.dnsPointed === true, detail: 'Point the configured gateway domain at that host.' },
    { name: 'Bitcoin/TAP connection files', ok: owner.bitcoinTapFilesInstalled === true, detail: 'Install files for the one selected source.' },
    { name: 'Ethereum RPC connection files', ok: owner.ethereumFilesInstalled === true, detail: 'Install the Ethereum RPC files.' },
    { name: 'Funded role key files', ok: owner.roleFilesInstalled === true, detail: 'Install the funded role keys and their public addresses.' }
  ].map(c => ({ ...c, detail: c.ok ? '' : c.detail }));
  return { ok: false, admitted: false, inventoryComplete: checks.every(c => c.ok), checks };
}
