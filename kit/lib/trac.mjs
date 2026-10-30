import { MAINNET_PARAMS } from '../../contract/beacon/bitcoin.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { assetPairs, stableJSON, decimalV2 } from '../../rules/src/index.js';
import { financialAsset } from '../../rules/src/financial-mint.js';
import { check, exact, hex32, integer, nonce } from './check.mjs';
import { publicKey } from './keyring.mjs';
import { signBytes } from './signing.mjs';
import { readInteger } from './api-values.mjs';
import { nativeTnk } from './tnk-runtime.mjs';

export function transactionCommand(op, value) {
  check(op === 'tf', 'Only transfers are permitted');
  exact(value, ['to', 'assets']);
  check(hex32(value.to) && assetPairs(value.assets), 'Invalid recipient or asset amounts');
  // Preserve this property order: trac-peer hashes the UTF-8 JSON command.
  return { type: op, value: structuredClone(value) };
}
export function contentHash(command) { return Buffer.from(blake3(Buffer.from(JSON.stringify(command)))).toString('hex'); }
export function validateContext(c) {
  exact(c, ['networkId', 'txv', 'incomingWritingKey', 'subnetBootstrap', 'msbBootstrap']);
  check(integer(c.networkId) && c.networkId > 0 && c.networkId <= 0xffffffff, 'Invalid MSB network');
  for (const k of ['txv', 'incomingWritingKey', 'subnetBootstrap', 'msbBootstrap']) check(hex32(c[k]), 'Invalid Trac context');
}
export function transactionHash(c, ch, n) {
  validateContext(c); check(hex32(ch) && hex32(n), 'Invalid transaction digest');
  const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  return Buffer.from(blake3(Buffer.concat([u32(c.networkId), ...[c.txv, c.incomingWritingKey, ch, c.subnetBootstrap, c.msbBootstrap, n].map(h => Buffer.from(h, 'hex')), u32(12)]))).toString('hex');
}
const batchOrdinal = n => typeof n === 'string' ? /^[1-9][0-9]*$/.test(n) : integer(n) && n > 0;
export class TracClient {
  constructor({ network, api, context, submit, status, integerVersion = 1, close = async () => {} }) { Object.assign(this, { network, api, context, integerVersion, submitPacket: submit, transactionStatus: status, close }); }
  async head() {
    const authority = await this.api.dmwAuthority(); check(authority.network === this.network, 'Foreign Trac network');
    const head = await this.api.dmwHead();
    if (this.integerVersion !== 2) return head;
    // Local archive offsets use safe Numbers. Never round a consensus height.
    return { ...head, tip: { ...head.tip, height: readInteger(head.tip.height) }, counted: readInteger(head.counted),
      ...(head.confirmed === undefined ? {} : { confirmed: readInteger(head.confirmed) }) };
  }
  hashAt(height) { height = readInteger(height); return this.api.dmwHashAt(this.integerVersion === 2 ? String(height) : height); }
  async balance(owner, asset) {
    check(hex32(owner) && financialAsset(asset), 'Invalid balance read');
    if (this.integerVersion !== 2) return this.api.dmwBalance(owner, asset);
    const account = await this.accountRoot(owner);
    if (!account) return '0';
    check(typeof this.balanceProof === 'function', 'upgrade_required: account proof reader unavailable');
    const context = await this.rulesContext(), evidence = await this.balanceProof(owner, asset, context.settings.values.proofBytes);
    check(evidence.owner === owner && evidence.asset === asset && evidence.root === account.root && evidence.revision === account.revision, 'Account proof differs from accepted notary');
    return this.api.dmwBalance(owner, asset, evidence.proof);
  }
  settings() { return this.api.dmwSettings(); }
  accountRoot(owner) { check(hex32(owner) && typeof this.api.dmwAccountRoot === 'function', 'upgrade_required: account root unavailable'); return this.api.dmwAccountRoot(owner); }
  financialRecord(key) { check(/^(fc|fp|bc|dc)\/[0-9a-f]{64}$/.test(key) && typeof this.api.dmwFinancialRecord === 'function', 'upgrade_required: financial record unavailable'); return this.api.dmwFinancialRecord(key); }
  // These APIs must be implemented by the independently verified notary
  // adapter. A public gateway response is never substituted for this authority.
  rulesContext() { check(typeof this.api.dmwRulesContext === 'function', 'upgrade_required: notary rules context unavailable'); return this.api.dmwRulesContext(); }
  renewalSlice(n) { check(batchOrdinal(n) && typeof this.api.dmwReceiptRenewalSlice === 'function', 'upgrade_required: renewal slice unavailable'); return this.api.dmwReceiptRenewalSlice(String(n)); }
  settingsByHash(hash) { check(hex32(hash) && typeof this.api.dmwSettingsByHash === 'function', 'upgrade_required: settings history unavailable'); return this.api.dmwSettingsByHash(hash); }
  discoveryCommitment(agent, commitment) { check(hex32(agent) && hex32(commitment) && typeof this.api.dmwDiscoveryCommitment === 'function', 'upgrade_required: commitment proof unavailable'); return this.api.dmwDiscoveryCommitment(agent, commitment); }
  mint(id) { check(hex32(id), 'Invalid mint'); return this.api.dmwMint(id); }
  batchLast() { return this.api.dmwBatchLast(); }
  batchRoot(n) { check(batchOrdinal(n), 'Invalid batch'); return this.api.dmwBatchRoot(this.integerVersion === 2 ? decimalV2(n) : n); }
  record(key) { check(/^[a-z0-9/._-]{1,64}$/.test(key), 'Invalid record'); return this.api.dmwRecord(key); }
  async preflight(owner, op, value) {
    transactionCommand(op, value); const head = await this.head();
    if (value.assets) for (const [asset, amount] of value.assets) check(BigInt(await this.balance(owner, asset)) >= BigInt(amount), 'Insufficient spendable balance');
    return head;
  }
  async prepare(wallet, op, value) {
    check(typeof this.context === 'function' && typeof this.submitPacket === 'function', 'Configure your own funded Trac transaction adapter');
    const address = publicKey(wallet); await this.preflight(address, op, value);
    const command = transactionCommand(op, value), context = await this.context(); validateContext(context);
    const n = nonce(), ch = contentHash(command), tx = transactionHash(context, ch, n);
    return { dispatch: command, context, ch, tx, nonce: n, address, signature: signBytes(wallet, Buffer.from(tx, 'hex')) };
  }
  async submit(packet) {
    const c = await this.context();
    check(stableJSON(c) === stableJSON(packet.context), 'Trac context changed; reconcile saved transaction before preparing another');
    check(packet.ch === contentHash(transactionCommand(packet.dispatch.type, packet.dispatch.value)) && packet.tx === transactionHash(c, packet.ch, packet.nonce), 'Transaction changed');
    return this.submitPacket(packet);
  }
}
// The peer must already be configured for a local subnet and local MSB. Nothing
// here starts a peer or connects to a default/public network.
export function runtimeTrac(peer, { network, localOnly, msb } = {}) {
  check(localOnly === true && peer.config.dmw.network === network, 'Explicit local peer and matching network required');
  const loopback = list => Array.isArray(list) && list.length > 0 && list.every(x => /^127\.0\.0\.1:[0-9]+$/.test(x));
  check(peer.config.dmw.beacon?.params?.retarget === false && peer.config.dmw.beacon?.params?.powLimitBits === 0x207fffff &&
    loopback(peer.config.dhtBootstrap) && loopback(msb?.config?.dhtBootstrap), 'Local regtest peer and local MSB discovery required');
  return peerTrac(peer,network,msb);
}
export function productionTrac(peer,{network,msb,pins,dryRun=false}={}) {
  check(peer.config.dmw.network===network && stableJSON(peer.config.dmw.beacon.params)===stableJSON(MAINNET_PARAMS), "Production deployment required");
  const msbBootstrap = msb.config?.bootstrap?.toString('hex') ?? msb.bootstrapHex;
  const networkId = msb.config?.networkId ?? msb.networkId;
  check(peer.base.key.toString("hex")===pins.bootstrap && msbBootstrap===pins.msbBootstrap && String(networkId)===String(pins.networkId), "Pinned Trac network required");
  check(peer.config.dmw.admin===pins.adminPublicKey && peer.config.dmw.committee===pins.committeePublicKey, "Pinned Trac authorities required");
  return peerTrac(peer,network,msb,{dryRun});
}
function peerTrac(peer,network,msb,options) {
  const protocol = peer.protocol.instance;
  const tnk = nativeTnk(msb, options);
  return Object.assign(new TracClient({ network, api: protocol.api, integerVersion: peer.config.dmw.v2 ? 2 : 1,
    context: async () => ({ networkId: peer.msbClient.networkId, txv: await peer.msbClient.getTxvHex(), incomingWritingKey: peer.writerLocalKey,
      subnetBootstrap: peer.base.key.toString('hex'), msbBootstrap: peer.msbClient.bootstrapHex }),
    submit: async p => {
      const result = await protocol.broadcastTransaction(p.dispatch, false, { address: p.address, signature: p.signature, nonce: p.nonce, tx: p.tx, txv: p.context.txv, ch: p.ch });
      check(result?.txo?.tx === p.tx, 'Transaction identity changed'); return { tx: p.tx, state: 'submitted' };
    },
    status: async tx => {
      check(hex32(tx), 'Invalid transaction');
      const native = typeof msb.getConfirmedTxInfo === 'function' ? await tnk.tnkTransactionStatus(tx) : null;
      if (native && native.state !== 'unknown') return native;
      try {
        const marker = await peer.base.view.get(`tx/${tx}`), row = marker && await peer.base.view.get(`txi/${marker.value}`);
        return !row ? native ?? { state: 'pending' } : row.value.err ? { state: 'rejected' } : { state: 'accepted' };
      } catch (error) { if (native) return native; throw error; }
    }
  }), tnk);
}
