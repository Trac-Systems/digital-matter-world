import { encodeTracAddress, isTracAddress, publicIdentities, TRAC_ADDRESS_ERROR } from '../../rules/src/trac-address.js';
import { compoundIdentityV4Active } from '../../rules/src/compound-identity-v4.js';
import { z } from 'zod/v4';
import { PLAIN_PATTERN_NAME, validPatternName } from '../../rules/src/pattern-names.js';
import { check } from './check.mjs';
import { findPatterns } from './search.mjs';
import { searchMatchPage } from './search-matches.mjs';
import { backtest } from './backtest.mjs';
import { chooseClaims, chooseCompound, chooseMint } from '../strategies/default.mjs';
import { readTools } from './read-tools.mjs';
import { isAsset, patternId, readInteger } from './api-values.mjs';

const hex = z.string().regex(/^[0-9a-f]{64}$/), units = z.string().regex(/^[1-9][0-9]{0,77}$/), height = z.number().int().nonnegative().safe();
const asset = z.string().refine(isAsset, 'Invalid matter asset'), actionId = z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/);
const pairs = z.array(z.tuple([asset, units])).min(1).max(16);
const craftInputs = z.array(z.tuple([z.string().regex(/^([0-9a-z]{1,24}|p2:(0|[1-9][0-9]*)|c2:[0-9a-f]{64})$/), z.string().regex(/^[1-9][0-9]*$/)])).min(2);
const proposal = z.object({ name: z.string().regex(PLAIN_PATTERN_NAME).describe('3–32 lowercase letters/digits after plain-name activation; before it, dmw plus 2–29 letters/digits.'), pat: z.string().max(64), fld: z.union([z.literal(4), z.literal(10), z.literal(11)]), dt: z.enum(['n', 'h']), amountMode: z.enum(['count', 'field-value']).optional().describe('Default count pays regex matches. Field-value pays the numeric field once per matching block; proposals require activation.') }).strict();
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const mintAsset = z.string().regex(/^(?:[0-9a-z]{1,24}|p2:(?:0|[1-9][0-9]*)|c2:[0-9a-f]{64})$/);
const deploymentAsset = z.string().regex(/^(?:[pc][0-9a-z]{1,23}|p2:(?:0|[1-9][0-9]*)|c2:[0-9a-f]{64})$/);
const publicInteger = z.union([height, decimal]);
const publication = z.object({ height: publicInteger, observation: publicInteger.optional(), audit: z.object({ path: z.string().max(512), hash: hex, bytes: height.max(1500000) }).strict() });
const namedAnchor = z.object({ height: decimal, hash: hex }).strict();
const namedMatches = z.array(z.object({ height: decimal, hash: hex, count: decimal }).strict()).min(1);
const witnesses = z.object({ anchor: namedAnchor, matches: namedMatches }).strict();

export function gameTools({ agent, history, historySync, source, strategies = {}, candidates = async () => [], compounds = async () => [] }) {
  const tools = {};
  const register = (name, description, shape, run, readOnly = true) => { tools[name] = { description, shape, schema: z.object(shape).strict(), run: async (...args) => { const result = await run(...args); return ['quote_bulk_mint', 'mint_bulk_on_chain', 'poll_bulk_mint', 'pay_bulk_mint'].includes(name) ? result : publicIdentities(result); }, readOnly }; };
  const currentHistory = () => historySync?.available() ?? history;
  const needHistory = () => { const value = currentHistory(); check(value, 'Configure a verified header history first'); return value; };
  const discovery = run => async (...args) => {
    if (historySync && !historySync.available()) return historySync.status();
    const head = await agent.trac.head(), value = historySync ? historySync.available(head.tip) : needHistory();
    if (!value) return historySync.status();
    for (const proposal of [args[0]?.proposal, ...(args[0]?.candidates ?? [])].filter(Boolean))
      check(validPatternName(proposal.name, head.counted), 'pattern_name');
    return run(value, head, ...args);
  };
  for (const [name, tool] of Object.entries(readTools(agent))) register(name, tool.description, tool.shape, tool.run, tool.readOnly);
  register('tnk_transfer', 'Send native TNK to another trac1… account. Amount is a decimal TNK string (up to 18 places) or max for balance minus fee. Reuse the action ID to resend the same signed packet.',
    { actionId, to: z.string().refine(isTracAddress, 'tnk_invalid_address'), amount: z.string().max(59) }, args => agent.sendTnkTransfer(args), false);
  register('use_credit', 'Allocate accepted fee credit to an open request with matching fee terms. Reuse the action ID after uncertainty.',
    { actionId, credit: hex, request: hex, items: z.array(z.object({ fee: hex, amount: z.string().regex(/^[1-9][0-9]*$/) }).strict()).min(1) }, args => agent.useCredit(args), false);
  register('transfer_credit', 'Transfer an accepted fee credit to another player using the current signed revision. Reuse the action ID after uncertainty.',
    { actionId, credit: hex, to: z.string().refine(isTracAddress, TRAC_ADDRESS_ERROR) }, args => agent.transferCredit(args), false);
  register('financial_action_status', 'Read acceptance of a saved credit or beneficiary action.', { id: hex }, ({ id }) => agent.service.financialActionStatus(id));
  register('claim_custody', 'Claim an accepted beneficiary liability to your chosen payout address. Saves one signed claim; never sends the custodian payment.',
    { actionId, id: hex, destination: z.string().min(1).max(90) }, args => agent.claimCustody(args), false);
  register('custody_status', 'Read a beneficiary liability and its exact payout plan for the custodian.', { id: hex }, ({ id }) => agent.service.custodyStatus(id));
  register('report_custody_payment', 'Report a transfer already made by the custodian for canonical verification. This tool never sends funds.',
    { id: hex, reference: z.string().min(1).max(100), index: z.number().int().nonnegative().safe() }, args => agent.dryRun ? { state: 'dry-run', action: 'report_custody_payment', ...args, sent: false } : agent.service.reportCustodyPayment(args), false);
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
  register('pattern_search_matches', 'Page through locally computed matching heights, canonical hashes and exact counts. Reuse the proposal, snapshot and cursor; this creates no find or server submission. The activated occurrence page size is the upper limit.', { proposal, cursor: z.string().max(1024).optional(), pageSize: z.number().int().min(1).max(200).optional() }, discovery(async (history, head, args, extra) => {
    const context = await agent.namedContext?.();
    return searchMatchPage({ history, tip: head.tip, executionHeight: head.counted, ...args, pageSize: args.pageSize ?? context?.settings.values.occurrencePageSize ?? 100, settings: context?.settings, signal: extra?.signal });
  }));
  register('search_patterns', 'Test bounded candidate patterns against verified local history and return matching heights, hashes, counts and a resumable local page cursor. Reports history downloading (x%) until ready.', { maxCandidates: z.number().int().min(1).max(60).default(10), candidates: z.array(proposal).max(60).optional() }, discovery(async (history, head, { maxCandidates, candidates }, extra) => {
    const context = await agent.namedContext?.();
    return findPatterns({ history, tip: head.tip, executionHeight: head.counted, existing: await agent.catalog(), settings: context?.settings, owner: encodeTracAddress(agent.owner), maxCandidates, candidates, strategy: strategies.searchPatterns, signal: extra?.signal });
  }));
  register('propose_pattern', 'Save the pattern, snapshot, real matching blocks and salt; commit with a stable action ID. Reads the activated rules and preserves the original journal.', { actionId, proposal, witnesses: witnesses.optional() }, discovery(async (history, head, args) => agent.propose({ ...args, history, patterns: await agent.namedContext?.() ? [] : await agent.catalog() })), false);
  register('reveal_pattern', 'Reveal the saved pattern and named blocks in its recorded eligibility window, after independently verifying the accepted commitment. Legacy actions add a witness attachment.', { actionId, publication: publication.optional(), witnesses: witnesses.optional() }, discovery(async (history, head, args) => agent.reveal({ ...args, history, patterns: await agent.namedContext?.() ? [] : await agent.catalog() })), false);
  register('submit_occurrences', 'Submit a bounded page of named matching blocks under activated v2 rules. Adds known evidence; it awards no find. Reuse the action ID after uncertainty.', { actionId, patternKey: hex, anchor: namedAnchor, matches: namedMatches }, args => agent.submitOccurrences(args), false);
  register('recover_refused_reveal', 'Record an owner-confirmed original HTTP 429 reveal_capacity refusal discarded by an older kit. Use the exact move ID from status, only when every attempt of that packet was definitely refused, never after a timeout or lost response. Preserves history and sends nothing; then retry reveal_pattern with the same action ID.', {
    actionId, move: hex, status: z.literal(429), code: z.literal('reveal_capacity'), confirmOriginalRefusal: z.literal(true)
  }, args => agent.recoverRefusedReveal(args), false);
  register('verify_claim', 'Find and verify the saved claim in its original witnessed receipt publication. If needed pass the claim provenance from block claims: {height,observation,audit}; height is the audit counted height, not the receipt tip. Returns verified/inclusion, not a settled win.', { window: height, publication: publication.optional() }, args => agent.claimInclusion(args));
  register('backtest', 'Replay legacy fixtures over a bounded history range. V2 needs accepted catalog and claim-state snapshots and is explicitly unsupported. No sends or payments.', { start: height, end: height }, async ({ start, end }, extra) => {
    check(end - start <= 10000, 'Use the CLI for replays over 10,000 blocks');
    if (historySync && !historySync.available()) return historySync.status();
    return backtest({ history: needHistory(), patterns: await agent.catalog(), settings: await agent.trac.settings(), owner: encodeTracAddress(agent.owner), strategy: strategies.chooseClaims, start, end, signal: extra?.signal });
  });
  register('compound_idea', 'Suggest owned named ingredients; v2 output identities and properties require an authenticated craft preview.', {}, async () => {
    const patterns = await agent.catalog(), types = await compounds(), balances = {}, counted = (await agent.trac.head()).counted;
    for (const p of patterns) {
      const assets = [patternId(p), ...(compoundIdentityV4Active(counted) && p.legacy?.asset ? [p.legacy.asset] : [])];
      for (const asset of assets) balances[asset] = await agent.trac.balance(agent.owner, asset);
    }
    for (const c of types) balances[c.id] = await agent.trac.balance(agent.owner, c.id);
    const settings = await agent.trac.settings();
    const suggestion = (strategies.chooseCompound ?? chooseCompound)({ patterns: publicIdentities(patterns), compounds: publicIdentities(types), balances, historyLength: typeof counted === 'string' ? String(BigInt(counted) + 1n) : counted + 1, height: counted, ruleset: settings.ruleset }) ?? null;
    if (!suggestion) return { suggestion: null, reason: Object.values(balances).some(v => BigInt(v) > 0n) ? 'no_craftable_recipe' : 'no_balance' };
    const warnings = [], mintableFinderSlots = [], slotPages = {}; let slotCount = 0, totalKnown = true;
    if (suggestion.previewRequired) warnings.push({ code: 'craft_preview_required', message: 'Run craft in dry-run mode to verify the v2 proof and obtain the canonical output identity and first-craft properties.' });
    else {
      const registered = await agent.mintRights({ asset: suggestion.id, limit: 1 });
      if (!registered.mintRights.some(r => r.deploymentRegistered)) warnings.push({ code: 'asset_unregistered', message: 'The first maker must inscribe and register this compound deployment before it can be minted.' });
    }
    for (const [asset, amount] of suggestion.inputs) {
      const page = await agent.mintRights({ asset, allowed: true, whoMayMint: 'finder', limit: 10 });
      const remaining = (BigInt(balances[asset]) - BigInt(amount)).toString();
      if (page.total === null) totalKnown = false;
      slotCount += page.total === null ? page.mintRights.length : readInteger(page.total);
      for (const row of page.mintRights) mintableFinderSlots.push({ asset, block: row.block, unitsUsed: amount, required: row.amount, remaining, blocksMint: BigInt(remaining) < BigInt(row.amount) });
      if (page.mintRights.length || page.next) slotPages[asset] = { total: page.total, next: page.next, tool: 'mint_rights', arguments: { filters: { asset, allowed: true, whoMayMint: 'finder' }, limit: 10 } };
    }
    if (slotCount || Object.keys(slotPages).length) warnings.push({ code: 'consumes_mintable_finder_units', message: 'This craft may consume units needed for mintable finder slots; continue the linked pages when a cursor remains.', slots: mintableFinderSlots, total: totalKnown ? slotCount : null, pages: slotPages });
    return { suggestion, reason: null, warnings };
  });
  register('craft', 'Consume input units through an owner-signed free craft. Reuse the same action ID after an uncertain result.', { actionId, recipe: z.enum(['fusion', 'resonance']).default('fusion'), inputs: craftInputs }, async args => {
    const context = await agent.namedContext();
    return agent.craft({ ...args, ...(context ? {} : { patterns: await agent.catalog(), compounds: await compounds() }) });
  }, false);
  register('refine_compound', 'Continue exact tier comparison for an accepted v2 compound. Reuse this action ID after uncertainty; each accepted step retains its cursor.',
    { actionId, asset: z.string().regex(/^c2:[0-9a-f]{64}$/), steps: z.number().int().positive().safe().optional() }, args => agent.refineCompound(args), false);
  register('mint_idea', 'Choose an eligible unminted block that fits your balance, preferring supplied UTC dates.', { asset, deployment: z.string().min(1).optional(), specialDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100).default([]) }, async ({ asset, deployment, specialDates }) => {
    const balance = await agent.trac.balance(agent.owner, asset);
    if (BigInt(balance) === 0n) return { suggestion: null, reason: 'no_balance' };
    const context = await agent.namedContext();
    const suggestion = (strategies.chooseMint ?? chooseMint)({ candidates: publicIdentities(await candidates(asset, { deployment })), owner: encodeTracAddress(agent.owner), counted: (await agent.trac.head()).counted, balance, settings: context?.settings, specialDates }) ?? null;
    return { suggestion, reason: suggestion ? null : 'no_eligible_slot' };
  });
  register('mint_on_chain', 'Reserve units with a signed quote. Then use pay_mint, poll_mint and inscribe_mint; the player pays and inscribes from their own wallet.', {
    actionId, asset: mintAsset, amount: units, deployment: z.string().min(1).optional(), block: z.union([height, decimal]).optional(), receiver: z.string().min(1).max(128).optional(), payer: z.string().min(1).max(128).optional(), kind: z.enum(['tap', 'ethereum']).default('tap'), compound: z.boolean().default(false)
  }, async args => {
    const addresses = agent.paymentAddresses(args), started = Date.now();
    const candidate = args.compound ? undefined : (await candidates(args.asset, { block: args.block, kind: args.kind, ...(args.deployment ? { deployment: args.deployment } : {}) })).find(c => c.find && String(c.find.block) === String(args.block));
    if (process.env.DMW_DASHBOARD_DEBUG === '1') process.stderr.write(`mint timing: candidate ${Date.now() - started}ms\n`);
    return agent.makeReal({ ...args, ...addresses, candidate });
  }, false);
  register('quote_bulk_mint', 'Save an exact bulk quote and nonce for up to 64 found blocks in one deployment. Review accepted, skipped and deferred blocks before submitting.', {
    actionId, asset: mintAsset, deployment: z.string().regex(/^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/),
    blocks: z.array(decimal).min(1).max(64), receiver: z.string().min(1).max(90), payer: z.string().min(1).max(90)
  }, args => agent.quoteBulkMint(args), false);
  register('mint_bulk_on_chain', 'Submit the exact saved bulk quote with explicit TAP and Bitcoin set-aside ceilings. Retry the same action ID after uncertainty. Never pays from a wallet.', {
    actionId, quoteId: hex, maxPayableFeeAtoms: decimal, maxSetAsideSats: z.number().int().nonnegative().safe(), dryRun: z.boolean().default(false)
  }, args => agent.makeBulkMint(args), false);
  register('poll_bulk_mint', 'Read bulk payment, permits and per-member confirmation progress. A broadcast is not a completed mint.', {
    orderId: hex, offset: z.number().int().min(0).max(63).default(0), limit: z.number().int().min(1).max(64).default(64)
  }, args => agent.pollBulkMint(args));
  register('pay_bulk_mint', 'Return the bulk payment page and exact wallet transfer/set-aside plan for human approval. Never spends or broadcasts.', {
    orderId: hex
  }, args => agent.payBulkMint(args));
  register('asset_tickers', 'List registered tickers, each with the full pattern supply. Omitted mint choices use its official ticker.',
    { asset: deploymentAsset, after: z.string().optional(), limit: z.number().int().positive().optional() }, ({ asset, ...page }) => agent.service.assetTickers(asset, page));
  register('report_ticker_payment', 'Report explicit confirmed TAP payment inscriptions for an additional ticker; never broadcasts a payment.',
    { id: hex, paymentIds: z.array(z.string().regex(/^[0-9a-f]{64}i[0-9]+$/)), expire: z.boolean().optional() }, args =>
      agent.dryRun ? { state: 'dry-run', ...args, sent: false } : agent.service.tickerPayment(args), false);
  register('deploy_ticker', 'Prepare an additional chosen ticker after the official deployment. Review its fee, then inscribe with an explicit Bitcoin fee ceiling.',
    { asset: deploymentAsset, ticker: z.string().min(1), retry: z.boolean().optional(), feeRate: z.number().positive().optional(), maxFeeSats: z.string().regex(/^[1-9][0-9]*$/).optional() }, async args => {
      const receiver = agent.bitcoinWallet?.address ?? agent.paymentAddresses({}).receiver;
      if (agent.dryRun) return { state: 'dry-run', asset: args.asset, ticker: args.ticker, receiver, signed: false, sent: false };
      if (args.maxFeeSats) { check(agent.bitcoinWallet, 'Configure the local Bitcoin signer'); return agent.playerMint.deploy(args); }
      return agent.service.deployTicker({ asset: args.asset, ticker: args.ticker, ...(args.retry ? { retry: true } : {}), receiver });
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
  register('inscribe_deployment', 'The first minter inscribes a pattern element and deployment, or the first maker deploys a compound, from the local Bitcoin wallet. Retry when the inscription lands in a block to register the same inscription.', { asset: deploymentAsset, feeRate: mintBitcoinArgs.feeRate, maxFeeSats: mintBitcoinArgs.maxFeeSats }, args => {
    check(agent.bitcoinWallet, 'Configure the local Bitcoin signer'); return agent.playerMint.deploy(args);
  }, false);
  register('register_deployment', 'Submit a player’s already-inscribed element or deployment for verification. Sends no Bitcoin transaction; dry-run unless launched live.', { asset: deploymentAsset, phase: z.enum(['element', 'deployment']).default('deployment'), inscription: z.string().regex(/^[0-9a-f]{64}i[0-9]+$/) }, async ({ asset, phase, inscription }) => {
    const job = await agent.service.deployment(asset);
    check((job.asset === asset || asset === job.catalogAsset && /^p2:(0|[1-9][0-9]*)$/.test(asset) && job.asset === 'p' + BigInt(asset.slice(3)).toString(36)) &&
      (job.kind === 'dmt' || job.kind === 'compound' && job.definition?.firstMaker === agent.address), 'Only this compound’s first maker can submit its deployment here');
    asset = job.asset;
    if (agent.dryRun) return { state: 'dry-run', asset, inscription, sent: false };
    return agent.service.submitDeployment({ asset, phase, inscription });
  }, false);
  register('pay_link', 'Pay the missing TAP link fees with the local Bitcoin wallet after accepted reservation. Preserve the journal for exact retries.', mintBitcoinArgs, args => {
    agent.playerLink.dryRun = agent.dryRun; return agent.playerLink.pay(args);
  }, false);
  register('poll_link', 'Read a paid link reservation and terminal settlement without signing or broadcasting.', { id: hex, timeoutMs: z.number().int().min(0).max(120000).default(30000) },
    (args, extra) => agent.playerLink.poll(args.id, { timeoutMs: args.timeoutMs, signal: extra?.signal }));
  register('link_bitmap', 'Sign a permanent Bitmap-link request and return its payment page. Acceptance requires current holder evidence. A zero-fee quote is Free and needs no payment.', { actionId, height: z.union([height, decimal]), payer: z.string().min(1).max(128).optional() }, args => agent.linkBitmap(args), false);
  register('transfer', 'Transfer integer units to a trac1… address using exact ledger assets after public-mint activation. Before activation, retain the authorization locally. V2 moves need no sender TNK; legacy transfers charge your own address. Reuse the action ID.', { actionId, to: z.string().refine(isTracAddress, TRAC_ADDRESS_ERROR), assets: pairs }, ({ actionId, ...value }) => agent.transaction({ actionId, op: 'tf', value }), false);
  return tools;
}
export async function runTool(context, name, args = {}, { readOnly = false, signal } = {}) {
  const tools = gameTools(context), tool = tools[name];
  check(tool, 'Unknown tool: ' + name + '. Valid names: ' + Object.keys(tools).join(', '));
  check(!readOnly || tool.readOnly, 'Use action ' + name + ' for this action tool');
  return tool.run(tool.schema.parse(args), { signal });
}
