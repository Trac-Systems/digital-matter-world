# Digital Matter World contract

An Intercom notary for Bitcoin header counting, committee batches, fungible balances,
owner-authorized exchanges, transfers and SHA-256 hashlocks. It contains no game
formulas, pattern matching, draws or payment verification.

Read [OPERATION.md](docs/OPERATION.md) for the clock, custody, settlement and
fixed-format requirements before choosing launch identities.

## Run locally

Use Node 23.11.0. The dependency lock preserves the tested RESET dependency graph,
including these exact source commits:

- trac-peer: `2e6f458cb1baa075bc52230c6eb9a3a349d91421`
- trac-msb: `ea72a9c82a85059c014387cb21f759d2419bed3c`
- @noble/curves: `1.9.7`; @noble/hashes: `1.8.0`; trac-wallet: `1.0.1`

```sh
source ~/.nvm/nvm.sh
nvm use 23.11.0
export npm_config_userconfig=/dev/null
cd contract
npm ci
npm test
npm run test:pear
npm run simulate
npm run measure
npm run measure:devnet
npm run devnet
```

The devnet is an automatic, finite exercise using a loopback DHT, a real local MSB,
an indexer and one writer. It demonstrates free headers and signed batches, paid
transfers, hashlock claim/refund, paid header/batch fallback, a 20-header paid
message, a large paid batch, an owner-signed exchange, a compound mint request/completion, and combined headers. The Pear command runs
the peers in separate Bare processes. Both paths check replicated state and TNK
fees, close their processes, and delete only their own generated run directory.
They neither connect to a public blockchain nor use real funds.

`simulate` runs 12,960 synthetic workload rounds (at least 90 days at 144 blocks/day), 500 agents,
random invalid messages, invalid signatures, replay, transfer/exchange races and
lock activity and per-asset conservation checks after every attempt. Extra request
rounds advance additional headers. Its seed is fixed; an optional block count can be passed to
`node scripts/simulate.mjs 25920`. Results are written to `simulation.json`.

`node scripts/measure-open-history.mjs` measures the all-history budget with 500
active agents, four claims each, aggregated credits and a RESET comparison. It
reports signed wire bytes, logical writes and standalone Hyperbee view-log growth.

`measure` writes `measurements.json` with logical key/value write bytes for combined
batches and headers. `measure:devnet` runs 1,000 measured blocks after filling the
header retention window and registering 500 agents. Each block has 16 credits, one
paid transfer and one paid lock. It writes `measurements-devnet.json` with committed
contract/runtime writes, physical input/view/system log growth and disk growth per
peer. All measurements separate logical bytes from physical storage. See
[STORAGE.md](docs/STORAGE.md) for workload limits and results.

## Files

- [signing.js](signing.js): standalone canonical JSON, hash and signing domains;
  shared with rules, clients and committee tools. No contract or Node imports.
- [state.js](state.js): buffered transitions; all reads see earlier buffered writes.
  Rejected calls discard the complete write set.
- [beacon/bitcoin.js](beacon/bitcoin.js): RESET header validation, compact records,
  revisable counted hashes, deep-fork recovery and incremental indexed pruning.
- [contract.js](contract.js), [protocol.js](protocol.js): Trac execution and reads.
- [docs/PROTOCOL.md](docs/PROTOCOL.md): exact wire formats and storage layout.
- [docs/STATES.md](docs/STATES.md): every state, entry, exit and timeout.
- [docs/STORAGE.md](docs/STORAGE.md): measured write volume and budget result.
- [docs/OPERATION.md](docs/OPERATION.md): deployment and operating requirements.

Bitcoin header arithmetic, the reference beacon, mainnet retarget fixture and
validator fanout originate in RESET. The production beacon stores neither the
complete header window nor an activity history in a single value. The reference
implementation exists only in tests and measurements.
