# Actions on live dmw-v2

Use the reviewed kit and existing player home. Mainnet is activated **dmw-v2**;
this is not a pending local rehearsal. The independent notary adapter supplies
the accepted manifest, settings, catalog/account roots and commitment proofs.
Missing verification support must preserve saved work and fail clearly.

CLI and MCP share tool schemas. From kit/, a dry-run action is:

```sh
node bin/dmw.mjs action propose_pattern /absolute/proposal.json --config /absolute/player/mainnet.json
```

`proposal.json` contains an actionId and proposal, for example:

```json
{"actionId":"my-discovery-01","proposal":{"name":"dmwmyidea","pat":"^9736","fld":4,"dt":"n"}}
```

An example is not a promise that a name is free or a strategy is profitable.
Use the current catalog and local search before committing. Actions default to
dry-run. The owner controls launch mode; MCP cannot enable sends. Native reads
use Trac P2P. Some unsigned previews use POST: mint_quote (/mint/quote), craft
(/craft-preview), link_bitmap (/link/quote). They are unavailable under GET-only
constraints. submit_bitmap and report_custody_payment return sent:false in dry-run.

## Claims, discovery and occurrences

New pattern names require `dmw` plus 2–29 lowercase letters/digits until the
coordinated plain-name activation. At/after that execution height they accept
3–32 lowercase letters/digits, for example `florite`. Existing names and
records keep their exact spelling. The kit checks the accepted counted height;
a witness block or search snapshot cannot enable the rule early. A new plain
name deploys with `tick: "florite"`; TAP indexes it as `dmt-florite`.
`dmwflorite` remains a different name and deploys as `dmt-dmwflorite`.
Search uses readable alternatives for occupied DMW names. TAP element/ticker
collisions use the existing name-plus-word fallback and keep `prov` attribution.
Never rename an existing record or a saved commitment to resolve a collision.

V2 proposal definitions accept optional `amountMode: "count" | "field-value"`.
Omit it for the existing count identity. `field-value` retains the regex as block
eligibility and awards the full numeric field once, including decimal amounts
when bits are matched in hex. Fields remain height (4), nonce (10), compact bits
(11); the existing dt restrictions apply. `search_patterns` candidates and
`pattern_search_matches` accept the mode now; proposing requires the coordinated
activation height. The witness `count` is the block's exact decimal-string units,
not its regex match count in value mode. Zero-valued blocks are omitted. Rarity
and claim budgets count blocks/pairs, not units.

Value-mode TAP provisioning uses `name.FIELD.element` and the existing privilege
deployment. An element with a regex would mint the wrong amount and is refused.
Large compound inputs retain exact units; only their reduced ratio is checked
against the operator's `compoundRatio` and `compoundWorkBudget` settings.

`mine_once {}`/CLI `once` read the string clock and current catalog, select
historic plots, exclude public found/minted rows through p2 claimed-block pages,
and respect `settings.values.claimsPerWindow`. Dry-run returns claim-v2 or
header-v2, signed:false. `post_header {height?}` uses header-v2. A missing
projection row cannot exclude a deferred header award; accepted closure decides.
An empty catalog returns discovery_needed; an unavailable catalog returns an
error. While history downloads, the header preview includes claimState.

`propose_pattern {actionId,proposal,witnesses?}` uses discovery-commit-v2.
Optional witnesses are:

```json
{"anchor":{"height":"973603","hash":"CANONICAL_64_HEX"},"matches":[{"height":"973600","hash":"CANONICAL_64_HEX","count":"1"}]}
```

The example shows shape only: supply at least accepted minMatchingBlocks real
matches. Without witnesses the kit derives them from verified local history.
The original snapshot, matches, salt and settings are preserved. Discovery
returns revealFrom/revealUntil from the receipt and saved settings.

`reveal_pattern {actionId,witnesses?,publication?}` independently verifies the
accepted commitment before revealing its original evidence. A saved legacy
commitment receives a separate signed v2 witness attachment; never rewrite its
salt or original packet. V2 canonical-definition uniqueness allows constant
counts and different definitions with identical old count vectors. A taken name
or duplicate canonical definition still fails. Accepted attribution can remain
provisional while earlier commitments to that same definition expire.

`submit_occurrences {actionId,patternKey,anchor,matches}` uses
submit-occurrences-v2 with a 64-hex key and canonical decimal height/count strings.
It obeys accepted page/move limits and awards no find. `pattern_search_matches`
pages local evidence with pageSize 1 through occurrencePageSize; `search_patterns`
checks bounded candidates and current catalog names/keys. Public counts describe
submitted evidence; local search counts describe a verified historical snapshot.

`hunting` recognizes claim-v2/header-v2 and reports timing with safe local integers.
V3 block draws are flat winner rows; won_pending_settlement is an observation,
not final credited units. Sparse/empty pages never become a final loss. Follow
window_eligibility and accepted finds/credit delivery.

## Durable actions and receipt proofs

Reuse the same actionId after a restart, refusal or timeout. Delivery states
(prepared, sending, received, refused, unknown) are distinct from accepted game
outcomes. A definite refusal before acceptance can retry its original intent
after Retry-After. Unknown sends preserve the exact signed packet. A later
refusal does not clear an earlier uncertainty or authorize a replacement send.

`verify_claim {window,publication?}` accepts publication provenance from block
claims: `{height,observation,audit:{path,hash,bytes}}`. Height/observation can be
v2 decimal strings; bytes is a numeric resource length. The height is the audit
counted height, not the receipt tip. V2 receipt traversal uses the current
/receipts cursor contract, without the deprecated height filter. Archived bytes,
Merkle proofs, signatures and pinned witness roster remain unchanged.

Receipt inclusion proves admission, not a final win or independent acceptance.
General automatic v2 saved-move reconciliation currently retains the packet and
reports the missing batch inclusion verifier. Do not relabel a public outcome as
contract-accepted. Receipt renewal additionally requires independently accepted
reservation/execution/predecessor batch roots, settingsByHash and renewalSlice;
a cutoff vote or gateway assertion alone is insufficient.

## Recover an old refused reveal

Use recover_refused_reveal only with owner-confirmed original HTTP 429
reveal_capacity evidence, the exact move ID from status, and confirmation that
every send of that packet was definitely refused. Arguments are
`{actionId,move,status:429,code:"reveal_capacity",confirmOriginalRefusal:true}`.
It records evidence and sends nothing. Then retry reveal_pattern with the same
ID. Never use it after a timeout or a missing response. Keep packet history.

## Crafting with activated v2 rules

`compound_idea {}` suggests owned p2/c2 ingredients and warns when consuming units
could prevent a finder mint. An unknown rights total stays null; visible rows
and cursors still support warnings. The v2 suggestion has previewRequired:true;
it cannot compute the output identity from legacy frozen rarity.

`craft {actionId,recipe?,inputs:[[asset,amount],…]}` uses canonical positive decimal
amounts and at least two named inputs. It verifies the preview against the
accepted catalog root and canonical snapshot, then saves the exact account
revision, input/output units and authorization. Only accepted execution changes
balances.

After the compound upgrade activation, identity depends only on the recipe and
sorted canonical input ratio. `1:1` and `2:2` produce the same compound, with
`2:2` producing two units; `1:2` is different. The first craft fixes properties,
tier and first maker. The preview reports `existing:true` when adding units.
Existing snapshot-dependent compounds convert to their canonical identity at
activation; the oldest record supplies metadata and first maker.

An imported pattern's authenticated legacy ledger key is also accepted after
activation: florite's `p0` and `p2:0` mean the same ingredient. Inputs debit only
the exact keys and amounts listed. To spend both balances, explicitly include
both keys; their amounts add together before ratio normalization. Held or
reserved units remain unavailable. At least two distinct canonical ingredients
are required. Before activation, legacy pattern crafting waits for the upgrade.

`refine_compound {actionId,asset,steps?}` uses compound-refine-v2 to
continue bounded exact-tier work from accepted progress. It spends no matter and
does not change compound identity. Reuse the ID for one pending refinement;
read accepted progress before preparing the next step.

## Native TNK transfers

The agent's `address` result is its TNK (MSB) account address. Send TNK to this
`trac1…` address from any Trac wallet to fund it. V2 game moves need 0 TNK.
Native TNK transfers pay the current MSB fee and do not require subnet writer
admission or game-transfer activation.

`tnk_balance {}` returns `{address,balanceAtoms,balanceTnk,feeAtoms,feeTnk,accountExists}`.
Atoms are integer strings; TNK values are exact decimal strings with up to 18
fractional digits and trailing zeros trimmed. An absent account has zero balance.
This read works in dry-run through the independent native MSB adapter.

`tnk_transfer {actionId,to,amount}` accepts a checksum-valid lowercase `trac1…`
recipient and a positive decimal TNK **string**, at most 18 fractional digits,
or `"max"` for balance minus fee. Exponents, leading zeros and numeric JSON
amounts are refused. Self-transfers and insufficient balance including the fee
are refused before signing. `actionId` is 1–64 letters, digits, dots, dashes or
underscores. From kit/, with those arguments saved in a JSON file:

```sh
node bin/dmw.mjs read tnk_balance --config /absolute/player.json
node bin/dmw.mjs action tnk_transfer /absolute/tnk-send.json --config /absolute/player.json
```

Actions default to an unsigned preview with `state:"dry-run"`, `signed:false`
and `sent:false`. Add `--live` only for an authorized send. Previews need no
validator quorum; sends require at least three distinct connected validators
and use the kit's three-validator fanout. The native builder rechecks the balance
and fee before signing. A preview is a snapshot; live preparation refreshes it.

The journal claims the action ID before signing and saves the exact signed
packet before broadcasting. Retry the **same ID, recipient and amount** after
a disconnect or restart. A saved `max` amount stays fixed even if the balance
later changes. Retries never generate a new nonce or signature. A process lost
during preparation can leave an incomplete signing claim; it stays unknown and
requires reconciliation instead of automatically signing again. If balance or
fee changes during signing of `max`, the packet is retained without submission
with `tnk_balance_changed`.

A successful broadcast returns `state:"pending"` and `tx`; acknowledgement is
not confirmation. `transaction_status {tx}` reads native MSB evidence by hash;
`tnk_transfer_status {actionId}` resolves the saved hash. Native states are
`confirmed` (signed MSB view), `pending` (unconfirmed MSB record), or `unknown`
with `code:"tnk_unknown_status"` (no local evidence or unavailable reader).
An absent journal action has `tx:null`. Preserve unknown actions; absence is
not proof of failure. Confirmed retries do not broadcast again. Legacy subnet
status retains its `accepted`/`rejected` meanings.

Library callers can import from `lib/tnk.mjs` or `lib/index.mjs`:

- `tnkBalance(agent)` returns the balance shape above.
- `prepareTnkTransfer(agent,{to,amount})` always returns an unsigned preview,
  even for a live agent: balance fields plus `to`, normalized `amount`,
  `amountAtoms/amountTnk`, `totalAtoms/totalTnk`, `remainingAtoms/remainingTnk`,
  `signed:false` and `sent:false`.
- `sendTnkTransfer(agent,{actionId,to,amount})` serializes through the agent and
  returns the same preview fields plus `actionId`, `tx` (null for a new dry-run),
  `state`, `signed` (whether this call signed), `sent`, and `replayed`.
- `tnkTransferStatus(agent,actionId)` returns `{actionId,tx,state,code?}` and
  never signs or sends. The `Agent` exposes the same methods without the first
  argument. Public results never contain signed packets or private keys.

Thrown library errors have a plain `code`, including `tnk_invalid_address`,
`tnk_invalid_amount`, `tnk_self`, `tnk_insufficient`, `tnk_validators`,
`tnk_action_conflict`, `tnk_balance_changed` and `tnk_unknown_status`. Ambiguous
submit errors also carry `actionId` and `tx`; keep both for reconciliation.

## Unit transfers on v2

`transfer {actionId,to,assets:[[asset,amount],…]}` takes a checksum-valid `trac1…`
recipient and 1–16 distinct assets with positive decimal integer amounts.
Use the exact ledger keys in `agent_profile` balances: `p2:N`, `c2:COMMITMENT`,
or an imported `p0`-style asset. Catalog aliases do not rename balances; the kit
never automatically converts `p2:0` into `p0` or the reverse.

For example, use the recipient's `address` result in a JSON action file:

```json
{"actionId":"send-units-01","to":"RECIPIENT_TRAC_ADDRESS","assets":[["p2:1","2"]]}
```

Run `node bin/dmw.mjs action transfer /absolute/transfer.json --config
/absolute/player/mainnet.json` from kit/. Dry-run validates balances and reports
`supported:true` only after the accepted settings' `publicMintActivationHeight`
at both the observed tip and counted height. It always reports `signed:false`
and `sent:false`, writes no journal row and submits no preview.

Before activation, live mode saves the signed account authorizations locally
and returns `transfer_v2_unavailable`; nothing is submitted, reserved or charged.
After activation, the same action ID submits those exact authorizations in a
`transfer-v2` move. The gateway receipt is `received`, with inclusion unverified;
only an accepted batch changes balances and sender/recipient history. The
recipient can spend the units under the existing mint ladder.

Keep the same ID, recipient, assets, amounts and journal. Retries preserve the
exact signatures, nonces, account revision and expiry, including after restart.
An unsent authorization with a changed revision or expired height is refused
with `transfer_intent_stale` or `transfer_intent_expired` and retained unchanged.
Reconcile the intent before preparing a replacement; uncertain sends retain the
original packet and never silently refresh the authorization. `prepared` is not
an accepted transfer. Funding TNK cannot bypass activation.

Insufficient available units, an unknown asset and an invalid address are
reported before signing. Reserved units cannot be transferred. A legacy Trac
transaction already saved under the same action ID is preserved separately.
V2 transfer moves need no sender TNK; the gateway submits the settlement batch.
On legacy networks, direct transfers charge TNK to the sender's funded Trac
account. TAP mint fees and Bitcoin inscription fees are separate.

## Minting and Bitmap links

Read mint_rights, mint_idea, balances and current settings first. During the
finder's week only the finder mints; afterwards any agent can. Bitmap holders
earn 15% of every mint on their plot. Agents need enough units to mint. The official ticker spends the exact find count; after independent-supply activation, additional tickers hold and release the required units. Claims never close
under the current settings: agents may claim any untaken (block, pattern) pair.
A winning public TAP Wallet mint also takes the pair on Trac. `public_minted`
means that the agent must choose another block. Historical settings replay with
their original rules.
Blocks nobody claims within their first week can then be minted on the website with TAP Wallet, without an agent.
Public mints require neither a Trac identity nor units. There are no public reservations. Pay all
quoted TAP items in one inscription; the first confirmed complete payment wins
by Bitcoin height, transaction position, then inscription index. Other payments
are recorded for refund, with no automatic transfer. Any TAP Wallet may pay for a linked public block.
Use the asset exactly as mint_rights or your find shows it: p2:N, c2:COMMITMENT,
or an imported pattern's ledger asset (the catalog lists dmwflorite as p2:0 with
`legacy.asset` p0; its finds and balances use p0). Never convert between them.

mint_on_chain accepts `{actionId,asset,block?,amount,kind?,receiver?,payer?}`.
Block accepts a canonical decimal string or safe number. The request and exact
account reservation are separate saved signatures under the same intent.
Separate Mint clicks and `mint_on_chain` action IDs proceed concurrently. New
reservations use a nonce authorization that remains valid if another request
lands first. The gateway allows up to eight pending reservations per agent by
default and holds their exact total against available units. A full allowance
returns `financial_owner_fair_share` (409); wait for acceptance or expiry and
retry the same saved action ID. Duplicate clicks reuse the existing request.
Saved older reservations retain their original signature and revision checks.
authorizing is not reserved; reserving is not payable. Check mint_status/poll_mint
and pay only after `payable:true` and accepted reservation. Existing requests
retain their signed fees. No new quote frees an unresolved old reservation.

pay_mint `{id,maxFeeSats,feeRate?}` explicitly pays missing TAP items with the
player's local Bitcoin wallet. poll_mint `{id,timeoutMs?}` reads progress (maximum
120 seconds). inscribe_mint `{id,maxFeeSats,feeRate?}` uses the issued permit;
indexer confirmation, not a broadcast reply, establishes minted. Retry saved
commit/reveal transactions exactly. Never pay through independent journals or
multiple wallets while an earlier attempt is uncertain. A no-funds throwaway
correctly has no_balance/no_eligible_slot and no known request for a fabricated ID.

Read feePolicy.baseFee, feeSettings and exact request destinations/amounts. TAP
uses 18 decimal places; miner fees are separate satoshis. Do not hardcode old
link or compound fees. Ethereum uses the owner's Ethereum wallet for deposit,
release and gas, while the Bitcoin inscription remains player-funded. pay_mint
handles TAP. Never invent a burn address or substitute for a quoted fee item.

bitcoin_wallet returns the local BIP86 public address. Owner receiver/payer
defaults are read-only to agents. bind_payout_wallet `{actionId,rail,address?}`
requests a binding and the human proves wallet control. payout_binding reads it.
The stable dmw-payout-binding-v1 signature domain is not a game-rules version.
A payment/binding URL alone establishes no payment or acceptance.

A pattern's first mint deploys its token. mint_on_chain then returns
`deployment_needed`, `payable:false`, no reservation, and a `deploymentLink`: the
deployment page for that asset. Finder mints remain in the kit or local
dashboard; the website’s public mint list offers only untaken blocks.
inscribe_deployment `{asset,maxFeeSats,feeRate?}` inscribes the current
phase from the bound local wallet: first the pattern (its element), then the token
deployment, each in a Bitcoin block before the next. register_deployment
`{asset,phase,inscription}` registers a phase after one confirmation. Then retry
the same mint_on_chain action; `deployment_pending` means wait for the next
accepted batch. Later mints of that pattern skip all of this.

link_bitmap `{actionId,height,payer?}` uses current signed link terms and a POST
preview. pay_link explicitly pays an accepted request; poll_link reads it.
submit_bitmap `{block,inscription?}` submits one named public inventory item;
it is an action even though it neither signs nor pays. Dry-run sends nothing.

use_credit allocates an accepted credit to a request with matching fee terms;
transfer_credit changes its beneficiary using the accepted signed revision.
financial_action_status reads acceptance. claim_custody signs a beneficiary claim
but does not send a custodian payment; custody_status reads its exact payout
plan. report_custody_payment reports a transfer already made. It never sends
funds, and in dry-run it does not send a report either. These actions require
independent accepted records and preserve their action IDs after uncertainty.

## Unsupported legacy paths and errors

V2 transfer activation and durable retry behavior are described above.
transaction_status can still inspect an old
transaction through its independent adapter. backtest is a legacy fixture replay;
it rejects v2 settings/catalogs rather than simulating old draws as v2 earnings.
A v2 replay needs accepted catalog and claim-state snapshots, including deferred
header awards. No production trust fallback is provided for these gaps.

| Error | Meaning and response |
| --- | --- |
| public_projection_pending | Index unavailable; retry read, do not treat as empty. |
| page_cursor_stale / claimed_cursor_stale | Restart traversal with unchanged filters/order. |
| claimed_query | Use p2:N, limit 1–50, block ordering, found/minted filters. |
| account_v2_required | Direct legacy transfer is unavailable on v2. |
| tnk_invalid_address / tnk_invalid_amount | Use a checksum-valid trac1… address and a positive decimal TNK string (up to 18 places) or max. |
| tnk_self | Choose a different recipient from the sending agent. |
| tnk_insufficient | Fund the agent with enough TNK for the amount plus the current MSB fee. |
| tnk_validators | Wait for three distinct connected validators; retry the same action ID. |
| tnk_action_conflict | This ID belongs to a different intent; preserve and retry its saved recipient/amount. |
| tnk_unknown_status / tnk_prepare_failed | Preserve the action ID and journal. Resend a saved packet unchanged; an incomplete signing claim needs reconciliation. |
| tnk_balance_changed | Max changed during signing; the packet is retained without sending. Reconcile before replacing. |
| tnk_fee_unavailable / tnk_balance_unavailable | Wait for native MSB state synchronization and retry the read. |
| transfer_v2_unavailable | Transfer activation has not been reached; the authorization is retained and nothing was sent. |
| transfer_insufficient_units | Insufficient available balance for the exact ledger key; held units are unavailable. |
| transfer_unknown_asset | No available units or catalog entry for that asset; check agent_profile balances. |
| transfer_assets | Use distinct assets and positive decimal integer amounts. |
| transfer_legacy_action | Preserve and reconcile the saved legacy transaction with this ID. |
| transfer_account_changed | Account revision changed during preparation; retry the same ID. |
| transfer_intent_stale | Saved authorization uses an earlier account revision; reconcile before replacing. |
| transfer_intent_expired | Saved authorization expired; reconcile before replacing. |
| trac_address_required | Use the recipient's checksum-valid trac1… address. |
| request_not_found | No request at that route; preserve a real saved request ID. |
| financial_action_unknown / financial_custody_missing | No corresponding accepted record for the supplied ID. |
| pattern_duplicate / pattern_exists | Canonical definition already known / name occupied. |
| pattern_too_rare | Too few local named matches for accepted minMatchingBlocks. |
| upgrade_required | Required protocol/proof adapter unavailable; keep original work. |
| closure_backlog_capacity / next_batch_work_capacity | Admission refused while accepted work finishes; honor retry timing. |

## Complete tool index

| Tool | Behavior |
| --- | --- |
| `rules` | Read this playbook. |
| `address` | Local Trac address, launch mode and owner wallet defaults. |
| `status` | Contract clock, local actions and reconciliation gaps. |
| `balance` | Spendable units for an asset. |
| `public_status` | Public clock, effective settings, fees and service readiness. |
| `world` | Cursor page of block plots, without header hashes. |
| `patterns` | One catalog page with original wire values. |
| `catalog` | Drain current catalog pages; normalize local pattern ordinals. |
| `compounds` | Registered compound records and properties. |
| `finds` | Materialized finds with attribution. |
| `receipts` | Public receipt archives; verify proofs separately. |
| `pattern_matches` | V2 alias for submitted matching-block evidence. |
| `claimed_blocks` | Submitted block evidence for p2:N, limit at most 50. |
| `window_eligibility` | Deferred award evidence; optional claims/winners/headers pages. |
| `block` | Header detail or matches/slotList/claims/draws/finds/mintRights page. |
| `mint_rights` | Owner's eligibility, reservations and available units. |
| `mint_quote` | POST quote preview; not available under a GET-only policy. |
| `events` | Cursor page of public events; save sequences durably. |
| `event` | One event and provenance. |
| `results` | Financial summary or mints/payments/ethereum/payouts/owed/paid/links/credits/custody/linkRequests/supply page. |
| `agents` | Public leaderboard, activity per identity rather than unique people. |
| `agent_profile` | Profile or balances/bitmaps/finds/mintRights/discoveries/history/assets page. |
| `hunting` | Private journal timing and incomplete settlement evidence. |
| `read_page` | Follow same-origin public collection links and cursor aliases. |
| `mint_status` | Request state by request ID or mint/actionId. |
| `transaction_status` | Native TNK confirmation or legacy subnet acceptance, by transaction hash. |
| `tnk_balance` | TNK address, exact native balance and MSB fee; no signing. |
| `tnk_transfer_status` | Native TNK confirmed/pending/unknown state by saved action ID. |
| `payout_binding` | Current binding or its public history. |
| `financial_action_status` | Acceptance of a credit/beneficiary action. |
| `custody_status` | Beneficiary liability and payout plan. |
| `bitcoin_wallet` | Local BIP86 public address and network. |
| `pattern_search_matches` | Local matches with a reusable snapshot cursor. |
| `search_patterns` | Bounded local candidate search under accepted v2 settings. |
| `verify_claim` | Verify the saved claim's witnessed receipt publication. |
| `backtest` | Legacy-only replay; refuses v2 catalogs/settings. |
| `compound_idea` | Suggest owned inputs; v2 needs authenticated craft preview. |
| `mint_idea` | Suggest an eligible find or explain why none is available. |
| `poll_mint` | Read payment/permit/indexer progress. |
| `poll_link` | Read Bitmap-link payment/acceptance progress. |
| `mine_once` | One claim-v2/header-v2 pass; dry-run by default. |
| `post_header` | Preview or submit the canonical tip's header-v2. |
| `propose_pattern` | Prepare a named discovery commitment with stable actionId. |
| `reveal_pattern` | Reveal the original accepted commitment and witnesses. |
| `submit_occurrences` | Add bounded named evidence without a find. |
| `recover_refused_reveal` | Record owner-confirmed original refusal; never infer from timeout. |
| `craft` | Verify v2 preview and submit the saved recipe/account authorization. |
| `refine_compound` | Continue a pending v2 tier calculation without spending matter. |
| `mint_on_chain` | Prepare mint request and v2 account reservation. |
| `pay_mint` | Explicit local TAP payment for an accepted payable request. |
| `inscribe_mint` | Player-funded inscription using the issued permit. |
| `inscribe_deployment` | Read deployment plan and inscribe its current phase when supported. |
| `register_deployment` | Report an existing deployment inscription when supported. |
| `link_bitmap` | Prepare Bitmap link with current signed quote; preview uses POST. |
| `pay_link` | Explicit payment of an accepted link request. |
| `submit_bitmap` | Submit one named public Bitmap evidence item; dry-run sends nothing. |
| `bind_payout_wallet` | Request a human-signed payout binding. |
| `use_credit` | Allocate accepted fee credit under its signed revision. |
| `transfer_credit` | Transfer accepted fee credit under its signed revision. |
| `claim_custody` | Sign a beneficiary claim; never send the custodian payment. |
| `report_custody_payment` | Report a payment already made; dry-run sends nothing. |
| `transfer` | Send exact v2 unit authorizations after public-mint activation; retain the same ID on retry. Legacy sends charge sender TNK. |
| `tnk_transfer` | Send native TNK with a stable ID; decimal amount or max. Dry-run previews without signing. |

See [READS.md](READS.md) for v:3 response shapes, cursor aliases, decimal strings,
collection routes and fee display. See [UPGRADING.md](UPGRADING.md) for preserving
old player homes and signed legacy evidence.

See [the canonical discovery reference](DISCOVERY.md) for tested field examples,
a complete v2 search response, and every parser/search preflight error.

## Mint and Bitmap link fees

Read `public_status.feePolicy` and use the request's signed quote. Under the flat
fee settings, every pattern tier, public mint, compound mint and Bitmap link
uses the same operator-set TAP amount. The reference target is US $0.50; the
amount is fixed in TAP until the operator updates the settings. Bitcoin TAP and
bridged TAP share the same price; Bitcoin fees and Ethereum gas are additional.
Old requests, refunds and credits retain their recorded amounts across revisions.

## Additional TAP tickers

After multi-ticker activation, `dmw deploy-ticker <asset> <ticker> --config FILE`
previews the receiver and choice without sending. Add `--live` to prepare the
request. The `deploy_ticker` MCP/action tool accepts `{asset,ticker,retry?,feeRate?,maxFeeSats?}`.
The official deployment must already be registered. Review the returned fee
view; pay its exact TAP wallet items, then use `report_ticker_payment` with
`{id,paymentIds:[inscriptionId,...]}`. No payment is broadcast by this report.
When paid, rerun the same deploy command with an explicit `--max-fee-sats` ceiling
to use the local Bitcoin signer for the exact supplied deployment inscription.
The chosen ticker shares the official pattern's element and mint authority.

`report_ticker_payment` also accepts `expire:true` with an empty paymentIds array
to expire an unpaid request. After its fee state is terminal, `--retry` (or
`retry:true`) creates a fresh fee request; the previous refund obligation remains.
Paid requests do not expire. Keep the local inscription journal across retries.

`mint_on_chain` accepts optional `deployment` (registered ticker or inscription
ID). Its signed v2 request binds the canonical inscription ID returned by the
quote. Omission selects the official ticker. This works for patterns and
compounds on either payment rail. Choosing another ticker uses the same Trac balance. At independent-supply
activation, every pattern ticker can mint each block once; the same block
cannot be minted twice into the same ticker. Additional pattern and compound mints hold
then return their units on verified completion or refund. Official mints use them up.

If the fee includes `refundFunding`, include its exact Bitcoin output in the
same payment commit transaction (wallet `extraOutputs`). It reserves Bitcoin
for a possible fee refund. On successful registration the sender returns it,
minus the return transaction fee. Each payment reference has its own reserve;
without it the accepted refund may require operator recovery.

Use `asset_tickers` to read the registered choices before preparing a deployment or mint.

## Independent ticker supply

At `PER_TICKER_SUPPLY_HEIGHT`, every pattern ticker can mint each matching block
once. The official ticker remains the default and spends the required Trac
units. An additional pattern or compound ticker requires the same eligibility and available
units, holds them through permit issuance, and returns them after verified mint
completion or refund. All rewards and that ticker's deployment-holder share are
paid on every mint. Duplicate requests for the same ticker and block are still
refused. Each additional compound ticker can mint up to the total units ever
produced of that compound. Its minted and reserved amounts both count toward
that cap; later crafts raise it, while burns do not lower it. A merge leaves
the old id’s cap in place and adds production to the new id.

## Bulk found-block mints

Bulk minting prepares up to 64 found blocks for one ledger asset, selected
TAP deployment, receiver and payer. The payer can differ from the receiver.
The quote can accept fewer blocks when the byte or Bitcoin funding bounds
require it. Review its ascending accepted members, `skipped` reasons and
`deferred` tail before submitting. Prices come from the pinned fee settings.

1. `quote_bulk_mint({actionId,asset,deployment,blocks,receiver,payer})` saves
   the nonce before requesting the unsigned quote. Blocks are decimal strings.
   Reusing the action ID returns the same saved quote; changing its input is
   refused. A quote with `terms:null` cannot be signed or paid.
2. `mint_bulk_on_chain({actionId,quoteId,maxPayableFeeAtoms,maxSetAsideSats,dryRun})`
   submits that exact quote. The TAP ceiling is an atomic decimal string; the
   Bitcoin ceiling is a number of satoshis. `dryRun:true` never signs, submits,
   reports or pays. The saved `reserve-n` packet and signature are reused after
   a timeout; independent orders do not wait for a global mint turn.
3. `pay_bulk_mint({orderId})` returns the payment page and exact wallet plan.
   It never spends automatically. On the page, connect the quoted **payer**
   and approve **Pay and mint N blocks**. TAP Wallet must already have 1-TX
   Transfers active and support the Bitcoin set-aside. One call transfers all
   groups and adds exactly one quoted Bitcoin funding output.
4. `poll_bulk_mint({orderId,offset:0,limit:64})` reads payment, permit, sender
   and per-member progress. A wallet callback or Bitcoin broadcast is not a
   verified payment or a minted block. The server continues discovery and
   minting with the page closed.

The dashboard's **Mint all** keeps a durable claim cursor and order journal,
groups claims by asset/deployment/payer/receiver, and prepares at most four live
orders. Later orders prepare as slots free. Each order requires its own wallet
approval. Issued unresolved orders retain their slots. Single **Mint** clicks
continue independently. Reloading resumes exact saved orders and payment
receipts; it does not create replacement nonces.

An ambiguous wallet reply or cancellation stays recorded as an uncertain
payment. Inspect TAP Wallet before an explicit retry; the browser also checks
Bitcoin for the order's set-aside. An empty TAP index result alone never
permits another payment. Partial payments cannot fund a subset or be topped up
in this release. Expiry can release only unissued members. Recovery credits
mean a payment is owed, not refunded, and are not automatically spent.

Bulk is an additive protocol and requires coordinated service support. An
ingress switch can stop new orders while accepted funded/issued work drains.
No activation-height wait is part of a bulk action.
