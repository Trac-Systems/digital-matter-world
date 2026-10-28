# Production launch and evidence protocol

DMW uses Node 24 LTS (24.22.1 or newer 24.x). Configure the application services
to use that runtime.

The runner operates on existing services. It does not install hosts, use SSH,
generate production role keys, run DKG on behalf of operators, or publish a
repository. The production path is explicit:

```sh
node deploy/preflight.mjs --target /absolute/private/target.json --stage preparation --online
node deploy/launch.mjs --execute --target /absolute/private/target.json
```

`node deploy/production-preflight.mjs --target FILE` is also an executable
offline audit (exit 1 for unresolved inputs). Both CLIs accept the annotated
`inputs/mainnet-inputs.template.json` worksheet through its strict `target`
projection. See [server examples](servers/README.md) for adaptable service definitions.

Execute only with approved deployment inputs. To exercise an isolated local stack, use
`launch.mjs --target FILE --dry-run --regtest`.

## Inputs and phase ordering

Use the mainnet target schema and owned 0600 files/0700 directories outside
checkouts. Complete the five local Unix accounts' provisioning, sidecar configuration and
DKG first. Preparation uses signed `/attest-bootstrap` responses from those
sidecars, so post-deployment signer configuration is not a prerequisite for
creating the deployment. Each response binds the challenge, network, epoch,
operator, group key and roster to the operator's pinned identity.

The Trac runtime file needs `mode: "prod"`, `directory` for the writer,
`hostDirectory` for the host, `msbWallet`, `msbBootstrap`, `msbChannel`,
`peerChannel`, normal mainnet `dhtBootstrap` addresses and `validators:"auto"`.
The checked-in example supplies the public Trac mainnet defaults (network 918).
The MSB observer discovers validators; startup and paid sends still require
three connections, and the wrapper sends to three validators. Optional explicit
validator lists remain supported. The one indexer is also the application admin;
the paid writer retains its own key. Wallet files use native Trac format and the
matching admin seed is hex. A fresh DMW subnet's bootstrap is
an output. Existing pins must match the durable subnet. Keep both runtime
directories and the host runtime emitted as `hostDirectory/runtime.json`.
Also supply a separate owned 0700 `fundingDirectory`: preparation/admission
opens an MSB observer there, without requiring a deployed DMW subnet or locking
the gateway's writer store. Only the explicit Trac launch phase creates the host.

Pin a confirmed retarget checkpoint in `bitcoin.checkpointFile`, including its
raw header and checkpoint object. The selected Core source must reproduce it,
including proof of work and confirmation depth, before a host peer is created.
An optional second source, if configured, must agree. Put the reviewed compiler artifact at
`paths.output/verification/escrow-artifact.json`. Its canonical object hash is
journaled before Ethereum submission and must match publication verification.

The sequence is preparation, operator-inscribed privilege authority and activation,
an empty pattern table, Trac registration, one-time escrow
deployment, runtime rendering, source verification and admission. Exact Bitcoin
texts are retained in `owner-inscriptions.json`; supply verified receipt IDs via
`runtime.ownerInscriptionsFile`. The launcher never prepares or sends Bitcoin
transactions. It resumes the same texts and IDs, rejects changed content and
requires one canonical inclusion confirmation, with no additional depth or
time delay. There is no TAP payment-release authority.

New mints pay every recipient directly; no periodic treasury payout policy is
needed. See [the implemented flow](PAYMENTS.md) and
[operator inscription bundle](LAUNCH-INSCRIPTIONS.md).

## Interruption and operator configuration

Keep the original input target unchanged and rerun the same execution command.
`paths.output/launch-journal` binds that input; it stores authority payloads,
prepared Bitcoin packages, the Ethereum signed transaction, the paid Trac packet
and output patches. A changed input, operation or compiler artifact is refused.
Recovery checks the chain before resubmission. It never substitutes a new
transaction identity to conceal an uncertain result.

If the transaction is still pending, resume using the same journal after its
first canonical inclusion. One confirmation is sufficient; no extra
confirmations or waiting period are required. The initial full preparation
funding gate is saved once; every new write still checks current funds and the
remaining cumulative budget. Final
admission checks the configured operational funding floors again, so top-ups
may be necessary after launch costs. Do not raise a budget by editing a live
journal or discard a journal to clear its decisions.

`deployed-target.json`, the deployment file, writer/host runtime files, gateway
config and `kit-public.json` are local outputs. Distribute reviewed public
outputs and bind each operator as its own Unix user using `bindOperator`; start the
existing host services with their emitted configurations. The runner does not
remotely install them. If publication or host binding is pending, admission
remains closed; supply the referenced files, bind the services and resume.
`production-result.json` exists only after final admission succeeds.

Completed authority, Trac and escrow phases are retained in the journal. A later
admission resume does not reopen provisioning or the Trac writer already owned by
the live gateway. Let the first launch process exit before starting those units.
Run the emitted host runtime with `deploy/trac-host.mjs` (the dedicated host unit)
and open public admission once the configured services pass validation.
Use your installation's service and proxy management procedures to enable
admission or close it while preserving durable state.

## Independent operator evidence

Each private `runtime.signerReads` file must include `evidence`, an endpoint
descriptor with `urlFile` and optional authentication-file references pointing
to the gateway. It also supplies that account's configured Bitcoin, Ethereum
and TAP connection files, its own Trac observer, identity/domain,
and separate `evidenceDirectory`,
`contexts` and `readerData`. There is no production signer SQLite-mirror fallback.
The renderer never opens another operator's credentials or gateway signing key.

The feed signs a challenge and response using pinned Ed25519 identities. Requests
bind version, network, epoch, member, nonce and time. Responses bind that challenge,
store revision and Trac stamp. Operators require age under 30 seconds and exact
agreement with their own Core tip/hash and Trac stamp. A failed refresh immediately
invalidates old evidence. Disk snapshots are not trusted automatically at startup.
Root, deployment and signing authorizations refresh first; transport-round and
recovery endpoints retain their existing ceremony checks.

Only explicit reader namespaces/fields, the next batch context and public audit
files are projected. Wallets, credentials, journals, release shares, preimages
and private signing records are excluded. Immutable audit hashes and protocol
signatures are checked again by the normal reader/policy path. Limits are 4,095
rows, 8 MB on the wire, 200 KB per audit and 1,024 unexpired challenge nonces.
Capacity overflow refuses signing. This version does not support unbounded
history replication; larger deployments need scoped/paginated evidence before
they exceed that envelope.

## Published verification receipt

Both `sourceVerificationFile` and `tokenVerificationFile` contain private JSON:

```json
{
  "chainId": "1",
  "address": "0x...",
  "artifactFile": "/absolute/private/artifact.json",
  "inputFile": "/absolute/private/standard-input.json",
  "artifactURL": "https://verification.example/artifact.json",
  "inputURL": "https://verification.example/standard-input.json",
  "artifactSHA256": "...",
  "inputSHA256": "...",
  "runtimeSHA256": "..."
}
```

The URL responses must exactly match the pinned local bytes; redirects fail.
`runtimeSHA256` hashes the lower-case `0x`-prefixed runtime hex string returned by
Ethereum. Source/settings digests and the compiler metadata's IPFS commitment
must match the published input and deployed runtime. Solidity uses a UnixFS
metadata commitment; the encoding is checked against real solc 0.8.26 output
and the [Solidity implementation](https://github.com/ethereum/solidity/blob/v0.8.26/libsolutil/IpfsHash.cpp).
Metadata is limited to one 256 KiB UnixFS leaf. Supplied `verified` flags have
no effect. Runtime, token decimals and proxy storage reads use one block, and
that block's canonical hash is rechecked after retrieval.

For a token proxy add `implementation`, `proxyKind` (`eip1167` or `eip1967`) and
`proxyRuntimeSHA256`; the artifact/runtime pin then names the implementation.
The proxy bytecode and embedded address or implementation slot must match.
Unsupported proxy kinds refuse admission. These checks establish publication
and runtime identity; the operator must still review the selected token's behavior
and upgrade authority.

## Local proofs

See [REHEARSAL.md](REHEARSAL.md) for current player-paid checks. Earlier service-funded proof results do not establish the player-paid
flow. Fixture tests do not authorize a host deployment or establish live chain
behavior.
