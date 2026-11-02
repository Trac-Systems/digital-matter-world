import { dashboardFixture } from './dashboard-service.mjs';
import { FEE_DEFAULTS, FREE_LINK_HEIGHT, SETTINGS_PROFILE, settingsRevision, hashObject } from '../../../rules/src/index.js';
import { financialLinkId } from '../../../rules/src/financial-link.js';
import { wireIdentities, publicIdentities } from '../../../rules/src/trac-address.js';

// Extend the existing dashboard fake transport; no external connections.
export async function linkFixture(t) {
  const f = await dashboardFixture(t), { agent, journal, clock, service } = f;
  journal.perTip = 100; clock.counted = FREE_LINK_HEIGHT;
  const settings = settingsRevision({ network: agent.network, effectiveBatch: '1', effectiveBitcoinWindow: FREE_LINK_HEIGHT,
    values: { ...SETTINGS_PROFILE, linkMultiplier: 0 } });
  const context = { settings, settingsHash: hashObject(settings) };
  agent.namedContext = async () => context; agent.trac.settingsByHash = async () => settings;
  agent.ownerConfig = { payer: { tap: f.binding.request.address } };
  const records = new Map(), packets = [], calls = [], failures = new Map(); let lost = false, busy = null, stalled = null, onPacket;
  const base = service.fetchImpl;
  service.fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (!path.startsWith('/link')) return base(url, options);
    calls.push(path);
    const response = (value, status = 200) => Response.json(publicIdentities(value), { status });
    if (stalled) await stalled(options.signal);
    if (busy) return response({ error: busy.code }, busy.status);
    const body = options.body ? wireIdentities(JSON.parse(options.body)) : null;
    if (path.startsWith('/link-status/')) {
      const id = path.split('/').at(-1), record = records.get(id);
      return record ? response(record) : response({ error: 'request_not_found' }, 404);
    }
    const block = body.block ?? body.request.block, failure = failures.get(block);
    if (failure && (!failure.path || failure.path === path)) {
      if (failure.once) failures.delete(block);
      return response({ error: failure.code }, failure.status ?? 400);
    }
    const bitmap = { agent: agent.owner, address: f.binding.request.address };
    const feeQuote = { settingsHash: context.settingsHash, baseFee: '1', feeSettings: { ...FEE_DEFAULTS, link: 0 } };
    if (path === '/link/quote') return response({ feeQuote, bitmap });
    if (path === '/link/request') {
      const r = body.request, id = financialLinkId(agent.network, r);
      packets.push(structuredClone(body)); onPacket?.(body);
      let record = records.get(id);
      if (!record) { record = { id, state: 'authorizing', block, owner: r.owner, payer: r.payer, price: '0' }; records.set(id, record); }
      if (body.reserve) {
        record.state = 'reserving';
        if (lost) { lost = false; throw Error('response_lost'); }
        return response(record);
      }
      const evidence = { version: 2, state: 'reservable', requestId: id, owner: r.owner, bitmapOwner: r.owner, bitmap, block: r.block,
        until: r.until, payer: r.payer, receiver: r.payer, rail: 'tap', settingsHash: r.settingsHash, request: r, quote: body.feeQuote, signature: body.signature };
      return response({ ...record, reservationEvidence: evidence, reservationAction: { type: 'link-reserve', id, owner: r.owner,
        block: r.block, terms: hashObject(evidence), until: r.until } });
    }
    throw Error('unexpected link fixture route');
  };
  return { ...f, linkRecords: records, linkPackets: packets, linkCalls: calls, failures, linkContext: context,
    lose: () => { lost = true; }, busy: value => { busy = value; }, stall: value => { stalled = value; }, onPacket: value => { onPacket = value; } };
}
