# Balances, escrows, exits and timeouts

All deadlines use the monotone **counted Bitcoin height**, not wall-clock time or
batch coverage. Any sender can advance headers independently of the committee,
through a free writer message or paid transaction. Bitcoin or network stalls stop
height-based deadlines.

## Fungible units

Asset identifiers describe types, not individual finds. A nonzero `v/N/ASSET`
contains a positive integer string; absence means zero. Grouped `ac` vectors and single `mk` credits add units; owner-signed
`xc` debits inputs and credits outputs, and transfers debit/credit atomically.
There are no per-find states or burn tombstones. Balances cannot become negative.

Units are held in exactly one of three places: spendable balances, a hashlock, or
unsettled mint escrow. For each asset, their sum equals committee credits plus
exchange outputs minus exchange inputs and completed-mint burns. Moving units
among those places preserves supply. Expired escrow is logically spendable before
its physical balance write; never add it to both categories when auditing.

## Hashlocks

| State | Entry | Exit | Deadline |
|---|---|---|---|
| Absent | Initial state or completed exit | Owner's `hl` debits units into a fresh lock | None |
| Claimable | `hl` fixes locker, recipient, asset amounts, hash and refund | Correct `hc` credits fixed recipient and deletes lock; clock reaches refund | Through refund−1 |
| Refundable | Counted reaches refund | `hr` credits original locker and deletes lock | No final expiry |

Anyone may submit claim/refund. Neither caller nor committee can redirect the
units. Claim and refund are disjoint at the boundary. A permanent sequence ensures
new locks have new identities. A lock has no forced sweep or admin exit.

## Mint requests

| State | Entry | Exit | Deadline |
|---|---|---|---|
| Absent | No record, or cancelled/cleaned request | Owner-signed `rq` debits amount into escrow under request digest | Signed request valid through `until` |
| Pending (`s:0`) | Successful `rq`, owner-signed expiry `e=request.expires` | Committee `rl` burns escrow; committee `rx` returns it; clock passes `e` | Live through `e` |
| Expired (read as `s:2`) | Counted becomes greater than `e` | Balance mutation materializes returned units; paid or batch `rx` removes request record | Units spendable immediately, no cleanup required |
| Completed (`s:1`) | Committee completes live request | None | Permanent small inscription receipt |

Request digest binds owner, asset, amount, receive-address hash, optional block,
nonce, admission deadline `until` and absolute expiry `expires`. Admission requires
6–2016 counted blocks remaining at execution. Delayed submission or changes to the
client duration suggestion cannot extend the signed expiry. Compound requests omit
block. Every mint request needs
owner consent. No unsigned fallback exists. A stale completion/cancellation names
only its original instance and cannot act on a later request for the same asset.

Escrow buckets aggregate requests by owner, asset and expiry. Spending, receiving,
locking or creating another mint first settles expired buckets. This happens once;
cleaning an old request cannot refund units again. A completed or cancelled request
never returns its nonce to the unused state. Expired raw request metadata can remain
until cleanup, but carries no spend restriction after expiry.

## Requests and batches

| State | Entry | Exit | Deadline |
|---|---|---|---|
| Unused owner request | Owner signs `xc` or `rq` | Valid batch executes and consumes nonce; validity ends | Valid through `until` |
| Consumed nonce | Successful request | None | Permanent per-owner namespace shared by both request types |
| Unreserved batch slot | Next sequence after last accepted batch | Committee preflights and reserves one digest in its durable journal | Coverage must be counted at application |
| Reserved/ready batch | Committee signs current epoch, next sequence, contiguous coverage and `deadline` | Apply successfully; retry identical digest; pass deadline; applied key change supersedes epoch | Require `0 <= deadline-counted <= 36` after `hx` |
| Reserved but refused / blocked outbox | Delay, paid spend, pause or another change invalidates the preflight snapshot | Retry same digest if valid again; reconcile acceptance; prove expiry or superseded epoch and retire | A refusal does not release the slot |
| Expired unused digest | Committed counted height exceeds signed deadline and sequence was not accepted | Archive evidence and durably retire digest; rebuild/re-preflight same next sequence in current epoch with a new deadline | Deadline+1, never deadline itself |
| Superseded-epoch unused digest | Applied key proposal advances epoch; sequence was not accepted | Archive draft, ceremony and outbox; rebuild from last accepted batch under current authority | Key application after 432-block proposal delay |
| Applied batch | All operations, including optional headers, succeed | None | Root and effects stand through Bitcoin reorganizations |

Reservation, outbox and retirement states above are responsibilities of external
signers/services, not contract records. The contract consumes a sequence only on
successful application. Preflight reserves neither funds nor inclusion: a paid
transfer can make an exchange fail at the same counted height, and delayed
inclusion can expire an owner request before the batch deadline.

On every tick/restart, reconcile the canonical accepted sequence/root, retained
submission evidence and current authority before retrying a saved draft. If already
accepted, finish local acceptance. Otherwise retry only the same digest until
independently verified committed counted height is greater than its deadline, or
the epoch is superseded. Persist retirement and preserve signatures, receipts and
journal evidence before authorizing a replacement. Rebuild from the last accepted
sequence/coverage and recheck budgets, balances, owner predicates and current
authority. Replacement can use the same sequence and epoch after expiry; it needs
a new signed digest. A transient `balance` error, a too-distant deadline error or
an uncommitted/rejected `hx` is not retirement proof. The contract does not enforce
the committee's one-digest-at-a-time policy.

A refused call writes nothing. Combined `hx` can advance the clock before batch
deadline and request checks; a late refusal rolls back its headers too. To make
expiry durable, submit those valid headers through standalone `hd`, which remains
usable during a pause. Recovery batches may cover many blocks. Eligibility uses
current application height, never a past height declared in coverage. Expiry does
not undo an applied batch or consume an unused owner nonce.

## Administration

| State | Entry | Exit | Deadline |
|---|---|---|---|
| No proposal | Initial state, application or handover | Current admin proposes | None |
| Waiting proposal | Store value and `at=counted+432` | Replacement resets delay; handover clears; clock reaches `at` | Exactly 432 blocks |
| Eligible key/setting | Proposal matures | Anyone applies, or admin replaces it | No expiry |
| Eligible successor | Admin proposal matures | Proposed new admin accepts in its own transaction, or current admin replaces | No expiry; old admin stays until acceptance |
| Running batches | Default, pause ends | Admin starts permitted pause | None |
| Paused batches | Store `until=counted+144` | Admin ends early or clock reaches until | Maximum 144 blocks |
| Cooldown | A pause ends | Clock reaches recorded end+144 | New pause impossible during 144 blocks |

Repeated off calls and admin handover preserve cooldown. Acceptance clears all
old-admin proposals. Key/setting application remains permissionless. Each applied
key proposal permanently increments committee epoch, even when the public key
stays the same or returns to an older value. The initial epoch is 0; neither admin
handover nor a setting change resets it. No null-admin
or alternate recovery authority exists. Pause affects batches only; it cannot stop
headers, transfers, hashlocks, expired-mint cleanup or administration.

## Bitcoin history and persistent records

The most cumulative work wins; equal work preserves first arrival. A fork with a
canonical common ancestor within 2016 blocks behind counted can rewrite hashes.
Counted height and existing asset operations never roll back. A shorter heavier
tip may put current confirmation depth below counted; readers must use `confirmed`
and recheck hashes. No new batch can reuse covered heights.

All branches below the retained floor become unusable immediately. Their physical
cleanup is incremental and has a fixed budget. Old canonical hash mappings remain,
while branch records age out. Fork storms still rely on Bitcoin's PoW cost.

Agent identities, consumed nonces and completed receipts persist. Owner-key loss
has no recovery. Notary strings can be replaced/deleted only by committee batches.
Settings and authority persist until their explicit delayed transitions; existing
lock and mint deadlines do not change with settings.
