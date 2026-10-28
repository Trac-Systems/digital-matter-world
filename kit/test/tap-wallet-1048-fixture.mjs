// Contract fixture: tap-wallet-extension-next 1.0.48, 5bc5348.
// content-script/tap-script/index.ts:437-535; internal/controller.ts:388-464;
// requests/tap-api.ts:707; approval/components/tap-action.tsx:73-140;
// approval/components/single-tx-transfer.tsx:752-758,894. No chain sends.
export function tapWallet1048({ address, publicKey, network = 'mainnet', active = true } = {}) {
  const authId = 'a1'.repeat(32) + 'i0', funding = 'b2'.repeat(32), calls = [];
  const state = { active, scope: [], address, network, calls, orderError: false, transferError: null, actionError: null, available: true };
  const current = () => state.active && state.scope.length === 0 ? { ins: authId, auth: [], addr: state.address } : null;
  const receipt = (id = authId) => ({ orderId: 'order-1048', paymentTxid: funding, txid: id.slice(0, 64), inscriptionId: id, pending: false });
  const provider = {
    requestAccounts: async () => [state.address], getAccounts: async () => state.locked ? null : [state.address],
    getNetwork: async () => state.network, switchNetwork: async value => state.network = value,
    getPublicKey: async () => publicKey,
    getCurrentAuthority: async () => current(),
    getAuthorityStatus: async () => ({ currentAuthority: current(), readyToTap: state.existingSetup ?? null, pendingAuthority: null }),
    createGlobalTapAuthority: async () => {
      calls.push(['createGlobalTapAuthority']);
      if (state.actionError) throw state.actionError;
      state.scope = []; return state.pendingOrder ? { orderId: 'order-1048', paymentTxid: funding, inscriptionId: '', pending: true } : receipt();
    },
    createTapAuthority: async tick => { calls.push(['createTapAuthority', tick]); state.scope = [tick]; return receipt(); },
    getInscriptions: async (cursor = 0, size = 20) => { calls.push(['getInscriptions', cursor, size]); return { list: state.available ? [{ inscriptionId: authId, address: state.address }] : [], total: state.available ? 1 : 0 }; },
    sendInscription: async (to, id) => { calls.push(['sendInscription', to, id]); if (state.activationError) throw state.activationError; state.active = true; return 'c3'.repeat(32); },
    getTapActionOrderResult: async orderId => {
      calls.push(['getTapActionOrderResult', orderId]);
      // In 1.0.48 this lookup is sent to paidApi, not the native inscriber.
      if (state.orderError) throw { code: -32603, message: 'Order not found' };
      return { orderId, txid: authId.slice(0, 64), inscriptionId: authId, pending: false, status: 3 };
    },
    redeemTapActions: async (message, options) => { calls.push(['redeemTapActions', message, options]); if (state.actionError) throw state.actionError; return receipt(); },
    singleTxTransfer: async items => {
      calls.push(['singleTxTransfer', items]);
      if (!current()) throw { code: 4001, message: 'No authority found' };
      if (state.transferError) throw state.transferError;
      return { txid: funding };
    },
    getBitcoinUtxos: async () => [],
    signPsbt: async () => { throw Error('Unexpected signPsbt'); },
    pushPsbt: async () => { throw Error('Unexpected pushPsbt'); }, pushTx: async () => { throw Error('Unexpected pushTx'); },
  };
  return { provider, state, authId, funding };
}
