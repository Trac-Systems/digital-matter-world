import { join } from 'node:path';
import { publicRefundKey } from '../../contract/public-mint.js';
import { validRequestId } from './mint-sender-keys.mjs';
import { readSenderJSON } from './mint-sender-view.mjs';
import { check } from './util.mjs';

export const REFUND_STATES = new Set(['refund_pending', 'refund_waiting_funds', 'refund_needs_operator', 'refund_sending', 'refund_sent', 'refund_confirmed']);
export function acceptedRefund(mints, id) {
  check(validRequestId(id), 'mint_refund_id');
  const record = mints.store.get('accountRecords', 'fp/public-refund/' + id);
  if (!record) return null;
  check(record.state === 'owed' && publicRefundKey(record) === 'fp/public-refund/' + id, 'mint_refund_binding');
  const funding = mints.store.get('mints', record.id)?.mintFunding ?? mints.store.get('tickerProvisioning', record.id)?.refundFunding;
  return { ...record, refundId: id, ...(funding ? { refundReserveSats: funding.refundReserveSats } : {}) };
}
export function refundPage(view, mints, params) {
  for (const name of params.keys()) check(['after', 'limit'].includes(name), 'mint_sender_page');
  const after = params.get('after') ?? '', limit = Number(params.get('limit') ?? view.settings.pageSize);
  check((after === '' || validRequestId(after)) && Number.isSafeInteger(limit) && limit > 0 && limit <= view.settings.pageSize, 'mint_sender_page');
  const page = mints.store.list('publicMintRefunds', { after, limit });
  return { keyId: view.keyId, rows: page.map(r => acceptedRefund(mints, r.id)).filter(Boolean), next: page.length === limit ? page.at(-1).id : null };
}
export function decorateRefund(view, record) {
  const id = record.refundId ?? (validRequestId(record.id) && record.reference ? publicRefundKey(record).split('/').at(-1) : null);
  if (!validRequestId(id)) return record;
  const snapshot = readSenderJSON(join(view.settings.directory, 'refunds', id + '.json'));
  const delivery = snapshot?.keyId === view.keyId && snapshot.refundId === id && snapshot.requestId === (record.requestId ?? record.id) &&
    snapshot.payer === record.tapAddress && REFUND_STATES.has(snapshot.delivery?.state) ? snapshot.delivery : null;
  return { ...record, refundId: id, refundDelivery: delivery ?? { state: 'refund_pending' } };
}
