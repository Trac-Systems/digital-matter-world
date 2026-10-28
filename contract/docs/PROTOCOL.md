# Protocol v1

## Deployment and clock

A deployment fixes a network ID, initial committee compressed secp256k1 public
key, admin ed25519 public key and Bitcoin checkpoint. Addresses in this contract
are 32-byte lowercase ed25519 public-key hex, not bech32m MSB addresses. Trac
authenticates a TNK transaction's sender and binds it to the MSB network and subnet.

`launch.js` contains RESET's difficulty-boundary mainnet checkpoint at 969696 with
its eleven ancestor timestamps. Omitting `beacon` in a deployment selects that
constant and `MAINNET_PARAMS`. Tests explicitly supply a local checkpoint. The
shipped peer entry accepts only loopback regtest configuration. Public network ID,
committee/admin identities and checkpoint approval remain deployment decisions;
they must be identical at every peer and frozen before public use.

Headers use strict 80-byte lowercase hex, Bitcoin PoW and compact targets, exact
difficulty at boundaries, integer retarget with a fourfold clamp, eleven-block
median time, cumulative-work selection and first arrival on equal work. Six
confirmations normally advance counted height to `tip-5`. A message contains
1–20 linked headers. All-known standalone `hd` returns `header_known`; a combined
batch may include known headers. No wall-clock time affects transitions. Compact
target, PoW limit and header hash are checked before reading the direct parent;
expected difficulty and median time are checked immediately after that read.
Only a header passing those checks can trigger a retained-ancestor walk.

Heavier forks may replace counted hashes if their common canonical ancestor is
at or above `max(checkpoint, counted - W)`, where
`W = max(interval, branchDepth, confirmations)` (2016 on mainnet). Counted height
never decreases. Existing batches, credits, nonces and deadlines stand. A shorter
heavier tip may temporarily lie below counted; `countedHash` is then null.
`dmwHead.confirmed` reports `max(checkpoint, tip-5)` separately from the monotone
clock, and `revision` increments when a winning fork replaces counted history.
Consumers must recheck event hashes and actual confirmation depth after a fork;
counted does not imply irrevocability.

This balance schema requires fresh deployment state; it does not migrate older
per-item stores or reinterpret their historical operations. Batches without
`epoch` or `deadline` and mint requests without `expires` are invalid; all signers
must use the current schema. The v1 signing-domain names are unchanged. Historical
batch inputs without these fields cannot be replayed under this implementation.

## Canonical JSON and signatures

Import the helpers from `../signing.js`; do not implement a second serializer.
Canonical JSON sorts object keys by JavaScript UTF-16 order, preserves array order,
uses JSON string escaping and admits only safe integers, strings, booleans, null,
plain objects and dense arrays. Negative zero, fractions, undefined, BigInt,
nonfinite numbers and nesting beyond 16 levels are rejected. There is no Unicode
normalization. The wire parser rejects duplicate keys, including escape-equivalent
spellings. Byte limits use UTF-8, not JavaScript string length.

Network IDs match `[a-zA-Z0-9._:-]{1,96}`. The domain separator `|` cannot occur in
one. All signed DMW domains contain the network ID:

```text
SHA256("dmw-batch-v1|" + network + "|" + canonicalJSON(batch without sig))
SHA256("dmw-xc-v1|"    + network + "|" + canonicalJSON(request))
SHA256("dmw-rq-v1|"    + network + "|" + canonicalJSON(request))
```

Batch signatures are 64-byte compact `r || s`, lowercase hex, secp256k1 ECDSA with
low-S required. The digest is signed directly, with no second hash. The contract
checks the current aggregate committee key and requires the signed `epoch` to
match its persistent committee epoch; it does not count committee members.
The 3-of-5 threshold ceremony and share security are external responsibilities.
Owner requests use ed25519 over the raw 32-byte digest, verified by trac-wallet's
verification function. They do not sign its hex text.

## Messages and transactions

The envelope is `{network, op, value}`. Free messages accept only `hd` and `bt`.
TNK transactions use the same envelope. All schemas reject extra fields.

| Function | Value |
|---|---|
| `hd` | `{headers:[headerHex,...]}` |
| `bt` | `{v:1,epoch,n,from,to,deadline,root,ops,sig,hx?}` |
| `tf` | `{to,assets:[[asset,amount],...]}` |
| `hl` | `{to,assets:[[asset,amount],...],hash,refund}` |
| `hc` | `{lock,preimage}` |
| `hr` | `{lock}` |
| `rx` | `{id}`; anyone may clean up an expired mint, returning only to its original owner |
| `ad_key` | `{key:compressedPublicKeyHex}` |
| `ad_set` | `{key:settingName,value:integer}` |
| `ad_admin` | `{address:newAdminPublicKeyHex}` |
| `ad_apply` | `{id:"key" | "set/SETTING"}` |
| `ad_accept` | `{id:"admin"}`; proposed new admin's own transaction |
| `ad_pause` | `{on:boolean}` |

Assets match `[0-9a-z]{1,24}`. Each asset list has 1–16 distinct asset IDs and each
amount is a **string** of 1–78 decimal digits, positive, with no leading zero.
Stored balances use arbitrary-precision integer strings. Sums may exceed 78 digits;
spending such sums may require multiple operands/transactions. No item IDs,
creation timestamps or burn tombstones exist. Zero balances are absent.

Transfers and locks debit all listed amounts atomically. A lock holds its units
outside spendable balances and fixes both locker and recipient. Anyone may
submit its exit; the caller cannot redirect it. Hash and preimage are 32-byte
lowercase hex. Claim requires `counted < refund`, refund `counted >= refund`.
The lock ID is the SHA-256 signing digest in domain `dmw-lock-v1` over network and
canonical `{from,sequence,to,assets,hash,refund}`. The global sequence never resets.

Batch sequence starts at 1 and coverage starts at checkpoint+1. Require
`n=previous.n+1`, `from=previous.to+1`, and `from<=to<=counted`. Recovery coverage
may span any number of blocks; encoded bytes and operations remain bounded.
Empty operations are valid. `root` is a 32-byte external audit commitment whose
contents the contract does not verify.

`epoch` is a required nonnegative safe integer, initially 0. It is part of the
batch digest because only `sig` is excluded. Every successfully applied committee
key proposal increments the persisted epoch, including a return to an older key
or reauthorization of the same key. Proposing/replacing a proposal, a refused apply,
settings changes and admin handover do not increment/reset it. Mismatch returns
`batch_epoch` before any header or operation writes. Epoch exhaustion refuses key
application instead of wrapping. Read `dmwAuthority().epoch` when signing; previous
epoch signatures never regain validity. Owner requests are not bound to an epoch:
a current committee may relay an otherwise valid owner request.

`deadline` is a required nonnegative safe-integer JSON number, an absolute counted
height included in the batch digest. At application, after any `hx`, require
`0 <= deadline - counted <= 36`. The fixed `MAX_BATCH_HORIZON=36` in `settings.js`
is not an admin setting. The deadline itself is inclusive; at deadline+1 the
digest can never apply again because counted never decreases. A too-distant or
expired deadline returns `batch_deadline`. Missing, negative or wrong-type values
return `batch`; noncanonical numbers fail encoding before schema validation.
Earlier schema, size, epoch, sequence and signature checks retain precedence:
replaying an already-applied sequence returns `batch_sequence` even after expiry.

The horizon is relative to counted at application, not `to`, tip height, signing
time or wall-clock time. A too-distant deadline may become admissible later, so
`batch_deadline` alone is not proof of permanent expiry. Signers must choose a
short deadline at most 36 blocks beyond their independently checked application
snapshot, preflight the complete signed body and retain that exact deadline on
retries. Replacing it changes the digest and requires a new signature. Byte
budgets include the field. It neither reserves balances nor extends owner-request
`until`/`expires`, lock refunds or mint escrow. No on-chain reservation, retirement
record or new storage key is introduced. See [STATES.md](STATES.md) for slot exits.

Optional `hx` is a list of 1–20 linked headers, covered by the committee signature.
The contract checks schema, epoch, sequence, byte limit and signature before ingesting
it, then checks deadline, pause, coverage and operations against the resulting
counted height. The complete dispatch is atomic: any refusal also discards its
headers, nonces, balance changes, sequence and root. During a pause use standalone
`hd`; a combined dispatch can succeed if
its headers reach the pause expiry. One combined dispatch per Bitcoin block is
the normal committee path; owner transfers and locks remain separate paid actions.

| Batch operation | Shape and effect |
|---|---|
| Aggregated finder credits | `{op:"ac",to,assets:[[asset,amount],...]}`; 1–16 distinct assets, grouped by owner/asset, no per-find record |
| Credit | `{op:"mk",to,asset,amount}`; add units to the recipient's balance |
| Exchange | `{op:"xc",request:{owner,in:[[asset,amount],...],out:[[asset,amount],...],nonce,until},sig}`; debit inputs and credit outputs |
| Mint request | `{op:"rq",request:{owner,asset,amount,receive,block?,nonce,until,expires},sig}`; debit units into pending mint escrow |
| Hold paid mint | `{op:"mp",id}`; pin seen payment, re-reserving expired units if available |
| Consume paid mint | `{op:"mc",id,permitHash,payments:[{key,amount,total},...]}`; consume held units once and record receipt use |
| Record mint | `{op:"rl",id,inscription}`; display receipt after consumption; no financial effect |
| Cancel mint | `{op:"rx",id}`; settle expired unpaid units and retain an expired request record |
| Notary record | `{op:"kv",key,value}`; string under `n/`, or delete with null |

Exchanges require owner signatures, unique assets on each side and sufficient
input balances. The same asset may appear on both sides. No recipe or conversion
ratio is enforced. Input plus output entries count toward `batch_assets`; every
single credit and mint request adds one; aggregate credits add the vector length. Claim budgets and Bitmap/mint rights are
external policies, not contract limits.

All mint requests require the owner's signature. `receive` is a 32-byte lowercase
hash committing to the intended Bitcoin receive address. Optional `block` is a
nonnegative safe integer; omit it for compounds. The contract is asset-agnostic
and verifies neither rights nor receiver interpretation. Request ID is the
lowercase hex of `requestDigest(network,"rq",request)`, including all those fields.
`mp`, `mc`, `rl` and `rx` identify this request instance, never just an asset or block.

Nonces are 32-byte lowercase hex, permanently single-use per owner across both
`xc` and `rq`. Requests are valid through `until` and expire at `until+1`. Refusal
consumes no nonce. Expiry or cancellation never makes a consumed nonce reusable.

`expires` is the owner's required absolute escrow-expiry height, a nonnegative
safe integer signed inside `rq.request` and included in its request digest/ID.
At execution require `6 <= expires - counted <= 2016`, using counted after any
combined headers. These are hard duration bounds, independent of the mutable
`pending_blocks` setting. The request's separate `until` deadline must also pass.
Malformed/out-of-range expiry returns `request_expiry`; no nonce or balance is
changed. Delayed admission shortens the remaining lifetime and may make the
request inadmissible; it can never move the signed expiry later.

Store exactly `e = request.expires`, with no recomputation. `pending_blocks`
(default 432) is only a suggested duration for clients preparing a request. A client
can choose an absolute height from that suggestion before obtaining the owner's
signature; neither the committee nor later setting changes can alter the signed
height. Scheduling services must use the accepted height and signed expiry for
the actual lifetime and payment/cancellation margins.

Unpaid escrow remains live at `expires` itself; at expiry+1 its units become
spendable. Balance mutations settle timed escrow first. `rx` is expiry-only and
retains `{...requestRecord,s:2}` for late payment verification. It cannot release
a paid hold. `mp` moves the reservation to the permanent escrow bucket; for an
expired request it first debits available units. `mc` requires that hold, consumes
it, and retains `{s:1,h:true,o,asset,amount,receive,e,block?,permitHash,paymentHash,
payments,inscription?}`. Each receipt key records immutable `total` and cumulative
`used`; overspending, duplicate keys and changed totals refuse atomically.
An identical repeated `mc` does nothing. A changed permit refuses. `rl` can add a
canonical inscription ID only to a consumed record; it does not prove inclusion
or consume units. Only independent committee readers establish external payment
and mint evidence.

Notary keys match `[a-z0-9/._-]{1,64}`. Values are at most 256 UTF-8 bytes, or null.
`open` and `charter` record namespaces are refused (`kv_namespace`).
The literal `n/` prefix prevents access to administrative/runtime namespaces.

## Administration and bounds

The fixed proposal delay is **432 counted blocks**. Only the current DMW admin
may propose keys, bounded settings or a successor. Anyone can apply eligible key
and setting proposals. Admin handover is exactly two transactions: old admin
proposes, then the new address submits `ad_accept` at/after the deadline. Until
acceptance the old admin remains current. `ad_apply` cannot transfer authority.
Replacement restarts the delay; acceptance clears every old-admin proposal.

Pause lasts at most 144 blocks. A new pause is forbidden until 144 blocks after
the preceding pause ended, including an early manual end. Repeated `off` cannot
reset that recorded end; handover preserves cooldown. Pauses affect batches only.
Headers, transfers, locks, claims/refunds, expired-mint cleanup and administration
remain available. Heights advance only through accepted headers.

| Setting | Default | Minimum | Maximum |
|---|---:|---:|---:|
| `batch_bytes` | 98304 | 1024 | 120000 |
| `batch_ops` | 512 | 1 | 512 |
| `batch_assets` | 4096 | 1 | 8192 |
| `batch_kv` | 16 | 0 | 64 |
| `pending_blocks` (client duration suggestion) | 432 | 6 | 2016 |
| `lock_min` | 6 | 1 | 144 |
| `lock_max` | 2016 | 144 | 52560 |

Outer protocol maximum: 131072 bytes. Hard lock bounds always allow `min<=max`.
Changed settings affect future actions or client suggestions; signed mint expiries
and stored deadlines are never recomputed.

## Storage and reads

| Key | Value |
|---|---|
| `v/N/ASSET` | positive balance decimal string |
| `e/N/ASSET` | sorted aggregate `[expiry,amount]` pairs for unsettled mint escrows |
| `pay/RECEIPT_KEY` | `{total,used}` permanent receipt allocation accounting |
| `m/REQUEST_DIGEST` | pending/expired request or permanent consumed permit record; see mint transitions |
| `a/ADDRESS`, `an/N`, `a/last` | permanent address/number bijection and counter |
| `l/LOCK`, `l/seq` | `{o,to,assets,hash,refund}` and monotone sequence |
| `rq/n/N/NONCE` | consumed request marker |
| `b/r/HASH` | `[height,prev,time,bits,periodTime,lastTimes,chainwork,poster]` |
| `b/x/HEIGHT/HASH`, `b/xh/HEIGHT` | linked height index and its head |
| `b/best`, `b/cnt`, `b/rev` | best tip, monotone counted height, counted-history revision |
| `b/h/HEIGHT`, `b/u/HEIGHT` | canonical hash at/below counted, or above it |
| `b/gc` | incremental pruning height cursor |
| `bt/last`, `bt/N` | latest `{n,to}` and permanent audit root |
| `n/finds/batch/N` | commitment to the batch finds/settlements files; N in base 36 |
| `n/receipt/batch/N` | receipt-seal commitment; N in base 36 |
| `n/KEY` | other notary string |
| `s/current`, `s/key`, `s/epoch` | changed settings, current committee key, persistent monotone epoch (initially 0) |
| `ad/current`, `ad/p/ID`, `ad/pause` | current admin, `{value,at}` proposals, `{until}` pause end |

All branches at or above the retained floor remain eligible. Cleanup performs at
most 64 iterations per supplied header, deleting a constant number of keys per
iteration. Expired raw records are unusable immediately even if deletion is
backlogged. Valid fork admission is not capped; the PoW/resource assumption remains.
Canonical hash keys persist, but their values may change on an accepted fork.

Expiry buckets aggregate unlimited requests by owner/asset/height. Settlement
removes all expired buckets; the finite pending-time bound limits remaining
bucket heights to 2017, with no global scan. Individual expired mint records may
remain until `rx`, without reserving spendable units. Completed receipts, used
nonces, agent identities, audit roots and historical log entries grow permanently.

Reads: `dmwHead`, `dmwHashAt`, `dmwBatchLast`, `dmwBatchRoot`,
`dmwBalance(ownerAddressOrNumber,asset)`, `dmwMint(id)`, `dmwLock`, `dmwSettings`,
`dmwPendingAdmin`, `dmwAgentNumber`, `dmwAgentAddress`, `dmwRecord`, `dmwAuthority`.
Each uses one closed-after-use snapshot. `dmwAuthority` includes the current
committee `epoch` as a JSON number alongside its committee public key.
`dmwMint` exposes expired pending records
as `s:2` without writing. Balances include all expired escrow; reading the raw
`v/` value alone is insufficient. Pending-admin reads cover nine fixed slots.
# Certified receipt renewal (v2 rehearsal)

An authorized settings amendment can reserve its complete immutable
receipt range with a committee-signed v2 batch whose `renewal.kind` is
`reserve`. The deployment must pin `v2.gateway` and five distinct
`v2.receiptSigners`; older deployments without these pins refuse renewal.
The cutoff commits the accepted batch/claim/catalog checkpoint, original and
authorized successor settings, contiguous receipt range, and immutable segment
roots. Independent signers verify all members and their original timely
segment certificates. The reserve batch changes only the notary sequence and
the durable renewal record; game/account roots and receipt bytes stay intact.

Only the immediately following `renewal:{kind:"execute",id}` batch may consume
that reservation. It includes every original segment under the original
settings, preserves all original receipt windows, and commits consumption
atomically with game/account changes. Fresh admission uses the authorized
successor afterward. An ordinary batch cannot bypass a pending renewal.
Signers reserve `receipt-renewal/<id>/<kind>` atomically with the normal batch
slot. Ambiguous responses retain both reservations; only independently proven
batch expiry/epoch change and nonacceptance retire them.

The gateway automatically fences at the successor's effective boundary and on
restart, after reconciling any uncertain draft. An empty cutoff includes a
witnessed empty segment; its execution advances the authenticated receipt chain.
Proof publications are indexed by renewal ID and observation, become visible
with local acceptance, and retain the original receipts and audit bytes.

New deployments may pin `v2.receiptProtocol:1`, the gateway and the five receipt
witnesses. The marker is installed with terminal import, cannot be added to an
existing deployment by an amendment, and requires durable quorum admission and
fencing on the signers. It does not authorize reducing any capacity limit.

All fourteen `settings_capacity_drain_required` guards remain:
`batchBytes`, `batchOps`, `batchAssets`, `batchKv`, `auditChunkBytes`,
`auditTotalBytes`, `summaryBytes`, `observationBudget`, `receiptSegmentEntries`, `proofBytes`,
`accountLeaves`, `accountProofNodes`, `accountProofBytes` and `accountActions`.
The immutable cutoff can itself exceed the original one-batch observation or
execution envelope. A valid two-receipt backlog with three segments and an
original observation budget of two remains durably sealed, but cannot renew
with this format. Renewal across multiple batches, and renewal of arbitrary
outstanding financial/proof obligations into smaller envelopes, are unfinished.
Older deployments also need an explicit reconciliation of preexisting receipts.
