# Production adapters

Node 24.22.1; ESM; no additional dependencies. The pinned Bitcoin and secp256k1
libraries are resolved through `local/package.json`; Trac uses the installed
`contract/` dependencies. Nothing connects at module import time.

Run the offline checks from the repository root:

```sh
source ~/.nvm/nvm.sh
nvm use 24.22.1
export npm_config_userconfig=/dev/null
node --test service/prod/test/*.test.mjs deploy/production-evidence.test.mjs
```

The tests use recorded Bitcoin genesis bytes, synthetic cryptographic fixtures,
captured regtest ord responses, RPC stand-ins for Ethereum and HTTP servers bound to loopback. No test starts a
chain daemon, loads an operator configuration, or contacts an external service.

## Integration

`loadConfig(absoluteFilename, {committee})` in `config.mjs` validates the schema
and filesystem requirements. `createAdapters({config,store,history,runtime?})`
in `adapter.mjs` returns the gateway's reads, transport, mint operations,
payment readers, links, observations and cleanup methods.
`service/prod/reads.mjs` exports
`createReads({config:absoluteFilename,readerId,gateway,identity})`; `gateway` is
the trusted public identity and `identity` is that operator's own signing seed.
Each signer needs its own owned connection files, `prod.readerData` and the
required authenticated `prod.evidence` endpoint.
The gateway accepts `prod.evidenceSnapshot: { "retries": 3, "backoffMs": 50 }`
(defaults shown). Retries may be 0–5 and the fixed delay 0–1000 ms. Each retry
rebuilds the entire envelope after a store revision or Trac stamp change;
authentication, replay, file-hash and capacity failures are never retried.
The original nonce stays consumed, including on exhaustion. Persistent churn
still fails closed with HTTP 400 `evidence_snapshot_changed`; signer HTTP
clients do not retry this POST. A request may not outlive its 30-second challenge.
Each configured signer verifies header history and transaction inclusion using
its own reader state and configured ord + ord-tap source.

`service/run.mjs --target FILE` renders and dispatches the selected production
or local adapter. Production deployment orchestration is documented in
[PRODUCTION.md](../../deploy/PRODUCTION.md); it uses existing services and
explicit file-backed roles.

Always call `await adapters.close()` or `await reads.close()`. A supplied gateway
store remains owned by the caller. Committee readers open their own durable
observer/index store and an authenticated evidence store. They do not open a
copy of the gateway database.

## Private configuration

`config.schema.json` describes the JSON shape; `validateConfig` also performs
cross-field, role, deployment and filesystem checks. Every private file must
already exist, belong to the process user, be a regular nonsymlink file with
mode 0600, and live outside every Git checkout. Private directories must exist
with mode 0700. Missing files are errors. File reads are bounded and use
`O_NOFOLLOW`. There are no default provider URLs or embedded credentials.

The top-level fields are `version:1`, `mode:"prod"`, `network`, `data`, and five
`committee` identity descriptors. Gateway use additionally requires
`gatewayKey`. The gateway's server/committee connection configuration belongs to
the embedding launcher. Endpoint objects contain `urlFile` and optionally
`tokenFile` (Bearer) or `authFile` (Basic credentials). Files contain only
the endpoint or credential value. Remote providers require HTTPS hostnames.
Same-host services may use an explicit `http://127.0.0.1:PORT` origin (1024–65535).
Other cleartext addresses, loopback aliases, embedded credentials and regtest
paths are refused. The dedicated ord source reader below is the only exception
for a private HTTP origin.

| `prod` field | Meaning |
| --- | --- |
| `contexts` | Private context directory; operator contexts arrive in authenticated snapshots |
| `evidence` | Required for operators: endpoint, directory, member, network and epoch; bounded signed gateway evidence |
| `readerData` | Per-process durable Bitcoin header, clock and Trac event state |
| `registry` | Private deployment/asset, beneficiary and fee registry |
| `deployment` | Exact original contract deployment JSON, matching the runtime |
| `headersFile` | Optional packed 80-byte mainnet headers, starting at genesis |
| `startTip` | First observation height, explicitly configured |
| `maxHeadersPerView` | Bounded live header catch-up; seed history before this is exceeded |
| `http` | Per-source pacing, timeout, retry/backoff and queue settings |
| `bitmapCache` | Public wallet snapshot memory, lifetime and tip-check settings (below) |
| `bitcoin` | `kind:"ord"` and `urlFile`; no RPC, wallet, alternate source or auth fields |
| `tap` | Exactly one endpoint with `agreement:1`, matching the Bitcoin source origin |
| `ethereum` | Endpoint, decimal `chainId`, lowercase `address`/`token`, deployment `fromBlock`, confirmation depth, `maxLogRange`, `maxLogPages` |
| `trac` | Expected `bootstrap`, `msbBootstrap`, `networkId`, private `runtimeConfig`; optional private `runtimeModule` override |
| `committeeRotation` | Optional independently approved rotation JSON file; absent means no authorization |

Public reads share the source's total `http.requestsPerSecond` budget (default
2), with lower priority than game reads at every dispatch. Their separate
`http.publicRequestsPerSecond` cap defaults to 1 and `http.publicMaxQueue` to 16;
they cannot consume the game's `maxQueue` slots. A game request may wait for
one already-running public request (bounded by `timeoutMs`) and the shared
pacing interval, but never for a public backlog or its retries. Continuous game
traffic can delay public reads. This budget is per process, as before.

Agent summaries return `bitmaps: null` and `bitmapStatus: {state: "deferred",
route: "/agents/<address>/bitmaps"}`. The page renders immediately and fetches
that route separately for its existing inspector. The bitmap route includes
`bitmapContext` with the verified TAP tip height/hash, tip `checkedAt`, snapshot
`loadedAt` (Unix milliseconds), and `cached`. Ownership is as of that tip, not a
claim about an unobserved latest block. An unbound agent returns an empty list
with `state: "unbound", tip: null` without contacting TAP or Bitcoin.

`prod.bitmapCache` defaults to `maxEntries: 128`, `maxRows: 10000` retained
across wallets, `maxInscriptions: 10000` per scan, `maxConcurrentLoads: 2`,
`ttlMs: 600000`, and `tipMaxAgeMs: 5000`. Tip observations are reused for at
most five seconds. When a tip check is due, a retained snapshot returns
immediately with its original tip/check time, `tipCheckDue: true`, and
`refreshing` indicating whether a background canonical check is running.
This reuses the same public queue and scan budget; a check failure never advances
the snapshot's tip or check time. An expired snapshot itself is never served.
Any newly observed height or hash invalidates a wallet's old snapshot on read,
including same-height reorganizations. Each new scan also checks the tip after
completion and rejects a mid-scan change. Concurrent reads of the same wallet
share the scan; excess distinct scans fail with `bitmap_cache_busy`. Wallets
above the configured inscription bound fail with `bitmap_count`; snapshots
above the retained-row budget are returned without caching. Expired/LRU entries
are evicted. Links are projected from current local records on every response.
These caches do not change payment, consensus or mint-ownership checks.

The registry requires one global `feePolicy:{current,revisions}` initialized
with `createFeePolicy(B)` from `service/src/fees.mjs`. Startup validates every
revision; missing policy is an error. Asset and link entries contain
metadata and destinations. All quotes and admissions are signed, and signers
verify their pinned B against the retained revision. Atomically replacing this
shared registry applies a new B to new quotes immediately; retain prior revisions
for admitted requests. See [live base fees](../README.md#live-base-fee).

Mint Ethereum access is read-only. `signerKeyFile`, `tapRelayer` and `inscriber`
are rejected. The one-time owner escrow deployment key belongs to `deploy/`,
never the running gateway. TAP source endpoints use `tapEndpoint`: the address
is loaded only from a private 0600 file (root-owned on Linux), or the exact
`$CREDENTIALS_DIRECTORY/<urlFile basename>` read-only copy systemd provides
(0400 owned by the service user, or root-owned 0440 readable through its ACL). Only an explicit HTTP(S) origin is accepted; requests stay on that
origin and redirects are refused. Errors never expose its contents. Local
readers require `local.tapSourceFile` and verify regtest genesis through the
same reader. Their configuration has no Bitcoin RPC endpoint.

## Evidence and transactions

Bitcoin headers come from the agents' Trac beacon, with raw headers, blocks and
transactions fetched from ord's `/r/blockinfo/{hash}`, `/block/{hash}` JSON and
`/r/tx/{txid}` routes. The 80-byte header and transaction IDs are reconstructed
locally. Raw blocks are reconstructed from ordered transaction objects, retaining
witness bytes and checking block weight and the witness commitment. Header snapshots verify
genesis, proof of work, linkage, mainnet retargets and median time. Indexed
transactions are decoded locally, bound to their txid, checked against the
block's Merkle root and rechecked on the canonical branch. The beacon counted
height remains the application clock. Confirmations never come from an
indexer's assertion alone. Full history should be seeded offline; missing history
beyond the configured fetch budget is refused. Header forks are retained by hash.

TAP and Bitcoin reads use the same configured ord origin. Responses and lists
are bounded; list pagination uses ord-tap's `offset`/`max`, and calls use paced
queues.
Deployment/privilege, successful mint records, lock plus consume state, Bitmap
ownership, balances, holders and block readers use the same source policy.
Consumed locks cannot regain an unconsumed status from a missing inclusion proof.

The REST API exposes current mutable state. Ownership, mint capacity and lock
reads require the requested tip/hash to match the current indexer snapshot,
with canonical checks before and after. Historical financial observations are
refused with `tap_historical_snapshot_unavailable`; an immutable historical TAP
snapshot integration is needed to replay such buffered financial observations.
Immutable block/audit and header histories remain usable for ordinary replay.
Private replay contexts, request bindings and certificates arrive through the
identity-authenticated evidence feed; ordinary signing request bodies cannot
install them. Operators require their own matching ord/Trac view and a fresh
signed snapshot. Accepted binary files remain bounded and checked against Trac
batch Merkle roots. See the evidence limits in
[PRODUCTION.md](../../deploy/PRODUCTION.md).

Trac uses `runtimeTransport` and `contract/runtime/fanout.js`. Paid transactions
require three distinct connected validators. MSB confirmation is tracked
separately from contract acceptance; a confirmed MSB transaction is not itself an
accepted batch. Gateway `Outbox` owns durable message/transaction retry identities.
Actual request acceptance heights are indexed from replicated contract history,
not inferred from today's lifetime settings. Snapshot changes refuse preflight.

The built-in `runtime.mjs` joins existing mainnet state using the pinned peer/MSB
libraries. Its private JSON requires `mode:"prod"`, `dmw`, `directory`,
`msbWallet`, `peerWallet`, `msbBootstrap`, `subnetBootstrap`, `msbChannel`,
`peerChannel`, explicit `dhtBootstrap`, and `validators:"auto"` for the standard
mainnet settings in `mainnet.mjs`. The native observer discovers validators from
replicated MSB state; startup waits for three connections. Explicit lists of
three or more distinct validator keys remain supported.
Wallets must already exist. Normal `openRuntime` joins an existing deployment;
the explicit launch path uses `connectRuntime(...,{create:true})` followed by the
shared, admitted bootstrap. Neither path creates role keys. An optional runtime module must export
`openRuntime({configFile}) -> {peer,bus,close}`. Neither the built-in runtime nor
its operation on a deployed network is exercised by these offline tests.

The native runtime also exports `openFundingRuntime({configFile})` for launch
preparation/admission. Supply `fundingDirectory`, an owned 0700 directory
different from the host and writer directories. This opens only the MSB
observer and its existing wallet, checks three connected validators, and does
not require a DMW deployment or create a Peer. It avoids both the fresh-subnet
bootstrap dependency and opening the gateway's live writer database for an
otherwise read-only funding check.

Ethereum uses the existing pinned-block escrow reader, with bounded log pages,
chain/token checks, event/getter agreement, canonical hash checks and configured
confirmation depth (one). The sender creates EIP-155 legacy transactions
locally, applies configured gas/price caps, and atomically journals signed raw
bytes plus the next reserved nonce before broadcasting. Ambiguous sends and
restarts retry the original bytes. Reverted receipts or canonical-hash changes
fail closed. There is no automatic replacement fee policy; operators must
reconcile a transaction that remains underpriced.

A signed `POST /mint/quote` reserves the requested Trac units and returns
`requestId`, `receiver`, `asset`, `amount`, `fees` and `payBy`. Every fee is an
atomic TAP item `{role,to,ticker,amount,tt}`. `fullFees` and `split` show the full
price; a recipient who is also the payer is omitted from `fees`.

The player pays the fee items before any permit exists. Status moves through
`awaiting_payment`, `partly_paid`, `paid`, `permit_issued` and `minted`, or
`expired`. `missing` contains only the unpaid amounts, so top-ups keep the same
request ID. Seeing a valid mempool or confirming payment pins the reservation
with `mp`. Final receipts need one confirmations. An unpaid reservation
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

The isolated live reader test is `service/test/ord-only.e2e.mjs`. Run it with
`DMW_BUILD_ROOT` pointing to the existing local ord build and Node 24.22.1 under
`nice -n 20`. It owns loopback ports 59750–59752 and shuts down only its children.
Its Core process creates the disposable chain and wallet inscriptions; gateway
and committee readers are denied access to that process. A local contract
harness applies the real Bitcoin beacon rules without opening DHT sockets.
The test checks mempool retention evidence, final fee items, mint inclusion and
reorg rejection. Regtest ord rejects the fixed mainnet burn recipient: that item
remains unpaid in the live test; exact burn matching is covered by unit tests.

Fee multipliers are global operator settings alongside B, retained per revision
and signed into quotes. Launch configuration uses link 3, tiers 1/3/10/30/100
and compound minimum 10. Use `service/scripts/base-fee.mjs` with `--link`,
`--tier-multipliers`, `--compound-minimum` and/or `--base-fee`; new quotes change
immediately after the coordinated registry update. Both gateway and all signers
need the revision-aware reader code; installed player kits need no update.

### Named paid evidence and source budgets

Paid production reads verify named items. `sourceLocators` is an optional request
field and is included in newly issued signed fee quotes. Its shape is
`{element:{id,offset},authority:{id,offset}}`: the element ID must equal the
registered element, and the authority ID must equal the registered privilege.
Offsets select one row (`max=1`) in `getDmtElementsList` and
`getPrivilegeAuthList`. Both values are untrusted hints: every reader checks the
returned ID, indexed semantics, inscription contents, inclusion and current
cancellation. Registration accepts the same object at `POST /mint/deployment`.
A submitted element may reuse an existing matching pattern/field pair; the
player must locate it. The service no longer searches the global catalog for
absence or an alternative name. An ignored element/name collision needs a new
named winner from the player; submitting IDs does not grant authority.

Payment submissions retain `paymentIds` and optionally
`paymentEvidence: {"<payment inscription>": {authority:{id,offset},
transfers:[{id,offset}]}}`. The authority position belongs to the payer's
`getAccountAuthList`; transfer positions belong to that inscription's
transaction's `getTransferredList`. Transfer offsets are also the permanent
receipt item indices. A submitted mint uses `inscription` and optional
`mintLocator:{id,offset}` in `POST /mint/payment`, selecting `getMintedList` for
its transaction. No wallet redeem/mint/auth history is searched in production.
An unconfirmed payment without an authority locator stays pending until it can
be verified from confirmed transfers. Confirmed named transactions without
positions retain the compatible one-page transaction read; transactions larger
than `sourceReads.pageSize` require exact positions. There is no wallet-age
cutoff, and the original request, submitted IDs, credits and detached permit
remain available for retries and correction of locators. A compound mint must
be reported by inscription ID.

Before upgrading a registry without these coordinates, run the explicit
operator import while admission is closed and application processes are stopped:

```
node service/scripts/import-source-locators.mjs /absolute/runtime.json /absolute/import-progress.json 16
```

Exit 75 means a bounded slice completed; repeat with the same progress file.
There is no lifetime row ceiling. The cursor survives interruption, resets on a
changed canonical branch, and every matched position is read again before the
registry update. This administrative import is never invoked by an action or
poll. It changes only lookup hints, preserving IDs, generations, approvals,
fees and destinations. Carry the same registry coordinates to each independent
signer.

`prod.sourceReads` controls source work and caches (defaults below). Cache byte
budgets may be zero to disable retention. Retention is LRU, in memory, per
independent reader; eviction only repeats verification. Inclusion metadata is
cached with the verified block proof, while current inscription addresses are
read within each action. Raw transaction witness data is cached only after
matching the fully verified block, keyed by block hash and txid.

| Setting | Default |
| --- | ---: |
| `contentBytes` | 8000000 |
| `transactionBytes` | 16000000 |
| `blockBytes` (includes verified headers) | 32000000 |
| `proofBytes` (includes inclusion metadata) | 8000000 |
| `indexedBytes` | 4000000 |
| `scopeBytes` | 8000000 |
| `contentMaxBytes` | 200000 |
| `tapMaxBytes` | 2000000 |
| `bitcoinMaxBytes` | 16000000 |
| `maxScopeMs` | 120000 |
| `pageSize` | 500 |
| `maxItems` | 64 |

Only indexed rows and inscription content anchored to a verified ancestor are
reused; a txid does not by itself bind inscription witness bytes. Each financial
scope has one outer before/after TAP height and canonical-hash pair; nested
reads share it and reject a different requested view. A changed or expired
scope fails before new mint admission is persisted. It never combines data
from different snapshots. There is no TTL-based reuse of mutable financial
state. Each action rechecks cancellations, receiver ownership, supply, bitmap
ownership and the winning mint as applicable.

`prod.http` uses a public queue and one total pacing rate. The dispatch
order is clock, paid, background, public. New settings are `clockMaxQueue=8`,
`backgroundMaxQueue=16`, `backgroundRequestsPerSecond=1`; paid capacity remains
`maxQueue=64`, public capacity remains `publicMaxQueue=16` and public rate
`publicRequestsPerSecond=1`. Identical outstanding GETs share a request; a
queued read is promoted if a higher-priority caller needs it. In-flight HTTP
requests are not preempted. Timeout, retry and total rate settings still apply
to all lanes. These are per-process budgets: operators must account for the
sum across the gateway and five signers when setting provider capacity.

The gateway obtains one verified clock observation for relay, observation
processing and status per poll. Paid processing, provisioning and public
projection refreshes run independently; a long projection cannot block the
next clock poll. A failed clock is reported as unavailable rather than stamped
as fresh. Signer evidence refresh and receipt checks share one verified clock
within the signer action. Accepted monetary batches still independently verify
Trac state, payouts and all required source evidence.
