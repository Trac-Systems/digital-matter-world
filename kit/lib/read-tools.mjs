import { encodeTracAddress, isTracAddress, publicIdentities, TRAC_ADDRESS_ERROR } from '../../rules/src/trac-address.js';
import { z } from 'zod/v4';
import { readFile } from 'node:fs/promises';
import { presentRead } from './reads.mjs';
import { check } from './check.mjs';

const number = z.number().int().nonnegative().safe();
const height = z.union([number, z.string().regex(/^(0|[1-9][0-9]*)$/)]);
const key = z.string().refine(isTracAddress, TRAC_ADDRESS_ERROR);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const asset = z.string().regex(/^(?:[0-9a-z]{1,24}|p2:(?:0|[1-9][0-9]*)|c2:[0-9a-f]{64})$/);
const page = { cursor: z.string().min(1).max(8192).optional(), limit: number.min(1).max(200).optional(),
  sort: z.string().min(1).max(64).optional(), order: z.enum(['asc', 'desc']).optional() };
const fields = {
  asset: asset.optional(), deployment: z.string().regex(/^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/).optional(), owner: key.optional(), address: key.optional(), agent: key.optional(), actor: key.optional(), discoverer: key.optional(), firstMaker: key.optional(),
  from: height.optional(), to: height.optional(), block: height.optional(), height: height.optional(), window: height.optional(), since: height.optional(),
};
for (const name of ['found', 'linked', 'minted', 'allowed', 'pending', 'nonzero', 'positive', 'header']) fields[name] = z.boolean().optional();
for (const name of ['tier', 'recipe', 'reason', 'whoMayMint', 'q', 'type', 'category', 'state', 'kind', 'action', 'status', 'payer', 'beneficiary', 'role', 'to']) {
  if (!fields[name]) fields[name] = z.string().max(2048).optional();
}
// `to` is a height for block ranges, a recipient for payout collections.
fields.to = z.union([height, z.string().max(2048)]).optional();
const list = { ...page, filters: z.object(fields).strict().optional() };
const options = ({ filters, ...rest }) => ({ ...filters, ...rest });

// CLI and MCP share validation and dispatch; SDK callers use Agent/ServiceClient.
export function readTools(agent) {
  const tool = (description, shape, run, readOnly = true) => ({ description, shape, schema: z.object(shape).strict(), readOnly, run: async (...args) => publicIdentities(await run(...args)) });
  return {
    rules: tool('Read the self-contained game playbook.', {}, () => readFile(new URL('../llms.txt', import.meta.url), 'utf8')),
    address: tool('Read your trac1… address for Trac identity and TNK fees.', {}, () => ({ address: encodeTracAddress(agent.owner), dryRun: agent.dryRun, owner: agent.ownerConfig, bitcoinNetwork: agent.bitcoinNetwork })),
    tnk_balance: tool('Read your TNK account address, exact MSB balance and native transfer fee. V2 game moves need 0 TNK.', {}, () => agent.tnkBalance()),
    tnk_transfer_status: tool('Read native TNK confirmation for a saved action ID without signing or resending.',
      { actionId: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/) }, ({ actionId }) => agent.tnkTransferStatus(actionId)),
    status: tool('Read the contract clock and recent journal actions with payment request IDs.', {}, () => agent.status()),
    balance: tool('Read spendable matter units.', { asset }, ({ asset }) => agent.balance(asset)),
    mint_status: tool('Read mint payment and expiry progress using a request ID or a mint/actionId from status.',
      { id: z.string().regex(/^(?:[0-9a-f]{64}|mint\/[a-zA-Z0-9._-]{1,64})$/) }, async ({ id }) => presentRead(await agent.mintStatus(id))),
    transaction_status: tool('Check a native TNK or legacy subnet transaction by hash. Native states are confirmed, pending or unknown.', { tx: hash }, ({ tx }) => {
      check(agent.trac.transactionStatus, 'Transaction status adapter required'); return agent.trac.transactionStatus(tx);
    }),
    public_status: tool('Read public network progress, fee policy and unit metadata.', { limit: page.limit }, args => agent.service.publicStatus(args)),
    world: tool('Read a cursor page of Bitcoin plots and opening, link and mint state.', list, args => agent.service.blocks(options(args))),
    patterns: tool('Read a cursor page of patterns, rarity, tiers and supply.', list, args => agent.service.patterns(options(args))),
    catalog: tool('Read the current pattern catalog across revision-pinned pages. V2 pattern numbers are safe local integers; assets use p2:NUMBER and legacy rows are excluded.', {}, async () => ({ patterns: await agent.catalog() })),
    compounds: tool('Read a cursor page of compound recipes and exact properties.', list, args => agent.service.compounds(options(args))),
    finds: tool('Read a cursor page of settled finds and attribution.', list, args => agent.service.finds(options(args))),
    my_finds: tool('Read your unminted finds on journal-known blocks, with finder deadlines. Bounded block reads avoid the agent-wide find cursor; keep paging even when finds is empty. Missing journal history is not covered.',
      { cursor: z.string().min(1).max(16384).optional(), limit: number.min(1).max(50).optional(), asset: asset.optional(), soonBlocks: number.max(1008).optional() }, args => agent.myFinds(args)),
    receipts: tool('Read public receipt publications. Verify signatures separately.', list, args => agent.service.receipts(options(args))),
    pattern_matches: tool('Page verified submitted matching blocks (limit 1–50), never an exhaustive history search. Use a p2:NUMBER asset on mainnet.', { asset, ...list, limit: number.min(1).max(50).optional() }, ({ asset, ...args }) => {
      if (asset.startsWith('p2:')) return agent.service.claimedBlocks(asset, options(args));
      check(agent.service.mode === 'regtest', 'Legacy pattern assets are archived; select a p2:NUMBER asset from patterns');
      return agent.service.readPage(`/patterns/${asset}/blocks`, options(args));
    }),
    claimed_blocks: tool('Page submitted and verified matching blocks (limit 1–50). Missing rows do not exclude a deferred header award; consult window_eligibility.', { asset: z.string().regex(/^p2:(0|[1-9][0-9]*)$/), ...list, limit: number.min(1).max(50).optional() }, ({ asset, ...args }) => agent.service.claimedBlocks(asset, options(args))),
    window_eligibility: tool('Read deferred header-award evidence for a window, or page the recorded windows. An absent claimed-block row does not prove a slot is free.',
      { window: height.optional(), collection: z.enum(['claims', 'winners', 'headers']).optional(), ...page }, ({ window, collection, ...args }) => {
        check(window !== undefined || collection === undefined, 'A window is required for its collection');
        return agent.service.readPage(window === undefined ? '/window-eligibility' : collection ? `/windows/${window}/${collection}` : `/window-eligibility/${window}`, args);
      }),
    submit_bitmap: tool('Verify one named Bitmap for the public inventory. This submits public evidence and does not sign or pay. Wallet discovery stays local.',
      { block: height, inscription: z.string().regex(/^[0-9a-f]{64}i(0|[1-9][0-9]*)$/).optional() }, args => agent.dryRun ? { state: 'dry-run', action: 'submit_bitmap', ...args, sent: false } : agent.service.submitBitmap(args), false),
    block: tool('Read block detail and bounded previews. Set collection to page matches, slotList, claims, draws, finds or mintRights.',
      { height, collection: z.enum(['matches', 'slotList', 'claims', 'draws', 'finds', 'mintRights']).optional(), ...list }, ({ height, ...args }) => agent.block(height, options(args))),
    mint_rights: tool('Read your mintable slots and compound units, settlement-based finder deadlines, Bitmap fee recipients and balance/hold restrictions. Wallet-only public mints use the website.', list, args => agent.mintRights(options(args))),
    mint_quote: tool('Preview a quote without wallet signing: exact units used, TAP fee splits/destinations and a separate Bitcoin fee. Uses POST /mint/quote without a reservation; unavailable under a GET-only policy.',
      { asset, deployment: z.string().min(1).optional(), block: height.optional(), amount: z.string().regex(/^[1-9][0-9]{0,77}$/).optional(), kind: z.enum(['tap', 'ethereum']).optional() }, args => agent.mintQuote(args)),
    events: tool('Read public events forward from since (exclusive sequence), or continue with cursor and the same filters. Save sequences durably.',
      { since: height.optional(), ...list }, args => agent.events(options(args))),
    event: tool('Read one public event and its provenance by sequence.', { sequence: height }, ({ sequence }) => agent.service.event(sequence)),
    results: tool('Read on-chain mint results, payout ledger and treasury/burn totals. Select a collection for cursor paging.',
      { collection: z.enum(['mints', 'payments', 'ethereum', 'payouts', 'owed', 'paid', 'links', 'credits', 'custody', 'linkRequests', 'supply']).optional(), ...list }, args => agent.results(options(args))),
    agents: tool('Read the public agent leaderboard. Scores count activity per key, not unique people or balances.', list, args => agent.agents(options(args))),
    agent_profile: tool('Read a public agent profile (defaults to you); select a collection for cursor paging.',
      { owner: key.optional(), collection: z.enum(['balances', 'bitmaps', 'finds', 'mintRights', 'discoveries', 'history', 'assets']).optional(), ...list }, ({ owner, ...args }) => agent.profile(owner, options(args))),
    hunting: tool('Read your local claims with draw heights and sealed commitments with reveal windows. Never returns salts, proposals or signed packets. Overdue claims need settlement reconciliation.',
      { cursor: page.cursor, limit: page.limit }, args => agent.hunting(args)),
    read_page: tool('Follow a public collections.COLLECTION or pages.COLLECTION.route with its next/nextCursor. Empty rows with a cursor are not the end. Supports nested /list pages; never follows a remote origin.',
      { route: z.string().min(1).max(16384), ...list }, ({ route, ...args }) => agent.service.readPage(route, options(args))),
  };
}
