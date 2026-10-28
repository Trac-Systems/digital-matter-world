# Playground control API

Version 1. Base URL and console origin: `http://127.0.0.1:59000`.
Amount scales are returned in `status.units`: `{tap:18,bridgedTap:18,bitcoin:8,ethereum:18,matter:0}`. Protocol values are base units; Bitcoin wallet `btc` is denominated in BTC.
The same server serves `playground/console/` at `/`. All amounts are decimal
integer strings. Heights and block counts are JSON integers. This is an isolated
regtest game; its patterns and rarity are computed from the local chain.

## Public gateway boundary

Game reads use the [public gateway API](../service/docs/READS.md). `/api/status`,
`world`, `blocks`, `patterns`, `table`, `compounds`, `finds`, `receipts`, `feed`,
`agents`, `mint-rights` and `results` are thin proxies: rows, totals, signed
cursors and continuation routes are returned unchanged. `/api/player/balances`,
`mintRights`, `bitmaps` and `finds` proxy `/agents/PLAYER_ADDRESS/COLLECTION`.
Block reads default `owner` to the player's `trac1…` address; any agent can request the same
view with that Trac address. No private game-state joins enrich these responses.

Public `pages.*.route` values are gateway paths. Prefix a route with
`/api/gateway` to follow it through the authenticated console server, preserving
its query and cursor; common routes also work with `/api`. `/api/list` forwards
nested public sources to the gateway. Limits and cursor validation happen there.
Content-addressed protocol artifacts retain their exact verification bytes;
use their public `/list` routes for paged array inspection.

`/api/player` combines the public agent profile with **your agent's local data**:
its own sealed proposal details, local action journal, wallet balances and
addresses, and pending payment signing information. These exceptions are marked
by `localData:{label:"your agent's local data",fields:{…}}`. The corresponding
local routes are `/api/player/discoveries`, `/api/player/history`,
`/api/player/pendingPayments`, `/api/player/items` and `/api/payment-plan/ID`.
Other agents' sealed proposals are never exposed: public profiles show only
`{exists:true,state:"sealed",opensAt:N}` until reveal.

Lab diagnostics remain local: `/api/lab/status`, `/api/lab/feed`,
`/api/lab/feed/SEQUENCE`, `/api/lab/events` (SSE), jobs, bot scheduling and
`/api/status/components`. Public status does not include private process or bot
configuration. Lab controls below retain their existing POST paths.

## Authentication and requests

Run `node playground/run.mjs up` to create/restore the game and print its local
login link, or `node playground/run.mjs link` to print it again. Open
`http://127.0.0.1:59000/?t=…`: the server validates the private token, sets an
opaque `dmw_session` cookie (`HttpOnly; SameSite=Strict; Path=/api`), and returns
HTTP 303 to `/` with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
No page is served at the token URL, and no token is put in page storage. The
cookie authenticates API requests and SSE. It is a browser-session cookie and
is renewed by opening the link after a server restart. The login link is reusable
until the game is wiped; the displayed token must remain private.

CLI clients may use `Authorization: Bearer TOKEN`, reading the 0600 file
`playground/.data/control.token` automatically. Players never need to paste it.
Only the exact console origin is accepted for CORS; requests without an Origin
are allowed for the CLI. Cross-site browser API requests are refused. Send JSON
with `Content-Type: application/json`. Errors are `{ "error": "reason" }` with an
HTTP error status; upstream mint reads preserve 404 for unknown requests and
return the current payment or permit state for known requests.

Mutating endpoints return HTTP 202 with a job: `{ "id":"UUID", "state":"queued",
"type":"mine", "created":1792830000000 }`. Poll `GET /api/jobs/UUID` or watch
SSE. A completed job has `state:"complete", result:…`; a failed job has
`state:"failed", error:"…"`. Jobs execute serially. Local payment jobs include each required transaction in a block, even when auto-mining is paused. A failed operation is
never automatically retried. Optional `actionId` (1–64 letters/digits/._-)
is accepted on player actions for the kit's persisted replay protection.

## Reads

### Paging contract and array inventory

Every collection accepts `limit` (default **50**, maximum **200**, minimum 1),
an opaque `cursor`, `sort` and `order=asc|desc`. Invalid limits, sort keys,
filters or cursors return HTTP 400. A page keeps its named array and adds
`{total,next,limit,sort,order,route}`. `total` counts all matching records before
paging; `next` is null at the end. Send `next` as the next request's `cursor`,
keeping the route, filters, sort and order unchanged. Limits may change between
pages. Public cursors expire on gateway restart; local cursors expire on console server restart. Ordering uses a stable tie breaker;
numeric amounts sort numerically without losing integer precision. Reads are
live, not snapshots: totals can change, and changed/deleted rows may move between
pages. Refresh from the first page after mutations or a reorg.

Summary reads keep the existing array names, each with at most `limit` entries,
and add `counts:{collection:total}` and
`pages:{collection:{total,next,limit,sort,order,route}}`. Follow the named `route`
for that collection. Summary requests accept `limit`; collection-specific sorts
and filters belong on the collection route. `/api/patterns` is also the patterns
page, with top-level paging metadata; its compounds preview has its own route.
`/api/results?kind=mints` is an alias for `/api/results/mints` (likewise for every
result kind below); omit `kind` for the summary.

| Paged route | Array | Default sort/order | Other allowed sort keys | Filters (exact unless stated) |
| --- | --- | --- | --- | --- |
| `/api/player/balances` | balances | asset/asc | amount | asset, nonzero=true\|false |
| `/api/player/mintRights` | mintRights | block/desc | asset, amount, reason, finderUntil | asset, allowed, minted, pending (booleans), whoMayMint, block |
| `/api/player/history` | history | sequence/desc | id, type, state | type, state |
| `/api/player/pendingPayments` | pendingPayments | id/asc | type, asset, block, height, state, price | type, asset, state, kind |
| `/api/player/bitmaps` | bitmaps | height/asc | inscription, linked | linked, height |
| `/api/player/discoveries` | discoveries | actionId/asc | name, state, revealFrom, revealUntil, asset | state, asset, q |
| `/api/player/items` | items (empty; matter is fungible) | id/asc | asset | asset |
| `/api/results/mints` | mints | id/asc | asset, block, amount, kind, state, price | asset, kind, state, owner, block |
| `/api/results/payments` | payments | id/asc | block, action, total | action |
| `/api/results/ethereum` | ethereum | id/asc | amount, status, payer | status, payer |
| `/api/results/payouts` | payouts | id/asc | beneficiary, accrued, paid, owed | beneficiary |
| `/api/results/owed` | owed | id/asc | role, amount, to | role, to |
| `/api/results/paid` | paid | id/asc | amount, to | to |
| `/api/results/links` | links | block/desc | id, linkHeight, owner | owner, block |
| `/api/patterns` | patterns | number/asc | name, tier, rarity, supply, minted, madeReal, discoverer | asset, tier, discoverer, q |
| `/api/compounds` | compounds | id/asc | name, tier, recipe, supply, madeReal, firstMaker | asset, tier, recipe, firstMaker, q |
| `/api/world` | plots | height/desc | region, halving | from, to (inclusive range), found, linked, minted |
| `/api/blocks/HEIGHT/finds` | finds | asset/asc | block, pattern, count, finder, findHeight | asset, owner, minted |
| `/api/blocks/HEIGHT/claims` | claims | agent/asc | window, reason | agent, header |
| `/api/blocks/HEIGHT/draws` | draws | window/desc | settledAt | window |
| `/api/blocks/HEIGHT/matches` | matches | number/asc | asset, count | asset, positive=true\|false |
| `/api/blocks/HEIGHT/slotList` | slotList | number/asc | asset, count, pattern | asset |
| `/api/blocks/HEIGHT/mintRights` | mintRights | block/desc | asset, amount, reason, finderUntil | same as player mintRights |
| `/api/finds` | finds | block/desc | asset, pattern, count, finder, findHeight | owner, asset, block, minted |
| `/api/receipts` | receipts | id/desc | height | height |
| `/api/jobs` | jobs | created/desc | id, type, state, finished | type, state |
| `/api/bots` | agents | name/asc | address, strategy | strategy, state=error\|ready |
| `/api/feed` | events | sequence/desc | at, type | type, actor, category=chain\|money, since (exclusive sequence) |
| `/api/status/components` | components | name/asc | state, pid | state |

Boolean filters accept only `true` or `false`. `q` is a case-insensitive name/ID
search. `whoMayMint` accepts `me` (currently allowed), `finder`, `landowner`,
`public`, `minted`, `pending`, `insufficient_balance`, or `none`; it matches the
reported mint-right reason, with `none` selecting rights not currently allowed.
World defaults to the whole currently indexed height range; use `from` and `to`
to constrain it. The range is not a page size: even a 512-block range returns at
most 200 plots per request. Each plot's finds preview names its block finds route.
`/api/blocks/HEIGHT` previews all six block collections above with counts/pages.
History includes `sequence` (journal row order) and `type` (action ID prefix).
Receipt rows include `id` and `height` in addition to `seal` and `archive`.

The array inventory also includes `status.components`; nested claim `patterns`;
draw `claims`, `winners` and other audit vectors; compound `inputs`;
payment split `consumed.al`; job `result` arrays; event `data` arrays (including
block `windows`/`found`); payment-plan `transactions`; and arbitrary
public gateway JSON arrays. These receive bounded previews and sibling `pages`
metadata too. Fixed two-scalar tuples such as `[asset,amount]` are atomic values.
The TAP payment plan's `redeem` document is also an atomic wallet instruction:
its exact fee-item vector remains intact for signing;
each contained array is checked against the 200-entry ceiling.
For arrays without a dedicated route, metadata names
`/api/list?source=ENCODED_API_PATH_AND_QUERY&path=ENCODED_JSON_POINTER`.
This authenticated read-only endpoint returns `{items,total,next,limit,sort,order,route}`;
it accepts the common paging arguments, `sort=index` (default, ascending) or a
direct scalar field present on its rows, and optional case-insensitive `q`.
Always use the supplied route, since nested paths identify rows in the source
read. A changed source may invalidate a nested path; refresh its parent first.
When source JSON already has a `pages` or `counts` field, its added metadata uses
`pagination` or `listCounts`, respectively, preserving the original fields.
The gateway proxy therefore never returns an unbounded array, even for static
index/world JSON. Single-job reads and completed POST job responses also bound
their embedded arrays and name the job read as their source.

`/api/feed` pages the durable public event index. Use `since=SEQUENCE&order=asc`
for events after a cursor. `/api/events` SSE reads these same public pages in
batches of at most 200 after `Last-Event-ID`; no private jobs or bot journals
enter that stream. A connection without that header receives new events only.
The Lab feed separately retains 2,000 local diagnostic events.

| Method/path | Response |
| --- | --- |
| `GET /api/lab/status` | `{version:1,state:"ready",network,tip:2100,counted:2100,batch:{n,to},mining:{enabled,intervalMs},bots:{count,intervalMs,paused},feePolicy:{baseFee,feeSettings:{link,tierMultipliers,compoundMinimum},unit,revision},components:[{name,state,pid?,url?}],history:{kind:"regtest",seedBlocks:2048},player:{address},consoleOrigin}` |
| `GET /api/status` | Public network, tip, counted height, batch, fee policy, settings, units and public-index progress; identical to gateway `/status`. |
| `GET /api/player` | `{address,discoveries:[],balances:[{asset,amount}],items:[],bitmaps:[{height,inscription,linked}],pendingPayments:[],mintRights:[],history:[],wallets:{bitcoin:{address,btc,tap},ethereum:{address,rpc,chainId:31337,token,balance}}}`. Matter is fungible; `items` is empty. |
| `GET /api/world?from=0&to=255` | `{tip,counted,from,to,plots:[{height,x,y,region,halving,hash,found,linked,minted,finds:[]}],total,next,…}`. Inclusive range, paged. |
| `GET /api/blocks/HEIGHT` | `{height,x,y,region,halving,header,found,minted,claimWindow,claims:[],draws:[],matches:[],finds:[],link,mintRights:[]}` |
| `GET /api/patterns` | `{patterns:[{number,name,pat,fld,dt,rarity,tier,discoverer,asset,supply,minted,madeReal,…}],compounds:[{id,name,tier,firstMaker,token,supply,madeReal,…}]}`. `minted` counts completed block mints; `madeReal` sums their amounts. Supply is remaining matter in Trac, including reservations and locks. |
| `GET /api/finds?owner=ADDRESS&limit=50` | `{finds:[],total,next,…}`; owner optional. |
| `GET /api/receipts?limit=50` | `{receipts:[],total,next,…}` |
| `GET /api/results` | `{mints:[],payments:[],ethereum:[],payouts:[],treasury:{…},burn:{…},outstandingSupply:{ethereum:ATOMIC_STRING},links:[]}`. Includes indexed results and transaction/inscription IDs. |
| `GET /api/bots` | `{count,intervalMs,paused,agents:[{address,strategy,…}]}` |
| `GET /api/payment-plan/ID` | Public wallet payment instructions: payer, quote, player-paid Bitcoin fees, TAP redeem items or Ethereum approval/deposit transactions. See WALLETS.md. |
| `GET /api/jobs/ID` | Job with state `queued`, `running`, `complete` or `failed`. |
| `GET /api/jobs` | `{jobs:[],total,next,…}`; latest 1,000 retained jobs. |
| `GET /api/feed` | `{events:[],total,next,…}`; public history, newest first. |
| `GET /api/feed/SEQUENCE` | One public indexed event; 404 if unknown. |
| `GET /api/events` | SSE, authenticated by session cookie or bearer header; native EventSource supports the cookie. |
| `GET /api/gateway/PATH` | Read-only proxy preserving all gateway query parameters, e.g. `/api/gateway/latest.json`, `/api/gateway/patterns`, `/api/gateway/world`, `/api/gateway/mint/ID`. |

## Lab controls

| POST path | JSON body | Completed job result |
| --- | --- | --- |
| `/api/mine` | `{count:1}` (1–10000) | `{before,tip,counted,mined}` |
| `/api/mining` | `{enabled:true,intervalMs:10000}` (1000–3600000) | Current mining settings; `enabled:false` pauses. |
| `/api/time-travel` | `{blocks:1008}` (1–10000) | `{before,tip,counted,mined}`. Advances real regtest blocks and drains gateway batches, including finder deadlines and regions. |
| `/api/reorg` | `{depth:1}` (1–7) | `{depth,before,tip,oldHash,newHash,replacementBlocks}` |
| `/api/fee` | `{baseFee:"22.6"}` (decimal TAP) | Updated fee policy with atomic `baseFee` and `unit` metadata. Outstanding signed quotes retain their original base price. |
| `/api/bots` | `{count:12,intervalMs:15000,paused:false,resetErrors:false}` (count 0–100, interval 1000–3600000; fields optional) | Current bot settings. |

| `/api/bots/step` | `{}` | One bot tick even while bots are paused: claims for all, then at most one economic action. |
| `/api/wallets/fund` | `{bitcoin:"bcrt1…",ethereum:"0x…"}`; either optional | Funds external test accounts once per address pair. |

## Player actions

All player signatures are made by the local kit identity. No private key or
password is returned. Transactions use the real local TNK-funded Trac account.
All paths below use POST and return jobs.

| Path | JSON body | Result |
| --- | --- | --- |
| `/api/player/header` | `{}` | Kit header receipt for the current tip. |
| `/api/player/claim` | `{plots:[{block:HEIGHT,patterns:[0,1]}]}`; omit plots to choose unfound matches across history | Kit claim receipt; a receipt is not a settled win. |
| `/api/player/discovery/commit` | `{actionId:"my-pattern",proposal:{name:"dmwexample",pat:"12",fld:4,dt:"n"}}` | `{phase:"commit",actionId,commitment,revealFrom,revealUntil,…}` |
| `/api/player/discovery/reveal` | `{actionId:"my-pattern"}` | Reveal receipt. Mine at least two blocks after commitment first. |
| `/api/player/craft` | `{recipe:"fusion",inputs:[["p0","1"],["p1","1"]]}` | Kit receipt and computed compound. |
| `/api/player/transfer` | `{to:AGENT_KEY,assets:[["p0","1"]]}` | Accepted TNK transaction. |
| `/api/player/mint/quote` | `{asset:"p0",block:HEIGHT,amount?:"1",kind:"tap"}` | Gateway price, units used, unit metadata and fee split per destination; kind also `ethereum`. |
| `/api/player/mint` | `{asset:"p0",block:HEIGHT,amount:"4",kind:"tap"}` | Returns player-funded deployment content if needed, then a pending mint request. Defaults to the player's funded payer and Bitcoin receiver. Optional `payer`/`receiver` support external wallets; use `/api/player/payment` for their payments. |
| `/api/player/compound/mint` | `{asset:COMPOUND_ID,amount:"1",kind:"tap"}` | Returns player-funded deployment content if needed, then requests a mint without a block. |
| `/api/player/pay` | `{id:REQUEST_ID,type:"mint"}` | Waits for the matter reservation, pays fee items, waits for the permit and inscribes from the local test wallet; type also `link`. Returns payment/inscription IDs and terminal request. |
| `/api/player/payment` | `{id:REQUEST_ID,paymentId:PAYMENT_ID}` or `{id:REQUEST_ID,inscription:INSCRIPTION_ID}` | Reports the external payment or final mint inscription. The payer releases Ethereum payment if needed; the receiver inscribes the permit. |
| `/api/player/bitmap` | `{height:HEIGHT}` | Inscribes an actual regtest Bitmap to the player's Bitcoin address; height must be at least 1. |
| `/api/player/link` | `{height:HEIGHT}` | Signed link request for a Bitmap the player actually holds. Pay it separately. |

To display mint choices, use `player.mintRights` or `blocks/HEIGHT.mintRights`.
Each entry includes `asset,block,amount,allowed,reason,finderUntil,minted,pending`.
The fee quote is available before either request or payment. `ethereum` means
payment in the local bridged TAP ERC-20 through DmwEscrow; test ETH pays gas.

## Events

Both streams send `id: SEQUENCE`, `event: update` and one JSON `data` line. This example is a **Lab** diagnostic event:

```json
{"sequence":1,"at":1792830000000,"type":"job","data":{"id":"UUID","state":"complete","type":"mine","result":{"tip":2101,"counted":2101,"mined":1}}}
```

Event types include `job`, `block`, `bot`, `player`, `payment`, `component`,
`draw`, `discovery` and `receipts`. Block publications include `windows` round numbers and
`found` historical block numbers; reorg events include `reorg:true,depth`. Bot action
events include `{actor,name,strategy,action,result}`; scheduling/errors can
instead carry `address,tip,state,error`. This local diagnostic stream is `/api/lab/events`; supply `Last-Event-ID` to replay up to 200 retained diagnostic events. Public `/api/events` instead emits claims, finds, discoveries, crafts, mint requests/completions, links and accepted transfers from the gateway index. The server sends
heartbeat comments. Fetch status and world reads after a block/job event;
chain results, receipts and batch state remain authoritative.

## Example

```sh
TOKEN="$(cat playground/.data/control.token)"
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:59000/api/status
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"count":10}' http://127.0.0.1:59000/api/mine
```

`node playground/tour.mjs` uses this same API and exercises the mechanics.
`node playground/run.mjs down` preserves the game. `wipe` removes only this
playground's owned private data. Anvil runs in memory; Ethereum is restored by
replaying a local block/transaction journal, never by a persisted Anvil snapshot.

## State details

`player.discoveries` restores
commitment/reveal state from the kit journal, including the proposal and reveal
window. Accepted patterns carry their asset ID. `pendingPayments` contains
unpaid and in-flight requests, with mint asset/block/amount, type, price,
expiry/refund heights and gateway state; completed outcomes are in `/results`.

Block `claims` are reconstructed from signed archived receipts after the active
round has closed. They include `agent`, `patterns`, `header` and `receipt`.
`slotList` gives the block’s matching pattern slots. There is no global find cap.
Claims name a `window` and historical `(block, pattern)` slots. The current budget
comes from `settings.claimsPerWindow` (default 100, maximum 1000).
Plots use the game's 210,000-block halving-region rule, independent of Bitcoin
regtest's 150-block coinbase subsidy schedule.

Jobs retain the latest 1,000 records and Lab diagnostics retain 2,000 events. Public events are indexed durably from accepted publications and transactions. Large time
jumps take several minutes because every intermediate observation is replayed
and signed. Leave the job running and poll its ID. There is no simulated clock
shortcut. `down` waits briefly for work, then stops only recorded processes;
a long interrupted job fails on restart rather than replaying.

`status.bitcoinTip` is Core's current height; `catchingUp` reports whether Trac
and accepted gateway batches have reached it. `worker` reports the gateway's
error while catching up. `lastWorkerError` retains its historical error even
after catch-up succeeds; it is not an assertion that a component is down.

Fee amounts and TAP balances use 18-decimal atomic strings on both payment rails.
Fee responses include `unit` metadata. `POST /api/fee` accepts a decimal TAP
string (for example `"22.6"`); matter quantities remain integer units.

`player.bitmaps` lists current holdings at the player's registered Bitmap address
(`wallets.bitcoin.bitmapAddress`), including both unlinked and permanently linked
Bitmaps. It pages the indexer's wallet history and verifies current ownership,
so transferred-away Bitmaps are excluded. `world.plots[].minted` and each find's
`minted` flag reflect completed on-chain mints. Compound `name` includes its
recipe, input quantities and element names; `recipe` and `inputs` stay available.
The table starts empty. Players and bots discover patterns through the kit
commit/reveal path after startup. The first minter pays for element and deployment inscriptions;
compound deployment belongs to its first maker. Evidence is ready in one block.

Bots and selected kit players bind their private local test wallets through the
same agent request, wallet proof and committee endorsement API as humans. An
existing human binding is preserved. Public current bindings and history are
available under `/api/payout-bindings/KEY/tap` or `/ethereum`, with `/history`
for the paged proof ledger. The kit's `bind_payout_wallet` returns the gateway's
bare signing page for intentional human replacements.

Use one Trac identity everywhere: the lowercase, checksum-valid `trac1…` address.
The kit `address` tool returns `address` (also the TNK account address). Transfer
recipients, profile routes and identity filters reject raw hex keys. Internal
signed packets and storage retain the protocol key encoding.
