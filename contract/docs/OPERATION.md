# Contract operation

The contract records fungible custody, signed exchanges and mint requests,
hashlocks, Bitcoin header counting and committee attestations. Game rules,
payments and inscription evidence are verified by the service and committee.

## Clock and custody

Trac host membership controls transaction and message availability separately
from the contract. Operators must maintain admitted writers and routes, protect
and back up the host administration key, and monitor admission flags. The
contract's bounded pause does not control the host's membership settings.

Refunds, mint expiry and administrative timeouts use counted Bitcoin height.
They require advancing headers and Trac availability, with no wall-clock exit.
Header recovery supports forks whose common canonical ancestor is within 2016
blocks behind counted height. Deeper forks require a replacement deployment.
Operate redundant relays, monitor progress and fork depth, and suspend new timed
commitments when the required clock is unavailable.

Mint completion and payment release rely on the configured committee's verified
attestations. The contract checks request authority and format; it does not
verify the inscription's recipient, amount, inclusion or confirmation depth.
Use threshold signing, independent evidence checks, separate key custody and
monitoring through administration delays. Committee authority includes credits
and notary records; mint completion applies only to a live, previously signed
request. These trust requirements also apply after committee replacement.

Bitcoin inscription, Trac settlement and TAP or Ethereum payment settlement use
separate clocks and predicates. They are not an atomic cross-chain transaction.
A permanent mint permit is issued only after payment settlement and unit
consumption. Reconciliation requires monitoring each chain; a finite confirmation count remains
subject to reorganizations, and a timestamp deadline cannot guarantee Bitcoin
clock progress.

The signature schemes, SHA-256 commitments, 80-byte Bitcoin header format,
proof of work, difficulty and median-time rules are fixed. Algorithm or consensus
changes require a compatible deployment. Within the retained window, valid
proof-of-work forks have no admission cap; incremental cleanup bounds work per
header, while storage depends on accepted fork activity.

## Mint timing and consumption

Owner-signed `rq` reserves units through its absolute expiry. Only an unpaid,
unheld request expires. `mp` pins a request after independent payment observation;
if it already expired, it debits available units again. Held requests use a
permanent escrow bucket and cannot be cancelled. `mc` requires that hold and
atomically consumes it, stores the permanent permit hash and records each
payment allocation once under `pay/KEY`. A repeated identical `mc` is idempotent;
a changed permit or overspent receipt refuses. `rl` can record display completion
only after consumption. It never consumes or returns units.

Committee policy verifies payment finality before `mc` and verifies its accepted
record before signing the receiver-bound permit. The permit has no expiry.
Players pay Bitcoin inscription fees and Ethereum release gas themselves.

## Batch reservation and recovery

A signing snapshot does not reserve balances or guarantee inclusion. Spending,
expiry or pause can change eligibility before execution. A refused batch has no
partial effects and does not consume its sequence; signers must reconcile their
saved reservation and outbox before preparing another batch.

Every batch includes a signed absolute counted-height `deadline`. After combined
headers, its inclusive application window is `0 <= deadline-counted <= 36`.
Signers choose within that horizon at the verified snapshot; retries retain the
same deadline. Once committed counted height exceeds it, and the batch has been
checked as unapplied, signers may retire the digest and sign a replacement for
the same sequence and epoch. At the deadline the original remains eligible, so
no second digest may be signed. A too-distant deadline may become eligible
later; an error code alone does not establish expiry.

Follow [STATES.md](STATES.md) for durable reconciliation. Retain drafts,
signatures, receipts and journals across restarts. Check accepted sequence/root
and authority before each retry, including epoch changes, and recheck replacement
batches against current state. A failed balance check does not retire a saved
reservation.

Rejected combined headers roll back with their batch. Only committed headers
advance the clock. Expiry does not undo accepted effects, reset nonces or extend
mint and payment margins. The 36-block application horizon has no wall-clock
bound. Signer policy must also check creation-time deadlines independently.

## Reorganizations and finality

Within the 2016-block recovery window, heavier forks rewrite canonical hashes.
Counted height, applied batches, balances and deadlines remain monotone. A
shorter heavier tip can temporarily lie below counted height; `countedHash` may
be null and rewritten lower hashes require canonical inclusion checks.
Consumers check `dmwHead.confirmed`, the tip and relevant hashes together.

Services void unsettled events when their claim-window or draw hash changes. Once a
batch credits units, those effects remain final. A later event status cannot
remove credited finds or reverse owner-controlled balances. Any different
settlement policy requires its own protocol design before deployment.

## Storage and availability

Evaluate the approximately 4 KB per-block peer-log target against physical
encoding: input, view and Autobase system logs. Combined headers and batches save
a dispatch, while message bodies, indexes, paid transactions and locks retain
history. See [STORAGE.md](STORAGE.md) for the measured workload and results.

Storage grows with activity. Completed receipts, used nonces, agent identities,
audit roots and counted hashes persist. Expired mint metadata requires `rx` for
view cleanup; aggregate expiry buckets bound lookup work per owner and asset.
Removing view keys does not remove log history. Any compression or retention
change requires a separate compatibility review; there is no fixed storage
ceiling independent of activity.

Header-based exits require Bitcoin progress, relays and available Trac writers.
Standalone `hd` is permissionless at the contract level and remains usable
without committee participation when the host accepts it. With both admin and
committee keys unavailable, existing transfers, hashlocks and their exits remain
available, but new batches and administrative recovery require those keys.

Local measurements use disposable peers and accelerated synthetic blocks. They
exercise signatures, settlement, replication and physical storage. Validate
long-running capacity and operational recovery separately. Clients must track
transaction acceptance and retry idempotently through validator reconnections;
a broadcast response is not settlement evidence.

## Administration and fixed formats

With the admin key, clock and network available, committee replacement takes
432 blocks. Reconcile and archive unapplied old-epoch drafts before rebuilding
under new authority. Each applied committee change increments the persistent
epoch; returning to an earlier key does not revalidate its old batches.
Admin succession requires acceptance by the new key. There is no alternate
recovery mechanism for a lost admin key or migration for a lost owner key.

Administration can replace the committee or change bounded settings after
432 blocks. A pause lasts at most 144 blocks, followed by 144 blocks of cooldown,
including early termination and handover. These actions do not directly move
balances or modify locks. Continued service also requires suitable batch limits
and an available committee.

Asset IDs contain at most 24 lowercase alphanumeric characters. Operands have
at most 78 decimal digits; lists contain at most 16 assets. Amounts are integer
base units with no contract decimal scale. Stored sums can exceed one operand.
JSON depth, safe-integer heights and sequences, signatures and inscription-index
width are fixed protocol formats.

Game formulas, asset mappings, recipes, draws, rights, emission caps, audits and
payment policies are external. They use credits, signed exchanges and notary
commitments; `kv` adds no custody or proof-verification primitives. Compounds use
the same signed mint schema with no block field.

Pin initial identities, network ID, code, dependency locks and checkpoint
consistently across peers. The checked-in checkpoint is a reproducible reference;
choose and verify a fresh launch checkpoint. Review native runtime compatibility.
Buffered transitions rely on the host view transaction for atomic persistence.
