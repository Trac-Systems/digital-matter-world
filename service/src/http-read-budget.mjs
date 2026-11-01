import { Limiter } from './limiter.mjs';
import { check } from './util.mjs';
import { publicMintClientIP } from './public-mint-admission.mjs';

// Local operator settings (listen.readBudget), outside consensus/resource digests.
export const HTTP_READ_BUDGET = Object.freeze({ enabled: true, capacity: 16384, burst: 1200, perSecond: 60, ttlMs: 120000 });
export function httpReadBudget(overrides = {}) {
  check(overrides && typeof overrides === 'object' && !Array.isArray(overrides), 'http_read_budget_setting');
  const settings = { ...HTTP_READ_BUDGET, ...overrides };
  check(Object.keys(settings).every(k => Object.hasOwn(HTTP_READ_BUDGET, k)) && typeof settings.enabled === 'boolean' &&
    ['capacity', 'burst', 'perSecond', 'ttlMs'].every(k => Number.isSafeInteger(settings[k]) && settings[k] > 0), 'http_read_budget_setting');
  const limiter = new Limiter({ ...settings, ttl: settings.ttlMs });
  return req => {
    if (!settings.enabled || !['GET', 'HEAD'].includes(req.method)) return;
    const key = publicMintClientIP(req);
    if (!limiter.take(key)) throw Object.assign(Error('read_request_rate'), {
      status: 429, retryAfterMs: limiter.retryAfterMs(key),
    });
  };
}
