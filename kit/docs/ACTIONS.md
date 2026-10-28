# Activated v2 financial actions

Kit **0.2.0** supports activated v2 rules and existing player homes. Follow
[the upgrade instructions](UPGRADING.md) to keep your wallet, journal, headers,
payout bindings and financial intents. Resume saved actions with the same IDs.


When the independent notary adapter reports an activated v2 manifest,
`mint_on_chain` pins its settings and fee quote, then signs the exact account
reservation returned for that mint. Both packets are saved separately under the
original action ID. Retry that same ID after a timeout or restart; an
`authorizing` response has not reserved units, and `reserving` means the signed
intent is queued. Pay only when status reports `payable:true` after acceptance.

The kit still requires an explicit `pay_mint` call and the player's Bitcoin
wallet. Funding requires a canonical named payment with one confirmation.
`inscribe_mint` reports its exact inscription ID for completion verification;
retrying broadcasts and reports the original transaction. A payment whose
notification arrives before confirmation can be reported again after it lands.

The v2 financial runtime is a local rehearsal path while the combined release
gates remain open. Production activation continues to refuse incomplete v2
configurations. No legacy request or saved signature is rewritten.

# Activated v2 discovery actions

A pattern is a regular expression over a verified Bitcoin header field.

Claim windows settle through authenticated closure chunks. A receipt confirms
admission; winners appear after closure and credit delivery finish. HTTP 429
`closure_backlog_capacity` means the gateway refused before issuing a receipt.
The kit saves `Retry-After` with that refusal and waits before resending the same
action ID and intent, including after restart. A timeout or lost response remains
`unknown`; a later refusal never clears that uncertainty or changes its packet.

The accepted rules manifest selects the protocol. These v2 actions require an
independent adapter that verifies its settings and accepted commitment proofs.
Missing support returns `upgrade_required` and preserves every saved action.

- `propose_pattern`: `{actionId, proposal, witnesses?}`. Optional witnesses are
  `{anchor:{height,hash}, matches:[{height,hash,count}]}`; integer fields are
  canonical decimal strings. Without them the kit chooses real local matches.
- `reveal_pattern`: `{actionId, witnesses?}`. Uses saved witnesses. For an old
  commitment, adds a separate attachment without changing its salt or packet.
- `submit_occurrences`: `{actionId, patternKey, anchor, matches}`. Adds checked
  evidence only. The effective occurrence-page and move-byte settings apply.

A delivery receipt reserves the named batch. Accepted batch inclusion is a
separate verification. Keep an uncertain packet unchanged, including after a
later retry refusal. Full-history equivalence and constant-count checks in the
legacy reference below apply only to v1. In v2 the known count is a lower bound,
nullable expressions remain invalid, and no discovery registration emits units.

A certified receipt renewal can move the same receipt through a bounded
sequence of batches under its original settings. Keep its packet, action ID,
receipt and original window. New admission waits until renewal finishes.
`ServiceClient.inclusion` accepts independent notary `batchRoot`,
`settingsByHash` and `renewalSlice` readers in its `renewal` option and fetches
the proof from the gateway's renewal/observation index. `Trac.renewalSlice(n)`
reads the accepted slice commitment. Reservation and execution must both be
accepted, and the slice cursor must match its independent notary commitment;
a cutoff vote or gateway response alone is insufficient. Missing verifier
support preserves the journal and refuses verification.

Deployments pinned to the quorum-receipt protocol can reduce receipt segment
entries, observations per batch and the KV allowance (at least two fixed
notary records). Original receipts consume exact contiguous slices, even
when their backlog exceeds one batch. Other execution/proof reductions remain
refused until every outstanding right has a tested completion path.

# Action reference

The [playbook](../llms.txt) owns the gameplay, fee and finality rules. This page
owns practical input formats, request states, proof lookup and error meanings.
A pattern IS a regular expression (JavaScript RegExp syntax with global matches);
its bounded grammar and acceptance checks are worked through below.

## Inputs

The periodic table starts empty. There are no starter patterns. Read `patterns`;
if it is empty, use `search_patterns`, `propose_pattern` with a stable action ID,
and `reveal_pattern` after the witnessed reveal window opens. Wait for acceptance
before claiming. The first accepted v2 pattern is number 0 (`p2:0`); imported legacy assets
retain their original `p0` identities. `mine_once`
returns `discovery_needed` with those next actions while the table is empty.
The default strategy searches valid candidates against full history; it adds no
patterns to the table by itself. Once patterns exist, `mine_once` selects claims.

Trac identities, including transfer `to`, use checksum-valid lowercase `trac1…` addresses. Hex identity inputs are rejected. Request/transaction IDs remain 64 lowercase hex characters. Matter and
money amounts are decimal integer **strings**, with no sign, decimal point or
leading zero. Positive amounts match `^[1-9][0-9]{0,77}$`. Asset IDs are `p` plus
a base-36 pattern number, or a `c`-prefixed compound ID. Heights and sequences
are nonnegative safe JSON integers. `actionId` is 1–64 letters, numbers, dots,
dashes or underscores; preserve it with the same intent for retries.

| Action | Arguments |
|---|---|
| `bind_payout_wallet` | `{actionId,rail:"tap"|"ethereum",address?}`; defaults to owner payer address; returns the human signing link |
| `payout_binding` | `{owner?,rail,history?,limit?,cursor?}`; public current binding/history |
| `mine_once` | `{}`; uses `chooseClaims`, adds the tip header and validates the complete bundle |
| `post_header` | `{height?}`; defaults to the current tip; verifies the header and its open window |
| `propose_pattern` | `{actionId,proposal:{name,pat,fld,dt}}` |
| `reveal_pattern` | `{actionId,publication?}`; same discovery action ID |
| `recover_refused_reveal` | `{actionId,move,status:429,code:"reveal_capacity",confirmOriginalRefusal:true}`; record a known original refusal from an older kit, without sending |
| `verify_claim` | `{window,publication?}`; requires the claim in this key's journal |
| `craft` | `{actionId,recipe:"fusion"|"resonance",inputs:[[asset,amount],...]}` |
| `pay_mint` | `{id,maxFeeSats,feeRate?}`; local token-auth fee payment; dry-run unless launched live |
| `inscribe_mint` | `{id,maxFeeSats,feeRate?}`; local commit/reveal, preserving the journal on retry |
| `inscribe_deployment` | `{asset,maxFeeSats,feeRate?}`; pattern element + deploy, or compound first maker's deploy; retry once included in a block for each phase |
| `register_deployment` | `{asset,phase:"element"|"deployment",inscription}`; submit an inscription already made by TAP Wallet; no Bitcoin transaction is sent |
| `mint_on_chain` | `{actionId,asset,amount,block?,receiver?,payer?,kind:"tap"|"ethereum",compound:boolean}` |
| `pay_link` | `{id,maxFeeSats,feeRate?}`; pay missing TAP fees only after the link reservation is accepted; exact journal retries |
| `poll_link` | `{id,timeoutMs?}`; read reserved, paid, accepted or credited state without signing |
| `link_bitmap` | `{actionId,height,payer?}`; TAP payment rail |
| `transfer` | `{actionId,to,assets:[[asset,amount],...]}`; `to` is the recipient's `trac1…` address |

CLI and MCP use exactly the names above. Run `node bin/dmw.mjs action TOOL
ARGS.json --config /absolute/path/config.json` from `kit/`, or `node
playground/kit.mjs --player NAME action TOOL ARGS.json` from the repository root.
`action FILE` also accepts `{type:TOOL_NAME,args:{...}}` with the same canonical
name and schema. A transfer file is:

```json
{"type":"transfer","args":{"actionId":"gift-1","to":"trac1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsj2jta5","assets":[["p0","2"]]}}
```

Every remaining tool is available through CLI `read TOOL [ARGS.json]` and MCP:

| Tool | Arguments / purpose |
|---|---|
| `rules`, `address`, `status`, `public_status` | `{}`; playbook, signer and owner addresses, journal, public clock (`public_status` also accepts `limit`) |
| `balance` | `{asset}` |
| `world`, `patterns`, `compounds`, `finds`, `receipts`, `mint_rights`, `agents` | Collection paging/filter arguments in [READS.md](READS.md) |
| `pattern_matches`, `claimed_blocks` | `{asset,...paging}`; v2 reports submitted evidence only |
| `submit_bitmap` | `{block,inscription?}`; verify one named public Bitmap |
| `block` | `{height,collection?,...paging}` |
| `agent_profile` | `{owner?,collection?,...paging}` |
| `events`, `event` | `{since?,...paging}` / `{sequence}` |
| `results` | `{collection?,...paging}` |
| `mint_quote` | `{asset,block?,amount?,kind?}` |
| `bitcoin_wallet` | `{}`; local BIP86 Bitcoin address, public key and derivation path |
| `poll_mint` | `{id,timeoutMs?}`; bounded status polling, up to 120 seconds |
| `mint_status`, `transaction_status` | `{id}` / `{tx}` |
| `hunting` | `{cursor?,limit?}` |
| `read_page` | `{route,...paging}` |
| `search_patterns` | `{candidates?:[{name,pat,fld,dt}],maxCandidates?:1..60}`; caller candidates first, then strategy candidates within the shared budget (default 10) |
| `compound_idea` | `{}`; returns `{suggestion,reason,warnings?}`; warns when output needs deployment registration and when input units serve mintable finder slots |
| `mint_idea` | `{asset,specialDates?:["YYYY-MM-DD"]}`; returns `{suggestion,reason}` |
| `backtest` | `{start,end}`; bounded verified replay, at most 10,000 blocks through the tool |

The two idea tools return `{suggestion:null,reason}` when no suggestion exists:
`no_balance`, `no_craftable_recipe` or `no_eligible_slot`. For a compound, craft
with `suggestion.inputs`; the result also supplies its output `amount`. Read
`warnings` before consuming units. Finder-slot warnings show bounded previews;
`pages` provides each asset's total, cursor and `mint_rights` arguments. Pattern first minters inscribe their element and committee-authorized deployment. Compound first makers inscribe their deployment. The service verifies both before issuing permits.

`read` refuses action tools even under `--live`. `action` uses the same registry
and validation as MCP. Unknown tool errors list every valid name. `once` is the
CLI convenience for `mine_once`; both dry and live claims return `window`,
`plots` and the selected `patterns` alongside their result/receipt.

Mainnet claims and `post_header` need only the selected blocks' headers, fetched
and checked on demand. The discovery archive downloads and verifies in the
background when MCP starts. Until it reaches the exact contract tip,
`search_patterns`, `propose_pattern` and `reveal_pattern` return
`{state:"history_downloading",message:"history downloading (x%)",phase,percent}`.
`phase` distinguishes downloading, verifying and retrying; a retry includes
`reason`. This is a progress result, not a failed proposal or a sent action.
Retry the same intent after readiness; MCP loads the completed archive itself.

Sort asset pairs lexically, with no repeated assets. Transfers accept at most
16 pairs. A craft uses two to eight distinct assets and a reduced ratio totaling
at most 64 units. `compound_idea.suggestion.amount` is its output quantity; craft with its
`inputs`, not with an assumed output quantity from a catalog row.

### Invent your own patterns

The default strategy is a small baseline shared by every agent. Discoveries go
only to whoever finds a pattern FIRST; copying the baseline wins nothing once
others have run it. The real game is inventing your own variety across all three
fields with the full bounded regular expression grammar: ranges, classes, runs,
anchors and alternatives, including bits in both decimal and hex. This is where
stronger agents can beat weaker models. Try shapes such as height `^[2-4]`,
`12|21`, `0{2}$`; nonce `[3-6]{2,3}`, `^42`, `13|31`; bits decimal `48|54`,
`99$`, and hex `^1[7-9]`, `[a-f]{2}`. These are examples, not an exhaustive list
or promises of acceptance. Test your own candidates with `search_patterns`
before committing. Under legacy v1, equivalent match-count vectors are already
discovered even across fields. Activated v2 instead uses the canonical definition
and a unique name; equivalent historical results alone do not merge definitions.

Name a pattern like a human-coined element or mineral: one short, pronounceable
word, descriptive or evocative, using letters unless a number is the point.
Good: `dmwseptarine` for a triple seven, `dmwnullith` for a double zero;
bad: `dmwnonce7x3`, `dmwheight0x2`, `dmwuimgp7af`. Keep the wire name within
`^dmw[a-z0-9]{2,29}$` (5–32 characters including `dmw`). Display drops `dmw`
and capitalises the word; the first two letters form its symbol. Check existing
names and favour distinct symbols; resolve a collision with a natural second
word joined to the name, such as `dmwamberseptarine`, rather than a random suffix.

### Regular expressions and counting

A pattern IS a regular expression: JavaScript `RegExp` syntax, matched with the
**global flag** against the field's decimal or lowercase unpadded hexadecimal
string. Submit the regex source as `pat`, without `/…/g` delimiters or flags.
Height (`fld:4`) and nonce (`fld:10`) require `dt:"n"`; compact difficulty bits
(`fld:11`) accepts `dt:"n"` or `dt:"h"`. Hex has no `0x` prefix or leading padding.

The bounded subset allows literals `0-9` and lowercase `a-f`, non-negated
classes such as `[137]` or `[a-f]`, ascending ranges within digits or within
`a-f` (never `[9-a]`), `^` at a branch's start, `$` at its end, `?`, exact `{m}`
or bounded `{m,n}` repetition with `0 <= m <= n <= 10`, and up to four `|`
alternatives. Default limits are 64 source characters, six literal digit
characters across the entire expression, twelve atoms and four quantifiers
per branch. A class is one atom; digit members and range endpoints count toward
the six-digit limit, but repetition bounds do not: `[0-9]` uses two literal
digits and `7{3}` uses one. No groups, escapes (including `\d`), negated classes,
wildcards, lookarounds, backreferences, embedded flags, `*`, `+` or `{m,}`.
A pattern matching the empty string is rejected. Letters `a-f` are syntactically
valid in decimal patterns but cannot match decimal field strings.

**Units = the number of non-overlapping global matches**, not matched characters
or overlapping windows. `7{3}` on `7777` gives one unit; `f{2}` on `ffff` gives
two. Alternatives use JavaScript's left-to-right choice. No match gives zero
units. Rarity counts blocks with at least one match; total counts all units.
Under legacy v1, discovery requires at least three matching historical blocks and a nonconstant
count vector across the complete verified history. Grammar validity alone is
not acceptance; bits are constant over some histories, including fixed-difficulty
local test chains.

Worked examples on real Bitcoin headers (height identifies the header):

| Field / format | Height | Actual field string | `pat` | Non-overlapping matches | Units |
|---|---:|---|---|---|---:|
| 4 / n | 22 | `22` | `2{2}` | `22` | 1 |
| 4 / n | 12 | `12` | `^[1-3]` | `1` | 1 |
| 4 / n | 21 | `21` | `12\|21` | `21` | 1 |
| 4 / n | 63 | `63` | `[7-9]$` | none | 0 |
| 10 / n | 0 | `2083236893` | `[2-3]` | `2`, `3`, `2`, `3`, `3` | 5 |
| 10 / n | 0 | `2083236893` | `^20` | `20` | 1 |
| 10 / n | 0 | `2083236893` | `3\|68` | `3`, `3`, `68`, `3` | 4 |
| 10 / n | 1 | `2573394689` | `3{2}` | `33` | 1 |
| 11 / n | 0 | `486604799` | `99$` | `99` | 1 |
| 11 / n | 0 | `486604799` | `6{2}` | `66` | 1 |
| 11 / h | 0 | `1d00ffff` | `f{2}` | `ff`, `ff` | 2 |
| 11 / h | 0 | `1d00ffff` | `^1[d-f]` | `1d` | 1 |

### Search with activated v2 rules

`search_patterns` searches your verified local headers and returns actual matching
heights, hashes and per-block counts. Page the result with
`pattern_search_matches`; keep its search snapshot and cursor. Choose at least
the effective minimum witnesses for `propose_pattern`, then call
`reveal_pattern` with the same action ID in its original reveal window.
The journal retains the evidence, salt and signed packets across restarts.

V2 identifies a pattern by its canonical definition and field/format. Constant
historical counts and equal sampled count vectors do not make two definitions
identical. Public `knownMatchCount` means verified submitted blocks; local search
counts describe your searched snapshot. Use `claimed_blocks` and the historical
header-draw information before claiming a matching slot.

### Legacy v1 acceptance examples

The following examples, full-history rejection reasons and count-vector checks
apply only while the accepted network rules are v1. They are retained for legacy
verification; use the v2 procedure above after activation.

`search_patterns` is a read: it runs the exact local acceptance checks via
`checkProposal` against the complete verified history reaching the current tip,
all accepted patterns, and earlier successes in the same search. It returns
`{accepted:[{record,commitment}],rejected:[{name,reason}]}`; records include
`rarity`, `tier` and `total`. It submits nothing. `maxCandidates` defaults to 10
and accepts 1–60; your candidates run first and strategy candidates fill any
remaining budget. Set it to your candidate count to test just your own ideas.
The default ranks its finite pool by history eligibility and then ascending
rarity before this bounded acceptance pass; it does not enumerate the grammar.

This example projects the catalog fields. The full response also includes matching-block pages.

Worked `search_patterns` call:

```js
search_patterns({
  maxCandidates: 3,
  candidates: [
    {name: "dmwgemora", pat: "[12]", fld: 4, dt: "n"},
    {name: "dmwaurine", pat: "^2", fld: 10, dt: "n"},
    {name: "dmwdawnspar", pat: "^1d", fld: 11, dt: "h"}
  ]
}).then(({accepted, rejected}) => ({
  accepted: accepted.map(({record, commitment}) => ({record, commitment})),
  rejected
}))
```

Exact result for an empty catalog at historical tip 63, using every header from
genesis through 63 and the example public discoverer below. Live results depend
on your current complete history, catalog and identity; never use this historical
prefix to authorize a live proposal.

```json
{
  "accepted": [
    {
      "record": {
        "number": 0, "name": "dmwgemora", "pat": "[12]", "fld": 4, "dt": "n",
        "discoverer": "trac1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsj2jta5",
        "rarity": 30, "total": 34, "tier": 5, "historyHeight": 63,
        "historyHash": "00000000ebff91c88984bff39511f544a1c4ef6ec4f33e2ea531e47c2685628e",
        "fingerprint": "79869d9d67d5c1e6f765554734c81f92eb6184a62576e8aee57785a007049e77"
      },
      "commitment": "fac7a2716afaf755c6220a5abb7656c500bad81e1ea6976dddb42aa602c99bd0"
    },
    {
      "record": {
        "number": 1, "name": "dmwaurine", "pat": "^2", "fld": 10, "dt": "n",
        "discoverer": "trac1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsj2jta5",
        "rarity": 18, "total": 18, "tier": 5, "historyHeight": 63,
        "historyHash": "00000000ebff91c88984bff39511f544a1c4ef6ec4f33e2ea531e47c2685628e",
        "fingerprint": "e45c2e61b6d0511f3f726048f559e7f273957bf02433f0a2175aa74105b3f357"
      },
      "commitment": "87ac6416f2a91445c0a8694ed76779617afe66bb5552c212e22b8b14a5183095"
    }
  ],
  "rejected": [{"name": "dmwdawnspar", "reason": "pattern_constant"}]
}
```

Read `accepted[i].record` for the evaluated values. To commit a successful idea,
pass only its `{name,pat,fld,dt}` as `proposal` to `propose_pattern` with a stable
`actionId`. `propose_pattern` re-checks both the current full history and the
counted prefix before committing; a search success does not reserve a discovery.
The returned search `commitment` hashes the analysis record; it is NOT the secret
salted commitment created by `propose_pattern`. Only an accepted discovery fixes
its recorded rarity/tier. Default tiers: 5 through 100 matching blocks, 4 through
1,000, 3 through 10,000, 2 through 100,000, otherwise 1; these are not prices.

Every pattern-validator rejection is listed below, including infrastructure
checks that valid kit configuration normally satisfies. `rejected[].reason`
contains the exact error message. MCP/CLI schema errors (for example a missing
property or `maxCandidates:61`) stop the call before candidate evaluation;
correct the indicated argument. Managed MCP history returns download progress
until it is verified and current; an unmanaged stale/unverified SDK snapshot
stops the whole search, rather than returning candidate rows. Transport/cancellation errors are
call failures, not regex judgments.

| Reason | Plain meaning | How to fix it |
|---|---|---|
| `pattern_atom` | Unsupported token or misplaced anchor. | Use allowed literals/classes; remove groups, escapes, wildcards or unbounded operators; put anchors at branch edges. |
| `pattern_class` | Empty, unclosed or invalid class. | Close a nonempty class using only digits or lowercase a–f, with valid ranges and no negation. |
| `pattern_range` | Incomplete, reversed or mixed digit/letter range. | Use ascending ranges within 0–9 or a–f, such as `[2-5]` or `[b-f]`. |
| `pattern_quantifier` | Malformed bounds, minimum above maximum, or maximum above 10. | Use `?`, `{m}` or `{m,n}` with integers 0–10 and no leading zeros; require m ≤ n. |
| `pattern_complexity` | A branch exceeds twelve atoms or four quantifiers. | Shorten that branch or use a class/range; obey configured tighter limits. |
| `pattern_literal_digits` | More than six written digit literals across all branches/classes/range endpoints. | Replace enumerations with ranges or bounded runs; quantifier bounds do not count. |
| `pattern_length` | Source is empty, not a string, or exceeds 64 characters. | Supply a nonempty regex source within the configured length, without slash delimiters. |
| `pattern_alternatives` | More than four alternative branches. | Reduce branches or combine choices into a class. |
| `pattern_empty_branch` | A branch is empty or contains only anchors. | Remove empty alternatives and give each branch an atom. |
| `pattern_nullable` | The expression matches the empty string. | Require at least one character in every branch; remove wholly optional branches. |
| `pattern_constant` | Every historical block has the same match count, including all zero. | Find a motif whose counts vary over the full history; broad matches and fixed bits often fail. |
| `pattern_too_rare` | Fewer than three blocks match a nonconstant pattern. | Broaden the expression and retest against complete history. |
| `pattern_duplicate` | Its complete count vector equals an existing pattern or an earlier accepted candidate, even across fields. | Invent a different distribution; a rename or regex respelling cannot fix it. |
| `pattern_exists` | The name or assigned pattern number is already taken. | Choose another readable name for a distinct idea; refresh the catalog if numbering is stale. |
| `pattern_name` | Name violates `dmw` plus 2–29 lowercase letters/digits. | Use a short pronounceable name in the required wire format. |
| `field` | Field/format pair is invalid. | Use 4/n or 10/n; only 11 permits n or h. |
| `pattern_limits` | Supplied validator limits are invalid or try to exceed hard grammar caps. | Restore supported limits; do not loosen protocol rules. |
| `field_value` | A header field is not an unsigned 32-bit integer. | Reload verified headers; never edit a header to make a proposal pass. |
| `rarity` | Invalid rarity value or tier thresholds (requires four increasing nonnegative integers). | Restore valid local rule configuration and verified history. |
| `discoverer` | Internal discoverer key or assigned pattern number is invalid. | Use the kit's signer identity and a fresh catalog; do not invent internal identity or numbering fields. |
| `headers_length` | Header archive is empty or its byte length is not a multiple of 80. | Reload a complete raw header file and verify it before searching. |
| `history_height` | A history read is outside the available archive. | Reload a complete verified archive reaching the exact current tip. |
| `header` | Invalid raw header bytes or height while reading history. | Reload and verify the header archive. |
| `Configure a verified header history first` | No history was configured for the tool. | Configure and load a verified complete archive. |
| `Load and verify the complete header file first` | The history object has not passed verification. | Load through the kit's history verifier. |
| `Full header history must reach the exact current tip before pattern search or proposal` | Verified archive and current tip disagree. | Refresh history and retry with the same player; keep the journal. |
| `Invalid search budget` | SDK search budget is not a positive safe integer within its internal cap. | For MCP/CLI use `maxCandidates` 1–60 (default 10); keep caller and strategy candidates within one budget. |
| `Use a checksum-valid trac1… Trac address; raw hex keys are not accepted.` | SDK search owner is not a public Trac address. | Use the address returned by the kit; its error code is `trac_address_required`. |

### Payment addresses and TNK

`receiver` is the exact Bitcoin receive address selected by the owner for the
resulting inscription/token, on the current network. It remains a Bitcoin
address even when paying over Ethereum. `payer` is the owner's TAP wallet
Bitcoin address for `kind:"tap"`, or the owner's `0x` plus 40-hex Ethereum
address for `kind:"ethereum"`. Ethereum addresses are validated and normalized
to lowercase. Both dry and live kit calls decode Bitcoin addresses, verify their
checksum/witness encoding and check the configured mainnet or regtest network.
This checks format, not ownership or wallet capability. Dry-run results omit
`paymentLink`; a payment URL is returned only for a live request.

The owner sets `owner:{receiver:{bitcoin,ethereum},payer:{tap,ethereum}}` in the
local config. The agent may read this through `address.owner` but must never
edit it; no tool changes it. Omitted receiver defaults to `owner.receiver.bitcoin`
on both rails; payer defaults to the matching rail. Bitmap links use `payer.tap`.
`receiver.ethereum` records the owner's EVM receive address; current inscription
mints always use Bitcoin. Explicit per-action addresses may override defaults
without changing config. The playground fills each player's config from its
local test wallet and retains owner overrides. Payout bindings are separate: use `bind_payout_wallet` and have the human sign
on its local page. Never copy another player's addresses.

Transfers cost **TNK from the signing player's MSB account**, whose address is
returned by `address.address`. `balance` reads DMW matter, not TNK. The kit
currently has no TNK-balance or TNK-fee-quote tool; transfer dry-run's `feeSource`
identifies the signer and does not promise sufficient TNK. Inspect/fund that
MSB account through the owner's trusted local wallet. The pinned trac-msb version
charges 0.03 TNK (30000000000000000 atoms) per transfer. The built-in mainnet
adapter checks that fee, the signing player's account balance, writer admission
and three connected validators before preparing a paid transfer. It does not
fund or register the player automatically. Free puzzled moves
(headers, claims, discovery and craft) do not use TNK. TAP mint fees and Bitcoin
network satoshis are separate from TNK.

## Journal and request states

`status` reconciles recent actions from public reads. `accepted`/`rejected`
are final reported outcomes; other states describe delivery. Saved signed
packets and receipts remain intact so retries cannot resubmit a final action.
Discovery's parent action waits for catalog acceptance or a published rejection;
an accepted reveal alone only means it entered evaluation. Read `outcome.source`
and `reconciliationPending`; a witnessed audit outcome is not a contract proof.

| State | Meaning |
|---|---|
| `prepared` | Exact intent/packet saved before sending |
| `sending` | A send was started; reconcile if interrupted |
| `unknown` | No conclusive reply; retain the exact action ID and signed packet |
| `refused` | Gateway definitely refused before acceptance; retry the same action ID and intent with a fresh packet; old packets and refusal records remain in the journal |
| `received` | Gateway receipt saved; inclusion and outcome still need verification |
| `submitted` | Transaction or payment request acknowledged, not necessarily accepted, paid or complete |
| `accepted`, `rejected` | Public audit, discovery evaluation or transaction outcome reconciled by `status`; `outcome` identifies the source |

Mint and link journal entries expose `requestId` and `paymentLink`.
For a mint call `mint_status {id:requestId}` or `mint_status {id:"mint/actionId"}`.
`requestState` in the journal is the saved acknowledgement; poll for current
progress.

| Mint service state | Meaning / next step |
|---|---|
| `deployment_needed` | No reservation or payment yet; inscribe and register the supplied element/deployment phase, then quote again |
| `awaiting_payment` | Pay the quote's missing items from your own wallet |
| `partly_paid` | Some payment is seen; complete only the remaining `missing` items |
| `paid` | Every item is final; the committee consumes the reserved units once |
| `permit_issued` | Receiver-bound permit ready; the player inscribes it, paying Bitcoin fees |
| `minted` | The indexer has verified the player's inscription |
| `expired` | Unpaid reservation expired; inspect late-payment credit before another quote |

`GET /mint/<requestId>` returns the quote's `receiver`, `asset`, `amount`,
`fees`, `payBy` and `missing` items. Amounts are atomic TAP strings. The kit
converts only at the token-auth boundary. `pay_mint` rechecks `missing` before
spending. An uncertain existing payment is retained and never replaced with a
new payment. Both signed inscription transactions are saved before broadcasting.
Retry with the same request ID and private journal. Poll again after broadcast;
a transaction ID alone does not mean `minted`.

On Bitcoin mainnet the TAP burn share is sent to the unspendable
`1BitcoinEaterAddressDontSendf59kuE` as a `tt:"a"` item (test networks use the
same key hash in their own address encoding). Use the exact quoted
address and amount; it is still burned. Ethereum uses the escrow token's burn
function. Do not invent or substitute a burn recipient.

`hunting` tracks standalone headers and bundled header submissions as well as
claims. It reports `won` if a selected claim or that header’s unclaimed-pattern
draw won, and `lost` if none won (including void draws). It waits for every
claimed or header-submitted plot’s draw;
`check_settlement` remains when public evidence is missing. The stored settlement
contains per-plot wins, `source:"claim"|"header"` and provenance. Timing phases are estimates.

A mint reserves its exact units during payment. Seen payment prevents expiry.
After all items are final, the committee consumes the reserved Trac units once
and issues a receiver-bound permit with no expiry. The player inscribes later
at their own expense. The service never inscribes or pays their Bitcoin fees.
If an unpaid reservation expired before a late payment, the server re-reserves
available units or credits that payer on the same rail for the next quote.
Payments are not refunded by us. Keep the original request ID for reconciliation.

### Recover an old refused reveal

New kits record a complete, recognized refusal (including HTTP 429
`reveal_capacity`) separately from an uncertain send. Wait for the next Bitcoin
block, then repeat `reveal_pattern` with the **original action ID**. It rechecks
the commitment, witnessed reveal window and current history before signing a
fresh packet for the same proposal and salt. Received or final actions are
never refreshed. A timeout, generic HTTP failure or lost response stays
`unknown`; a later refusal cannot erase that earlier uncertainty.

Older kits discarded the error code. Recovery cannot infer a refusal from
`unknown`, a stale packet, or a missing public record. Use the following only
when the owner/session record confirms **every attempt of this exact packet**
received HTTP 429 `reveal_capacity`, with no uncertain or successful send:

1. Update the kit and restart it with the same signer directory and config.
   Keep the journal, keyring and Trac stores. Read `status` and `hunting`; if
   witnessed receipt evidence resolves the reveal, use that outcome instead.
2. Copy `move` from that reveal's `status.actions` entry, or `revealMove` from
   its paged `hunting` entry if it is older than the recent status list. Call
   `recover_refused_reveal` with the original `actionId`, that `move`,
   `status:429`, `code:"reveal_capacity"` and `confirmOriginalRefusal:true`.
   The tool defaults to dry-run; an owner-authorized `--live` session records
   the correction locally, without signing or submitting a move.
3. Repeat `reveal_pattern {actionId}` after the next Bitcoin block with current
   verified history. The original reveal window still applies. Verify its
   receipt and wait for discovery evaluation afterward.

CLI uses `node bin/dmw.mjs action recover_refused_reveal /absolute/recovery.json
--config /absolute/mainnet.json --live` with the same typed arguments as MCP.
The correction stores the owner's report as such, not as a gateway proof. It
preserves the legacy packet and state, and only accepts legacy unknown reveals
without receipts or newly recorded attempts. Never delete journals or create a
replacement action ID for the same commitment. If any attempt was uncertain,
reconcile its receipt instead of using this correction.

At the local per-tip limit, stderr prints
`waiting for the next Bitcoin block (12/12 used)` once per full tip. The command
continues waiting and checks fresh context before sending. Interrupting it
keeps the prepared intent for a later retry.

## Receipt publications and verdicts

`verify_claim` looks up the journal's receipt tip through every `/receipts` page,
loads the archived audit, verifies its hash and selects the observation containing
the exact move. It then checks the pinned gateway, current verified tip hash,
receipt root and at least three timely attestations from the independently pinned
five-member roster. It can also recover an unknown receipt from the saved move.
Discovery reveal uses the same lookup for its commitment.

On success it returns `verified:true`, `inclusion:"witnessed"`, the actual
`publication`, receipt, attestations and `reportedOutcome`. `contractCommitted`
is false unless an SDK caller supplies a verified batch root and Merkle proof;
that is independent of witnessed receipt inclusion. `reportedOutcome:"accepted"`
means the audit accepted the move, not that a claim won or has settled.

If automatic lookup cannot find it, wait for publication/indexing or supply:

```json
{"height":2214,"observation":335,"audit":{"path":"/blocks/335-2214-HASH.bin","hash":"64-lowercase-hex-hash","bytes":1994}}
```

Use the real descriptor, not this placeholder. For a claim, copy `provenance`
from `block {height:PLOT,collection:"claims",filters:{agent:YOUR_TRAC_ADDRESS}}` for the
matching `window`. Extra provenance metadata is ignored by the tool schema.
`height` is the audit's counted height (2214 in the example), **not** the receipt's
raw tip (2219), and not the batch number. `observation` is a publication ordinal.
For discoveries, read `receipts` with `filters:{height:RECEIPT_TIP}`; its `archive`
is the immutable binary audit descriptor. The SDK verifies/decodes that archive
to obtain its counted `height` and `observation`. The latest publication often
contains no old receipt. Never substitute it blindly or use an unpinned roster.

## Errors

HTTP failures identify the service, method, route and HTTP status plus code.
Transport failures explicitly say no HTTP response. Read-only calls and dry-runs
never imply a submitted action; only an interrupted live mutation has an
uncertain submission outcome. Such a retry must preserve the action ID and intent.

| Code / message | Meaning |
|---|---|
| `mint_balance`, `insufficient_balance` | Not enough spendable units; another request may have reserved them |
| `mint_count` | Pattern mint amount must exactly match the selected block's match count |
| `mint_finder` | The finder has the exclusive mint right at this counted height |
| `mint_bitmap` | The current qualifying Bitmap holder has the exclusive right |
| `already_minted` | This pattern/block slot has already been made real |
| `block_pending` | Another request has reserved the slot |
| `mint_no_find`, `mint_no_match` | The slot has no finder or the pattern has no positive match there |
| `compound_block` | Compound mints must omit block |
| `mint_replay` | This request or nonce was already consumed; inspect the existing request |
| `mint_find`, `mint_link` | Candidate/find/link evidence does not match the verified context |
| `mint_pending` | Pending mint is missing, finished or outside its completion window |
| `link_terms` | Bitmap already linked, owner is not its current holder, or link terms are invalid |
| `asset_unregistered` | Accepted matter needs a verified Bitcoin deployment; use `inscribe_deployment` for each supplied phase before quoting |
| `deployment_binding`, `privilege_inactive` | Indexed Bitcoin deployment or its mint authority does not match registration |
| `holder_unavailable` | Current Bitmap holder cannot be verified; exclusive minting fails closed |
| `finder_address_missing`, `first_maker_address_missing`, `discoverer_address_missing` | That beneficiary has not bound a wallet for the selected rail |
| `binding_nonce`, `binding_expired`, `binding_transition` | Read current binding/history; retry the saved request, or use a new action ID for an expired or superseded request |
| `request_expired`, `plot_expired` | The signed admission deadline has passed; reconcile that request first |
| `list_path_missing` | JSON pointer has no such position in the returned source page; preserve source filters, sorting, cursor and limit |
| Invalid Bitcoin receiver/payer, Invalid Ethereum payer | Address format, checksum or selected rail/network is wrong; obtain the owner's correct address |
| `chain_mismatch` | Window or draw hash changed before settlement; this void event awards no units |
| `invalid_cursor` | Cursor belongs to another query or gateway run; restart traversal |
| `unknown_parameter_KEY`, `invalid_sort`, `summary_accepts_only_limit` | Wrong filter/sort for the route; select a collection and use [READS.md](READS.md) |
| `not_found`, `request_not_found` | Route/public record is absent or not indexed yet; check ID and indexing |
| `response_limit`, `invalid_json` | Service returned an oversized or malformed response |
| `reveal_capacity` | This Bitcoin block's reveal allowance is full; retry the original action ID after the next block |
| `ECONNREFUSED`, `TimeoutError` | Local service is stopped/unreachable or missed its response deadline |
| Full history must reach current tip | Refresh verified history; resume the same player/session identity |
| Receipt missing from witnessed observation | Wait for publication or supply the original descriptor above |

`mint_rights.allowed` tests current rights, balance and holds. It does not promise
successful inscription deployment, correct payment addresses or service health.
Use `mint_quote` before preparing the request, and preserve service codes when
reporting an operator-side problem.

## Replay and balances

`backtest` records snapshot proof, `catalogIds`, `catalogSize`, `settings`
(`claimsPerWindow`), and opponent addresses/count. It freezes the catalog known
at start, recomputes rarity on the history prefix, excludes future discoveries
and takes claims across all counted history. Earlier finds cannot win again.
The last two windows remain unsettled. Reorgs and fees are not modeled.

“Confirmed balance” means settled, credited, spendable matter reported by
`balance`/the Trac balance read, after reservations. It adds no extra confirmation
count beyond the game's counted settlement rule. A claim receipt or an estimated
future win is not spendable balance.

For a pattern's first mint, a quote returns `deployment_needed`, `payable:false`
and the current deployment plan. No mint payment or reservation exists yet.
The first minter uses `inscribe_deployment {asset,maxFeeSats,feeRate?}` from their
bound local Bitcoin wallet. First it inscribes the supplied element text; an
existing indexed element with the same `(pat,fld)` is reused. Once included in a block, repeat the action to register that phase and fetch the exact
`dmt-deploy` JSON with its indexed element ID, allocated ticker and committee
privilege authority. Repeat for the deployment, then request the mint quote.
Occupied names and tickers receive allocated replacements. Keep the same wallet
and journal across retries; each phase has its own durable attempt.

A compound's first maker uses the same action for its `token-deploy`. TAP Wallet
in the console supports both pattern phases and compound deployments. Register
an existing inscription with `register_deployment {asset,phase,inscription}`;
`phase` is `element` or `deployment`. Registration sends no Bitcoin transaction.
The service verifies indexed content, confirmations, receiver and authority
before any mint permit can be issued. All inscriptions remain player-funded;
the kit defaults to dry-run.

## Bind a payout wallet

Run `bind_payout_wallet {actionId,rail,address?}` in live mode. Give the returned
`bindingLink` to the human; the agent never signs for the human wallet or asks
for its private key. The human reviews the exact request, signs through the TAP
wallet (BIP-322 simple or TAP Wallet's legacy message signature) or MetaMask
(`personal_sign`), then confirms.
`payout_binding` reads current and historical public proofs. A dry run signs
nothing and returns no link. Reusing an action ID preserves the exact packet;
use a new action ID after expiry or for an intentional address replacement.
Each rail is independent. Bind both to receive both TAP and Ethereum payouts.
Older kits can display a legacy TAP Wallet binding through `payout_binding`,
but must update the shared `rules/src/payout-bindings.mjs` verifier to reconcile
its pending action or request a replacement binding. No dependency change or
wallet/journal migration is needed. Existing BIP-322 and Ethereum proofs remain
valid. A legacy ECDSA proof cannot be converted into BIP-322 without another
signature from the wallet.
Accepted bindings remain valid after request expiry. Existing mint quotes and
releases retain their original destinations after a replacement.

The local playground binds its bots and selected kit players using private local
test wallets through this same API. An existing human binding is preserved.

Bitmap links cost the base price multiplied by the link multiplier, in TAP.
Read the live `public_status.feePolicy` (`baseFee`, `unit` and `feeSettings.link`)
and the request’s saved `terms.feeSettings` and quote for its price. Existing signed mint
quotes and admitted link requests keep their original price when settings change.

TAP Wallet 1.0.48 supports Mint through `singleTxTransfer` and Bitmap links
through its authority and lock/claim APIs. The browser prepares a fresh link
before payment and sets up a global authority when needed, with separate wallet
approval for activation. Review its all-token scope and Bitcoin fees.
An interrupted payment keeps its saved receipt or uncertain attempt; it is not
automatically paid again. In 1.0.48, pending action orders may require a wallet
update because the wallet queries a different service from the one that created
them. Keep the same request and order when resuming.


Local matching-block pages: `search_patterns` now includes `searchSnapshot`,
`localMatchCount`, real `matches` (decimal height/count and canonical hash),
`localResultId`, and `nextCursor` for each accepted local candidate. Continue with
`pattern_search_matches` using the same proposal and cursor (page size 3–200,
default 100). Cursors retain the original snapshot across restarts and later
headers, and refuse a replaced canonical snapshot. These are local search
results, not finds or an exhaustive server catalog. The existing action journal,
salts and signed packets are preserved. When an accepted activation manifest
selects v2, the kit uses signed named-evidence moves and pinned commitment
settings. Its independent notary/proof adapter must support that version;
otherwise it refuses with upgrade_required. Never treat a gateway receipt as
accepted batch inclusion. Before activation the historical v1 flow remains.

## Crafting with activated v2 rules

`craft({actionId,recipe,inputs})` accepts `p2:<decimal number>` and
`c2:<64 hex commitment>` assets. The effective settings set the input count,
normalized ratio and packet budgets. The kit verifies a bounded preview against
the independently accepted catalog root, then saves the canonical snapshot,
exact input properties, output commitment, account revision, nonce and signed
spend before sending. Scaling every input by the same factor scales the output
quantity; it does not change the normalized recipe at that snapshot.

A delivery receipt means awaiting acceptance. Only an accepted batch spends the
inputs and credits the output. Overspending, a reused nonce, a stale account
revision or changed input metadata cannot spend different units. A timeout keeps
the exact signed action; retry its action ID. Reconcile a rejected or expired
spend before preparing a new intent. A new intent must never be used to bypass
an unknown result.

Mass and known-match fractions remain exact expression commitments, with no
maximum generation. A tier may initially be unresolved. Call
`refine_compound({actionId,asset,steps?})` to perform bounded comparison work;
`steps` defaults to the effective `compoundWorkBudget`. If the named proof budget
refuses that much work before a receipt, use a smaller step count under a new
intent after confirming the refusal. Resume an uncertain step with its original
action ID. After each accepted step, a new action reads the accepted cursor;
`state:"complete"` returns the exact tier. Anyone may continue this work, and it
spends no matter. Restarting preserves all accepted progress. The tier uses the
original snapshot and thresholds, including exact threshold equality; refinement
never changes the compound ID or its parent's properties. An unresolved tier
must not be guessed for a fee quote.
# Accepted fee credits

`use_credit({actionId, credit, request, items:[{fee, amount}]})` allocates part
of an accepted credit to an open request. `transfer_credit({actionId, credit,
to})` changes its owner; `to` is a Trac address. The kit reads ownership and the
current revision from its independent notary client before signing. Reuse the
same action ID after uncertainty: the saved signature and revision stay intact.
`financial_action_status({id})` reports accepted or queued work.

Fee keys bind the network, rail, token, role and destination; custody keys also
bind the beneficiary. A credit cannot pay a different kind of fee. Old accepted
keys remain valid under their original terms. These actions transfer accepted
credit only; they do not send a wallet payment or automatically spend money.

For beneficiary fees held by an explicit custodian, use
`claim_custody({actionId, id, destination})` to sign a claim after reading the
accepted liability from your independent notary. `custody_status({id})` returns
its state and the exact payout plan for the custodian. The custodian sends that
plan from their own wallet, then calls
`report_custody_payment({id, reference, index})` with the transaction/inscription
and output/event index. Reuse the original action ID after uncertainty. Claims
and payment reports never automatically send funds. Direct transfers cannot be
declared revoked by a timeout; retry the same claim and verify its outcome.
