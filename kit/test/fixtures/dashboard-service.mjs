import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519';
import { Agent } from '../../lib/agent.mjs';
import { Journal } from '../../lib/journal.mjs';
import { ServiceClient } from '../../lib/service-client.mjs';
import { dashboardJournal } from '../../lib/dashboard-state.mjs';
import { FakeService } from '../fake-service.mjs';
import { cleanup, temp, testWallet, history, witnesses } from '../helpers.mjs';
import { hashObject, settingsRevision, SETTINGS_PROFILE, mintRight } from '../../../rules/src/index.js';
import { publicIdentities, wireIdentities } from '../../../rules/src/trac-address.js';
import { bindingId, bindingMessage, attestBinding } from '../../../rules/src/payout-bindings.mjs';
import { financialMintId, verifyFinancialMintRequest } from '../../../rules/src/financial-mint.js';
import { accountActionDigest } from '../../../contract/root-accounts.js';
import { verifyPayer } from '../../../service/src/mints.mjs';
import { signTestPayout, testPayoutAddress } from '../../../service/test/payout-wallets.mjs';
import { createWeb } from '../../../service/src/web.mjs';

// site: the fixture also serves the public site shell, so the dashboard's /me page renders.
export async function dashboardFixture(t, { http = false, site = false } = {}) {
  const directory = await temp(t), network = 'dmw-kit-test', wallet = testWallet(), owner = wallet.publicKey.toString('hex');
  const journal = await Journal.open(directory, network, { intervalMs: 0, perTip: 1 }); cleanup(t, () => journal.close());
  const settings = settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '20', values: { ...SETTINGS_PROFILE } });
  const rulesContext = { settings, settingsHash: hashObject(settings) };
  const request = { agent: owner, rail: 'tap', address: testPayoutAddress('02'.repeat(32), 'tap'), nonce: '1', expiry: Date.now() + 3600000 };
  const message = bindingMessage(network, 'regtest', request), w = witnesses();
  const binding = { id: bindingId(network, 'regtest', request), request, agentSignature: wallet.sign(Buffer.from(message)).toString('hex'),
    walletSignature: signTestPayout(message, '02'.repeat(32), 'tap'), acceptedAt: Date.now() };
  binding.attestations = w.members.slice(0, 3).map((m, i) => attestBinding(binding, { network, bitcoinNetwork: 'regtest', signer: m.id, secret: testWallet(20 + i).secretKey.toString('hex') }));
  const fake = new FakeService({ network, history: history(), tip: 20 }), packets = [], calls = [];
  const records = new Map(), claims = ['12', '11', '10'].map(block => ({ asset: 'p2:1', block, count: '3', finder: owner, findHeight: '19', finderUntil: '1027', settingsHash: rulesContext.settingsHash }));
  const minted = new Set(['10']); let pause, lose = false;
  const clock = { counted: '20' }, balances = new Map([['p2:1', { amount: '100', current: true }]]), links = new Map(), holders = new Map(), unregistered = new Set();
  // Pattern overview reads: catalog rows, this agent's discoveries and read-only deployment states.
  const patterns = [{ number: '1', asset: 'p2:1', name: 'dmwtest', tier: 3 }], discoveries = [], deployments = new Map();
  const candidate = find => {
    const link = links.get(find.block) ?? null, currentHolder = holders.get(find.block) ?? null;
    const right = mintRight({ find, owner, counted: clock.counted, link, currentHolder });
    const balance = balances.get(find.asset) ?? { amount: '0', current: true };
    const short = BigInt(balance.amount) < BigInt(find.count), isMinted = minted.has(find.block), registered = !unregistered.has(find.asset);
    return { ...find, find, link, currentHolder, finderUntil: find.finderUntil, minted: isMinted, pending: null,
      right: right.role, whoMayMint: right.role, rightAllowed: right.allowed,
      balance: balance.current ? balance.amount : null, allowed: right.allowed && !short && balance.current && !isMinted && registered,
      reason: isMinted ? 'minted' : !registered ? 'asset_unregistered' : !balance.current ? 'balance_projection_pending' : short ? 'insufficient_balance' : right.role };
  };
  const read = async (url, options = {}) => {
    const u = new URL(url), path = decodeURIComponent(u.pathname), body = options.body && wireIdentities(JSON.parse(options.body)); calls.push({ path, method: options.method ?? 'GET', query: Object.fromEntries(u.searchParams) });
    const response = (value, status = 200) => Response.json(publicIdentities(value), { status });
    const page = (key, rows) => {
      const offset = Number(u.searchParams.get('cursor') ?? 0), limit = Number(u.searchParams.get('limit') ?? 25);
      return response({ v: 3, [key]: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? String(offset + limit) : null, total: null });
    };
    if (path.startsWith('/payout-bindings/')) return response({ binding });
    if (path.includes('/agents/') && path.endsWith('/finds')) {
      const rows = claims.filter(f => f.finder === owner && (u.searchParams.get('minted') !== 'false' || !minted.has(f.block)) && (!u.searchParams.has('asset') || f.asset === u.searchParams.get('asset')));
      return page('finds', rows.map(f => ({ ...f, minted: minted.has(f.block) })));
    }
    if (path.includes('/agents/') && path.endsWith('/balances')) return page('balances', [...balances].filter(([asset]) => !u.searchParams.has('asset') || asset === u.searchParams.get('asset')).map(([asset, balance]) => ({ asset, ...balance })));
    if (path === '/patterns') return response({ patterns: patterns.filter(p => !u.searchParams.has('asset') || p.asset === u.searchParams.get('asset')).slice(0, 1), nextCursor: null });
    if (path.includes('/agents/') && path.endsWith('/discoveries')) return page('discoveries', discoveries);
    const deployment = /^\/mint\/deployment-state\/(.+)$/.exec(path)?.[1];
    if (deployment) return response(deployments.get(deployment) ?? (unregistered.has(deployment)
      ? { asset: deployment, state: 'awaiting_player_deploy', phase: 'element', catalogAsset: deployment } : { asset: deployment, state: 'registered', phase: 'deployment', catalogAsset: deployment }));
    if (path === `/agents/${publicIdentities({ owner }).owner}/mintRights`) return page('mintRights', claims.map(candidate).filter(row =>
      ['asset', 'block'].every(key => !u.searchParams.has(key) || row[key] === u.searchParams.get(key)) &&
      ['allowed', 'minted'].every(key => !u.searchParams.has(key) || row[key] === (u.searchParams.get(key) === 'true'))));
    if (path === '/mint/quote' && body) {
      if (pause) await pause;
      if (!body.request) return response({ asset: body.asset, feeQuote: { settingsHash: rulesContext.settingsHash } });
      packets.push(structuredClone(body));
      const r = body.request, id = financialMintId(network, r);
      assert.equal(verifyFinancialMintRequest(network, r, body.signature, clock.counted), true);
      assert.equal(candidate(claims.find(f => f.asset === r.asset && f.block === r.block)).allowed, true);
      assert.equal(verifyPayer(network, body), true);
      assert.equal(r.amount, '3'); assert.equal(body.receiver, binding.request.address); assert.equal(body.payer, binding.request.address);
      const evidence = { version: 2, requestId: id, owner: r.owner, asset: r.asset, amount: r.amount, receiver: body.receiver, payer: body.payer,
        rail: body.kind, expiry: r.expires, settingsHash: r.settingsHash, request: r, quote: body.feeQuote, signature: body.signature, authorization: body.authorization };
      const action = { type: 'reserve', id, owner: r.owner, asset: r.asset, amount: r.amount, terms: hashObject(evidence), revision: '0', nonce: r.nonce, until: r.until };
      if (!body.reserve) {
        records.set(id, { requestId: id, owner, asset: r.asset, block: r.block, receiver: body.receiver, payer: body.payer, amount: r.amount, state: 'authorizing', payable: false, fees: [], missing: [], payBy: { rail: 'tap' } });
        return response({ id, state: 'authorizing', reservationEvidence: evidence, reservationAction: action });
      }
      const { sig, ...reserve } = body.reserve;
      assert.deepEqual(reserve, action); assert.equal(ed25519.verify(sig, accountActionDigest(network, reserve), owner), true);
      if (lose) { lose = false; return response({ error: 'lost_response' }, 503); }
      const state = { ...records.get(id), state: 'awaiting_payment', payable: true,
        missing: [{ role: 'treasury', to: binding.request.address, amount: '1000000000000000000', ticker: 'tap', tt: 'a', dta: id }] };
      state.fees = structuredClone(state.missing); records.set(id, state); return response(state);
    }
    const id = /^\/(?:web-api\/)?mint\/([0-9a-f]{64})$/.exec(path)?.[1];
    if (id) return records.has(id) ? response(records.get(id)) : response({ error: 'request_not_found' }, 404);
    if (path === '/mint/payment') return response({ reported: true, ...body });
    return fake.fetch(url, options);
  };
  let origin = 'http://127.0.0.1:1';
  if (http) {
    const web = site ? createWeb(null) : null;
    const server = createServer(async (req, res) => {
      try { if (web && req.method === 'GET' && await web.handle(req, res)) return; let body = ''; for await (const chunk of req) body += chunk;
        const response = await read(origin + req.url, { method: req.method, ...(body ? { body } : {}) });
        res.statusCode = response.status; res.setHeader('content-type', 'application/json'); res.end(await response.text());
      } catch { res.statusCode = 500; res.end('{"error":"fixture_failed"}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
    cleanup(t, () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  }
  const service = new ServiceClient({ origin, network, receiptSigners: w.members, ...(!http ? { fetchImpl: read } : {}) });
  const agent = new Agent({ wallet, network, service, journal: dashboardJournal(journal), dryRun: false, bitcoinNetwork: 'regtest', ...(site ? { paymentOrigin: origin } : {}),
    trac: { network, head: async () => ({ counted: clock.counted, tip: { height: Number(clock.counted) } }), settingsByHash: async () => settings } });
  agent.namedContext = async () => rulesContext;
  const context = { agent, candidates: async (asset, { block }) => (await service.mintRights(agent.address, { asset, block, limit: 50 })).mintRights };
  return { directory, journal, agent, service, context, binding, claims, minted, records, packets, calls, clock, balances, links, holders, unregistered, patterns, discoveries, deployments,
    pause(value) { pause = value; }, lose() { lose = true; } };
}
