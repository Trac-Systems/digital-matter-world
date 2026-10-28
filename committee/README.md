# Local committee

Five Go sidecars hold a 3-of-5 secp256k1 key generated through distributed key
generation. Five separate Node services authorize contributions using independent
read clients and the shared rules library. No aggregate private key is constructed.
The implementation is local: all listeners and peer destinations require
`127.0.0.1`, and no component submits Bitcoin or Ethereum transactions.

## Run

Use Go 1.26.x and Node 24.22.1. From the repository root:

```sh
source ~/.nvm/nvm.sh
nvm use 24.22.1
export npm_config_userconfig=/dev/null
cd committee
npm ci --ignore-scripts
cd ..
node committee/run.mjs up
node committee/run.mjs down
```

The first `up` builds the binary and generates fresh key shares. Subsequent runs
reuse the encrypted shares. Sidecars use ports 57500–57504; signer services use
57600–57604. Private local configuration, credentials, append-only journals and
PID records live in ignored `committee/.run/`. Build outputs and dependency
caches live in `${DMW_BUILD_ROOT}/target/committee/`. `down` verifies
each recorded PID's configuration argument before terminating it. It never kills
by executable name. Ceremony computations are disposable child processes owned,
cancelled and reaped by their sidecar.

The default read adapter refuses all signing requests. Health and key generation
work without a gateway. To enable policy operations, configure each signer's
`signer.json` with a local absolute `readModule` exporting
`async createReads(options)`. Configure each operator's clients independently;
requests cannot choose a module, RPC endpoint or trusted snapshot. See
[read interfaces](docs/READS.md). The integration tests supply explicit mocked
Bitcoin/Trac reads while retaining real processes, rules and threshold signing. Ethereum reads use the deployed
contracts on a disposable local Anvil.

These automatically generated credentials are for disposable local operation.
The same operating-system account can read all five directories. Real operator
isolation requires separate machines or accounts and separately provisioned
credentials; a shared local account is not a threshold security boundary.

## Threshold protocol

`tss/go.mod` pins
[`github.com/bnb-chain/tss-lib/v3 v3.0.0`](https://github.com/bnb-chain/tss-lib/releases/tag/v3.0.0).
Its threshold parameter is 2, meaning three participants are necessary. Signing
uses an agreed subset of exactly three; keygen needs five. Resharing currently
uses all five old and all five new, disjoint identities. Every ceremony has a
fresh 32-byte session nonce, network, epoch, participant roster and deadline.
Session IDs are durably consumed before computation and cannot be replayed.
No proof-disabling switches or upstream test key fixtures are used.

Each peer has its own Ed25519 identity and X25519 encryption key. Messages use
pairwise AES-256-GCM encryption and Ed25519 signatures binding session, sender and
recipient. Broadcasts additionally require matching authenticated digest echoes
from every selected participant before delivery to TSS. A conflicting echo,
authenticated malformed message, invalid proof or timeout aborts the session.
Unauthenticated packets are refused without letting an outsider abort a session.
Transport size and message counts are bounded. The roster and encrypted envelope
are independent of the loopback address, but remote networking is deliberately
disabled until separate-machine transport and identity provisioning are reviewed.

Shares use scrypt (N=32768, r=8, p=1), a fresh salt and AES-256-GCM with
network/signer associated data. Share files have mode 0600 and are atomically
written and fsynced. No incomplete ceremony overwrites an existing share.
Signatures contain decimal `r`, decimal low-S `s`, recovery ID `v` (0 or 1), and
64-byte compact hex. Ethereum uses `v+27`; TAP uses the decimal recovery ID.

The authenticated sidecar control endpoints are `POST /prepare`, `/go`, `/status`,
`/abort` and `/commit`; `/peer` uses peer identities instead of the control token.
The separate control token belongs only to the signer/operator, never to the
gateway. `tss.mjs` exports local orchestration utilities for keygen, signing and
resharing. `createGroup` creates five fresh identities; `ceremony(old, 'reshare',
{epoch: oldEpoch+1, newGroup})` performs the transition after both groups start.

Key-changing ceremonies collect signed readiness certificates from every
participant. The coordinator saves a public `decision-SESSION.json` before
committing. On resharing it stores **all five replacement shares before retiring
any old share**. Completion retires and overwrites each old vault, including
across restarts. Final distributed commit is not an atomic transaction: a crash
or unavailable participant during commit needs operator recovery from the saved
decision and surviving vaults. Do not discard either group until completion is
verified. Uncommitted computation is discarded on abort; already committed vaults
are not rolled back. Automatic recovery of an interrupted final commit is not
implemented.

Resharing preserves the public key and requires retirement of every old share,
including backups. An old threshold set remains cryptographically valid for that
key. Manage all copies under the same custody and retirement policy.

## Signing policy

Replay accepts v4 observations with window claims anywhere in counted history. The default claim budget comes from `rules.CLAIM_DEFAULTS.claimsPerWindow` (100; maximum 1000), and independent readers require the configured budget to match. Window H is decided by H+2 on arrival. Grouped `ac` credits and find/receipt commitments keep contract writes bounded. Each credited segment starts its finder rights immediately; a DMT mint requires an authenticated find. Bitcoin evidence and Ethereum deposit/release evidence require one block. Canonical-chain and reorg checks remain mandatory.


`signer/pay-first.mjs` derives the exact fee list independently from accepted
request, fee revision, beneficiary bindings, deployment and chain payment reads.
It validates the full owner signature, receiver commitment, pending acceptance,
block mint rights, whole-unit amount and indexed deployment authority. Missing
or inconsistent evidence refuses a signature.

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

`ethereum-payment-release` is a separate proposal from `mint`. It verifies the
confirmed payer-bound deposit, expected remaining split, active committee and
EIP-712 domain. Its signature authorizes the stored split only; anyone may pay
gas to submit it. A `mint` proposal requires Trac's consumed record to match the
exact permit and payment-allocation hashes. Signing slots bind the request and,
for DMT, the asset/block permanently.

Ethereum's split has treasury, finder (first maker for compounds), landowner,
discoverer and burn amounts. Self-recipient amounts are zero. No share
is routed through the treasury as a later liability. EIP-712 uses `DmwEscrow`,
version `1`, configured chain ID and escrow address. Rotation remains separately
authorized by the independent operator approval read.

## Tests

From `committee/` with Node 24.22.1 and `npm_config_userconfig=/dev/null`:

```sh
npm test
node run.mjs build
npm run test:tss
npm run test:services
npm run test:evm
```

The EVM test requires `forge` and `anvil` on PATH, or `DMW_TEST_FORGE_BIN` and
`DMW_TEST_ANVIL_BIN` pointing to local binaries. It compiles the pinned Solidity
contracts offline into `${DMW_BUILD_ROOT}/target/committee-escrow-out`
with a separate cache. It deploys LocalTap and DmwEscrow on an in-memory Anvil,
deposits funds, obtains a real threshold release, and verifies direct payments
and reduced token supply. It refuses a permit until the release is final and
the fixture reports accepted Trac consumption. It then signs a permanent permit
and applies a threshold-signed committee rotation after its fixed delay. It also
checks payer namespace collisions, independent refunds, protected admin recovery,
event/getter disagreement, replay refusal and typed-data digest equivalence.
Integration tests record PIDs and stop every child in `finally`. Test evidence and encrypted disposable vaults are
retained under the shared build directory. Each integration command needs its
own fixed loopback ports; run these commands sequentially.

For Go tests, from `committee/tss/`:

```sh
export GOTELEMETRY=off
export GOPATH=${DMW_BUILD_ROOT}/target/committee/go-path
export GOMODCACHE=${DMW_BUILD_ROOT}/target/committee/go-mod
export GOCACHE=${DMW_BUILD_ROOT}/target/committee/go-cache
export GOTMPDIR=${DMW_BUILD_ROOT}/target/committee/tmp
export TMPDIR="$GOTMPDIR"
go test -race -v ./...
```

## Receipt witnesses, result recovery and preflight

`POST /attest-root {tip,hash}` reads the gateway seal/receipts and the signer's
independent persisted Bitcoin high-water mark. It durably signs one root per
height only while `tip <= highestTip < tip+2`, before H+2 can decide any included
claim. Three distinct configured identities are required. Conflicting roots
fail closed, and missed windows cannot be certified retroactively. A known
certificate cannot be omitted during batch replay; repeated empty observations
reference it. With no timely quorum, the observation has no accepted moves.
See [rules](../rules/docs/RULES.md#witnessed-intake-and-discovery) for exact
commit/reveal order, omission handling, work bounds and snapshot invalidation.
Signers verify supplied history through independent read clients. Costly replay
runs in a Node worker thread; history requests stay on the configured read side.
Discovery does
at most 4,096 count evaluations per observation, maintains incremental indexes,
and uses persistent maps rather than copying historical finds.

`signProposal` returns `certificate` for mint permits:
`{domain:"dmw-mint-result-v1",network,details,signature,attestations}`.
Each attestation is `{signer,sig}` over canonical
`{domain,network,details,signature}`. Three distinct roster identities must agree.
Details include the original owner signature, receiver, deployment, permanent
permit and consumed payment allocations. The verifier rederives both hashes and
checks the recovered committee authority and three identity signatures. Preserve
the certificate and original signing identity. Mint certificates do not release
a preimage or reopen a consumed slot.

Every reconstructed batch calls independent `preflight(batch,{counted,last})`
before slot reservation. The provided adapter reuses the real contract's
`StateTransition.batchOp` against snapshot-pinned reads and a disposable write
set. It checks head, pause, epoch, sequence, current settings, owner deadlines,
nonces, balances and pending state. It never submits the writes. Recovery replay
records expired crafts/admissions as rejected audit inputs. An adapter without
preflight refuses signing.

Fairness is per public key, with no identity system. Bitcoin miners can influence seeds by withholding candidate headers.
Settled events remain final through deeper reorgs; excess units whose mintable
capacity disappears remain on Trac without clawback. These are accepted limits,
not properties repaired by threshold signing.
# Batch replay operations

Set `replayTimeoutMs` in each signer's JSON configuration (the file passed to
`committee/signer/service.mjs`). The default is 120000 milliseconds. It bounds
worker startup and each replay; use a positive integer no greater than Node's
timer maximum, 2147483647. Restart the configured signer after changing it.

Production replay reads the signer's own validated header database read-only,
loads a hash-bound branch once, and shares that snapshot between observations
with the same ancestry. It never trusts a header path supplied by a proposal.
Custom in-memory read adapters retain the synchronous history interface.
Timeouts and worker crashes fail the current preparation before reservation;
the next request starts a replacement worker. Keep deployed release directories
immutable so replacement workers load the same rules as the running signer.

The gateway currently allows 60000 milliseconds for `/prepare`. A replay
timeout above that is a local computation ceiling, not a longer gateway HTTP
deadline. If a request outlives HTTP, preserve the ceremony and use its status
and reservation checks; an HTTP timeout alone never permits another reservation.
