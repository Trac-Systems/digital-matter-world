# Independent read clients

`signer/adapter.mjs` imports only exported rules and contract signing modules.
It isolates the compact pending-record representation and binary block-file
format. `signer/reads.mjs` exports `createLocalReads({trac,indexer,records,ethereum})`
to connect independently configured clients. There are no RPC URLs in policy.
The gateway cannot supply these objects through a signing request.

Each read must return fresh, independently verified state. A production adapter
must verify the chain/network, deployment and receipt inclusion, not merely turn
gateway JSON into the following normalized shapes. Cross-read consistency and
Bitcoin confirmation/reorg handling belong to the injected readers. All amounts
are decimal strings in atomic units; DMT/compound units have zero decimals.

| Read | Result |
| --- | --- |
| `authority()` | Exported `dmwAuthority()` snapshot containing `{network,committee,epoch}` |
| `counted()` | Contract counted height, safe nonnegative integer |
| `pending(id)` | Exported `dmwMint(id)`: `{s:0|1|2,o,asset,amount,receive,e,block?,h?,permitHash?,paymentHash?,payments?}` |
| `agentAddress(o)` | Exported `dmwAgentAddress(o)` |
| `pendingAcceptance(id)` | Verified accepted `rq` event `{id,created,expiry}` |
| `assetContext(asset,block?,at?,payoutSnapshot?)` | Registered deployment and independently indexed rules/fee context below, resolving the binding IDs in the fixed quote |
| `mintFeeTerms(id)` | Verified `{baseFee,payoutSnapshot}` from the mandatory signed quote, request-bound admission, agent payment intent and retained global `feePolicy` revision |
| `mintPayoutSnapshot(id)` | The same verified signed quote for batch admission |
| `isMinted(deployment,tick,block)` | Strict boolean, true if the deployment/block was minted |
| `bitmap(block)` | Current indexed holder `{agent,address}`; verify the Bitcoin-holder/Trac-agent link |
| `blockHold(asset,block)` | First accepted live hold `{id,expiry}` |
| `payer(id)` | Authorized payer from the request/payment binding |
| `mintRequest(id)` | Original owner-signed request and authorized payer; lookup hints only |
| `mintPayment(id)` | Independently verified fee items, receipts, used amounts and finality |
| `paymentUsed(key)` | Trac `{total,used}` accounting |
| `escrowDeposit(payer,id)` | Verified Ethereum deposit snapshot from `ethereum.deposit(payer,id)` |
| `escrowRotation(successor,deadline)` | Verified Ethereum authority snapshot from `ethereum.rotation(...)` |
| `committeeRotation()` | Independently approved `{newCommittee,nonce,committeeEpoch,deadline}`, or null |
| `mint(id)` | Successful indexer observation below, never mere inscription existence |
| `batchContext(sequence)` | Trusted replay inputs, previous state and contract batch head |
| `batchStamp()` | Consistent current `{counted,tip,tipHash,revision,last:{n,to}}` covering contract and indexed Bitcoin state |
| `balance(owner,asset,at)` | Authoritative spendable decimal balance, including expired escrow |
| `nonceUsed(owner,nonce,at)` | Strict Boolean from accepted contract request history |
| `mintAuthorization(id)` | Independently verified compact original permit authorization, described below |

The contract pending record omits its creation height. Do not derive that height
by subtracting today's `pending_blocks` setting: it may have changed. Read the
accepted `rq` event and its actual application height. Its expiry must match the
current pending record and the owner's signed `request.expires`. Admission must
have been within `until` and 6..2016 blocks before `expires`. Permit timing uses
that accepted lifetime even after the admission deadline has passed. `receive`
hashes the exact UTF-8 receiver string. The request digest from the exported contract serializer is the pending record ID.

An asset context contains:

```text
deployment: {
  id: inscription ID, kind: "dmt" | "compound", tick,
  active: true, privilegePublicKey: compressed committee key,
  decimals: 0, remaining: decimal string, limit: decimal string
}
tier, feeSettings?
treasury, finderAddress?, firstMakerAddress?, discoverer?
payouts: {finder,firstMaker,discoverer} // binding IDs or null
find: {block,asset,count,finder,findHeight}       // DMT only
link: {block,linkHeight} | null                // DMT only
```

Resolve the registered deployment against the indexer, including authority
activation, remaining capacity and limits. `find` and hold records must
derive from verified committed block files and accepted contract request order.
The current Bitmap holder is read separately on every authorization.

Player payout addresses come only from the public double-signed binding ledger.
The authenticated `POST /bind-payout` endpoint independently verifies the exact
agent Ed25519 signature and the wallet's Taproot BIP-322 simple or Ethereum
EIP-191 proof. It journals a strictly increasing agent/rail nonce before returning
an identity attestation. New endorsements require a live request and an acceptance
time within the preceding minute; exact journaled retries return the same vote.
See the [binding protocol](../../service/docs/READS.md#payout-wallet-bindings).

The `bindings` reader verifies both signatures and at least three distinct votes
against the configured five identity keys. It resolves audited finder,
discoverer and first-maker attribution to the quote's binding IDs and
checks their historical validity. Native batch and mint policy additionally
reject rollback against the signer's own endorsement journal. Quote replacement
is covered by the agent's payment-intent signature. Releases use the original
verified mint authorization and never resolve a new payout wallet.

Mint payments are direct per-item receipts. Each receipt includes its immutable
key, role, recipient, token, atomic amount, transfer type, confirmations, accepted
status and previously used amount. TAP readers require an indexed successful
internal transfer from the authorized payer with exact request/role data. A
mempool read independently verifies the signed redeem and active authority.
TAP burn requires an exact transfer to `1BitcoinEaterAddressDontSendf59kuE`.
Ethereum burn is verified from the escrow release.

Ethereum identifies each deposit by `(chainId,contract,payer,requestId)`. Readers
verify the original payer intent and exact split. An open deposit is seen but
not final payment. Only a successful released deposit with confirmed settlement
produces final receipts. Unused credit from an expired request is checked against
the original signed owner and Trac receipt totals before reducing the next deposit.

Create the `ethereum` client with
`createEscrowReader({rpc,chainId,address,token,fromBlock?})` from
`signer/escrow-reader.mjs`. Supply the operator's local RPC function
`async rpc(method,params)`. `fromBlock` defaults to `0x0`; set it to the deployment
block to bound event searches. The reader pins all getters and the event query to
one latest block number, filters `Deposited` by both request ID and payer,
verifies that event against `getDeposit(payer,id)`,
checks the event's canonical block hash, and rechecks the snapshot block hash.
It validates chain/token and compares its computed hashes to contract utilities.
These consistency checks require a trusted RPC source. The operator selects
that source and its freshness and chain-finality policy.

`deposit(payer,id)` returns:

```text
{
  chainId,address,token,blockNumber,blockHash,timestamp,
  committee,committeeEpoch,rotationNonce,payer,requestId,confirmations,releaseDigest,
  pendingCommittee: {successor,executableAt,nonce,adminOrigin},
  deposit: {
    payer,status,amount,expiry,splitHash,
    split: {treasury,treasuryAmount,finder,finderAmount,
            landowner,landownerAmount,discoverer,discovererAmount,
            burnAmount}
  }
}
```

Amounts, timestamps, epochs and nonces are decimal strings; block numbers are RPC
hex quantities; addresses and bytes32 fields have `0x`. Request ID and final
`releaseDigest` use bare lowercase hex; confirmations and status are integers.
Release policy requires status `1`, one deposit confirmation and a timestamp
strictly before expiry. Mint policy requires status `2` and one settlement
confirmation. Stored split/hash and digest must agree. Treasury, finder,
landowner, discoverer are direct destinations; first maker uses the
finder slot. Payer-owned shares are zero, and verified earlier credits reduce
only matching items. Burn calls the token's native burn operation.

For rotation, `rotation(successor,deadline)` returns the same chain/authority
snapshot plus `rotationDigest`. It decodes all four `pendingCommittee()` fields,
including the Boolean `adminOrigin`. Policy refuses missing origin data or any
pending admin-origin recovery, even when mature. Committee-origin proposals may
be replaced under the normal nonce/epoch/deadline checks.
`records.committeeRotation()` must independently approve the exact successor, nonce, committee epoch and submission deadline;
unconfigured adapters refuse. Neither the HTTP proposal nor the RPC digest utility
is authorization to install a successor. Verify successor key possession and
provision its operators before configuring approval. The policy checks current
committee, nonce, epoch and inclusive deadline before reserving a rotation slot.

A mint observation contains:

```text
{
  accepted:true, fail:false, confirmations, inscription,
  deployment, tick, receiver, amount, dta, permitHash,
  committee: compressed public key, block?      // DMT only
}
```

Use actual credited amount and receiver from the indexed mint and inscription
ownership at mint acceptance, not an inscription's requested amount or its later
transfer recipient. Bind the original permit and authority. One confirmation
is required. Recheck after reorganizations. The local tests prove
the observer gate with mocked reads; they do not establish an indexer consensus
or trustless atomicity between Bitcoin mint and payment settlement.

Batch context is `{last:{n,to},counted,state,patterns,history,hashAt,gateway,
settings,limits,headers?,inputs:[...],views?:[...]}`. Each input supplies the
exported `processBlock` arguments for one file, excluding shared state/patterns,
history and configuration. The signer reads the current contract authority
independently, checks the proposal's mandatory batch epoch and its own public key, then rechecks authority
after replay. Its batch journal slot includes both epoch and sequence. The
sidecar membership epoch is independent of the contract batch epoch.
The signer sequentially replays inputs and advances
the state it derives itself. Published gateway receipts, sealed roots, chain
hashes and prior state must be independently fetched and verified by the adapter.
The proposal contains `{network,kind:"batch",batch,files:[binaryHex,...]}`.
Header submissions are existing witnessed `header` moves or a claim’s `header`.
Replay verifies the raw header against that block in the observation’s branch
and its open window, then deduplicates `{block,agent}` in `headerSenders`.
Unclaimed-pattern wins carry `source:"header"`, become ordinary finders, and
use existing grouped `ac` credits. No new contract batch field is needed. Large header
rounds persist their fixed settlement and credit cursor across batches; find
rights start at the segment credit height. Each file lists only its newly credited winners,
so large rounds also fit the publication byte ceilings. Replaying the inputs
must reproduce that progress and every credit, source, ticket count and winner
byte for byte.

Version 4 observation files include `observation`, `previousHeight`, `height`,
`tip`, `tipHash`, `confirmed`, `mintOperations` and `linkOperations`, in addition
to receipts, moves, results and operations. Every input must be independently
associated with its observation. `views[i] = {history,hashAt}` supplies the
historical branch at that observation; absent `views`, the shared readers apply.
Never replace old-branch snapshots with a final-chain lookup during reorg replay.
State advances in file order, including a repeated counted height or raw tip.
Closed claim windows stay closed,
and already settled events do not reverse. A pre-settlement window/deciding-hash mismatch
voids that event. Historical snapshots must include the actual confirmed clock.

The builder accepts up to 512 observations and 1,500,000 total audit bytes by
default; each file still has its independent 1,500,000-byte cap. The hard total
limit is 1,800,000, leaving room in the signer's 4 MiB JSON request for hex files
and a bounded batch. Coverage starts at `last.to + 1` and ends at the last file's
counted height, which must advance at least once. A stalled-only prefix remains
buffered. Catch-up headers exceeding the `hx` limit of 20 are posted separately
through `hd`; recovery then signs against the independently read counted head.

Only version-4 observation files are accepted by the batch builder. It aggregates
per-agent `ac` credits and commits the batch's finds and receipt notaries.
`receipt/batch/N` commits all ordered binary
`{observation,tip,hash:tipHash,seal:receiptRoot}` records with the standard rules
Merkle tree. All other operations retain exact replay order. The audit root still
commits every complete file. Do not concatenate `file.ops` to construct a batch:
use exported `buildBatch` or `batchOperations(files,sequence)`.

For batches carrying financial input, `batchStamp` is read before and after
evidence verification. It must match the context's contract head and the final
observation's tip/hash; any revision/head change refuses the attempt. Readers
must pin contract/indexer reads to that snapshot and check consistency, including
a same-height reorg. The signer separately rechecks counted height and committee
authority. RPC trust and atomic snapshot construction remain adapter duties.
Include relevant source revision tokens in the stamp when payment/indexer state
can change independently of Bitcoin; extra stamp fields are also compared.
Bitcoin and Ethereum evidence require exactly one inclusion confirmation; canonical
snapshot and reorg checks still apply.

### Mint batch evidence

`mintOperations` entries use `rq`, `mp`, `mc` or `rx`, retaining the original
owner-signed request and receiver. They belong to the final observation at the
current execution height. Limits remain eight by default and 32 maximum, with
one action per request per batch. Admission (`rq`) independently checks context,
Bitmap, indexed mint absence, block hold, current balance and nonce.

`mintRequest(id)` returns the original signed payment intent and lookup hints.
`mintPayment(id)` independently reads accepted per-item receipts and their finality;
it returns `{requestId,kind,payer,fees,receipts,requiredConfirmations}`. Ethereum
also supplies `depositFinal`, `split`, `depositFees` and `depositAmount`.
`paymentUsed(key)` reads Trac's consumed total. Credit sources must carry the same
signed owner, payer and rail and an expired, unheld source reservation.

`mp` evidence contains the pending acceptance, raw reservation, current balance,
independently derived permit authorization and observed payment. A seen payment
holds existing units permanently or re-reserves an expired amount when available.
`mc` requires that hold and every fee final. It commits the exact permit hash and
allocations `{key,amount,total}`. Contract accounting refuses reused amounts and
persists the consumed record. `rx` can only retire an expired unpaid, unheld
request. There is no Bitcoin cancellation proof or mint-time consumption.

The committee re-reads this evidence through `paidMintPlan`, never accepting the
gateway's balances, monetary fields or receipt claims as authority. Consumed
requests reconstruct their original allocations even after remaining receipt
credit is used elsewhere. `mint(id)` watches the player's inscription for display;
it cannot refund or consume units.

## Witness and recovery interfaces

The current signer requires these additional reads and fields:

| Read | Exact result or responsibility |
| --- | --- |
| `tip()` | `{tip,highestTip}` from an independent durable header observer; `highestTip` never decreases, including across restart/reorg |
| `receiptObservation(tip,hash)` | `{seal,receipts}` fetched before the signing deadline, independently of the request body |
| `receiptCertificate(tip,hash)` | `null` if no timely quorum exists, otherwise `{seal,attestations}` from the independently collected canonical root ledger |
| `mintCertificate(id)` | Public mint result certificate with original details, completed ECDSA signature and three distinct identity attestations |
| `preflight(batch,{counted,last})` | `{ok:true,counted,last,digest}` only after actual contract operation preflight against the pinned live snapshot; failures throw |
| `records.contractDeployment()` | Original validated contract deployment configuration for local transition preflight |
| `trac.dmwRead(key,at)` | Raw contract key/value at the exact accepted snapshot, including null for absent keys |
| `link(block,at)` | Verified permanent link or null |
| `linkTerms(id,request,at)` | Independently derived link payer binding, fee configuration and payment domain |
| `linkPayment(id,at)` | Independently verified payment using `verifyLinkInput` and the link fee/split |

`settings.receiptSigners` contains the trusted five `{id,identity}` entries. It
must come from operator configuration or authenticated membership state, never
the proposal's chosen roster. The service config also supplies the trusted
`gateway` Ed25519 public key for `/attest-root`. A gateway root and its alleged
tip alone cannot establish timing. A signer calls the independent clock even
when re-serving an old attestation. Persist missed/conflicting windows and
publish certificates so another member can recover the same witnessed order.

Each replay input now has `rootAttestations`, `linkOperations` (default empty),
and the existing move/mint/link evidence. Files also record
`receiptReference`, `discovery`, `mintOutcomes`, `linkOutcomes`, and `commissions`.
Nonempty observations without a valid quorum fail. The independent certificate
reader prevents omission of an already certified root; repeated empty files
reference its root without reapplying receipts. Unattested empty files are allowed
only for missed windows with no canonical certificate. A root conflicting with
the one already recorded in replay state fails. The full binary audit commits
attestations, including the commitments inside their receipt sets.

Process buffered observations using `executionHeight = batchContext.counted`.
The signer supplies that value itself when rebuilding; a gateway cannot lower
it to revive an expired request. Expired `rq` inputs remain in `mintOperations`
with a rejected `mintOutcomes` entry and no corresponding contract operation.
Independent mint evidence checks consume only accepted entries. Preserve the
same result in service-built files before asking for a signature.

Discovery commitment and reveal move schemas and order are defined in the rules.
No extra arbitrary discovery-order number is accepted: ordering derives from the
witnessed commitment tip, commitment hash and agent. Persist the commitment queue,
revealed-job queue, partial work and incremental indexes across observations.
Use exported record-index accessors for replay maps. History readers must preserve
consistent snapshots during worker replay; history field callbacks cannot return
an evolving branch in the middle of a reconstruction.

`mintAuthorization(details)` now includes `commissions`. A completion's
independently authenticated authorization must include the exact same list.
Completed mint files record each owed amount with the inscription; the periodic
public treasury payout ledger references those obligations and actual TAP tx IDs.
Readers must not invent an absent finder or omit a direct fee item.

For interrupted permits, recover the original `/status` and durable `/result`.
`/recover-result` verifies the original consumed permit commitment. Never create
a new digest or reopen a consumed DMT slot. Mint payment preimage release and
Bitcoin cancellation readers have been removed.

Paid-link evidence additionally requires `payment.consumed:true` and `payment.settlement = {accepted:true,refund:false,paymentId,txid,confirmations}`. The link reader verifies the actual successful release and exact destinations/burn, with at least one confirmation. A funded-but-refundable lock and a refund cannot buy a permanent link. Transaction IDs use bare 32-byte hex, including normalized Ethereum transaction hashes. For Ethereum the terminal deposit status must be the successful released state.
