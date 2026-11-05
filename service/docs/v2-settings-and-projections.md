# Settings amendments and v2 public projections

This is an implementation note for the unreleased v2 branch. Production startup
still refuses with `v2_release_incomplete`.

## Settings

The existing notary administrator proposes a complete successor document with
`ad_settings {document}`. The document must extend the current revision hash,
advance its batch boundary and preserve the network. Settings amendments use their own batch and Bitcoin boundaries, without the
generic administrator delay. Anyone can apply the accepted
proposal with `ad_apply {id:"settings"}`. Application authorizes the successor;
the first batch satisfying **both** boundaries installs it. Until then, batches
continue under the current document. Ordinary `ad_set` cannot bypass the v2
document.

The notary retains each authorized document at `v2/settings/<hash>`, and exposes
the current and scheduled documents in `dmwRulesContext`. `dmwSettingsByHash`
provides historical point reads. Signers select the effective document from their
independent notary snapshot and authenticate historical documents required by a
proposal. Gateway cold starts load the current pointers and fetch retained
documents by hash, without loading the entire revision chain.

Segments retain their original document. Claims retain their window's allowance;
finds record `settingsHash` and `finderUntil`, including deferred header awards.
Commitments retain their original reveal rules. Quotes may record `settingsHash`;
their original time and height limits remain valid after later revisions. New
v2 quotes require `feePolicyRevision` to equal the actual fee-policy hash and
require the link multiplier to agree. Fixture revision `"0"` cannot issue a v2
quote. Fee-only amendments use the existing `feePolicyRevision` and
`linkMultiplier` fields through the operator's settings procedure.
No arithmetic change or new activation constant is needed for all-one multipliers.

Round policies, archived draw policies and recorded find deadlines are included
in the accepted claim snapshot/root. Continuation reads retain authenticated
membership and absence checks. Missing original settings or named-state proof
nodes fail replay instead of rejecting an acknowledged move. The shared mint
rights check uses a revisioned find's recorded decimal deadline; verified quote
terms retain their original settings hash when passed to financial consumers.
The financial executor refreshes transport/account limits from the effective
batch document and retains the signed reservation's original terms commitment.

Revisioned quote and acceptance heights are canonical decimal strings; legacy
quotes retain their original numeric encoding. Validation converts caller
heights at this explicit boundary and preserves the signed original window.

The gateway fences admission at the authorized successor boundary, reconciles
uncertain drafts first, and resumes the durable cutoff after restart. A quorum
certifies the accepted claim checkpoint and the complete original receipt and
segment range. A reservation batch and its immediately following execution
batch carry those receipts under their original document, without moving their
Bitcoin windows or rewriting their signatures. Empty cutoffs advance a witnessed
empty segment. Renewals cannot introduce unrelated financial transitions.

New deployments may pin `v2.receiptProtocol:1`, `v2.gateway` and
`v2.receiptSigners` to require durable quorum admission/fencing. The gateway
config must match those pins. A restart cannot retrofit this protocol onto an
older deployment, and these pins do not authorize a capacity reduction.

All fourteen guarded execution/proof reductions still refuse with
`settings_capacity_drain_required`, including `receiptSegmentEntries`. A cutoff
can exceed its original observation or execution envelope even when the
successor only reduces the admission count. Renewal across multiple batches and
general renewal of outstanding claims, quotes, reservations, credits and exits
into smaller envelopes are unfinished. The current single-execution renewal
is usable only when the complete immutable cutoff fits its original envelope.
An empty gateway queue is not authenticated completion evidence. No local
resource change authorizes dropping a receipt or moving a deadline.

`GET /receipt-renewals/<id>/<observation>` returns an immutable proof descriptor
by a single indexed lookup after local acceptance. It binds the reservation and
execution batches, the audit leaf and each original receipt's cutoff membership.
The kit fetches these bytes when `renewal` supplies independent `batchRoot` and
`settingsByHash` readers; gateway proof data alone never establishes acceptance.

Activated runtimes accept local resource documents from version 3 onward. Versions 1 and 2
remain verifiable for retained records. Version 3 adds source response/retry
budgets, history/replay/archive caches and timeouts, signer request size, HTTP
timeouts/rates, asset work queues and sponsorship ceilings. `runtimeResources`
maps these settings; `configuredResources` applies the reader settings to both
gateway and independent signer startup. `runtimeCapabilities(document, resources)`
checks whether the local envelope can process the selected consensus document.
Readiness requires three replies naming that settings hash and schemas
integer 2, batch 2, file 5 and receipt 2. Insufficient capacity prevents new
admission. Retained resource hashes remain available with reservations.

Version 4 adds relay observation page size and committee health, readiness,
request, response, status polling and history-page limits. The same observation
page limit applies to new production and queued reads. Reducing it retains queued
rows across restart. New polling intervals apply to resource-configured clients;
legacy clients retain their caller-driven polling behavior. The same v4 document
also includes closure work/read/byte throughput estimates and timeout padding.
They derive replay, preparation, evidence and signing-session deadlines from the
consensus chunk budgets. Bounded closure requires the complete v4 field set;
retained v1–v3 resource documents keep their original hashes and validation.

Closure checkpoints retain the draw seed and authenticated progress across
batches and restarts. New claim/header admission reserves pending pairs, bytes
and windows before writing a receipt; exact retries recover their existing
quorum acknowledgment even when the backlog is full or admission is fenced.
Renewal preserves original receipts and settings. Its batches sum closure work,
reads and bytes across all observation chunks and split before exceeding any
whole-batch limit, while idle receipt segments add no closure cost.

Sponsorship is disabled in the launch resource profile. `sponsoredSender` takes
the minimum of the resource ceilings and separately authorized owner funding,
reserves an exact transaction before sending, and retries the same reservation
after a reduction or restart. Counts and atomic amounts are decimal strings;
`status()` reports the remaining transaction budget and runway threshold. This
hook does not authorize funding or live sends.

Financial integration should select `effectiveSettings` from independently read
current/scheduled documents for each proposed batch. `accountSettings(document)`
maps account, proof, payment-page and lock limits. Root-account authorization
and fee-credit `until` fields, plus new hashlock `refund` heights, must be decimal
strings when execution height is decimal. Existing locks compare their stored
absolute refund height. Signed quotes and accepted obligations retain their
original document; changing the execution envelope cannot reprice them.

## Public reads

Accepted v2 events update sparse decimal-keyed occurrence rows and persisted
catalog/agent projections in resumable phases. Event cursors and page changes
commit atomically. Pending fences name the affected asset, owner, block,
catalog or ranking scope. A queued attribution correction retains both owners'
fences. Unrelated jobs and other assets do not invalidate a collection cursor
or its serialized response cache. Cursors survive normal restart.

Craft events carry their exact compound records into `catalogTypes`. Accepted
tier refinements add `tierProgress` without rewriting the committed recipe.
Mint and link acceptance writes also retain a `feedBlockChanges` entry in the
same transaction. Feeds consume these bounded entries through `markBlock` after
restart and retain them on publication failure. Individual find, discovery,
craft, completed mint and completed link events have durable identities; their
agent scores advance with the resumable event cursor in the same transaction.

Catalog, agent, world/map, explicit finds, events, result collections and pinned
ranking highlights use SQLite indexes. Work pages have independent row/byte
budgets, may have `total:null`, and may contain no selected rows plus a
continuation. Exact primary filters select an index; secondary filters run
over a bounded candidate window. Owner rights walk only the owner's balance
asset keys and corresponding awarded slots; a named asset supports diagnostics
without a balance. Compound candidates come from owned compound balances.
Implicit unmaterialized header awards remain separate window evidence.

`/bitmaps/submit` verifies a named block/inscription against a consistent source
snapshot and accepted wallet binding. Inventory reads never subscribe to wallet
history. Submitted items refresh in bounded maintenance; stale ownership cannot
authorize a public eligible result. Actual mint/link authorization keeps its
independent named checks. The local keyed deployment registry is projected in
bounded pages; a changed registry revision makes unrefreshed entries unknown.

Account execution publishes changed balances, owner account-head markers and
per-asset materialized supply atomically for credits, crafts, transfers,
reservations, consumption and refunds. Terminal import seeds the same rows
after verifying the complete snapshot. Accepted financial write sets also
publish sanitized mint, link, payment, credit and custody results, payout
liabilities, event intents and quarantine counts. Public results page these
indexes without reading chain sources. Recovery and quarantine markers prevent
affected rows from being represented as current or eligible.

Burn totals count each independently verified v2 payment receipt once, even
when allocation spans pages or its remainder becomes credit. Terminal import
labels historical allocations whose old commitments lack fee roles as unknown
legacy burn. Materialized matter supply includes held balances and excludes
unmaterialized awards. A durable bounded registry cursor separately refreshes
treasury address balances and bridged ERC-20 supply from named, anchored source
reads. Completed snapshots carry their verification times; unavailable sources
retain the previous snapshot. Public views never trigger this work. The v2
activation release guard remains in place.

Preexisting v2 stores require the explicit offline script
`node service/scripts/migrate-public-projections.mjs STORE_DIRECTORY`.
It resumes an exclusively locked, paged rebuild. HTTP reads never rebuild
indexes or silently treat an unmigrated store as empty. Account proof reads
still require independent notary-root verification.

Pattern symbols are permanent public display metadata. `catalogPatterns`,
`/patterns`, `/table` and public discovery records include `symbol`; committed
pattern definitions and authenticated evidence do not. Assignment strips the
`dmw` prefix, uppercases the first character and tries each later character in
name order, then ordered pairs of later characters, and so on. Accepted names
can contain digits, which remain characters in the spelling. The first unused
spelling wins. If every spelling is occupied, projection reports
`pattern_symbol_exhausted` rather than reusing another pattern's symbol.

The `publicPatternSymbols` registry has unique indexes for assets and symbols.
Updates, deletions and public-index rebuilds retain reservations. Discovery
events allocate in numeric pattern order before chunking. On the first store
open after this change, `pattern-symbols-v1` fills existing catalog records
before replaying pending journal discoveries. It first queues catalog
identities, then assigns in numeric order, committing at most 128 records per
page with resumable progress. No header/find history is scanned. Subsequent
opens check the completion key; reads never run the fill. Preserve this registry
with the store when backing up or rebuilding public projections.

## Header distribution

Version 2 header manifests point to immutable content-addressed binary-tree
nodes and raw/gzip chunks. Appending touches new chunks and bounded tree paths;
reorgs replace the affected suffix. Durable reference counts retain configured
manifest generations and collect old nodes in bounded maintenance. Publishing
the root follows immutable-file fsync. Range, ETag and HEAD reads never contact
the source. The host header API opens the verified gateway SQLite chain read
only; the gateway store must exist before that role starts.

The kit verifies chunk descriptors/hashes, range responses, gzip output size,
Bitcoin chain rules and an independent canonical tip before replacing its
history. The operator signs manifests with an independently pinned Ed25519 identity.
Explicit pin rotation, monotone epochs/sequences and downgrade rejection retain
trust across restarts. Interrupted chunks remain pinned until a signed successor
abandons them; bounded indexed cleanup collects unused owned cache files.
See [header-distribution.md](header-distribution.md) for trust and resource settings.

A private seed checkpoint binds file identity, nanosecond modification/change
times, consensus parameters, the full initial checksum and validated endpoint.
An unchanged seed restart reads zero seed bytes. Changed/appended files rehash
and verify their full contents, reusing already validated database headers.
Import checkpoints commit after each chunk, allowing interrupted imports to
resume without rehashing the already checked prefix. Authenticated immutable
seeds avoid the initial whole-file checksum pass. Legacy and decimal storage
layouts have separate checkpoint identities within the shared implementation.

Integration with G4b: wire header chunk settings (`chunkRows`, `chunksPerTick`,
`manifestRetention`, `garbagePerTick`, `cacheSeconds`) and the kit descriptor
budgets through the shared resource lifecycle; finish header/SQL integer
boundaries. G3b/G3c must publish all balance/head/result/summary deltas, including
terminal import and reversals. The combined 500-agent mixed workload remains
an independent release gate; 500 public reads alone do not satisfy it.

## Recovery and integer boundary

Gateway and signer reader configuration accepts
`financialChain: { shallowReorgLimit: 6, rebaseBatchLimit: 1024 }`. The defaults
allow six losing Bitcoin headers and a gap of 1024 accepted batches after the
anchor batch. A zero header limit disables rebasing; a zero batch limit permits
only an anchor in the latest accepted batch. Set the same values for every
reader. This is operator configuration because accepted settings documents
reject additional keys without a contract parser release.

A shallow rebase requires the current stamp to be canonical, a fork point
within that header budget, and complete accepted provenance without money
evidence. The reader inspects the accepted batch named by `fp/chain`
provenance, including all inputs before and after the pointer. Its checkpoint
chain must start at a proved canonical boundary and end at the current financial
anchor. Only reservations, capacity reservations/releases, and credit expiries
with no money evidence qualify; unknown operations, payments, receipts, custody,
escrow, refunds backed by external evidence, surplus and public/bulk funding
remain fenced. The normal checkpoint records the new canonical anchor and the
hash of the previous losing anchor. Ethereum verification is unchanged.
Unfunded beneficiary allocations in reservation fee terms are allowed; a
custody payment key, claimable state or settlement proof is refused.

Deployment-open and deployment-add inputs also qualify only when the reader
independently proves the named inscription's reveal transaction is confirmed
in the current canonical chain at or before the stamp tip. The existing Bitcoin
inclusion adapter verifies the transaction, block and retained header view;
the accepted input's old confirmation count is insufficient. Missing,
unconfirmed, unavailable or orphaned reveals refuse rebasing. Each reader
caches one successful inclusion per deployment with the anchor proof. A new
stamp must still contain that verified block; no transaction is fetched again
per input. A transient source failure can retry without rereading accepted files.

An unchanged checkpoint does not update existing record provenance. The reader
therefore authenticates every subsequent accepted batch through the pinned
accepted tip, within `rebaseBatchLimit`. Financial inputs must bind exactly to
the file's operation suffix. The remaining operations may contain only ordinary
game account actions: credits, crafts, transfers and compound merges. An
unannotated `fp` operation or financial account action such as `reserve-n`,
`consume`, `release-many` or `refund` refuses recovery. Bound financial inputs
at the unchanged anchor must satisfy the same money-free rule as the anchor
batch. No unaccepted local financial state proves safety.

Each gateway or signer reader caches a compact authenticated proof by losing
anchor identity. Concurrent and subsequent inputs reuse verified batches;
advancing the accepted tip verifies only the new tail. Restarting a reader
rebuilds the bounded proof. Missing headers/archives, over-limit gaps, unknown
effects and incomplete predecessor chains retain
`financial_chain_recovery_required`. It never searches before the provenance
batch or beyond the configured gap.
No contract change, settings amendment, state rewrite or automatic financial
recovery is performed. Both the gateway and signers need the reader code.

V2 journal progress uses canonical decimal strings in a separate SQLite TEXT
checkpoint. Existing numeric journal frames remain readable. New writes and
recovery compare/increment without Number conversion, including counters beyond
2^63. Legacy writers fail rather than round at the safe-number boundary.

V2 branch views and replay workers share the current canonical prefix and retain
only the changed suffix; cached prefix anchors are checked again after a reorg.
Legacy branch replay retains its original complete-ancestry behavior.

The activated path now emits decimal batch sequence/epoch/height/deadline and
observation fields. Beacon heights, revisions, window/settlement cursors,
claim/header counts and agent identifiers use exact comparisons and increments.
Bounded array positions, byte counts and protocol header words remain numbers.
The terminal import reads legacy records without rewriting their bytes; new
state follows the manifest's integer schema. Prototype fixtures without the
activated document retain their earlier numeric representation.

`Store.countUint()` reads decimal materialized counts; `hasRows()` is the boolean
form. Legacy `count()` explicitly refuses beyond its numeric capability.
Height keys retain old padding through 16 digits and use length-ranked text
above it. Activated branch tables use TEXT keys. `BitcoinViews` uses the selected integer schema: activated readers retain a
separate decimal layout with exact catch-up cursors and binary ancestry links
for named reads. Both layouts share verification, catch-up and seed checkpoint
implementation; `DecimalBitcoinViews` is only a compatibility constructor. Its pending work survives reopening. It does not silently
reinterpret the old SQL INTEGER layout. Bootstrap from the retained header
archive is an explicit offline stream.

Activated audit/receipt filenames use content hashes so long decimal fields do
not exhaust filesystem component lengths. Contexts also use their content hash
and a named sequence descriptor; legacy filenames remain unchanged.

Activated signer journals write decimal indices while preserving the bytes and
MACs of the numeric prefix. Reopening a decimal tail continues in decimal form.
TSS configuration, worker requests and vaults accept canonical decimal epochs;
legacy numeric ceremony encodings remain unchanged. Rotation/health comparisons
use exact integers. Unsafe bare numeric epochs are rejected at the Go boundary.

Activated source snapshots and saved Trac cursors expose decimal revisions.
Decimal-capable source adapters receive exact seek strings. Existing Hyperbee
adapters still require safe numeric seeks and explicitly refuse beyond their
capability; changing this API does not remove that dependency's internal limit.
The full S23 gate remains open for that dependency and remaining legacy
financial/public interfaces. These fixtures do not certify a live migration.
