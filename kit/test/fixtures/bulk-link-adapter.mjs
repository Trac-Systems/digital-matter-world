import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SETTINGS_PROFILE, FEE_DEFAULTS, FREE_LINK_HEIGHT, settingsRevision, hashObject } from '../../../rules/src/index.js';
import { financialLinkId } from '../../../rules/src/financial-link.js';
import { wireIdentities, publicIdentities } from '../../../rules/src/trac-address.js';

// Process-level CLI/MCP fixture. Every service call stays in this fake transport.
export async function create({ network, config, service }) {
  const settings = settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: FREE_LINK_HEIGHT,
    values: { ...SETTINGS_PROFILE, linkMultiplier: 0 } });
  const manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '1', previousBatchRoot: '11'.repeat(32),
    bitcoinAnchor: { height: FREE_LINK_HEIGHT, hash: '22'.repeat(32) }, settingsHash: hashObject(settings), catalogRoot: '33'.repeat(32),
    accountsRoot: '44'.repeat(32), receiptSegmentStart: '0', schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const context = { settings, settingsHash: hashObject(settings), manifest, manifestHash: hashObject(manifest) };
  const file = join(config.directory, 'fixture-link-records.json'); let records = {};
  try { records = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bitmap = { agent: config.fixtureOwner, address: config.owner.payer.tap };
  const quote = { settingsHash: context.settingsHash, baseFee: '1', feeSettings: { ...FEE_DEFAULTS, link: 0 } };
  service.fetchImpl = async (url, options) => {
    const path = new URL(url).pathname, body = options.body ? wireIdentities(JSON.parse(options.body)) : null;
    const response = (value, status = 200) => Response.json(publicIdentities(value), { status });
    if (path === '/link/quote') return response({ feeQuote: quote, bitmap });
    if (path === '/link/request') {
      const r = body.request, id = financialLinkId(network, r), record = records[id] ??= { id, state: 'authorizing', block: r.block, owner: r.owner, payer: r.payer, price: '0' };
      if (body.reserve) record.state = 'reserving';
      await writeFile(file, JSON.stringify(records));
      if (body.reserve) return response(record);
      const evidence = { version: 2, state: 'reservable', requestId: id, owner: r.owner, bitmapOwner: r.owner, bitmap, block: r.block,
        until: r.until, payer: r.payer, receiver: r.payer, rail: 'tap', settingsHash: r.settingsHash, request: r, quote: body.feeQuote, signature: body.signature };
      return response({ ...record, reservationEvidence: evidence, reservationAction: { type: 'link-reserve', id, owner: r.owner,
        block: r.block, terms: hashObject(evidence), until: r.until } });
    }
    if (path.startsWith('/link-status/')) {
      const record = records[path.split('/').at(-1)];
      return record ? response({ ...record, state: record.state === 'reserving' && !config.fixtureHold ? 'accepted' : record.state })
        : response({ error: 'request_not_found' }, 404);
    }
    return response({ error: 'fixture_unavailable' }, 503);
  };
  return { source: {}, trac: { network, settings: async () => ({ ruleset: 'dmw-v2' }), rulesContext: async () => context,
    settingsByHash: async () => settings, head: async () => ({ counted: FREE_LINK_HEIGHT, tip: { height: Number(FREE_LINK_HEIGHT) } }) }, close: async () => {} };
}
