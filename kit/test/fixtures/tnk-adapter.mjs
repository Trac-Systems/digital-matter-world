import { encodeTracAddress } from '../../../rules/src/trac-address.js';
import { applyStateMessageFactory } from '../../../contract/node_modules/trac-msb/src/messages/state/applyStateMessageFactory.js';
import { bigIntTo16ByteBuffer, decimalStringToBigInt } from '../../../contract/node_modules/trac-msb/src/utils/amountSerialization.js';
import { runtimeTrac } from '../../lib/trac.mjs';
import { fakeTrac, history } from '../helpers.mjs';

// Actual installed transfer builder, with in-memory balances and transports.
// No sockets, native stores, external reads or funds are used by this fixture.
export function fixtureBus(wallet) {
  const state = { balance: 10n ** 19n, fee: 10n ** 16n, exists: true, signed: 0, prepared: 0,
    validators: ['validator-a', 'validator-b', 'validator-c'], sent: [], confirmed: new Map(), pending: new Map(), accept: true };
  const config = { addressPrefix: 'trac', networkId: 1, dhtBootstrap: ['127.0.0.1:1'] };
  const signer = { address: encodeTracAddress(wallet.publicKey), sign(bytes) { state.signed++; return wallet.sign(bytes); } };
  const manager = { connectedValidators: () => state.validators, pickRandomValidator: pool => pool[0],
    pickRandomConnectedValidator: () => state.validators[0] };
  const bus = {
    config, wallet: signer,
    state: { getFee: () => state.fee === null ? null : bigIntTo16ByteBuffer(state.fee),
      getNodeEntry: async address => { if (address !== signer.address) throw Error('Foreign fixture account'); return state.exists ? { balance: bigIntTo16ByteBuffer(state.balance) } : null; } },
    network: { validatorConnectionManager: manager, validatorMessageOrchestrator: {
      async send(payload) {
        const validator = manager.pickRandomConnectedValidator();
        await state.beforeSend?.(payload);
        state.sent.push({ validator, bytes: JSON.stringify(payload) });
        if (state.transportError) throw Error('Disconnected fixture transport');
        return state.accept;
      },
    } },
    async prepareTransferOperation(to, amount) {
      state.prepared++;
      const amountBigInt = decimalStringToBigInt(amount), feeBigInt = state.fee, senderBalance = state.balance;
      if (!state.exists || amountBigInt + feeBigInt > senderBalance) throw Error('Insufficient balance for transfer + fee');
      const payload = await applyStateMessageFactory(signer, config).buildPartialTransferOperationMessage(
        signer.address, to, bigIntTo16ByteBuffer(amountBigInt), Buffer.alloc(32, 3), 'json');
      await state.afterSign?.();
      return { payload, amountBigInt, feeBigInt, senderBalance };
    },
    broadcastPartialTransaction(payload) { return bus.network.validatorMessageOrchestrator.send(payload); },
    async getConfirmedTxInfo(tx) { if (state.statusError) throw Error('Unavailable fixture state'); return state.confirmed.get(tx) ?? null; },
    async getUnconfirmedTxInfo(tx) { if (state.statusError) throw Error('Unavailable fixture state'); return state.pending.get(tx) ?? null; },
  };
  return { bus, state };
}

export function fixtureTrac(wallet, network = 'dmw-kit-test') {
  const { bus, state } = fixtureBus(wallet), fake = fakeTrac(history(), { network }), records = new Map();
  const peer = { config: { dmw: { network, beacon: { params: { retarget: false, powLimitBits: 0x207fffff } } }, dhtBootstrap: ['127.0.0.1:1'] },
    protocol: { instance: { api: fake.trac.api } }, base: { writable: false, view: { get: async key => records.get(key) } } };
  return { trac: runtimeTrac(peer, { network, localOnly: true, msb: bus }), state, bus, peer, records };
}

export async function create({ wallet, network }) {
  return { ...fixtureTrac(wallet, network), close: async () => {} };
}
