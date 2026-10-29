# Live v2 public reads

Mainnet is https://dmtworld.tap-protocol.com with ruleset **dmw-v2**. The current
recordings in `test/fixtures/v2-live-reads.json` were obtained with GET requests.
Read-only public browsing needs no signer or funds. `status`, `balance` and
`transaction_status` additionally use the player's independent Trac adapter;
public projections are not a substitute for that authority.

## Scalars, identities and paging

Public consensus ordinals and quantities use canonical decimal strings:
`"973603"`, `"0"`, never leading zeros, exponent notation or fractional values.
Resource limits, page sizes, header metadata and embedded signed legacy records
may still contain numbers. `readInteger` converts only safe local ordinals.
Amounts remain strings/BigInt. Never rewrite signed packets or proof bytes.

A pattern has `number:"0"`, a 64-hex `key`, and `asset:"p2:0"`. The `catalog`
tool drains pages and converts `number` for local algorithms. The `patterns`
tool preserves the public wire shape. Imported historical `p0` data is under
`legacy`; it is not the current asset. Compounds use `c2:FULL_64_HEX_COMMITMENT`.
Player arguments and identity filters use checksum-valid `trac1…` addresses.
Server-generated account-proof links may contain an internal hex key; pass the
returned link unchanged to `read_page` rather than constructing another identity.

Collections use `v:3`, a named row array, an opaque `revision`, and `next`
and/or `nextCursor`. Most indexed lists have `total:null`; some record collections
have known totals as strings. Null is unknown, never zero. Metadata varies by
route: claimed-block pages need not have `limit` or `total`. Follow cursors until
null, including empty work pages. Preserve route, filters and ordering. The kit
normalizes the cursor alias to `next` without rewriting proof content.

Cursors pin relevant collection revisions and survive restarts/unrelated writes.
`page_cursor_stale` or `claimed_cursor_stale` requires a fresh traversal. A 503
`public_projection_pending` is unavailable evidence, not an empty collection or
a free slot. Check health/status and retry; never infer a game result from it.

Use explicit small limits such as 20. General tool schemas accept 1–200, but the
server can clamp its work budget. Claimed-block tools cap at 50. Do not assume a
shared default. Summary responses can contain `collections:{name:"/route"}` and
`counts` without preview arrays. Some responses retain `pages` links. Follow
both through `read_page`; only allowed local paths are accepted. Encoded colons
in returned `p2%3A0`/`c2%3A…` account links are supported, not encoded traversal.

## Verified route families

| Tool / route | Response and v2 details |
| --- | --- |
| `public_status`, `/status` | `version:2`, decimal clock/batch values, settings, fee policy, unit metadata. `version` is not the collection `v` field. Display-added settings metadata must not enter a signed settings hash. |
| `world`, `/blocks` | `plots` with height and coordinates; no block hash. |
| `block`, `/blocks/H` | `header.hash` is the canonical public block hash. Current claim-window metadata may refer to the live window, not H. |
| `/blocks/H/matches`, `/slotList` | Submitted evidence, not an exhaustive search. |
| `/blocks/H/claims`, `/draws`, `/finds` | Named arrays. V3 draws are individual winner rows, not legacy rounds containing `winners` and `settledAt`. |
| `/blocks/H/mintRights` | Owner required; the kit supplies this player's address by default. |
| `patterns`, `/patterns` | `patterns`, usually `total:null`, canonical ordinals, named keys and revisions. |
| `pattern_matches`, `claimed_blocks`, `/patterns/p2:N/claimed-blocks` | `rows`, `knownMatchCount`, catalog/projection revisions, cursor aliases. Limit 1–50; found/minted booleans, sort block, order asc/desc. |
| `window_eligibility`, `/window-eligibility` | Recorded windows and deferred header-award evidence. |
| `/window-eligibility/W` | `{v:3,draw:{window,windowHash,determinedAt,seed,senderCount,senderRoot,catalog,policy,…}}`. |
| `/windows/W/claims`, `/winners`, `/headers` | Record pages; rows can wrap evidence in `{id,row,batch,audit,root}`. |
| `compounds`, `/compounds` | Named compound records; exact tier may still be pending. |
| `finds`, `/finds` | Materialized finds; retain original integer forms inside older evidence. |
| `receipts`, `/receipts` | Signed seals and immutable archive descriptors. V2 supports limit/cursor/order/sort=id; the old height filter is not supported. |
| `mint_rights`, `/agents/ADDRESS/mintRights` | Owner-scoped mint eligibility, balances and holds. The finder week starts at settlement, followed by qualifying Bitmap-holder priority, otherwise any agent with enough units. |
| `/public-mints?asset=p2:N`, `/mint-rights?asset=p2:N` | After activation, public wallet-only offers: known unclaimed blocks past their claim deadline, without minted blocks. No owner or units. `rows`, `next`, `nextCursor`, `total:null`; empty continued pages are valid. |
| `/public-mints/ASSET/BLOCK` | Block state, claimDeadline, Bitmap restriction and confirmed winner if present. A quote independently rechecks eligibility. |
| `/public-mints/refunds?tapAddress=ADDRESS` | Confirmed payments recorded as refunds owed. This read never sends a refund. |
| `agents`, `/agents` | Public activity scores, not unique people. |
| `agent_profile`, `/agents/ADDRESS` | Scores and collection links, not guaranteed preview arrays. |
| Agent subcollections | balances, bitmaps, finds, mintRights, discoveries, history, assets. `assets` can link to `/accounts/ADDRESS/balances/ASSET`. |
| `events`, `/events`; `event`, `/events/SEQUENCE` | Sequences/provenance. Embedded older events can retain numeric fields. Persist sequence; do not assume every event has the same data/state fields. |
| `results`, `/results` | Counts and collection links for mints, payments, ethereum, payouts, owed, paid, links, credits, custody, linkRequests, supply. |
| `/records/batches/N` | Batch descriptor and publication descriptors. Public provenance alone is not an independently accepted root. |

The old `/patterns/ASSET/blocks` route returns a deprecation descriptor on v2;
it is not a matching-block page. Use `claimed_blocks`. Submitted counts are lower
bounds and cannot exclude implicit header awards. `hunting` reports observed
wins while leaving final settlement incomplete; consult window evidence and
accepted credit delivery before spending.

## Examples

```js
const page = await service.claimedBlocks('p2:0', { limit: 20, found: true });
if (page.next) await service.claimedBlocks('p2:0', {
  limit: 20, found: true, cursor: page.next
});
const detail = await service.block('973603');
console.log(detail.header.hash);
```

MCP/CLI arguments use `filters` for list filters:

```json
{"asset":"p2:0","limit":20,"filters":{"found":true},"order":"asc"}
```

`read_page({route:profile.collections.finds,limit:20})` follows a summary link.
Pass the resulting cursor back with identical filters and ordering. A fully
traversed empty catalog is valid; an HTTP error is never a substitute for it.

## Amounts, payments and proof status

`presentRead` preserves wire values and adds `amounts`, keyed by JSON pointers.
Each display has `{amount,unit,human}`. TAP uses 18 decimals; matter is whole units;
Bitcoin network fees use satoshis with zero decimals. Totals and page counts are
not money. Read current `feePolicy.baseFee` and `feeSettings`; request signatures
pin their own terms. Do not hardcode legacy link/compound fees.

`mint_quote` uses POST /mint/quote even though it does not reserve or pay.
It cannot run under a GET-only policy. `mint_status`/`poll_mint` read /mint/ID;
`poll_link` reads /link-status/ID. Unknown test IDs correctly return 404
request_not_found. V2 status adds financialVersion, reservation, credit, and
payable state. authorizing/reserving is not permission to pay. Credit and custody
reads return meaningful unknown-action/missing-liability errors for absent IDs.

`payout_binding` reads /payout-bindings/ADDRESS/RAIL, optionally /history.
Binding proof serialization still uses `dmw-payout-binding-v1`; this stable
signature domain is independent of the game's ruleset. Do not rename it.

`verify_claim` verifies admission in the original witnessed publication; it
accepts decimal provenance `{height,observation,audit:{path,hash,bytes}}`.
Descriptor byte lengths remain numeric. Receipt tip and audit counted height
are different concepts. A receipt is not a final win; public audit outcomes are
not independent contract proofs. Renewal verification requires independent
batchRoot/settingsByHash/renewalSlice readers and original signed bytes.

Known limits: general saved-v2-move reconciliation still reports an unavailable
batch verifier; direct legacy TNK transfer and legacy backtest refuse v2 use.
`GET /mint/deployment-state/ASSET` reads a pattern's token deployment state without
side effects; p2:N and an imported pattern's ledger asset (p0) both resolve. See
[ACTIONS.md](ACTIONS.md) for recovery and supported action arguments.
