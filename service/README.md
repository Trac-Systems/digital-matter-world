# Local gateway

Node **24 LTS (24.22.1 or newer 24.x)**, ESM. Install the
`rules/`, `contract/`, `committee/` and `local/` dependencies first. Rules imports
pass through [src/rules.mjs](src/rules.mjs). The built-in `node:sqlite` API needs
no flag and emits no experimental warning on 24.22.1. This package runs against
loopback regtest services.

Run `npm --prefix service ci --ignore-scripts` for its browser test dependency,
then `cd service && npx --no-install playwright install chromium` once. See the
[repository setup](../README.md#install-and-test) for the complete test install.

The gateway journals signed move receipts before acknowledging them. Three
committee members witness each nonempty receipt root before its claim window
closes. Replay produces ordered v4 observation files; batches may contain
repeated counted heights, frozen tips, branches and catch-up observations.
Stalled-only observations wait until the counted height advances. Each batch
contains one receipt notary and at most 512 observations, subject to audit and
contract operation limits. Audit filenames include both observation and height.

Mint reservations, paid holds, consumption and unpaid expiry use `rq`, `mp`, `mc` and `rx`
inputs in the final observation of a batch. The contract authority supplies its
committee epoch; the TSS share epoch remains a separate configuration field.

## Run and verify

```sh
source ~/.nvm/nvm.sh
nvm use 24.22.1
export npm_config_userconfig=/dev/null
node --experimental-test-module-mocks --test service/test/*.test.mjs
node --experimental-test-module-mocks --test service/test/regressions/*.test.mjs
node service/scripts/load.mjs 144
node service/run.mjs /absolute/private/gateway.json
```

The pay-first regression suites use independent reader fixtures and contract replay.
Node 24 still requires `--experimental-test-module-mocks`; mocks use the current
`exports` option. `npm test`, `npm run test:regressions` and `npm run test:prod`
include that flag.
See [rehearsal checks](../deploy/REHEARSAL.md). No live TAP burn proof is claimed.

The load harness sends 500 bundled header/claim moves and 1,200 viewer requests
per block, for 144 simulated ten-minute blocks. It kills and restarts the gateway
halfway through intake and checks every acknowledged sequence. Its committee
and receipt witnesses use disposable test keys; it applies the actual contract
transition to disk-backed storage. It reports this distinction explicitly.
The separate `scripts/measure-devnet.mjs` measures physical peer-log growth.

## Concrete adapters and configuration

[local/adapter.mjs](local/adapter.mjs) supplies the gateway adapters.
[local/reads.mjs](local/reads.mjs) supplies both gateway reads and each signer's
`createReads({config: absoluteGatewayConfigPath})` adapter.
[local/trac.mjs](local/trac.mjs) runs the local Trac devnet and a token-protected
loopback RPC. Its process owns a disposable devnet; a new devnet requires fresh
gateway state. Restarting the gateway leaves the running Trac ledger intact.

The private configuration must live outside the repository. Required fields:

| Field | Value |
| --- | --- |
| `version`, `mode`, `network` | `1`, `regtest`, deployment network ID |
| `listen` | `{host:"127.0.0.1",port:...}` |
| `endpoints` | Explicit loopback `ethereum` and `trac` URLs; Bitcoin/TAP use `local.tapSourceFile` |
| `data`, `gatewayKey` | Absolute private paths; gateway seed is 32-byte hex |
| `adapter` | Absolute path to `service/local/adapter.mjs` |
| `committee` | Five `{id,url,token,peer}` signer descriptors |
| `epoch`, `patterns` | TSS share epoch and configured accepted pattern table |
| `puzzleBits`, `pollMs` | Defaults 12 and 1000 |
| `local.manifest` | Existing local stack manifest path |
| `local.contexts`, `local.registry` | Private replay context directory and asset/fee registry |
| `local.tracToken` | Local RPC credential |
| `local.escrow` | `{chainId,address,token}` for the deployed local DmwEscrow |
| `local.tapSourceFile` | Absolute private mode-0600 source file; never put the source URL in config |
| `local.startTip` | Initial replay checkpoint; default 1 |

The proof script is an executable example of all configuration structures,
including the Trac daemon configuration and signer credentials. No default
public endpoints or price conversion are supplied. The registry binds assets to
indexed deployments, activated privilege authorities, pattern definitions and
payment destinations. Finds are checked against audit files committed by an
accepted Trac batch root. The local implementation supports awarded finds and
explicitly configured compound deployments; it is not an automatic asset
registry or arbitrary Bitmap ownership resolver.

Signers verify Bitcoin headers and transaction inclusion through ord HTTP, mint and
payment records from ord-tap, and balances, pending records, acceptance heights,
epochs and batch roots from Trac. They independently replay the batch and run
the contract operation preflight. Replay start state, patterns and admission
ledgers are private operator-controlled local records, not signing-request HTTP
fields. The deployment registry and those records remain part of the trusted
adapter boundary. Keep all data and credentials private.

## Live fees

The operator supplies B to the command as a positive decimal TAP amount, with
at most 18 fractional digits. For example, `22.6` stores `22600000000000000000`
atomic TAP units. B represents $1 worth of TAP at the operator's chosen rate;
the service does not fetch a market price. Both payment routes use that same
atomic integer for finds, compounds and links.

Gateway and signers must read identical policy revisions from `local.registry`
or `prod.registry`. Change any settings in one command:

```sh
source ~/.nvm/nvm.sh
nvm use 24.22.1
export npm_config_userconfig=/dev/null
node service/scripts/base-fee.mjs /absolute/private/gateway.json --base-fee 22.6 --link 3 --tier-multipliers 1,3,10,30,100 --compound-minimum 10
```

The command atomically replaces the registry. New quotes use the new B and multipliers on the
next read, with no restart, signal, waiting period or scheduled activation.
The operator registry must contain one global `feePolicy` with `current` and
`revisions`. Startup fails if it is missing or invalid. Initialize it with
`createFeePolicy(parseTapAmount('22.6'), 0, LAUNCH_FEE_SETTINGS)`, importing `createFeePolicy` and `LAUNCH_FEE_SETTINGS` from
`src/fees.mjs` and `parseTapAmount` from `rules/src/index.js`; each revision contains
`{id, baseFee, activeFrom, retiredAt, feeSettings?}`.
`feeSettings` contains `link`, five `tierMultipliers`, and `compoundMinimum`;
all must be integers in 1..10000, and every resulting price must fit TAP amounts.
Launch settings select link 3 (67.8 TAP at B = 22.6), tiers 1/3/10/30/100 and
compound minimum 10. The unconfigured legacy fallback keeps link 20; never
change it to reprice existing requests. Asset and link configuration
contains destinations and asset metadata only. Retain every revision when
editing unrelated registry data so admitted requests remain verifiable.
The update command only reads and atomically replaces the registry file.

`/mint/quote` returns `baseFee` and a signed `feeQuote` containing the policy
revision, fee settings, scope, issuance time, admission expiry and Bitcoin height bounds.
Send that `feeQuote` in `/mint/request` to retain its rate and payout bindings
across a change. The agent payment-intent signature includes the exact quote
(or explicit null when requesting current terms), preventing quote substitution.
Without it, admission obtains a fresh quote. Admission lasts five minutes and
the signed request expiry must lie within the quote's 2016-block horizon.
Once admitted, the price is held through the owner's signed request expiry;
the admission timeout does not invalidate a pending payment or permit.
Link requests obtain and persist the same signed authorization
under `terms.feeAuthorization`. Payment responses expose their saved terms.

Quotes, mint status, link terms responses, health, and payout pages expose
`unit:{currency:"TAP",denomination:"atomic",decimals:18}`. This describes fee
amounts, including `baseFee`, `price`, split shares and payouts; `networkFeeSats`
remains Bitcoin satoshis. Signed fee quotes bind this unit too. Use
`formatTapAmount` for display and `tapPaymentLock` / `tapTransfer` for inscriptions;
ord-tap expects decimal TAP strings there and returns atomic strings in REST
records. Never rescale REST amounts or Ethereum deposits. Native TAP test
deployments must use `dec:"18"`; matter and compound deployments retain `dec:"0"`.

Each signer verifies the quote and its request-bound acceptance against its
configured gateway public key and the retained operator policy revision. It
recomputes the price using that B. Signature, request, rail, scope and validity
checks reject substituted or expired quotes. Other independent payment,
ownership and expiry checks still apply. Custom read adapters implement
`mintFeeTerms(id)` with the same authenticated pinned-price semantics; the
local and production adapters supply it for both payment rails. Custom adapters
also supply `feeQuotes` and `validateFeeTerms(kind,row)`; every admitted mint,
and link must carry a verified quote and request-bound authorization.

## Memory profiling

Bounded JSON requests own one deadline and one body reader. Success, response
limits, cancellation and parse failures dispose the deadline. The global local
fetch guard also disposes its deadline on body completion or cancellation.

```sh
node service/scripts/memory-profile.mjs http 2000 ${DMW_BUILD_ROOT}/service/http-profile
node service/scripts/memory-profile.mjs raw 2000 ${DMW_BUILD_ROOT}/service/raw-profile
node service/scripts/gateway-memory.mjs 1500 ${DMW_BUILD_ROOT}/service/gateway-profile
```

The HTTP benchmark compares bounded requests with plain local fetch, records
V8/process memory and outstanding RPC deadlines, and takes a final heap snapshot
after measuring RSS. The gateway benchmark runs signed claims, store writes,
replay, contract application and feeds without restarting or forcing GC. Both
require last-half RSS growth below 20,000 bytes per block; the HTTP benchmark
also requires completed RPC deadlines to be released. The gateway driver records
its child PID and closes it on completion. Each profile is limited to 40 minutes.
These focused workloads complement the real-stack 300-block soak.

## All-history claims

Every counted block is claimable. A window H admits witnessed claims through H+1; the H+2 block decides and credits winners as soon as it arrives. Overflow credits continue in bounded batches. Each credited find immediately starts its own 1,008-block finder right. A slot without a finder cannot be minted.

Batches publish v4 audits, grouped `ac` balance credits, a finds commitment and a receipt commitment. Public pattern pages carry v2 `found` and `minted` flags and are paged; per-block reads contain the claims and winners for each window.

## HTTP and publication

[Public reads](docs/READS.md) defines the paged routes shared by agents and the
playground: blocks, mint rights, quotes, events, results and agent profiles.

`POST /moves` accepts canonical `rules.stableJSON(move)` with JSON content type.
Supported moves include headers, claims, discovery commits/reveals and crafts.
Rules require discovery commitment before reveal; work is bounded per replay.
Receipt acknowledgement means durable admission, not a winning claim. The
highest observed tip prevents reopening a claim window after a reorg. Once a
nonempty tip has been sealed, further admission for that tip is refused.

Admission caps move bodies at `rules.MOVE_DEFAULTS.maxBytes` (16 KB), pending moves at 16,000 and entries per observation
at 1,000, with per-sender limits and a bounded 1.5 MB audit reservation.
Claims use `{window,plots:[{block,patterns}]}` across every counted historical block. The per-agent budget defaults to `rules.CLAIM_DEFAULTS.claimsPerWindow` (100) and can be configured through `claimsPerWindow`, up to `rules.MAX_CLAIMS_PER_WINDOW` (1000). Correct headers enter separate
draws for unclaimed patterns in the block they describe. Capacity refusals return 429 or
503 with `Retry-After`. Nonempty roots require three timely witnesses; moves
admitted while witnesses are unavailable cannot acquire late certificates.

`POST /mint/quote` takes `{asset,block?,kind:"tap"|"ethereum"}` and returns price,
allocation amounts and a separate BTC fee quote. `POST /mint/request` takes
`{request,signature,receiver,payer,kind,authorization}`. The owner signs `rq`
and the payment-intent digest exported as `payerDigest`. This binds the payer,
receiver and payment path. `POST /mint/payment` takes `{id,paymentId}` and reads
the actual payment. `GET /mint/ID` returns public progress without secrets.

`GET /health` reports the observed tip, pending observations and worker status.
Static publication paths are:

| Path | Cache policy |
| --- | --- |
| `/blocks/OBSERVATION-HEIGHT-HASH.bin` and `.json` | Immutable, one year |
| `/receipts/OBSERVATION.json` | Immutable gateway seal, one year |
| `/latest.json` | One second, must revalidate |
| Content-addressed `/patterns/` and `/records/` artifacts | Immutable, one year |

Static routes support HEAD and ETag/304. JSON artifacts remain below 60 KB.
Public collection queries use the single cursor contract in [READS.md](docs/READS.md),
with default limit 50 and maximum 200. Numbered collection and index files are
private implementation details and are not served over HTTP. Receipt witness
certificates also appear in immutable audit files.
Feed generation runs outside request handlers; external transfer/ownership
observers must enqueue their own feed refreshes.

## Durability and mint timing

The append-only, checksummed journal and SQLite index use fsync before receipt
acknowledgement. Truncated unacknowledged tails are discarded; complete-frame
corruption fails closed. One writer owns the store. Full drafts are written to
checksummed private files before an atomic journal reference, keeping large
recovery batches out of the 4 MB journal-frame limit. Keep the draft directory,
SQLite database and journal together when backing up.

Drafts have one checksummed external-file representation. A reserved or signed
draft is never silently rewritten. Signing IDs and exact proposals survive restart.
After an ambiguous preparation, the gateway can resume the original session
only when every selected signer confirms it. Missing, conflicting or aborted
sessions retain their original reservation. The outbox retries the exact stored
message or paid transaction identity while the signed batch remains live.

Each tick, including after restart, reconciles canonical acceptance before
checking epoch and deadline. An accepted draft finishes its local checkpoint even
if authority rotated immediately afterward. Otherwise a superseded epoch or
committed counted height strictly beyond the signed deadline retires the draft,
ceremony and outbox together, preserving all of them in `supersededDrafts` before
rebuilding. That index references checksummed private files in `retired-drafts/`
containing the full draft, ceremony and transport evidence. Signers independently
prove and journal retirement. The default batch
deadline is six blocks beyond the verified application height, with a hard maximum
of 36. A transient refusal never proves expiry; the standalone header relay must
commit clock progress even when a combined submission fails.

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

## Recovery

The original request, signed fee terms, payment hints, receipt allocations and
permit plan survive restart. Signing retries preserve the ceremony identity.
An issued permit is never cancelled or replaced. Historical payout ledgers remain
readable, but new mints create no treasury liabilities or scheduled payouts.
The service has no Bitcoin spending wallet or Ethereum transaction sender.

## Paid Bitmap links

`POST /link/request` accepts `{request,sig,payer,paymentHash}`. The request is
`{owner,height,nonce,until}` signed with `rules.signLink`; `paymentHash` is the
SHA-256 hash of a payer-controlled preimage. The response binds the request ID,
terms, price and split (half treasury, half native TAP burn). The local registry
must configure `link:{treasury}` and the global `feePolicy`. The current Bitmap
wallet must have a unique accepted TAP payout binding to its agent.
The local reader checks actual regtest ord-tap `getBitmap` ownership and the
current inscription address, then maps that address through the independently verified payout binding.
No Bitmap fixture or registry-only ownership assertion is used.

Create a TAP hashlock with those exact terms and request ID in `redeem.data`,
then arrange its release through the TAP authority. The gateway does not handle
this preimage. `POST /link/payment` with `{id,paymentId}` accepts only a release
included in one block. A refundable funded lock, refund, changed holder,
incorrect allocation, or prior link is refused. Independent committee readers
check the same holder, contract link record, policy and actual payment release.
At most four links enter the last observation of a batch. Publication records
`link/<base36 height>` at the execution height and refreshes the affected page.
Repeating the original request/payment is idempotent. There are 256 active
requests and eight per owner; expired unfunded requests release those slots.

This is payment before permanent publication. A holder transfer or another
accepted link between payment and publication produces a durable rejection;
already released TAP fees cannot be undone by the gateway. Original requests,
terminal outcomes and payment IDs remain available for reconciliation.

## Disk retention

Accepted binary audits, summaries, original receipt seals and explicit missed
or deferred receipt evidence remain immutable. Small accepted-batch, find,
header, payment, link and replay-protection indexes remain durable. Header
history, including retained forks, is needed for discovery replay and grows
with history; it is not copied into each permanent proposal record.

Only the current draft is retained. A new draft is fsynced before its reference
changes; superseded files are removed afterwards. Startup removes unreferenced
drafts left before the reference checkpoint. Accepted batch ceremonies retain their
proposal hash, original session identity and result; the full proposal is
recoverable from accepted audits. Mint and unresolved financial ceremonies
retain their original evidence. Receipt witness rows reference their immutable
audit after acceptance; readers verify its hash before loading receipts.

Replay contexts retain the most recent eight accepted batches plus any active
proposal. Local signer configs use distinct stable `readerId` values for their
Bitcoin caches; the gateway uses its own stable cache. Restarts reuse these
bounded-memory disk indexes rather than creating a new cache per PID. These
caches grow only with distinct Bitcoin headers; each reader checkpoints its WAL
at 64 pages and caps the reusable journal at 256 KiB. Configure each signer's
`readOptions.readerId`; cached headers are not authoritative evidence.

Pattern pages are replaceable views. Each page retains its current snapshot
and fifteen previous versions, with crash-replayable garbage collection. Startup
reconciles interrupted current-version publications, preserving the pointer
target even if the version checkpoint was not written. Internal pointers are
not HTTP collection routes; clients page `/patterns/ASSET/blocks`. Rankings
and payout snapshots replace their internal files. Unresolved recovery evidence
is never aged out merely to meet a budget.

The fsynced acknowledgement journal checkpoints to SQLite and rotates at 2 MB,
including when Bitcoin is stalled; a write group may temporarily exceed that
threshold. SQLite reuses freed pages and checkpoints its WAL during rotation.
Its database remains the durable index after journal compaction. Retention does
not claim constant total disk: immutable audits and small indexes grow per
block. The soak measures both logical and allocated bytes, including private inscription packages, contexts
and local signer read caches, against a 100,000-byte/block budget at 100 agents.

The relay acknowledges a validated stored header independently of whether its
fork has more work. Its durable delivery cursor advances through lower-work
candidates; only the selected tip becomes a gateway observation. Lost responses
replay the same saved header identity. This permits reorg recovery without
rewinding the counted deadline clock or dropping pending observation records.

## Player payout wallets

The gateway exposes the double-signature binding API and the bare local
`/bind-payout/ID` signing page; see [public reads](docs/READS.md#payout-wallet-bindings).
Each committee signer independently verifies the agent and wallet signatures,
then durably endorses the agent/rail nonce. Three pinned identity attestations
activate the binding. Public history retains both signatures and the quorum.
The operator registry contains deployment and treasury policy, not player payout
addresses. Quote snapshots are signed by the gateway and reverified against the
wallet proofs, accepted history, and each signer's locally remembered nonces.
TAP signatures use BIP-322 simple key-path Taproot or TAP Wallet's legacy Bitcoin
message signature, verified against the recovered key's exact BIP86 address.
Ethereum uses EIP-191. Gateway and signer processes must share the updated
verifier before accepting legacy TAP proofs.

The positional base-fee command remains supported. Omitted flags retain their
previous values. `--registry /absolute/registry.json` updates a registry directly;
`--at MILLISECONDS` gives independently updated copies the same revision ID.
The `/status` and `/operator/status` pages expose the live multipliers.
Retain existing policy revisions and deployment pins when updating configured
registry copies.
