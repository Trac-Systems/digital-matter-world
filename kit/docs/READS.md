# Public read reference

Use the tool names and CLI examples in [README.md](../README.md). This is the
kit’s own copy of the gateway read contract; no external documentation is needed.
MCP/CLI use `filters:{...}`; SDK options are flat. `events` explicitly selects
ascending order; bare `/events` and `read_page` retain the gateway’s descending
default. `block {height}` sends only the height in the path; add
`filters:{owner:ADDRESS}` when you want wallet-specific block rights.


The gateway is the common read boundary for agents and the playground. No login,
wallet or operator credential is required. These routes expose public chain,
receipt and accepted-batch data. They never expose wallet journals, discovery
salts, unrevealed proposals, signer enrollment packages or private endpoints.

## Paging

Collections accept `limit` (default 50, 1–200), opaque `cursor`, `sort`, and
`order=asc|desc`. Unknown/duplicate parameters, invalid filters and foreign
cursors return 400. Every page retains its named array and adds
`{total,next,limit,sort,order,route}`. Send `next` as `cursor` with the same route,
filters and ordering; `next:null` means the end. Page size may change. Ordering
has a stable identity tie breaker; integer amounts compare as integers. Cursors
expire on gateway restart. These are live reads: refresh after a mutation/reorg.

Summary routes accept `limit` and return bounded previews, plus
`counts:{collection:total}` and `pages:{collection:{total,next,limit,sort,order,route}}`.
Follow the supplied collection route. Nested arrays also have counts/pages;
two-scalar tuples are atomic. A nested array without a dedicated route uses
`/list?source=ENCODED_PUBLIC_PATH_AND_QUERY&path=ENCODED_JSON_POINTER` and returns
`{items,total,next,limit,sort,order,route}`. It accepts `sort=index` or a scalar
field, and optional case-insensitive `q`. Sources must be gateway read paths. `path` is a JSON pointer into the returned
source page: array indices start at zero within that page, after filtering,
sorting and cursor selection. Keep the exact source URL, including its limit,
filters, order and cursor. For example, the first filtered event uses
`/events/0/data/assets`, regardless of its sequence number. The selected nested
array is paged in full even if the source only previews it. A missing position
returns `list_path_missing`. Nested `/list` sources are bounded to two levels. Mint-rights sources (including the
`mintRights` field of a block/profile) are excluded from `/list`; use the
indexed `/mint-rights`, `/agents/ADDRESS/mintRights` or `/blocks/HEIGHT/mintRights`
route instead. Unsupported rights sources return `list_source_has_dedicated_route`.

Booleans accept only `true|false`. Block filters are nonnegative safe integers.
`q` searches names/IDs without case sensitivity. Exact filters are otherwise
strings. All money is an integer string with
`unit:{currency:"TAP",denomination:"atomic",decimals:18}`. Matter units have zero
decimals. Bitcoin network fees are separate satoshi amounts with `decimals:0`; e.g. `100000` displays as `100000 sat`. Page totals, limits and other metadata are counts, never money.

## Routes

| GET route | Array | Default sort/order | Other sorts | Filters |
| --- | --- | --- | --- | --- |
| `/world`, `/blocks` | plots | height/desc | region,halving | from,to (inclusive),found,linked,minted |
| `/patterns`, `/table` | patterns | number/asc | name,tier,rarity,supply,minted,madeReal,discoverer | asset,tier,discoverer,q |
| `/compounds` | compounds | id/asc | name,tier,recipe,supply,madeReal,firstMaker | asset,tier,recipe,firstMaker,q |
| `/patterns/ASSET/blocks` | rows | block/desc | count,finder,findHeight | from,to,found,minted,linked |
| `/finds` | finds | block/desc | asset,pattern,count,finder,findHeight | owner,asset,block,minted |
| `/receipts` | receipts | id/desc | height | height |
| `/records/batches` | batches | n/desc | from,to | none |
| `/mint-rights?owner=ADDRESS` | mintRights | block/desc | asset,amount,reason,finderUntil | asset,reason,block,allowed,minted,pending,whoMayMint |
| `/agents` | agents | finds/desc | address,discoveries,crafts,mints | address,q |
| `/agents/ADDRESS/balances` | balances | asset/asc | amount | asset,nonzero |
| `/agents/ADDRESS/bitmaps` | bitmaps | height/asc | inscription,linked | height,linked |
| `/agents/ADDRESS/finds` | finds | block/desc | asset,pattern,count,finder,findHeight | asset,block,minted |
| `/agents/ADDRESS/mintRights` | mintRights | block/desc | asset,amount,reason,finderUntil | same as mint-rights, excluding owner |
| `/agents/ADDRESS/discoveries` | discoveries | asset/asc | name,state,opensAt | asset,state,q |
| `/agents/ADDRESS/history` | history | sequence/desc | at,type | type,actor,category,since |
| `/events`, `/feed` | events | sequence/desc | at,type | type,actor,category,since |
| `/results/mints` | mints | id/asc | asset,block,amount,kind,state,price | asset,kind,state,owner,block |
| `/results/payments` | payments | id/asc | block,action,total | action |
| `/results/ethereum` | ethereum | id/asc | amount,status,payer | status,payer |
| `/results/payouts` | payouts | id/asc | beneficiary,accrued,paid,owed | beneficiary |
| `/results/owed` | owed | id/asc | role,amount,to | role,to |
| `/results/paid` | paid | id/asc | amount,to | to |
| `/results/links` | links | block/desc | id,linkHeight,owner | owner,block |

`GET /status` returns public network, tip/counting/batch progress, fee policy,
settings and unit metadata. `GET /agents/ADDRESS` returns a public profile with
bounded balances, finds, discoveries, history and mintRights. All Trac identities are checksum-validated lowercase `trac1…` addresses. Raw hex keys are rejected. A sealed discovery exposes only
`{state:"sealed",exists:true,opensAt:N}`; proposals appear only after public reveal.
Leaderboard scores count public finds, accepted discoveries/crafts and completed
mints; they are not wallet balances or a claim about unique people.

`GET /blocks/HEIGHT` returns header fields, spiral coordinates, found/minted state,
`claimWindow:{window,closesAt,drawAt,settlesAt,claimable,claimsPerWindow}`, `link`
and the collections below. Window H admits claims during H and H+1; H+2 closes
and decides it on arrival, without an extra confirmation depth.

| Suffix on `/blocks/HEIGHT` | Array | Default sort/order | Other sorts | Filters |
| --- | --- | --- | --- | --- |
| `/matches` | matches | number/asc | asset,count | asset,positive |
| `/slotList` | slotList | number/asc | asset,count,pattern | asset |
| `/claims` | claims | agent/asc | window,reason | agent,header |
| `/draws` | draws | window/desc | settledAt | window |
| `/finds` | finds | asset/asc | block,pattern,count,finder,findHeight | asset,owner,minted |
| `/mintRights` | mintRights | block/desc | asset,amount,reason,finderUntil | asset,reason,block,allowed,minted,pending,whoMayMint |

Block reads optionally accept `owner=ADDRESS`, including collection routes. Without
an owner, rights describe eligibility in general; `allowed` does not assert a
particular wallet balance. With an owner, rights also check that owner's units.
Rights enumerate every found matching slot,
and compounds for agent reads. Each row contains `asset,block,amount,allowed,
rightAllowed,deploymentRegistered,whoMayMint,reason,finderUntil,finder,link,currentHolder,minted,pending`.
`whoMayMint` is `finder`, `bitmap` (the current linked Bitmap holder), `public`
or `holder` (compound units). `reason` also reports `minted`, `pending`,
`insufficient_balance`, `holder_unavailable`, or `asset_unregistered`.
`deploymentRegistered` means the service has verified the player-inscribed Bitcoin deployment;
`allowed` requires this as well as the units/rights/hold checks. `rightAllowed`
reports the ownership right independently of registration. Registry or chain
state may change after a read; quote and admission still verify the deployment,
active authority, payment destinations and live evidence. `whoMayMint` filters additionally
accept `me` (`allowed:true` for the selected owner), `none` (`allowed:false`
for that owner, including missing units, pending/minted slots and unregistered
assets) and `landowner` (alias of `bitmap`). Role filters compare `whoMayMint`,
independently of `reason`; for example an unregistered public slot still matches
`whoMayMint=public`. `none` does not mean no one can ever mint that slot. Finder exclusivity lasts
1,008 counted blocks; subsequent Bitmap exclusivity requires a link predating
the find. An unfound slot cannot be minted.

Compound type catalogs omit the first craft's `amount`; it is neither current
supply nor wallet balance. `supply` is remaining fungible matter, `madeReal` is
units inscribed, and `minted` counts completed mints. Craft results retain `amount`.

`POST /mint/quote` creates a signed player's reservation and returns
`{requestId,receiver,asset,amount,fees:[{role,to,ticker,amount,tt}],payBy:{rail,untilBlock}}`.
The kit's `mint_on_chain` supplies its durable signed request. A bare
`mint_quote` read previews terms without payment or a reservation; it is not a
payable request. Fees are atomic TAP strings, `tt:"a"` is an address payment and
`role:"burn"` uses `tt:"a"` to the fixed unspendable burn address. Per-role `dta` values correlate
executed fee items with this request. Payout binding snapshots fix recipients;
a later wallet replacement must not redirect an existing quote.

`GET /mint/<requestId>` adds `state` and `missing`. States are
`awaiting_payment`, `partly_paid`, `paid`, `permit_issued`, `minted`, `expired`.
A missing item's amount can be smaller than its original fee after partial
payment or a credit. Pay only those missing amounts. `permit_issued` supplies
`mintContent`, the exact inscription JSON/text; it must be bound to the receiver
and request ID. A first quote can instead return `state:"deployment_needed"`, `payable:false`,
`requestId:null`, and `deployment` with its exact current phase content.
`GET /mint/deployment/ASSET` serves the plan for either a pattern or a compound.
A pattern has an element phase followed by `dmt-deploy`; an existing matching
indexed element skips the element phase. `POST /mint/deployment` takes
`{asset,phase,inscription}` once included in a block. No mint permit is issued
until its indexed element and deployment have been verified.

A missing beneficiary binding makes quoting fail with its role-specific
`*_address_missing` error (`first_maker_address_missing` for the first maker).
On Bitcoin mainnet the TAP burn share is sent to the unspendable
`1BitcoinEaterAddressDontSendf59kuE` as a `tt:"a"` item (test networks use the
same key hash in their own address encoding). Use the exact quoted
address and amount; it is still burned. Ethereum uses the escrow token's burn
function. Do not invent or substitute a burn recipient.

Public Bitcoin fee
estimates and the player-approved maximum determine local commit/reveal fees;
there is no service Bitcoin-fee invoice.

### Payout wallet bindings

`GET /payout-bindings/KEY/tap` and `/payout-bindings/KEY/ethereum` return
`{agent,rail,binding}`; `binding:null` means no accepted wallet. Append `/history`
for `{bindings,total,next,limit,sort,order,route}`. History uses the common paging
contract, defaults to `acceptedAt/desc`, and also sorts by `id`; it has no filters.
Each accepted binding contains `id,request,agentSignature,walletSignature,
acceptedAt,attestations`. These are public proofs, with no private wallet data.

`POST /payout-bindings/request` accepts `{request,agentSignature}`, where request
is exactly `{agent,rail,address,nonce,expiry}`. `nonce` is a positive decimal
integer string (at most 20 digits) that increases for that agent and rail;
`expiry` is a Unix time in milliseconds, at most 24 hours ahead. The canonical
UTF-8 signing message is `dmw-payout-binding-v1\n` followed by stable-key-sorted
JSON of `{network,bitcoinNetwork,agent,rail,address,nonce,expiry}`. Both wallets
sign that same message: the agent with Ed25519, the human with a TAP wallet or
Ethereum EIP-191 `personal_sign`. Ethereum addresses are lowercase.
TAP accepts BIP-322 simple key-path P2TR (SIGHASH_DEFAULT or SIGHASH_ALL, optional
`smp` prefix) and TAP Wallet's legacy Bitcoin Signed Message compact signature.
Legacy proofs must be canonical base64, exactly 65 bytes with header 27–34 and
low-S ECDSA. The recovered account key's x-only BIP86 Taproot address must exactly
match the request on the configured mainnet/regtest network. Other Bitcoin
address types are refused; legacy messages are limited to 4,096 UTF-8 bytes.
Both formats retain the original wallet signature in the committee certificate.

The response supplies `id,message,bindPath,state` and the public agent request.
`GET /payout-bindings/requests/ID` reads the same public request. The local
`/bind-payout/ID` page lets the human review and sign with TAP wallet or MetaMask;
the page submits the signature itself. The link contains only a public request ID.
`POST /payout-bindings/complete` takes `{id,walletSignature}` and returns the
accepted binding after three independently verifying committee endorsements.
All five members are contacted. The request expiry limits submission, not the
lifetime of an accepted binding. Replacement needs another double-signed request
with a higher nonce. Exact retries retain their request ID and proofs.
`binding_transition` means a replacement is awaiting committee endorsement;
retry that request, or create a higher-nonce binding if it expired. Existing
quotes fixed before the transition keep their original binding IDs.

`GET /results` returns previews of all result collections plus `treasury`, `burn` totals and
`outstandingSupply:{ethereum:ATOMIC_STRING}`, the bridged ERC-20 `totalSupply()`.
Outstanding supply is independent of the burned amounts; all use TAP's 18 decimals. `kind=COLLECTION` aliases the corresponding collection route.
`mints.kind` identifies the payment rail: both TAP and Ethereum payments produce
Bitcoin inscriptions. Ethereum results include escrow state/transaction evidence.
Mint fee shares are paid directly by the player. Indexed item evidence must
show each beneficiary’s payment; a permit or broadcast response alone is not
proof of the final inscription. `GET /mint/ID` retains its public
progress response. Link `owner` filters refer to the currently indexed Bitmap
holder, not the original link payer. Ethereum rows include public deposit/release
transaction IDs. Burn totals count verified paid TAP burn items and released Ethereum
escrows, excluding refunded payments.

Events have `{sequence,id,at,type,data,provenance}`. Use `since=SEQUENCE&order=asc`
to read forward from a durable sequence; `cursor` continues a bounded traversal.
Types include `claim`, `find`, `header_find`, `discovery`, `craft`, `mint_request`,
`mint_complete`, `link`, `transfer`, and `block`.
Categories are `chain|money`; `actor` selects a public agent key. `GET
/events/SEQUENCE` (also `/feed/SEQUENCE`) reads one event. Events cite the public
receipt, accepted batch/audit, or indexed transaction that produced them. No
local bot/job/wallet activity is mixed into the public feed. Transfer `at` uses
the counted Bitcoin block time when the public transaction is indexed;
`provenance.timeSource:"indexed_counted_block"` and `height` identify that clock,
not an invented Trac transaction timestamp. Discovery events distinguish
`revealed`, `accepted` and `rejected`; rejections include the public commitment.

## Proof publications

`/latest.json` identifies the latest observation's immutable audit, summary and
receipt seal. Immutable files retain their exact bytes for hash/signature
verification (1 MB summary JSON, 1.5 MB binary audit). Use `/list` with an immutable file as
its source to page arrays inside it with the same 50-row default and 200-row cap.

Public collections have one cursor contract. Read `/patterns`,
`/patterns/ASSET/blocks`, `/agents/ADDRESS/balances` and `/world` for live views.
Numbered collection files, their index pointers and `/world.json` are not public
routes; requests return 404 even if those files exist on disk. `next` is always
an opaque cursor or null, never a filename. Internal pattern snapshots and
retention pointers are not a second collection API.

Claims, draws and events are indexed in the background. `/status.publicIndex`
reports `processedObservation`, `latestObservation` and `observationLag` as
publication ordinals, plus `indexedHeight`/`indexedTip` (counted/raw heights of
the processed publication) and `latestHeight`/`latestTip` (published targets).
Heights are null before the corresponding publication exists. Accepted-batch
provenance progress is separate: `processedBatch`, `latestBatch`, `batchLag`
and `indexedBatchHeight`. `eventSequence` is the last emitted event sequence.
`caughtUp:true` means both publication and batch ordinals reached their targets;
it does not assert that Bitcoin, Trac or payment indexers have caught up.
Top-level `catchingUp`, `tip`, `counted`, `bitcoinTip` and `batch` describe those
chain/batch clocks separately.

Public views are reproducible indexes, not an additional consensus authority.
`GET /records/batches/N` returns the accepted batch and a paged publications
manifest. Events cite that manifest, batch root and leaf index when indexed.
Retrieve the manifest's immutable audit files to reconstruct its Merkle root;
compare that root with Trac's accepted batch N. Manifest arrays use `/list`.
Verify immutable audit hashes, receipt signatures/witnesses and Trac batch roots
for consensus claims. Live ownership, balance, hold and payment reads come from
the same indexers used for mint admission; unavailable evidence fails closed.

## Interpreting fields

- `publicIndex` distinguishes publication/batch ordinals from Bitcoin heights;
  use its `caughtUp` and lag fields as described above.
- Block `claimWindow` and local `hunting` use deciding height H+2;
  check actual settlement evidence.
- `results.outstandingSupply.ethereum` is the bridged token's outstanding
  supply. `results.burn` contains only independently counted burn totals.
- Compound type catalogs omit first-craft `amount`. Read `supply`, `madeReal`
  and `minted` for current totals; wallet amounts come from balances.
- Pattern `rarity`, `total`, `tier`, `fingerprint` and `historyHeight` describe the
  accepted discovery snapshot. The number of headers is `historyHeight+1`, since
  genesis is included. Growing history does not reassign that recorded tier.
- Rights rows also carry `found,void,time,find` for candidate selection.
  `time` is Unix seconds. `find` includes `asset,block,count,finder,findHeight`
  with a required finder and find height. An
  `allowed:true` row requires `deploymentRegistered:true` as well as indexed
  units/rights/holds. Quote and admission recheck current evidence.

Use [ACTIONS.md](ACTIONS.md) for action formats, states, proof publications and
error meanings.

Draw winners and finds expose `source:"claim"|"header"`. `tickets` counts
distinct eligible keys in that source’s draw. `header_find` events identify
whole units awarded for a correct header where nobody made an eligible claim.
They belong to category `chain`, include finder/block/asset/count and cite the
settlement audit just like claim finds. There is no global find cap. Header wins have the normal finder mint right.
Large rounds may credit across batches; per-file settlements show `credited/total`,
`complete` and the newly credited `winners` segment. Each credited find receives
its full finder window. A changed window or deciding hash can void a round
before its credits begin. A new pattern may be claimed in all historical blocks
where it matches; minting always requires a find.

Compound modeled matches use `ceil(rarity * (countedHeight + 1))` when the craft
is evaluated; a suggestion uses the counted height it just read. Stored type
properties reflect the first accepted craft (`created + 1` headers), not the
latest tip. The pattern input fractions use their own recorded discovery
`historyHeight + 1` snapshots.

Trac identity fields (including owner, finder, agent, firstMaker and discoverer),
route parameters, filters and cursor anchors use the same `trac1…` address.
Agent search matches address prefixes. Protocol archives retain their signed wire
encoding; public projections encode identities without changing transaction IDs,
block hashes, Bitcoin addresses, Ethereum addresses or exact amounts.

The live `feePolicy` includes `baseFee`, `revision`, `unit` and
`feeSettings:{link,tierMultipliers,compoundMinimum}`. Multipliers are counts,
not atomic TAP. Launch settings are link 3, tiers 1/3/10/30/100 and compound
minimum 10. Signed quotes bind their own revision and multipliers; a live
change does not reprice existing requests.
