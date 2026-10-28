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
All five local Unix accounts use the configured single ord + ord-tap source. Each
verifies its own header history and transaction inclusion.

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
| `bitcoin` | `kind:"ord"` and `urlFile`; no RPC, wallet, alternate source or auth fields |
| `tap` | Exactly one endpoint with `agreement:1`, matching the Bitcoin source origin |
| `ethereum` | Endpoint, decimal `chainId`, lowercase `address`/`token`, deployment `fromBlock`, confirmation depth, `maxLogRange`, `maxLogPages` |
| `trac` | Expected `bootstrap`, `msbBootstrap`, `networkId`, private `runtimeConfig`; optional private `runtimeModule` override |
| `committeeRotation` | Optional independently approved rotation JSON file; absent means no authorization |

The registry requires one global `feePolicy:{current,revisions}` initialized
with `createFeePolicy(baseFee)` from `service/src/fees.mjs`. Startup validates every
revision; missing policy is an error. Asset and link entries contain
metadata and destinations. All quotes and admissions are signed, and signers
verify their pinned base price against the retained revision. Atomically replacing this
shared registry applies a new base price to new quotes immediately; retain prior revisions
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

Fee multipliers are global operator settings alongside the base price, retained per revision
and signed into quotes. Launch configuration uses link 3, tiers 1/3/10/30/100
and compound minimum 10. Use `service/scripts/base-fee.mjs` with `--link`,
`--tier-multipliers`, `--compound-minimum` and/or `--base-fee`; new quotes change
immediately after the coordinated registry update. Both gateway and all signers
need the revision-aware reader code; installed player kits need no update.
See [host 157 fees](../../deploy/host-157/FEES.md) for its pinned copies.
