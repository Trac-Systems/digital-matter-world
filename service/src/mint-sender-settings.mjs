import { isAbsolute } from 'node:path';
import { check } from './util.mjs';

// Local operator policy, independent of committee economic settings.
export const MINT_SENDER_DEFAULTS = Object.freeze({ enabled: false, refundsEnabled: false, refundReserveSats: 12000, maxRefundFeeRate: 10, refundContentBytes: 2048, refundTickers: ['tap'], feeRate: 2, feeMargin: 2, feeTargetBlocks: 3, bitcoinApiPath: '/api',
  payoutsEnabled: false, payoutDailyCapAtoms: '100000000000000000000', payoutMaxAtoms: '50000000000000000000',
  postageSats: 546, dustSats: 546, contentBytes: 4096, maxFundingSats: 100000, maxFeeSats: 90000,
  maxFeeRate: 1000, feeWaitMs: 300000, stuckMs: 180000, pollMs: 2000, fundingPollMs: 10000, terminalPollMs: 300000, timeoutMs: 5000,
  retryMs: 2000, maxRetryMs: 60000, concurrency: 4, pageSize: 50, healthMs: 60000,
  heartbeatMaxAgeMs: 90000, maxUtxos: 100, maxResponseBytes: 2000000 });
export function mintSenderSettings(input = {}) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'mint_sender_settings');
  const paths = ['seedFile', 'directory', 'bitcoinApiUrlFile'];
  check(Object.keys(input).every(k => k in MINT_SENDER_DEFAULTS || paths.includes(k)), 'mint_sender_setting_unknown');
  const s = { ...MINT_SENDER_DEFAULTS, ...input };
  const configured = s.enabled || s.payoutsEnabled || paths.some(k => s[k] !== undefined);
  check(typeof s.enabled === 'boolean' && typeof s.refundsEnabled === 'boolean', 'mint_sender_enabled');
  check(typeof s.payoutsEnabled === 'boolean', 'mint_sender_payouts_enabled');
  for (const key of ['payoutDailyCapAtoms', 'payoutMaxAtoms'])
    check(typeof s[key] === 'string' && /^[1-9][0-9]{0,77}$/.test(s[key]), 'mint_sender_setting_' + key);
  check(typeof s.bitcoinApiPath === 'string' && /^(?:\/[a-zA-Z0-9_-]+)*$/.test(s.bitcoinApiPath), 'mint_sender_bitcoin_api_path');
  for (const [k, v] of Object.entries(MINT_SENDER_DEFAULTS)) if (typeof v === 'number')
    check(Number.isFinite(s[k]) && s[k] > 0 && (['feeRate', 'feeMargin'].includes(k) || Number.isSafeInteger(s[k])), 'mint_sender_setting_' + k);
  check(Array.isArray(s.refundTickers) && s.refundTickers.length === 1 && s.refundTickers[0] === 'tap', 'mint_sender_refund_tickers');
  check(s.refundReserveSats <= s.maxFundingSats && s.maxRefundFeeRate <= s.maxFeeRate && s.refundContentBytes <= 80000, 'mint_sender_refund_bounds');
  check(s.feeRate >= 1 && s.feeRate <= s.maxFeeRate && s.maxFeeRate <= 1000 && s.feeTargetBlocks <= 1008 && s.feeMargin >= 1 && s.feeMargin <= 100 &&
    s.postageSats >= 546 && s.postageSats <= 100000 && s.dustSats >= 546 && s.dustSats <= 100000 && s.contentBytes <= 80000 && s.maxFundingSats >= 546 && s.maxFundingSats <= 100000 &&
    s.maxFeeSats <= s.maxFundingSats && s.concurrency <= 32 && s.pageSize <= 100 && s.maxUtxos <= 1000 &&
    s.timeoutMs <= 30000 && s.healthMs <= 60000 && s.heartbeatMaxAgeMs > s.healthMs && s.maxRetryMs >= s.retryMs,
  'mint_sender_setting_bounds');
  for (const [key, value] of Object.entries(s)) if (key.endsWith('Ms')) check(value <= 0x7fffffff, 'mint_sender_timer_bounds');
  for (const key of paths) check(!configured && s[key] === undefined || isAbsolute(s[key] ?? ''), 'mint_sender_path_' + key);
  return Object.freeze(s);
}
