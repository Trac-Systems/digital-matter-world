import { isTracAddress } from '../../rules/src/trac-address.js';
import { fanOutValidatorSends } from '../../contract/runtime/fanout.js';
import { hex32 } from './check.mjs';
import { formatTnk, parseTnk, requireTnk, tnkError, tnkQuote } from './tnk-values.mjs';

const atoms = (bytes, code) => {
  requireTnk(bytes instanceof Uint8Array && bytes.length === 16, code);
  return BigInt('0x' + Buffer.from(bytes).toString('hex'));
};

const patchedNetworks = new WeakSet();

// Native TNK and subnet transactions share our existing fanout wrapper. Patch
// each kit network once; the public MSB broadcast API reaches this orchestrator.
export function nativeTnk(bus, { dryRun = false } = {}) {
  if (!patchedNetworks.has(bus.network)) { fanOutValidatorSends(bus.network, 3); patchedNetworks.add(bus.network); }
  const requireValidators = () => requireTnk(new Set(bus.network.validatorConnectionManager.connectedValidators()).size >= 3, 'tnk_validators');
  const balance = async address => {
    requireTnk(isTracAddress(address), 'tnk_invalid_address');
    const fee = atoms(bus.state.getFee(), 'tnk_fee_unavailable');
    const entry = await bus.state.getNodeEntry(address);
    const value = entry ? atoms(entry.balance, 'tnk_balance_unavailable') : 0n;
    return { address, balanceAtoms: String(value), balanceTnk: formatTnk(value),
      feeAtoms: String(fee), feeTnk: formatTnk(fee), accountExists: !!entry };
  };
  return {
    tnkBalance: balance,
    tnkRequireValidators: requireValidators,
    async prepareTnkTransfer(quote) {
      requireTnk(!dryRun, 'tnk_dry_run');
      requireTnk(bus.wallet?.address === quote.address, 'tnk_signer');
      requireTnk(isTracAddress(quote.to), 'tnk_invalid_address');
      requireTnk(quote.to !== quote.address, 'tnk_self');
      requireValidators();
      // Refresh immediately before the public builder, which independently
      // checks the sender's balance plus fee before it signs.
      const fresh = tnkQuote(await balance(quote.address), quote.to, quote.amount);
      const prepared = await bus.prepareTransferOperation(fresh.to, fresh.amountTnk);
      const payload = prepared.payload;
      requireTnk(payload?.address === fresh.address && payload.tro?.to === fresh.to && hex32(payload.tro.tx) &&
        typeof payload.tro.am === 'string' && /^[0-9a-f]{32}$/.test(payload.tro.am) &&
        BigInt('0x' + payload.tro.am) === parseTnk(fresh.amountTnk), 'tnk_packet');
      // Keep only the public JSON packet; the builder's BigInt metadata must
      // never pass through lossy Number conversions or a JSON bigint replacer.
      const current = { ...fresh, balanceAtoms: String(prepared.senderBalance), balanceTnk: formatTnk(prepared.senderBalance),
        feeAtoms: String(prepared.feeBigInt), feeTnk: formatTnk(prepared.feeBigInt) };
      const actual = tnkQuote(current, fresh.to, fresh.amountTnk);
      return { tx: payload.tro.tx, payloadJSON: JSON.stringify(payload), quote: { ...actual, amount: quote.amount },
        // A concurrent balance/fee change must not silently turn max into a
        // partial drain. Retain the signed packet, but do not broadcast it.
        blockedCode: quote.amount === 'max' && actual.remainingAtoms !== '0' ? 'tnk_balance_changed' : null };
    },
    async submitTnkTransfer(packet) {
      requireTnk(!dryRun, 'tnk_dry_run');
      let payload;
      try { payload = JSON.parse(packet.payloadJSON); } catch { throw tnkError('tnk_packet'); }
      requireTnk(payload?.tro?.tx === packet.tx && hex32(packet.tx) && payload.address === bus.wallet?.address, 'tnk_packet');
      requireValidators();
      // No builder, nonce or signing on this path. Parsing produces a fresh
      // transport copy so an upstream mutation cannot alter the saved bytes.
      requireTnk(await bus.broadcastPartialTransaction(payload), 'tnk_unknown_status');
      return { tx: packet.tx, state: 'pending' };
    },
    async tnkTransactionStatus(tx) {
      requireTnk(hex32(tx), 'tnk_invalid_tx');
      try {
        // A legacy subnet operation also has an MSB record. Its bus inclusion
        // does not establish acceptance by the game; leave it to peerTrac.
        if ((await bus.getConfirmedTxInfo(tx))?.decoded?.tro) return { tx, state: 'confirmed' };
        if ((await bus.getUnconfirmedTxInfo(tx))?.decoded?.tro) return { tx, state: 'pending' };
      } catch { return { tx, state: 'unknown', code: 'tnk_unknown_status' }; }
      return { tx, state: 'unknown', code: 'tnk_unknown_status' };
    },
  };
}
