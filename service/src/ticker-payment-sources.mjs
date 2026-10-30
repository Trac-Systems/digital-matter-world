import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { selectedDeployment } from './registry.mjs';
import { publicRefundKey } from '../../contract/public-mint.js';

export const tickerRequestId = (network, asset, tick, receiver, nonce) => rules.hash(rules.stableJSON(['dmw-ticker-deploy-v1', network, asset, tick, receiver, ...(nonce ? [nonce] : [])]));
export function installTickerPaymentSources(reads, { network, bitcoinNetwork = 'mainnet', lookupSettings }) {
  const options = { network, bitcoinNetwork, lookupSettings };
  const verified = async (id, at) => {
    check(rules.multiTickerActive(at?.executionHeight ?? at?.counted ?? await reads.counted()), 'multi_ticker_inactive');
    const row = await reads.store.get('tickerPayments', id);
    check(row && (!row.requestNonce || rules.hex(row.requestNonce, 32)) && row.id === tickerRequestId(network, row.asset, row.tick, row.payer, row.requestNonce), 'ticker_request_binding');
    const { verifyTickerDeployPayment } = await import('./ticker-payments.mjs');
    return { row, payment: await verifyTickerDeployPayment(reads, row, at, options) };
  };
  reads.tickerDeploymentFee = async (entry, at) => {
    at ??= await reads.batchStamp();
    const { row, payment } = await verified(entry.tickerRequestId, at);
    check(row.asset === entry.asset && row.tick === entry.indexTick && row.payer === entry.receiver && !row.reason && payment.final &&
      !await reads.financialRecord('fp/ticker-refused/' + row.id, at), 'ticker_payment_binding');
    return payment;
  };
  reads.tickerRefundEvidence = async (action, at) => {
    const { row, payment } = await verified(action.request, at);
    const registry = await reads.registry(), registered = selectedDeployment(registry, row.asset, row.tick);
    check(!registered || registered.tickerRequestId !== row.id, 'ticker_already_registered');
    check(['ticker_occupied', 'ticker_expired'].includes(action.reason), 'ticker_refusal_reason');
    if (action.reason === 'ticker_expired') check(BigInt(at.counted) > BigInt(row.until) && (!payment.final || row.reason === 'ticker_expired'), 'ticker_payment_live');
    else check(await reads.tap('getDeployment/' + encodeURIComponent(row.tick)), 'ticker_not_taken');
    const { tickerPaymentRefunds } = await import('./ticker-payments.mjs');
    const refund = tickerPaymentRefunds(row, payment, action.reason).find(r => r.reference === action.reference);
    check(refund && publicRefundKey(refund) === 'fp/public-refund/' + action.id, 'ticker_refund_binding');
    return { requestId: action.id, state: 'ticker_refund', refund };
  };
  return reads;
}
