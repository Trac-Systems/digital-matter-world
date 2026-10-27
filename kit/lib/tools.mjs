import { encodeTracAddress, isTracAddress, publicIdentities, TRAC_ADDRESS_ERROR } from '../../rules/src/trac-address.js';
import { z } from 'zod/v4';
import { check } from './check.mjs';
import { findPatterns } from './search.mjs';
import { backtest } from './backtest.mjs';
import { chooseClaims, chooseCompound, chooseMint } from '../strategies/default.mjs';
import { readTools } from './read-tools.mjs';

const hex = z.string().regex(/^[0-9a-f]{64}$/), units = z.string().regex(/^[1-9][0-9]{0,77}$/), height = z.number().int().nonnegative().safe();
const asset = z.string().regex(/^[0-9a-z]{1,24}$/), actionId = z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/);
const pairs = z.array(z.tuple([asset, units])).min(1).max(16);
const proposal = z.object({ name: z.string().regex(/^dmw[a-z0-9]{2,29}$/), pat: z.string().max(64), fld: z.union([z.literal(4), z.literal(10), z.literal(11)]), dt: z.enum(['n', 'h']) }).strict();
const publication = z.object({ height, observation: height.optional(), audit: z.object({ path: z.string().max(512), hash: hex, bytes: height.max(1500000) }).strict() });

export function gameTools({ agent, history, historySync, source, strategies = {}, candidates = async () => [], compounds = async () => [] }) {
  const tools = {};
  const register = (name, description, shape, run, readOnly = true) => { tools[name] = { description, shape, schema: z.object(shape).strict(), run: async (...args) => publicIdentities(await run(...args)), readOnly }; };
  const currentHistory = () => historySync?.available() ?? history;
  const needHistory = () => { const value = currentHistory(); check(value, 'Configure a verified header history first'); return value; };
  const discovery = run => async (...args) => {
    if (historySync && !historySync.available()) return historySync.status();
    const head = await agent.trac.head(), value = historySync ? historySync.available(head.tip) : needHistory();
    if (!value) return historySync.status();
    return run(value, head, ...args);
  };
  for (const [name, tool] of Object.entries(readTools(agent))) register(name, tool.description, tool.shape, tool.run);
  register('bind_payout_wallet', 'Request a payout binding signed by this agent; the human signs with the wallet on the returned local page. Reuse the action ID on retry.', {
    actionId, rail: z.enum(['tap', 'ethereum']), address: z.string().min(1).max(90).optional()
  }, args => agent.bindPayoutWallet(args), false);
  register('payout_binding', 'Read an agent payout wallet or its public proof history.', {
    owner: z.string().refine(isTracAddress, TRAC_ADDRESS_ERROR).optional(), rail: z.enum(['tap', 'ethereum']), history: z.boolean().default(false), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional()
  }, ({ owner, rail, ...options }) => agent.service.payoutBinding(owner ?? encodeTracAddress(agent.owner), rail, Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined))));
  register('mine_once', 'If the table is empty, return discovery_needed with the discovery steps. Otherwise claim the current open window or submit its header. Defaults to dry-run.', {}, () => {
    check(source, 'Configure a header source'); return agent.runOnce({ history: currentHistory(), source, strategy: strategies.chooseClaims ?? chooseClaims });
  }, false);
  register('post_header', 'Submit a correct header for free during its block’s open window; defaults to the observed tip. Unclaimed patterns are drawn among its header senders.', { height: height.optional() }, async ({ height }) => {
    check(source, 'Configure a header source'); return agent.postHeader({ height, history: currentHistory(), source });
  }, false);
  register('search_patterns', 'Test bounded candidate patterns against full verified history. Reports history downloading (x%) until ready.', { maxCandidates: z.number().int().min(1).max(60).default(10), candidates: z.array(proposal).max(60).optional() }, discovery(async (history, head, { maxCandidates, candidates }, extra) => {
    return findPatterns({ history, tip: head.tip, existing: await agent.catalog(), owner: encodeTracAddress(agent.owner), maxCandidates, candidates, strategy: strategies.searchPatterns, signal: extra?.signal });
  }));
  register('propose_pattern', 'Check history and commit a secret pattern. Reports download progress until ready; keep the action ID for reveal.', { actionId, proposal }, discovery(async (history, head, args) => agent.propose({ ...args, history, patterns: await agent.catalog() })), false);
  register('reveal_pattern', 'Reveal the saved pattern only after three pinned signers witness its commitment, at commitment tip +2 through +144. Supply the original observation if it is no longer latest.', { actionId, publication: publication.optional() }, discovery(async (history, head, args) => agent.reveal({ ...args, history, patterns: await agent.catalog() })), false);
  register('verify_claim', 'Find and verify the saved claim in its original witnessed receipt publication. If needed pass the claim provenance from block claims: {height,observation,audit}; height is the audit counted height, not the receipt tip. Returns verified/inclusion, not a settled win.', { window: height, publication: publication.optional() }, args => agent.claimInclusion(args));
  register('backtest', 'Replay a strategy over a bounded verified history range. No sends or payments.', { start: height, end: height }, async ({ start, end }, extra) => {
    check(end - start <= 10000, 'Use the CLI for replays over 10,000 blocks');
    if (historySync && !historySync.available()) return historySync.status();
    return backtest({ history: needHistory(), patterns: await agent.catalog(), owner: encodeTracAddress(agent.owner), strategy: strategies.chooseClaims, start, end, signal: extra?.signal });
  });
  register('compound_idea', 'Find a craftable pair with exact rational rarity.', {}, async () => {
    const patterns = await agent.catalog(), types = await compounds(), balances = {};
    for (const p of patterns) balances['p' + p.number.toString(36)] = await agent.trac.balance(agent.owner, 'p' + p.number.toString(36));
    for (const c of types) balances[c.id] = await agent.trac.balance(agent.owner, c.id);
    const suggestion = (strategies.chooseCompound ?? chooseCompound)({ patterns: publicIdentities(patterns), compounds: publicIdentities(types), balances, historyLength: (await agent.trac.head()).counted + 1 }) ?? null;
    if (!suggestion) return { suggestion: null, reason: Object.values(balances).some(v => BigInt(v) > 0n) ? 'no_craftable_recipe' : 'no_balance' };
    const warnings = [], mintableFinderSlots = [], slotPages = {}; let slotCount = 0;
    const registered = await agent.mintRights({ asset: suggestion.id, limit: 1 });
    if (!registered.mintRights.some(r => r.deploymentRegistered)) warnings.push({ code: 'asset_unregistered', message: 'The first maker must inscribe and register this compound deployment before it can be minted.' });
    for (const [asset, amount] of suggestion.inputs) {
      const page = await agent.mintRights({ asset, allowed: true, whoMayMint: 'finder', limit: 10 });
      const remaining = (BigInt(balances[asset]) - BigInt(amount)).toString();
      slotCount += page.total;
      for (const row of page.mintRights) mintableFinderSlots.push({ asset, block: row.block, unitsUsed: amount, required: row.amount, remaining, blocksMint: BigInt(remaining) < BigInt(row.amount) });
      if (page.total) slotPages[asset] = { total: page.total, next: page.next, tool: 'mint_rights', arguments: { filters: { asset, allowed: true, whoMayMint: 'finder' }, limit: 10 } };
    }
    if (slotCount) warnings.push({ code: 'consumes_mintable_finder_units', message: 'This craft consumes units available for your mintable finder slots.', slots: mintableFinderSlots, total: slotCount, pages: slotPages });
    return { suggestion, reason: null, warnings };
  });
  register('craft', 'Consume input units through an owner-signed free craft. Reuse the same action ID after an uncertain result.', { actionId, recipe: z.enum(['fusion', 'resonance']).default('fusion'), inputs: pairs }, async args => agent.craft({ ...args, patterns: await agent.catalog(), compounds: await compounds() }), false);
  register('mint_idea', 'Choose an eligible unminted block that fits your balance, preferring supplied UTC dates.', { asset, specialDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100).default([]) }, async ({ asset, specialDates }) => {
    const balance = await agent.trac.balance(agent.owner, asset);
    if (BigInt(balance) === 0n) return { suggestion: null, reason: 'no_balance' };
    const suggestion = (strategies.chooseMint ?? chooseMint)({ candidates: publicIdentities(await candidates(asset)), owner: encodeTracAddress(agent.owner), counted: (await agent.trac.head()).counted, balance, specialDates }) ?? null;
    return { suggestion, reason: suggestion ? null : 'no_eligible_slot' };
  });
  register('mint_on_chain', 'Reserve units with a signed quote. Then use pay_mint, poll_mint and inscribe_mint; the player pays and inscribes from their own wallet.', {
    actionId, asset, amount: units, block: height.optional(), receiver: z.string().min(1).max(128).optional(), payer: z.string().min(1).max(128).optional(), kind: z.enum(['tap', 'ethereum']).default('tap'), compound: z.boolean().default(false)
  }, async args => {
    const addresses = agent.paymentAddresses(args);
    return agent.makeReal({ ...args, ...addresses, candidate: args.compound ? undefined : (await candidates(args.asset, { block: args.block, kind: args.kind })).find(c => c.find?.block === args.block) });
  }, false);
  register('bitcoin_wallet', 'Read the local Bitcoin signer address and derivation path. Fund only with cardinal BTC and bind this payout wallet before quoting.', {}, () => {
    check(agent.bitcoinWallet, 'Configure the local Bitcoin signer');
    const { address, publicKey, network, path } = agent.bitcoinWallet;
    return { address, publicKey, network, path, dryRun: agent.dryRun };
  });
  const mintBitcoinArgs = { id: hex, feeRate: z.number().min(1).max(1000).optional(), maxFeeSats: z.string().regex(/^[1-9][0-9]{0,9}$/) };
  register('pay_mint', 'Pay only missing TAP fee items with the local Bitcoin signer. Dry-run by default; unsupported native burns stop before spending. Preserve the journal on retry.', mintBitcoinArgs, args => {
    check(agent.bitcoinWallet, 'Configure the local Bitcoin signer'); return agent.playerMint.pay(args);
  }, false);
  register('poll_mint', 'Poll the request for final payment, a receiver-bound permit, or an indexed mint. This read never signs or broadcasts.', { id: hex, timeoutMs: z.number().int().min(0).max(120000).default(30000) }, (args, extra) => agent.playerMint.poll(args.id, { timeoutMs: args.timeoutMs, signal: extra?.signal }));
  register('inscribe_mint', 'Inscribe an issued mint permit from the local Bitcoin wallet. Dry-run by default; resumes the exact saved commit/reveal.', mintBitcoinArgs, args => {
    check(agent.bitcoinWallet, 'Configure the local Bitcoin signer'); return agent.playerMint.inscribe(args);
  }, false);
  register('inscribe_deployment', 'The first minter inscribes a pattern element and deployment, or the first maker deploys a compound, from the local Bitcoin wallet. Retry when the inscription lands in a block to register the same inscription.', { asset, feeRate: mintBitcoinArgs.feeRate, maxFeeSats: mintBitcoinArgs.maxFeeSats }, args => {
    check(agent.bitcoinWallet, 'Configure the local Bitcoin signer'); return agent.playerMint.deploy(args);
  }, false);
  register('register_deployment', 'Submit a player’s already-inscribed element or deployment for verification. Sends no Bitcoin transaction; dry-run unless launched live.', { asset, phase: z.enum(['element', 'deployment']).default('deployment'), inscription: z.string().regex(/^[0-9a-f]{64}i[0-9]+$/) }, async ({ asset, phase, inscription }) => {
    const job = await agent.service.deployment(asset);
    check(job.asset === asset && (job.kind === 'dmt' || job.kind === 'compound' && job.definition?.firstMaker === agent.address), 'Only this compound’s first maker can submit its deployment here');
    if (agent.dryRun) return { state: 'dry-run', asset, inscription, sent: false };
    return agent.service.submitDeployment({ asset, phase, inscription });
  }, false);
  register('link_bitmap', 'Sign a permanent Bitmap-link request and return its payment page. Acceptance requires current holder evidence and a completed payment.', { actionId, height, payer: z.string().min(1).max(128).optional() }, args => agent.linkBitmap(args), false);
  register('transfer', 'Send integer asset units; TNK is charged to your own trac1… address.', { actionId, to: z.string().refine(isTracAddress, TRAC_ADDRESS_ERROR), assets: pairs }, ({ actionId, ...value }) => agent.transaction({ actionId, op: 'tf', value }), false);
  return tools;
}
export async function runTool(context, name, args = {}, { readOnly = false, signal } = {}) {
  const tools = gameTools(context), tool = tools[name];
  check(tool, 'Unknown tool: ' + name + '. Valid names: ' + Object.keys(tools).join(', '));
  check(!readOnly || tool.readOnly, 'Use action ' + name + ' for this action tool');
  return tool.run(tool.schema.parse(args), { signal });
}
