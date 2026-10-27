import { encodeTracAddress, isTracAddress, publicIdentities, TRAC_ADDRESS_ERROR } from '../../rules/src/trac-address.js';
import { z } from 'zod/v4';
import { readFile } from 'node:fs/promises';
import { presentRead } from './reads.mjs';
import { check } from './check.mjs';

const height = z.number().int().nonnegative().safe();
const key = z.string().refine(isTracAddress, TRAC_ADDRESS_ERROR);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const asset = z.string().regex(/^[0-9a-z]{1,24}$/);
const page = { cursor: z.string().min(1).max(8192).optional(), limit: height.min(1).max(200).optional(),
  sort: z.string().min(1).max(64).optional(), order: z.enum(['asc', 'desc']).optional() };
const fields = {
  asset: asset.optional(), owner: key.optional(), address: key.optional(), agent: key.optional(), actor: key.optional(), discoverer: key.optional(), firstMaker: key.optional(),
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
  const tool = (description, shape, run) => ({ description, shape, schema: z.object(shape).strict(), run: async (...args) => publicIdentities(await run(...args)) });
  return {
    rules: tool('Read the self-contained game playbook.', {}, () => readFile(new URL('../llms.txt', import.meta.url), 'utf8')),
    address: tool('Read your trac1… address for Trac identity and TNK fees.', {}, () => ({ address: encodeTracAddress(agent.owner), dryRun: agent.dryRun, owner: agent.ownerConfig, bitcoinNetwork: agent.bitcoinNetwork })),
    status: tool('Read the contract clock and recent journal actions with payment request IDs.', {}, () => agent.status()),
    balance: tool('Read spendable matter units.', { asset }, ({ asset }) => agent.balance(asset)),
    mint_status: tool('Read mint payment and expiry progress using a request ID or a mint/actionId from status.',
      { id: z.string().regex(/^(?:[0-9a-f]{64}|mint\/[a-zA-Z0-9._-]{1,64})$/) }, async ({ id }) => presentRead(await agent.mintStatus(id))),
    transaction_status: tool('Check an already submitted TNK transaction.', { tx: hash }, ({ tx }) => {
      check(agent.trac.transactionStatus, 'Transaction status adapter required'); return agent.trac.transactionStatus(tx);
    }),
    public_status: tool('Read public network progress, fee policy and unit metadata.', { limit: page.limit }, args => agent.service.publicStatus(args)),
    world: tool('Read a cursor page of Bitcoin plots and opening, link and mint state.', list, args => agent.service.blocks(options(args))),
    patterns: tool('Read a cursor page of patterns, rarity, tiers and supply.', list, args => agent.service.patterns(options(args))),
    compounds: tool('Read a cursor page of compound recipes and exact properties.', list, args => agent.service.compounds(options(args))),
    finds: tool('Read a cursor page of settled finds and attribution.', list, args => agent.service.finds(options(args))),
    receipts: tool('Read public receipt publications. Verify signatures separately.', list, args => agent.service.receipts(options(args))),
    pattern_matches: tool('Read all historical matching blocks for a pattern, using cursor/limit.', { asset, ...list }, ({ asset, ...args }) => agent.service.readPage(`/patterns/${asset}/blocks`, { ...options(args) })),
    block: tool('Read block detail and bounded previews. Set collection to page matches, slotList, claims, draws, finds or mintRights.',
      { height, collection: z.enum(['matches', 'slotList', 'claims', 'draws', 'finds', 'mintRights']).optional(), ...list }, ({ height, ...args }) => agent.block(height, options(args))),
    mint_rights: tool('Read your mintable slots and compound units, finder deadlines, Bitmap rights and balance/hold restrictions.', list, args => agent.mintRights(options(args))),
    mint_quote: tool('Read a quote without wallet signing: exact units used, TAP fee splits/destinations and a separate Bitcoin fee.',
      { asset, block: height.optional(), amount: z.string().regex(/^[1-9][0-9]{0,77}$/).optional(), kind: z.enum(['tap', 'ethereum']).optional() }, args => agent.mintQuote(args)),
    events: tool('Read public events forward from since (exclusive sequence), or continue with cursor and the same filters. Save sequences durably.',
      { since: height.optional(), ...list }, args => agent.events(options(args))),
    event: tool('Read one public event and its provenance by sequence.', { sequence: height }, ({ sequence }) => agent.service.event(sequence)),
    results: tool('Read on-chain mint results, payout ledger and treasury/burn totals. Select a collection for cursor paging.',
      { collection: z.enum(['mints', 'payments', 'ethereum', 'payouts', 'owed', 'paid', 'links']).optional(), ...list }, args => agent.results(options(args))),
    agents: tool('Read the public agent leaderboard. Scores count activity per key, not unique people or balances.', list, args => agent.agents(options(args))),
    agent_profile: tool('Read a public agent profile (defaults to you); select a collection for cursor paging.',
      { owner: key.optional(), collection: z.enum(['balances', 'bitmaps', 'finds', 'mintRights', 'discoveries', 'history']).optional(), ...list }, ({ owner, ...args }) => agent.profile(owner, options(args))),
    hunting: tool('Read your local claims with draw heights and sealed commitments with reveal windows. Never returns salts, proposals or signed packets. Overdue claims need settlement reconciliation.',
      { cursor: page.cursor, limit: page.limit }, args => agent.hunting(args)),
    read_page: tool('Follow a public pages.collection.route with its next cursor. Supports nested /list pages; never follows a remote origin.',
      { route: z.string().min(1).max(16384), ...list }, ({ route, ...args }) => agent.service.readPage(route, options(args))),
  };
}
