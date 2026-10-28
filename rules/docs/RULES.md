# Deterministic matter rules

This ESM library runs in Node and browsers. It contains no network client in its
runtime graph. Header download, benchmark, simulation and export commands live in
`scripts/`. Node commands use 24.22.1; dependencies are pinned in `package-lock.json`.

## Fungible matter and all-history claims

A pattern has one opaque asset ID, `p` followed by its number in base 36. A winning
find for pattern X in block B credits **count(B,X)** integer units of X. Find IDs
identify attribution in audit files, never individual contract assets. Only
non-void settlements create supply. Balances are decimal integer strings.

Every counted historical block is available for claims at any time. The current
new tip is also eligible in its own claim window. There is no opening schedule,
old-block lottery, charter fee, or global limit on winning finds. The per-agent
rate setting `claimsPerWindow` defaults to four distinct slots and may be 1–64.
Repeated finds for the same owner and asset aggregate before reaching the contract.
Initialize replay with `{lastTip:firstObservedTip-1,counted:checkpointHeight}`;
`lastTip` and `highestTip` track raw observations, independently of `counted`.

The square spiral starts at (0,0), then (1,0), (1,1), (0,1), (-1,1), turning
counterclockwise. Integer inversion covers unsigned 32-bit heights exactly.

## Claims, receipts and settlement

A claim window starts on first observation of tip H. Claims enter at H or H+1;
observing H+2 closes it permanently, even if a reorg subsequently lowers the tip.
The first observed H+3 hash decides draws. Settlement waits until H+3 is both
counted and confirmed on the current branch. A changed window or deciding hash
voids an unsettled event without issuing units. Already accepted credits stay final.

Each signed claim lists increasing block heights and increasing pattern numbers.
The wire allows up to 64 plots and 64 selections per plot; the smaller per-agent
window budget applies across all signed receipts and plots. Duplicate selections
have one ticket. Conflicting selections by the same agent for a plot invalidate
that plot. Exceeding the total budget invalidates that agent's whole window, so
arrival order cannot choose the surviving selections. Already-found slots are
rejected both on intake and at settlement, including when an earlier window
settled during the waiting period. Other past claims may target any block at or
below the window's counted-height snapshot, plus that window's new tip.

Every eligible slot wins: a lone claimant receives it, and multiple distinct
claimants draw uniformly using rejection sampling and the `claim-v2` domain.
Only unclaimed, unfound slots of the new tip enter the separate `header-find-v2`
draw among its correct header senders. Old headers never enter this fallback.
No sender and no claimant leaves the slot unfound and unmintable, available for
a later historical claim. Every winner receives the exact match count once and
ordinary finder mint rights. Records carry `source:"claim"|"header"` and their
claim `window`. Header participants have deduplicated `{block,agent}` tickets.

Moves have shape:

```js
{v:1, network, a:agentPublicKey, t, b:anchorTip, h:anchorHash, p:payload, w:puzzleNonce, sig}
// Claim payload:
{window, plots:[{block, patterns:[patternNumber]}], header:{height,raw}} // header optional
```

Supported move types are `header`, `claim`, `discovery-commit`, `discovery-reveal`,
and `craft`. Plain `proposal` moves are rejected as `move_type` during validation,
parsing and signing. A proposal is accepted only inside a `discovery-reveal`
payload. Ed25519 signs
`SHA256("dmw-move-v1|" + network + "|" + canonicalJSON(unsignedMove))`. The computing
puzzle requires 12 leading zero bits by default in
`SHA256("dmw-puzzle-v1|" + canonicalJSON(unsignedMove))`. Its nonce is bounded hex.
The anchor must be on the observed chain and no more than two raw tips old.

Each gateway receipt signs `{v:1,network,gateway,tip,hash,sequence,move}` with the
`dmw-receipt-v1` domain. `move` is the move digest. The gateway persists a global
monotonic receipt sequence and its highest observed tip. Pass that highest tip to
`signReceipt`; the committee independently enforces the irreversible cutoff in
its event state. A receipt promises inclusion, not validity of the claimed find.

At each tip, receipts in sequence order form a count-bound Merkle tree. A signed
`dmw-receipt-root-v1` certificate binds network, gateway, tip hash, count and root.
`receiptProof`/`verifyReceiptProof` expose inclusion proofs. `processBlock`
verifies the seal, every receipt, every move signature and puzzle, and records
rule rejections. Omission of a receipt changes the published root. A signed
receipt with no inclusion in the published root is evidence of gateway omission;
receipts cannot cryptographically prove when a gateway first learned a header.

`processBlock` observes one tip at a time. It accepts the counted height/hash
separately, plus `confirmed` from the contract head (default `min(counted, tip-5)`),
and also accepts a re-observation at or below the greatest seen tip
without creating additional windows. Call it for every observed new raw height;
gaps in that observation clock are refused. Counted height can repeat or jump forward.
Persist state and audit files atomically. Version 4 files bind a monotone
`observation` ordinal, `previousHeight`, `height`, raw tip/hash and `confirmed`.
Use one immutable file per observation, including repeated identical tips.
`height-hash` alone is not a unique filename during a stall.

`buildBatch` chains each file's `previousHeight` to the preceding file's height
(or `lastTo`), and requires consecutive observation ordinals. Coverage remains
`from = lastTo + 1`, `to = lastFile.height`. At least one counted height must
advance: a stalled-only prefix is buffered until progress makes a contract batch
possible. One batch can cover a counted jump, many heights, repeated observations
and fork changes. Replay must use each observation's own independently verified
chain snapshot, including hashes at earlier event heights. A single final-chain
lookup cannot reconstruct an old-branch observation.

The builder retains every file in its ordered Merkle root. It also emits two
constant-size records: `receipt/batch/N` commits binary
`{observation,tip,hash:tipHash,seal:receiptRoot}` rows, and `finds/batch/N` commits
binary `{observation,height,settlements}` rows, with N in base 36. Find attribution
and every window's claims and winners remain in the files. Consecutive credits
aggregate by owner and asset; debit/reservation barriers preserve replay order.
Default bounds are 512 observations, 1,500,000 total audit bytes (hard maximum
1,800,000), 98,304 signed batch bytes, 512 operations, 4,096 asset touches and 16
notary records. Recovery shares these limits across all observations. Both
`buildBatch` and `batchOperations` require version-4 files; missing, unsupported
or mixed versions fail with `batch_file_version`.
The rules processor does not submit transactions or run a gateway.

## Mint rights and pending requests

`mintRight` is a deterministic committee check. For a settled find at counted
height F:

1. Until, but not including, F+1,008, only that find's finder may mint.
2. Thereafter, if the block's permanent Bitmap link height is **strictly less**
   than F, only the Bitmap's current holder may mint, with no deadline.
3. Otherwise anyone may mint with enough of their own X units.

The current holder is an input obtained at request time. The integration must
resolve verified Bitmap ownership to the request's Trac owner key; the rules
never cache a previous holder. Missing holder data fails closed for an exclusive
Bitmap right. Link records contain block and link height and survive transfers.

`mintCandidate` requires a find with a real finder, plus a positive match count
in the current verified header. Missing finds fail with `mint_no_find`. Recounting
a rewritten header retains original attribution. Existing units or a Bitmap link
do not make an unfound slot mintable. The finder window begins when its credit
is included; there is no synthetic finderless candidate or absent-finder burn.

A pattern mint request names exactly one block and consumes exactly that block's
match count. Its asset, block and amount must match the find data. The request is
always owner-signed. `acceptMintRequest` also checks the owner's available
balance and current indexed mint status. Invoke it in accepted contract order
and persist its returned hold atomically with acceptance. The first accepted
request holds an asset/block pair through its recorded expiry. A new nonce gives
a new digest ID; a stale completion cannot settle that replacement.

A signed `POST /mint/quote` reserves the requested Trac units and returns
`requestId`, `receiver`, `asset`, `amount`, `fees` and `payBy`. Every fee is an
atomic TAP item `{role,to,ticker,amount,tt}`. `fullFees` and `split` show the full
price; a recipient who is also the payer is omitted from `fees`.

The player pays the fee items before any permit exists. Status moves through
`awaiting_payment`, `partly_paid`, `paid`, `permit_issued` and `minted`, or
`expired`. `missing` contains only the unpaid amounts, so top-ups keep the same
request ID. Seeing a valid mempool or confirming payment pins the reservation
with `mp`. Final receipts need one confirmation. An unpaid reservation
may expire; a later payment re-reserves units when available, otherwise its final
items become credit for the same owner, payer and rail. The next matching quote
uses that credit first. Receipt use is recorded atomically on Trac to prevent
spending a credit twice.

After all items are final, `mc` consumes the units exactly once and commits the
receiver-bound permit hash and payment allocations. Only then may the committee
sign. The saved permit has no expiry and `GET /mint/REQUEST_ID` serves the same
content indefinitely. The player inscribes it from their own Bitcoin wallet.
A successful indexed mint changes the display to `minted`; it does not debit
Trac a second time. Compound deployment content is likewise inscribed by the
first maker and independently verified before any mint permit.

On Ethereum, a confirmed deposit pins units but remains refundable. The
committee supplies `ethereumRelease` calldata; the payer or any recipient submits
it and pays gas. All direct shares and the burn must be finally released before
Trac consumption and permit signing. The checkout computes the deposit from the
remaining fees after verified credit. An Ethereum payer still needs a Bitcoin
wallet for the mint inscription.

The TAP burn share is an ordinary address item to
`1BitcoinEaterAddressDontSendf59kuE` on mainnet. Other Bitcoin networks encode
the same destination script with their network version. The independent
reader requires the exact network-specific address, amount, payer and request-bound item data.
Wallets pay the full list in one `singleTxTransfer`, or only missing items on a
top-up. Ethereum continues to use the escrow token's burn function.

### Mint inputs in observation files

`processBlock` accepts owner-signed `rq`, `mp`, `mc`, `rx` inputs. Each includes
the original request, signature, receiver and independently verified evidence.
Admission validates exact signed expiry (6–2016 blocks), rights, deployment,
balance, nonce and block hold. `mp` pins seen payments; `mc` requires a held
reservation and final payment allocations. `rx` is limited to expired unpaid
requests. At most eight inputs by default (32 hard maximum) enter the final
observation at current execution height. Balances and receipt use are projected
in operation order. `rl` is no longer a mint batch financial transition.

## Compound types and TAP permits

Fee currency is TAP with 18 decimals on both payment routes. All `baseFee`,
`feeFor`, `splitFee`, commission and payment evidence amounts are integer atomic
TAP strings. `parseTapAmount` converts decimal TAP to atoms and rejects more than
18 fractional digits; `formatTapAmount` renders exact decimal strings without
floating-point arithmetic. Splits floor each share in atoms and put the remainder
in treasury. A total cannot exceed ord-tap's lock limit of `(2^64-1) * 10^18` atoms.
`tapPaymentLock` and `tapTransfer` render decimal inscription amounts; indexed
ord-tap amounts and Ethereum amounts are already atomic. Compound/matter mint
quantities below are a separate asset with zero decimals.

Each pattern unit has mass 1, charge `patternNumber mod 65521`, a three-bit field
spectrum, generation 0, and exact rational rarity
`matchingBlocks / discoveryHistoryLength`. A recipe uses two to eight distinct
asset types. Input quantities reduce by their greatest common divisor: 2A+2B
creates two units of the same compound type as A+B. The reduced recipe contains
at most 64 units, bounding arithmetic and recipe complexity.

Fusion sums mass, sums mass-weighted charge modulo 65521, unions the spectrum,
and raises each input rarity fraction to its reduced quantity before multiplying.
Generation is one above the greatest input generation. Resonance additionally
requires equal charges and divides rarity by the reduced input-unit count. All
fractions are reduced exactly. The resulting mass and rarity representation have
explicit bounds. Tier derives from the ceiling of modeled matching blocks at the
current counted history length; recipe identity does not depend on that length.

The compound ID is `c` plus 23 base-36 characters of its full recipe commitment.
The registry retains the full commitment and rejects a shortened-ID collision.
Repeated crafts add units of the same type. `firstMaker` is recorded once.
Owner-signed `xc` consumes amounts of input assets and credits an amount of the
compound asset. Before processing crafts, the integration must synchronize
`state.balances` and consumed nonces with the authoritative contract view, including
transfers and locks; the in-memory simulation has no external transactions. A
compound make-real request omits `block`.

Each compound type has one ordinary TAP token, with ticker `dmw` + compound asset
ID. It is not a DMT block inscription. `compoundDeploy` produces:

```json
{"p":"tap","op":"token-deploy","tick":"dmwc123","max":"18446744073709551615","dec":"0","prv":"AUTHORITY_INSCRIPTION_ID"}
```

`prv` must name an existing, uncancelled privilege-authority inscription. A deploy
has no separate privilege signature; authority creation and the inscription
transaction are external. Zero decimals preserve integer Trac units. TAP's token
supply limit is 2^64-1 at zero decimals. The service must check remaining TAP
supply before signing: ord-tap clips a mint to the remaining supply, which would
otherwise burn more Trac units than are minted.

`compoundRequestPermit` is the committee-facing builder. It verifies the owner's
signature, consumed pending digest ID, exact recipient
commitment (`receive = SHA256(UTF8(address))`) and remaining indexed TAP supply.
It uses the pending digest as both salt and `dta`. The pending record must explicitly prove consumption; unconsumed requests refuse.

The lower-level `compoundMintPermit` returns the inscription fields, UTF-8 bytes and SHA-256
32-byte digest to sign. The exact preimage is:

```text
tap-token-mint-TICK-AMOUNT-ADDRESS-SALT
tap-token-mint-TICK-AMOUNT-ADDRESS-DATA-SALT    (when dta is present, including empty)
```

The original ticker and amount strings are used. Sign the digest directly using
recoverable secp256k1 ECDSA; no personal-sign prefix and no second hash. The mint
contains `prv:{sig:{v,r,s},hash,address,salt}`, where `v` is recovery ID 0–3, `r`
and `s` are `0x`-prefixed 32-byte hex strings, `hash` is the digest's lowercase hex,
and `address` exactly equals the inscription owner. Use a unique 32-byte hex salt
per request. `attachMintPrivilege` accepts an externally produced signature;
`signMintPrivilege` is a local single-key reference implementation, not a
threshold-signing implementation. The committee must use the key of the registered
privilege authority. `dta` can bind a pending-request digest and is limited to
512 UTF-8 bytes.

These bytes follow the frozen ord-tap implementations in
`tap/ops/deploy.rs`, `tap/ops/mint.rs`, and
`tap/mod.rs::build_mint_privilege_message_hash` /
`verify_privilege_signature_with_msg`. The tests independently check SHA-256
preimages and recover the signing public key.

Compound fees pay first maker 30%, burn 35%, and treasury 35%. They have no finder,
landowner or discoverer share. Find fees pay finder 30%, linked landowner 15%,
burn 20%, discoverer 5% when present, and treasury the remainder. An unlinked
landowner share is burned. There is no early-opening allocation; its former 10%
stays in the treasury remainder. Each share floors independently; treasury receives
rounding remainder. Fees are integer base units throughout.

## Contract operations and audit data

`operations.js` defines validated operations, including
`aggregateCreditOp(to,assets)` for `{op:"ac",to,assets:[[asset,amount],...]}`.
`aggregateCredits` in `batch.js` combines adjacent credit runs.
`operations.js` is the request-schema and request-schema module. It uses
`contract/signing.js` for canonical serialization and owner/batch digests. The
contract's protocol document is the wire-format authority. The rules code never
edits or upgrades the contract. The library validates requests, but the contract
must independently check signatures, balances, nonce replay and expiry. Operation amounts are positive canonical
decimal strings of at most 78 digits; accumulated balances may exceed that width.

`buildBatch` requires an explicit nonnegative safe-integer `epoch` from the
contract's current `dmwAuthority()` snapshot. The epoch is included in the signed
batch digest; it cannot default to zero after rotation. Also supply the verified
application `executionHeight`, independently of historical coverage `to`.
The default signed `deadline` is six counted blocks after that height; an explicit
deadline must be in the inclusive range `[executionHeight, executionHeight+36]`.
The contract checks this range after combined headers. Changing the deadline
changes the signing digest and its bytes count toward the complete wire budget.

`buildBatch` commits compact binary audit files, validates operation equality
against their contents, and can include raw headers in `hx` for one dispatch per
counted block. Its returned digest excludes the external committee signature.
Merkle leaves hash `0x00 || fileBytes`; internal nodes hash `0x01 || left || right`;
an odd node duplicates itself. The root also binds leaf count. Empty roots use a
separate domain. Receipts' roots are present inside audit files and in notary
operations carried in the batch.

Binary files begin with `44 4d 57 02`. Canonical tagged values encode null,
booleans, safe integers, arrays, sorted-key objects and strings. Integers use
unsigned base-128 varints with a separate negative tag. Strings are interned in
first-encounter order; even lowercase hex strings of at least eight characters
are stored as raw bytes. Files are standalone and need no external dictionary.
The decoder bounds bytes/depth/counts, rejects trailing bytes and verifies the
canonical re-encoding. It preserves every move and gateway signature. Settlement
summaries retain winners and ticket counts; complete draws can be recomputed from
the referenced earlier claim files.

Audit files are capped at **1,500,000 bytes**, viewer JSON at **1,000,000 bytes** by
default. Oversized input is refused; a live gateway must enforce admission and
move-size limits before promising inclusion. The 500-agent workload bundles an
agent's plot claims and header into one signed move; signatures and individual
gateway receipts remain present. Viewer summaries omit the full signed moves.

`patternBlockPages` emits every historical block with a positive count, regardless
of find or mint status. Each page covers 4,096 heights. Its rows contain height
delta, match count, indexed mint inscription or null, finder or null, find height
or null, permanent link height or null, and found status (page schema v2). The manifest lists page
bounds, row counts, sizes and content hashes. An exporter can refresh the last
page on each new tip, and any affected page after a mint, find or link update.

## Pattern grammar and history

Patterns use the safe intersection of V8 and RE2: lowercase hex literals,
non-negated classes/ranges, anchors, bounded `?` and `{m,n}`, and up to four
alternatives. Defaults bound length to 64, literal digits to six, atoms per branch
to twelve, and quantifiers per branch to four. Unbounded repetition, groups,
backreferences, escapes, lookarounds, flags and wildcards are rejected. A proposed
pattern needs at least twelve historical matching blocks. Limits may tighten.
The TAP count oracle follows JavaScript global-match counting exactly; discovery additionally rejects nullable patterns and constant vectors.

Supported TAP fields are decimal height (4), decimal nonce (10), and decimal or
lowercase unpadded hexadecimal bits (11). Discovery compares complete match-count
vectors across all accepted patterns, including different fields. Equal rarity
alone does not imply duplicate identity. Counts, fingerprint, snapshot height and
hash are fixed at discovery. The launch table is empty. The first accepted discovery is pattern 0; there are no starter patterns. The first minter inscribes its element and deployment from their own wallet before a mint permit can be issued.

The header reader stores consecutive 80-byte headers from genesis. Verification
checks genesis, previous hashes, PoW, compact difficulty targets, every retarget
with its fourfold clamp, and median time past. The explicit HTTP maintenance
command obtains header fields from the configured blocks API, reconstructs the
80 bytes and verifies the advertised hash before writing. It retries with
backoff, paces requests, checkpoints progress, and resumes by page. No endpoint
is hardcoded into the library. An independent tip-hash check is recorded separately
from cryptographic chain validation.

## Running

```sh
source ~/.nvm/nvm.sh
nvm use 24.22.1
export npm_config_userconfig=/dev/null
cd rules
npm test
npm run test:browser
DMW_HEADERS=/absolute/path/mainnet.bin npm run test:history
node scripts/verify-headers.mjs HEADERS MANIFEST [SECOND_HEADERS]
node scripts/benchmark.mjs HEADERS ELEMENT_SNAPSHOT OUTPUT_JSON
node scripts/simulate.mjs HEADERS OUTPUT_JSON 1000
node scripts/block-lists.mjs HEADERS OUTPUT_DIRECTORY [CATALOG_JSON]
```

For a download, supply `DMW_HEADER_SOURCE` as the public HTTPS blocks API base at
runtime, and use `fetch-headers.mjs esplora OUTPUT END_HEIGHT START_HEIGHT`.
Concurrency and delay are controlled by `DMW_HEADER_CONCURRENCY` and
`DMW_HEADER_DELAY_MS`. The fixture is a local build artifact, not a package asset.

Simulation uses 500 deterministic local test keys and real historical mainnet
headers. Puzzle search is disabled in that workload, while all cryptographic
signing and verification remain enabled. It reports preparation time separately
from rule processing, audit/summary sizes, and signed batch/envelope wire bytes.
Wire bytes are not physical Trac peer log growth. The latter requires replay on
a devnet with its bookkeeping and storage overhead included.

## Witnessed intake and discovery

A nonempty observation requires `rootAttestations` from at least three distinct
members of `settings.receiptSigners`, the independently configured five-member
`[{id,identity}]` Ed25519 roster. Each witness signs
`{v:1,network,signer,tip,hash,root,count,observedTip}` with domain
`dmw-receipt-witness-v1`. It must have observed the root at that tip or the next
(`tip <= observedTip < tip+2`). This conservative deadline precedes H+3 for
both H and H+1 claims. Witnesses durably retain their highest observed tip and
one root per height; they refuse conflicting roots even after a fork or restart.
The source of that high-water mark must be an independent continuously persisted
header observer, including while no attestation request is being served.

The signer also reads the independently collected root certificate for each
observation. A gateway cannot omit a known certified nonempty root. Fewer than
three timely witnesses means no accepted moves at that tip: record an empty
missed observation, keep the window, and do not backdate a later certificate.
A repeated empty observation references the already witnessed root through
`receiptReference`; it never reapplies old receipts. A conflicting certificate
halts that observation for investigation; replay never selects one by arrival
order. Missing members may later verify the saved quorum certificate without
issuing a new historical attestation. A gateway receipt omitted before the root
closes is evidence of omission, not a draw ticket. This design assumes at least
three honest, independently observing witnesses; it does not prevent censorship
by the gateway before root publication.

Discovery uses two signed moves:

```js
{t:"discovery-commit", p:{commitment}}
{t:"discovery-reveal", p:{proposal:{name,pat,fld,dt},salt}}
```

`discoveryCommitment(proposal,salt,agent)` hashes the canonical array
`["dmw-discovery-v1",proposal,salt,agent]`; salt is a fresh 32-byte secret.
The commitment must be in a witnessed root. Reveal from commitment tip +2 through
+144 inclusive. Earlier commitment tip wins; same-tip ties sort by commitment
hash, then agent key. Receipt sequence and reveal arrival order do not decide
attribution. An earlier unrevealed commitment blocks later evaluation until it
reveals or expires. Research must remain secret until its commitment is
witnessed. A public commitment cannot be reused by another agent.

The deterministic queue has at most 64 commitments and 64 revealed jobs, and the
accepted registry is capped at 256 patterns. Each observation evaluates at most
4,096 historical pattern counts and accepts at most one discovery. Work state,
queue order and indexes persist with replay state; each audit file records work
performed, queue length and final rejection reasons. There is no wall-clock
work cutoff. The snapshot is the reveal's counted height on the replay branch.
A rewritten reveal snapshot rejects the job with `discovery_snapshot_reorg`; the author may commit again. Indexes extend over new heights and invalidate on a changed boundary hash or a shorter snapshot. Rejected candidate indexes are removed. Existing pattern
vectors are reused, including across fields; fingerprints are rolling SHA256
starting at SHA256("dmw-count-vector-v1"), then hashing `previousHex:count` for
each height. Equal fingerprints reject duplicates conservatively. Nullable
patterns and constant all-history count vectors are rejected for discovery;
the low-level TAP counting oracle retains its exact empty-match behavior.

Historical maps (`finds`, `balances`, `types`, `usedNonces`,
`linkPayments`, `links`, `receiptSeals`, discovery indexes) use flat input maps
and persistent radix indexes during the current replay lifecycle. The gateway's
`initialState`, `hotState` and `hydrateState` create flat maps from bounded store
reads; `Pipeline.build` also hydrates balances, types and consumed payments into
these maps. The first rule update wraps a flat map as a shared immutable base
with a radix path; later observations reuse that index. Both layouts are active,
not selected by a snapshot version or size threshold.

Use `recordGet`, `recordSet`, `recordDelete`, `recordSize` and `recordObject` for
either layout. Only the gateway's flat hydration stage may index maps directly.
Unchanged maps and their bases are shared; an update copies a bounded radix
path. `recordObject` explicitly materializes a flat export; avoid flattening
lifetime indexes per observation. Persist index objects between observations;
the gateway archives cold rows and clears hot maps after accepted batches.
Individual owner balance maps and active mint records remain ordinary objects.

## Execution budgets and paid links

Pass `priorOperations: budgetOperations(previousFiles)` to each observation in a
batch. Allocation counts aggregated credits and reserves space for final roots.
Crafts exceeding the budget receive `operation_budget`. All settlement types can
continue across batches without discarding any winner. The first accepted credit
freezes the draw; later deep reorgs do not redraw it. Pending rounds retain a fixed
`settlement` and `credited` cursor. A partial earlier window blocks later windows'
settlements, preventing overlapping claims from issuing duplicate supply.

Each file reports `complete`, `credited`, `total`, claim outcomes, and only newly
credited winners. Each credited find is published immediately with its own
`findHeight` and full finder week. Later segments receive their full week when
credited. The audit stores claim outcome rows; viewer summaries show their count.
Discovery work remains queued. Excess links and mint inputs remain queued with
budget outcomes. Final serialized sizes are checked before signing. Credit
vectors carry at most 16 distinct asset/amount pairs each; contract growth is
bounded by active owner/asset pairs, not by the number of historical matches.

`executionHeight` is the current authoritative counted height used for requests
in a recovery replay; it defaults to the observation height in ordinary processing.
An expired craft records `request_expired` and changes no balances or nonce.
An expired `rq` records the same result in `mintOutcomes` and emits no request op.
Keep the original inputs in the audit. Every signer reconstructs using the live
context height and preflights the resulting operations through the actual
contract transition before reserving a sequence. Final mint inputs still belong
in the last observation. A signature cannot extend an owner's deadline.

`linkOperations` has at most four entries per observation. Each entry is
`{request,sig,terms,payment,bitmap,previous:null}`. Request is
`{owner,height,nonce,until}`; use `signLink` / `linkId`, domain `dmw-link-v1`.
`verifyLinkInput` in `link-payments.js` verifies the signed request, independently
read `{baseFee,treasury,payer,hash,feeSettings?}` terms and rail-specific payment.
Ethereum also binds chainId, contract and token. Pricing uses `feeFor("link", baseFee, 1, terms.feeSettings)`,
50% burn and the remainder to treasury. Links require a completed payment, not just a refundable funded lock: `payment.consumed:true` and `settlement:{accepted:true,refund:false,paymentId,txid,confirmations}` with one confirmation. The independent reader verifies the actual release, all recipients and burn, and refuses refunds as payment. The verified current Bitmap holder must match the owner;
the permanent link must not already exist. Independent signer reads verify the
holder, prior link, terms and payment. Accepted links emit `link/<base36 block>`
with the execution height and retain the paid evidence. `linkOutcomes` records
budget deferral; rejected/unused payment refunds remain on their original path.

Mint fee items pay each nonzero finder, first-maker, discoverer, landowner and
treasury allocation directly on the chosen rail; payer-self shares are omitted.
TAP sends the burn allocation to `TAP_BURN`; Ethereum calls the token burn method.
There is no charter recipient, queue, payment custody or contract record.

## Accepted fairness and finality limits

Fairness in claim and header draws is per public key. One participant can use many
keys; the puzzle charges work and does not establish unique human identity.
There is no identity admission system. Bitcoin miners can influence draw
seeds by withholding valid headers, at the cost of mining opportunity; rejection
sampling and inclusion checks cannot prevent this influence.

Settled events are final. A later reorg beyond the accepted inclusion can reduce
a found pattern's current mintable capacity below issued supply. Excess units
remain on Trac; no clawback or unconditional backing guarantee applies.
Serialization rejects isolated UTF-16 surrogates in keys and values. UTF-8 binary
decoding preserves leading U+FEFF, including in object keys.


### Operator fee settings

The revisioned global fee policy carries `feeSettings:{link,tierMultipliers,compoundMinimum}`
in signed quotes and admitted terms. Read the live `/status` response's
`feePolicy` for `baseFee`, `unit` and `feeSettings`. Find prices in TAP use the
base price multiplied by the tier multiplier; compounds use the greater of
that multiplier and `compoundMinimum`. A Bitmap link uses `feeSettings.link`.
The base price and multipliers may change for new quotes. Verify saved terms
against their retained revision, never the current revision.
`FEE_DEFAULTS` remains the legacy fallback (including link 20) solely for
unconfigured historical terms and installed verifier compatibility. The link
split remains half burn, half treasury, with integer rounding as before.
