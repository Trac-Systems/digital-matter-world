# Activated financial lifecycle integration

This module extends the existing `FinancialExecution` queue, account overlay,
signer replay and `fp` contract operation. It is a v2 path. Legacy accepted
files and rules are unchanged. It does not enable production startup, send a
payment, create a deployment inscription or deliver a permit.

Submit `{type: "lifecycle", id, action}`. `action.id` equals `id`; its `type`
selects a transition below. The exact action shapes are checked in
`contract/financial-lifecycle.js`. Owner authorizations use the exported
`lifecycleDigest(network, action)`. Ordinary payment-credit signatures retain
`paymentCreditDigest`. IDs, receipt keys and revision checks are permanent;
retries use the same signed action.

## Independent source adapter

Both gateway and every signer call `financialEvidence(transition, at)`.
`financialRecord(key, at)` must return accepted notary values, including proven
absence, from the same pinned snapshot. Never serve gateway `accountRecords`
as the signer's independent notary view. The gateway overlay must also retain
the named dependencies needed to build a transition. Evidence is compared
byte-for-byte with the independently reconstructed result before effects run.
Native readers expose `financialScope` for sequential dependencies: each
verifier overlays only its own verified effects and reservation evidence.
The view lasts for one batch, spans its observations, and never changes the
shared reader or publishes speculative records. Full notary stamps supply
the Bitcoin anchor even when the pipeline initially names only height and batch.

The evidence shape for each action is in
`rules/src/financial-lifecycle.js`. All evidence has `requestId`. A field named
`state`, `snapshot`, `confirmations` or `revocation` is the result of source
verification, never an assertion to trust from the submitted JSON. Native
adapters must verify the following dependencies:

| Actions | Independent source checks |
| --- | --- |
| `link-reserve` | Exact signed owner, counted Bitmap height, current bound holder, original activated fee terms, absent link, deadline. `terms` hashes the whole reservation evidence. |
| `link-complete`, `link-exit` | Accepted reserved entitlement and funding root; complete allocation or exact external refund; invalidation proof if exiting before expiry. A paid reservation remains valid after holder transfer. Late execution alone does not invalidate a timely payment. |
| `credit-use`, `credit-transfer` | Exact signed existing `fp` operation and accepted revision. Fee keys must include the original role, destination, rail and token domain; they must permit reuse only for identical fee obligations. |
| `custody-accrue` | Original quote identifies an explicit approved custodian and the exact beneficiary; the corresponding fee reached that custodian in a canonical block. The consumed funding root and terms must match. Never infer custody from a missing address. |
| `custody-claim` | Owner-signed destination is valid on the pinned rail. |
| `custody-settle` | Exact claim, amount, source custodian, destination and canonical transfer output. Receipt identity includes rail/domain, transaction and output/event index. |
| `custody-reopen` | The prior payout authorization was irrevocably revoked without paying. Expiry or a timeout is insufficient. A rail without this proof cannot reopen a possibly sent payment. |
| `deployment-open` | Canonical, externally usable deployment; exact stable logical asset, external identity, generation, previous generation, maximum and limit. Registration requires a pristine deployment: zero external mints and outstanding permits, with the whole maximum remaining. Legacy used capacity requires the migration adapter. |
| `capacity-reserve`, `capacity-issue`, `capacity-finish`, `capacity-release` | Original reservation/plot and pinned deployment; recoverable original permit; exact canonical mint or accepted unconsumed refund. A mint receipt binds deployment, permit, asset, amount and plot. |
| `recovery-begin`, `recovery-page` | Complete affected financial dependency set against the accepted snapshot, both chain heads and staged archived ancestry; exact old records and their disposition. Include account/supply roots, locks, payment usage, dependent credits, spending, custody, capacity and obligations, not only the original receipt. A caller's list is not evidence of completeness. |
| `recovery-approve`, `recovery-refresh`, `recovery-finish` | Recheck the manifest and both heads against the accepted notary batch; verify actual beacon adoption before removing the global recovery fence. |
| `recovery-abort`, `recovery-release` | Abandoned, unadopted candidate; or reinstated canonical backing for the exact unchanged quarantined record. |
| `credit-repair-open`, `credit-repair-finish` | Exact quarantined credit and replacement fee terms, then independently verified replacement funding. Replacement allocations use the normal global payment-usage proof and are permanently consumed without granting another link, mint or payout. |

All external settlement evidence counts in its first canonical block. There
are no added confirmation waits. A source outage defers work and retains its
identity. Native adapters now reconstruct links, fee credits, deployment
capacity and beneficiary custody using independent notary and chain clients.
Synthetic adapters remain in planner tests. Production activation remains
refused with `v2_release_incomplete` until every release gate is complete.

## Links and credits

A link reservation opens `fp/<id>` and reserves `fl/slot/<block>` atomically.
Only after the reservation is accepted should a client release irreversible
payment. Ordinary `fund` pages then allocate its fees; their verified inclusion
height must precede the original deadline. Completion consumes funding and
writes `k/link/<base36 block>`. V2 public link fields are decimal strings.
Exit produces the exact allocated transferable credit, or records a proved
Ethereum refund without creating a credit. Surplus continues to use the
existing paged surplus path.

`FinancialExecution` runs `FinancialLinkReconciler` before readiness/build.
Its cursors and active/recovery indexes are durable and bounded by operator
`workPage`. Expired jobs leave local active slots even during source outages;
their accepted reservation and payment claim remain in reconciliation. A
fully funded invalidated job also attempts an independently verified exit.
Accepted terminal transitions remove both alternative queue intents and
release matching legacy `creditClaims`, without deleting another job's claim.

Credit spending applies immediately under the owner's signed revision, so the
new path needs no local claim lock. Arbitrarily many credits can be spent in
successive bounded pages. The remaining amount and revision of each source
credit persist after transfer, partial spending and request exits.

## Capacity and custody

Native quotes resolve missing beneficiary addresses only through explicit
`assetCustody.tap` / `assetCustody.ethereum` configuration. These must be valid
addresses on the configured rail. The accepted quote pins the beneficiary,
custodian and fee domain; later bindings cannot redirect an existing liability.
The runtime accrues each consumed request's liabilities through a durable,
bounded queue. `claim_custody` saves an owner-signed destination, and
`custody_status` exposes the exact plan for the custodian to execute manually.
`report_custody_payment` names an already sent transfer and output/event index.
TAP data and Ethereum transfer calldata bind the claim identity; canonical
source checks bind sender, recipient, token, amount and receipt uniqueness.

An accepted `fp/chain` checkpoint covers the verified Bitcoin and Ethereum
settlement prefixes. Independent readers verify both retained-branch ancestry
and independent best-chain membership of the prior anchor before any
new financial effect or detached mint permit. A fork requires reconciliation;
it cannot be hidden by replacing the checkpoint with the new tip. This keeps
partial payments and transferred credits backed without lifetime history
scans. Direct transfers have no irrevocable unpaid revocation proof, so the
native adapter refuses `custody-reopen`; a timeout never authorizes repayment.

For a new mint, include `capacity: {deployment, plot}` in the independently
reconstructed reservation evidence. The existing `reserve` transition then
reserves both matter and capacity atomically. Existing `consume` and `refund`
automatically issue/release that capacity. Once an asset has an activated
generation, both the planner and contract refuse consumption without reserved
capacity. Production adapters must register generations and require this field
for every new mint; the old fixture-only interface for unregistered assets
remains available for integration compatibility.

Capacity includes reserved and issued permits. Renewal requires the old
generation's maximum to be minted and all reservations resolved. Generation
numbers are arbitrary-size decimal strings. Old permit/deployment identities
remain unchanged, and plot keys use the logical asset across all generations.
No quantity is rounded and no capacity is freed by a permit timeout.

Custody liabilities use one deterministic ID per consumed request/fee. They
require a consumed mint obligation; replacement-backing requests cannot also
create a second beneficiary liability. They do not allocate the source payment
again. Claims retain one full-amount
payout identity; a retry cannot create another payout. `custody-reopen` permits
renewal only after proved revocation, and `custody-settle` consumes the receipt
identity once. Publishing or executing the actual custodian transfer remains
the rail adapter's responsibility.

## Deep reorg order

1. Enable the existing accepted `s/beaconRecovery` archive root. Stream `br`
   begin/append operations with archived checkpoint proofs and normal PoW,
   difficulty and MTP checks. Do not replace the checkpoint with a supplied hash.
2. Native `recovery-inventory` freezes financial mutations. Every signer reads
   complete bounded ranges of accepted financial keys from its pinned notary
   checkout. `recovery-inventory-page` binds the exact next range and chains its
   record hashes/dispositions into the manifest. `recovery-inventory-seal`
   requires an independently empty tail; a submitted list cannot establish
   completeness. `recovery-page` then reconciles these accepted pages, retaining
   all records and quarantining orphaned dependencies. Imported `fi/*` identities
   and cleared slot tombstones remain exact; import retention grants no native
   funding or replacement permit.
3. `recovery-approve` writes `recoveryApproved/<id>`, bound to both heads, the
   complete manifest and the immediately following batch. Put `br adopt` in
   that next batch. An intervening batch requires `recovery-refresh` and a
   fresh independent check. Adoption remains subject to greater chainwork.
4. After adoption, `recovery-finish` removes the global fence. Individual
   quarantines remain. A stale/abandoned candidate can instead be aborted;
   already established quarantines and financial identities are retained.
5. Canonical reinstatement can release a quarantine. A quarantined fee credit
   can alternatively open a dedicated replacement funding request, accept
   ordinary settlement pages and consume them with `credit-repair-finish`.
   Neither route changes the original credit amount or permits reused payments.

The runtime exposes `recovery.begin({anchor, proof, target?})` to the local
operator integration; it requires the accepted archive proof and an independently
observed fork. `RecoveryCoordinator` takes one bounded step per tick, pauses
ordinary batching/admission, and persists each exact draft before signing or
delivery. Recovery-only files use version 6 and preserve the accepted claim
checkpoint except its observation ordinal, including pending receipt segments.
The independent policy reconstructs every operation, claim root and envelope,
then runs actual notary preflight. Accepted `bt/last`, staged beacon records and
`b/recovery` come from the notary instead of stale gateway caches.

Acceptance wins over expiry after restart. An unsigned, unreserved stale draft
can be archived and rebuilt; signed/ambiguous drafts retain their identity until
accepted or independently expired/superseded. An intervening accepted batch
requires reconciliation of its checkpoint before approval refresh. A candidate
that loses canonical status can be aborted without deleting quarantines. Finish
records the already accepted adoption anchor before releasing the global fence.
An extension or second fork between adoption and cleanup cannot strand that
cleanup; ordinary spending still requires independent canonical membership, and
a second fork can start a fresh archived recovery. Public mint/link payment
status and custody payout plans honor recovery fences and record quarantines.
No automatic external transaction is part of recovery.

Irrevocable external mints or payouts cannot be undone by restoring a local
checkpoint. Their original identities and liabilities remain recorded. This
module does not invent a replacement permit or automatically refund consumed
matter when the original external authorization may still be usable.

## Integration boundaries

G3b supplies native evidence adapters, runtime/client routing and detached
permit recovery. It must retain these lifecycle hooks when integrating its
multi-observation overlay. G4 supplies public/account/custody/capacity
projections and settings revision integration. Terminal migration must map
the retained `fi/*` legacy identities and capacity totals into the new active
records before enabling new reservations. I1 retains complete migration,
five-signer mixed-load verification and release gating. No Ethereum escrow
contract or domain changes are introduced here.
