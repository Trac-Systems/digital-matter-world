# Local development

The stack runs Bitcoin Core regtest, ord-tap, a wallet gateway and an in-memory
Anvil chain. All listeners bind to `127.0.0.1`. Each start creates a new run under
`data/` in the external build directory configured by `local/common.mjs`; stopped runs remain available for
inspection. No chain is resumed automatically.

See [Compound minting and Bitcoin payments](docs/PAYMENTS.md) for ordinary
privileged token mints, the payer wallet payload, native payment splits and burns,
and independent HTLC refunds. Run those proofs with `node local/prove-payments.mjs`
on a fresh stack; the test suite includes them too.

The [cancellable batch inscriber](docs/INSCRIBER.md) provides durable preparation,
commit/reveal broadcast and both Bitcoin cancellation paths for the service
queue. It controls its own Taproot keys and uses a dedicated descriptor wallet.
The immediate-broadcast wallet gateway below remains a separate development path.

One-time setup on this Apple Silicon machine:

```sh
./local/setup
```

Prerequisites are Bitcoin Core **29.0.0**, Foundry **1.7.1**, Rust **1.89.0**,
Python **3.11.15**, Ninja, Xcode command-line tools, Node **23.11.0** under nvm,
and the existing Solidity **0.8.26** compiler at `~/.svm/0.8.26/solc-0.8.26`.
The read-only ord-tap source is pinned to
`b8f6ea35cf6b9d405d4db7c58555e3c8ab33e8cd` in the shared build directory.
`local/build-ord` builds the exact Node **20.10.0** V8 libraries required by that
revision, verifies the release source checksum and packaged `SHA256SUMS`, and
builds ord with `cargo build --locked --release`. RE2 **2024-06-01** is vendored
by ord-tap. V8 lives at `target/node20-v8` outside the read-only checkout;
native and Cargo outputs use
`target/` in that external build directory. The first setup takes substantially
longer than subsequent starts. Setup reuses the built ord binary.

```sh
./local/up
./local/down
./local/wipe /absolute/path/to/the/printed/run
```

Use the exact absolute run path printed by `up` in the wipe command. Wipe checks
the ownership marker, rejects symlinks, stops the recorded processes and removes
only that run. It does not remove the shared build. `down` optionally accepts a
specific absolute run path. It uses the run's private control socket; recovery
after a supervisor crash also checks each recorded PID's start time and command
before signalling it. A lock prevents simultaneous stacks on the fixed ports.
Logs, disposable wallet recovery material, inscription batches, order records
and `manifest.json` live in the run folder, with private file permissions.

| Service | Local endpoint |
| --- | --- |
| Bitcoin RPC | `http://127.0.0.1:18443` |
| ord and TAP REST | `http://127.0.0.1:55888` |
| TAP wallet gateway | `http://127.0.0.1:55999` |
| Anvil, chain ID 31337 | `http://127.0.0.1:58545` |

Bitcoin uses cookie authentication, `txindex=1`, no external peers and a funded
`faucet` wallet. The separate `ord` wallet starts with 10 test BTC and protects
its inscription outputs during funding. The manifest contains the mining and
inscriber addresses, Anvil accounts and deployed token address. Anvil has no
state dump or persistence option enabled.

Block making and the protocol proof:

```sh
source ~/.nvm/nvm.sh
nvm use 23.11.0
export npm_config_userconfig=/dev/null
node local/stack.mjs mine 10
node local/stack.mjs mine 1 2
node local/stack.mjs mine stop
node local/prove.mjs
node local/stack.mjs status
```

The first mining command makes ten blocks; the second makes one block every two
seconds after indexing completes. Disk checks refuse starts, builds, mining and
inscribing below 100 GiB free.

Automatic mining belongs to the supervisor and stops with `down`; the `mine stop`
command pauses it without stopping the stack. Intervals never overlap an active
mining/indexing operation.

The proof creates a DMT element, activates a secp256k1 privilege authority by
self-transfer, deploys a `prv`-gated DMT ticker, and mints block 100 to a specific
receiver. Its `[0-9]` pattern on field 4 counts three matches and credits three
tokens. It checks the REST balances, holder record and consumed signature;
wrong receivers, missing permits, duplicate block/ticker mints and signature
replays cannot add supply. It then executes a transferable inscription, HTLC
claim and timed refund (including wrong-preimage and early-refund rejection),
and authority-gated escrow settlement. Finally, it batches eight independently
permitted mints for blocks 102–109 to alternating receivers in one reveal and
checks every holder and balance. Results are saved as `proof.json`.

All TAP feature heights are zero on regtest: see `feature_height` in
`ord-tap/src/index/updater/inscription_updater/tap/mod.rs`. The mint message is
`p-op-tick-blk-dep-address[-dta]-salt`, hashed with SHA256 and signed with
recoverable secp256k1 ECDSA. Authority and redeem messages instead hash
`JSON.stringify(payload) + salt`. The direct JS dependencies are
`@noble/curves` **1.9.7** and `@scure/btc-signer` **1.8.1**, with the dependency
tree fixed by `package-lock.json`.

`local/inscriber.mjs` uses ord's wallet commit/reveal implementation. Its batch
file selects `separate-outputs`: multiple envelopes share one reveal transaction
and each gets an output with its requested receiver and postage. The proof
actually batches the element and privilege authority, then eight DMT mints.
Calls accept up to 100
entries, bounded content sizes, and ord's standard transaction weight checks.
Dependent operations whose IDs or state are needed by later operations use
separate confirmed transactions. This is the same batching mechanism available
for many independent signed DMT mints.

This ord revision's commit recovery-key import fails with the installed Core 29
wallet. The disposable inscriber therefore uses ord's `--no-backup` option.
Successful reveals are verified, but an interrupted commit has no separately
imported recovery key. Failed orders are retained and are not automatically
retried. This choice is confined to disposable regtest funds.

The gateway implements the request shapes in the pinned TAP wallet checkout
`9c549de160a2f0594b3b91f86b06aa4cff84cf0b`. Bitcoin UTXOs use serialized
`scantxoutset` scans with mempool spends/outputs applied; transaction history
walks the small regtest chain. Ord serves real inscription metadata, content,
previews and ownership. TAP paths proxy to `/r/tap/`, and token balance rows are
enriched with deployment metadata for the wallet. Rune lists are empty, matching
the wallet's regtest behavior; Rune indexing is not enabled.

Text and TAP-transfer orders return a unique pay address and a conservative
local fee quote. A one-second worker checks for one confirmed payment, then
creates the commit/reveal. The explicit `paid` route does the same check and is
idempotent after success. Transfer orders create the transferable at the token
owner's address; the wallet subsequently sends it. Only unpaid orders can be
cancelled. A broadcast failure is recorded for inspection rather than silently
retried. The stack is disposable: order records are retained for inspection,
not restored into a later fresh run. Test inscriptions are funded by the ord
wallet and payments are received by the faucet wallet; this is local test
accounting, not a production inscriber.

TRAC is explicitly stubbed: fee, validity and balance are zero, history is empty,
and broadcasts fail with HTTP 501. Prices return zero. This stack does not start
a Trac devnet. The pinned wallet has two caveats despite its regtest gateway
setting: its BTC-price client does not switch bases in `UsdAPI.changeNetwork`,
and `TracApi` base selection/history do not branch for regtest. These call sites
need a wallet-side correction before relying on an extension session to remain
entirely local. The gateway tests exercise the matching local routes directly.

Run all checks with the stack stopped:

```sh
source ~/.nvm/nvm.sh
nvm use 23.11.0
export npm_config_userconfig=/dev/null
node --test local/test/*.test.mjs
cd eth
forge test
```

The integration suite starts real daemons, runs the mint/transfer/lock proof,
replays wallet-shaped requests from `local/test/fixtures/wallet-requests.json`,
verifies paid inscription orders, stops the daemons, then checks a fresh start
and exact-path wipe. It preserves its first stopped run for inspection.
No public RPC or wallet service is used by these checks.
