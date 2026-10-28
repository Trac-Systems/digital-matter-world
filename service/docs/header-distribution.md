# Immutable header distribution

V2 header manifests are signed by the gateway operator's existing Ed25519
identity (`gatewayKey`), using the domain `dmw-header-manifest-v1`. This is a
publication signature, not a committee signature or an alternative to Bitcoin
validation. The signature covers the complete manifest, including network,
sequence, root descriptor, extent and tip. Tree nodes and raw/gzip chunks have
SHA-256 names. No source endpoint or credentials belong in any public artifact.

The kit requires independently installed identity pins for v2 manifests. By
default the CLI uses the repository's gateway public key at signing epoch `0`.
An SDK caller passes `manifestTrust: {keys:[{key,epoch}]}` to `downloadHeaders`.
A mirror cannot supply its own trust policy. The kit still verifies raw and
compressed checksums, PoW, links, difficulty transitions, median time and an
independently obtained canonical tip before publishing the archive.

Rotation is an explicit release/operator change. Choose a new decimal epoch,
install the new key/epoch in the trusted kit network profile's optional
`headerManifestTrust.keys`, then configure the gateway's `headerSigningEpoch`
and established private `gatewayKey` file. An overlap profile can pin both old
and new epochs. Remove the retired key in a later trusted release. Remote
manifests never authorize a successor key. A client durably remembers its
highest authenticated epoch/sequence before fetching chunks; it refuses a
lower epoch/sequence, conflicting manifest at the same sequence, or a return
to unsigned v1 distribution. Reorgs publish a higher sequence with a changed
root; they do not require lowering this fence. Preserve the gateway store and
client `.manifest.json` files across restart. A restored older gateway store
must publish in a newly authorized epoch, not reset clients' fences.

## Operator resources

`headerChunkSettings` controls `chunkRows`, `chunksPerTick`,
`manifestRetention`, `garbagePerTick`, `cacheSeconds`, `immutableCacheSeconds`,
`manifestBytes`. Chunk/tree files are synced before publication.
Unchanged manifests and signature-only rotations do not recompress history.
The public header role uses `context.publicHeaderSettings` (`pageRows`,
`cacheSeconds`) and the existing verified gateway SQLite store. None of its
four `/api/blocks/tip/height`, `/api/block-height/<height>`,
`/api/block/<hash>/header`, `/api/blocks/<height>` routes constructs a source
client. A missing verified store fails closed.

Kit `headerChunkLimits` (SDK `chunkLimits`) controls `chunkBytes`, `nodeBytes`
`cleanupFiles` and `cacheKiB`. `headerHTTPSettings` controls `timeoutMs`,
`archiveTimeoutMs`, `responseBytes`, `retries` and `backoffMs`. Configure
`responseBytes` to accommodate the signed manifest and align `chunkBytes`
with the publisher's raw/compressed chunk sizes. These are local resources;
they do not change Bitcoin consensus or the pinned operator identity.

Cache files are owned by a manifest root in a private SQLite ledger. The
archive's existing exclusive process lock covers selection, transfer and
cleanup. The cache database also retains an exclusive SQLite lock across its
durable commits, fencing simultaneous recovery of a stale process lock. Selecting an authenticated successor explicitly abandons the previous
transfer; its independently verified installed archive is retained. Cleanup
uses two indexed ranges excluding the active root, at most `cleanupFiles`
entries per pass (one pass at start and one on successful completion). Both
partial and complete files for the active root stay pinned across failures and
process restarts. A successful verified install releases that root's cache
files. Unknown files are preserved. Old flat-cache files are cleaned in bounded
passes only after a successful install; no active downloader uses that layout.
Only the affected client's cache is collected, never a shared mirror's chunks.

## Seed checkpoints on gateway and signers

Ordinary flat `prod.headersFile` remains supported. Its initial integrity pass
is checkpointed before validation. Each bounded validation transaction commits
the endpoint and exact file identity (device, inode, size, nanosecond timestamps)
together with its headers. A restart of an unchanged completed seed reads zero
seed bytes; an interrupted import starts at the committed boundary. Changing
a flat file invalidates its checkpoint and requires a new initial integrity
pass. `views.seed(file,{audit:true})` explicitly requests a complete audit.

For immutable seeds, install the signed manifest and its tree/raw chunks into a
private local directory, outside the checkout, through the operator's normal
file distribution process. The directory keeps the public relative layout
`headers/tree/...` and `headers/chunks/...`. Configure every production reader:

```json
{
  "prod": {
    "headerSeed": {
      "manifestFile": "/absolute/private/seed/manifest.json",
      "directory": "/absolute/private/seed",
      "trust": {"keys": [{"key": "<independently pinned Ed25519 public key>", "epoch": "0"}]},
      "limits": {"chunkBytes": 16000000, "nodeBytes": 60000, "cleanupFiles": 64}
    }
  }
}
```

`headerSeed` takes precedence over `headersFile`; both gateway and five signer
production readers call the same implementation with separate private SQLite
stores. A pre-escrow host observation reader accepts `context.headerSeed`.
The private `lookupSettings.seedChunkRows` bounds validation transactions.
Every chunk is hash-checked before insertion, each committed endpoint binds the
consensus parameters and exact database row, and incomplete work resumes within
at most one chunk reread plus its tree path. Completed startup reads the signed
manifest and its checkpoint, with zero chunk/tree reads or source calls. The
verified database, rather than unused local seed bytes, is authoritative after
import. `views.seedChunks({...options,audit:true})` explicitly rereads the seed
and detects subsequent archive corruption. Replacing the seed manifest is an
explicit new bootstrap; it does not silently assume an unchanged prefix.

A cold kit still verifies its entire downloaded chain. Server checkpoints do
not let a new player trust an operator's statement of Bitcoin validity.

## Reproducible local measurement

Run `service/scripts/measure-header-distribution.mjs` under `nice -n 20` with
an offline mainnet header file, a **new absolute disposable directory**, an
output JSON filename, then client count, transport concurrency and sample Mbps.
The script never calls an external source and removes only its own exact
scratch path. It verifies the input, imports the verified gateway store,
measures six independent reader restarts, and compares three fresh real-kit
clients: legacy raw, legacy gzip and signed immutable chunks.

The separate controlled transport cohort authenticates the manifest and hashes
every node/chunk for every client, and exercises all four local public routes.
It records transferred response-body bytes, elapsed time, requests and client
latency percentiles. It deliberately labels transport results separately from
the three full Bitcoin consensus verifications. This is a loopback bandwidth
proof, not a live-host/CDN capacity certification or the mixed game load gate.
Cold mainnet data does not become smaller just by chunking; mirrors offload the
origin, and stable chunks reduce append/retry work. Report the measured wire
sizes without borrowing synthetic regtest compression ratios.
