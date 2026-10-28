# Public reads

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
| `/world`, `/blocks` | plots | height/desc | region,halving | from,to (inclusive),claimable,found,linked,minted |
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
settings and unit metadata. The gateway primes status before listening and
refreshes it on the existing poll. Catalogs (`/patterns`, `/table`, `/compounds`)
and record highlights are also poll snapshots; requests do not query the Bitcoin
source or rescan mint history. Values reflect the last completed refresh, and a
failed refresh reports its error until recovery. Catalog sorts and exact filters
use precomputed indexes; text searches scan only the cached catalog.
World and record-list indexes update on the poll. During initial backfill or an
index update they return 503 (`public_index_pending`) instead of making the
request rebuild history; retry after the advertised interval. Successful response
fields, pagination and cursors are unchanged.

`GET /world/map` is the canvas projection of the committed world index. It
accepts only optional inclusive `from` and `to`, with at most 40,001 plots.
Defaults cover the newest 40,001 indexed plots (or the whole shorter history).
It returns `{tip,counted,from,to,marks}` in one response. Plain plots are implicit;
their region is `floor(height/2016)` and halving is `floor(height/210000)`.
Each sparse mark contains `height,found,linked,minted`, the first two finds
(`asset,minted`) in the normal block-find order, `findCount` (the same up-to-200
preview count as the map's old full-plot read), and `findMinted` for that preview.
Claims still come from the feed. The response contains no headers or ownership
RPC results and performs no upstream reads. It is bounded by range instead of
cursor pagination; full plot/block details keep their existing paged routes.
Unknown/duplicate parameters and oversized ranges return 400; an unavailable
or lagging index returns 503.

`GET /agents/ADDRESS` returns a public profile with
bounded balances, finds, discoveries, history and mintRights. All Trac identities are checksum-validated lowercase `trac1…` addresses. Raw hex keys are rejected. A sealed discovery exposes only
`{state:"sealed",exists:true,opensAt:N}`; proposals appear only after public reveal.
Leaderboard scores count public finds, accepted discoveries/crafts and completed
mints; they are not wallet balances or a claim about unique people.

`GET /blocks/HEIGHT` returns header fields, spiral coordinates, `claimable`, `found`, `link`, `minted`, and these bounded collections. `claimWindow:{window,closesAt,drawAt,settlesAt,claimable,claimsPerWindow}` describes the current window H. It closes at H+2 and the H+2 hash decides immediately on arrival. The claim budget defaults to the rules constant (100), with a configurable ceiling of 1000.

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
Rights enumerate every settled matching slot, including slots without a finder,
and compounds for agent reads. Each row contains `asset,block,amount,allowed,
rightAllowed,deploymentRegistered,whoMayMint,reason,finderUntil,finder,link,currentHolder,minted,pending`.
`whoMayMint` is `finder`, `bitmap` (the current linked Bitmap holder), `public`
or `holder` (compound units). `reason` also reports `minted`, `pending`,
`insufficient_balance`, `holder_unavailable`, or `asset_unregistered`.
`deploymentRegistered` means the operator has registered the Bitcoin deployment;
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
the find. An unawarded settled slot follows the same shared rules.

Compound type catalogs omit the first craft's `amount`; it is neither current
supply nor wallet balance. `supply` is remaining fungible matter, `madeReal` is
units inscribed, and `minted` counts completed mints. Craft results retain `amount`.

`POST /mint/quote` accepts the signed request envelope with receiver, payer, rail,
request signature and payer authorization. It reserves the units and returns
`requestId`, `receiver`, `asset`, `amount`, `fees`, `missing`, `payBy`,
`reservation` and `payable`. Wait for reservation acceptance before paying.
Each fee states its role, recipient, ticker, atomic amount, transfer type and
request-bound `dta`. TAP burn is an address item to
`1BitcoinEaterAddressDontSendf59kuE`; Ethereum burns through escrow. All other
shares go directly to the beneficiary. Items payable to the payer are omitted;
`fullFees` and `split` preserve the full shares and `payableAmount` shows the discount.

A bare `{asset,block?,amount?,kind:"tap"|"ethereum"}` call remains a nonpayable
preview with `requestId:null` and a signed `feeQuote`. For a block, units equal
its match count; for a compound, supply `amount` (default one). Admission
recomputes and verifies the terms. Addresses come from the agent's double-signed
payout binding for that rail. A signed fee quote includes `payouts`, the exact
public binding IDs used when terms were fixed. An unbound required beneficiary
fails with a lowercase `*_address_missing` error. The signed quote also binds
Bitmap ownership and link state. A change before reservation requires a fresh
quote; after acceptance, readers recover the original holder from the accepted
audit, so a later sale cannot redirect a partly paid quote.

`POST /mint/payment` supplies `requestId`/`id` and `paymentId`/`paymentIds` as
lookup hints. The readers verify payment independently. `GET /mint/REQUEST_ID`
returns `awaiting_payment`, `partly_paid`, `paid`, `permit_issued`, `minted` or
`expired`, plus missing items. Seen payment holds the units. Late payment either
re-reserves available units or becomes matching same-owner/payer/rail credit.
After final payment, the accepted Trac operation consumes units once and the
committee signs a permanent receiver-bound permit. `permit`, `mintContent` and
`inscriptionText` remain retrievable. Submitting `inscription` to the payment
route adds an indexer lookup hint; it never triggers a second unit debit.

The checkout route also supplies Ethereum deposit calldata and later
`ethereumRelease`. The payer or a recipient sends the release and pays gas;
release must finalize before permit issuance. A Bitcoin wallet is still required
for the player's mint inscription. `GET /mint/deployment/ASSET` supplies first
compound deploy text, and `POST /mint/deployment` verifies the indexed inscription.

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
Payout totals distinguish accrued, paid and owed; payout transaction evidence is
operator-recorded and independently checkable. `GET /mint/ID` retains its public
progress response. Link `owner` filters refer to the currently indexed Bitmap
holder, not the original link payer. Ethereum rows include public deposit/release
transaction IDs. Burn totals count consumed TAP claims and released Ethereum
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
verification (60 KB JSON, 200 KB binary). Use `/list` with an immutable file as
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

Draw winners and finds expose `source:"claim"|"header"`. `tickets` counts
distinct eligible keys in that source’s draw. `header_find` events identify
whole units awarded for a correct header where nobody made an eligible claim.
They belong to category `chain`, include finder/block/asset/count and cite the
settlement audit just like claim finds. There is no per-block find cap. Header wins have the normal finder right. Large windows can credit across batches; each file records only its newly credited winners and continuation progress. Every segment is indexed immediately, with rights starting at its credit height. A changed window or deciding hash before settlement voids that draw. A new pattern can be claimed across all matching counted history, and minting requires a recorded finder.

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
