# Verified header downloads

The kit downloads Bitcoin history once, verifies it locally and uses immutable
chunks for subsequent transfers. The operator signs the small v2 manifest with
the gateway Ed25519 key already pinned in the installed network release. A
public mirror can serve the files but cannot choose a trusted signing key.
Checksums, Bitcoin PoW, chain links, difficulty, median time and an independent
tip check all remain required. A signature alone is insufficient.

Interrupted downloads resume at the partial chunk's exact byte. The kit keeps
an exclusive lock for each output file and preserves its current download's
cache across failures. It cleans abandoned caches in bounded passes after an
authenticated successor supersedes them. The installed verified header file
stays in place until its replacement passes every check. Keep the companion
`.manifest.json` file: it prevents manifest rollback and unsigned downgrade.

For direct library calls, pass `manifestTrust: {keys:[{key,epoch}]}` to
`downloadHeaders`. Obtain the key independently. Never copy a key out of the
manifest you are trying to verify. The CLI uses the installed network profile;
its default identity is `gatewayKey` at epoch `"0"`.

An operator rotation arrives in a trusted kit release with an explicit
`headerManifestTrust` policy in the network profile. An overlap release can pin
both epochs; a later release removes the retired key. The download response
cannot authorize that change. A changed trust policy in a player config must
match the repository profile. Do not erase the manifest fence to bypass a
rollback error; use the corrected operator publication/trusted release.

Local resource settings can be supplied in the player config:

| Setting | Default | Meaning |
| --- | --- | --- |
| `headerChunkLimits.chunkBytes` | 16000000 | Maximum raw/compressed chunk bytes |
| `headerChunkLimits.nodeBytes` | 60000 | Maximum authenticated tree node bytes |
| `headerChunkLimits.cacheKiB` | 1024 | SQLite cache memory budget in KiB |
| `headerChunkLimits.cleanupFiles` | 64 | Cache entries per cleanup pass; up to two passes per successful refresh |
| `headerHTTPSettings.responseBytes` | 60000 | Maximum small HTTP response, including manifest |
| `headerHTTPSettings.timeoutMs` | 10000 | Small-response HTTP timeout |
| `headerHTTPSettings.archiveTimeoutMs` | 120000 | Chunk/archive HTTP timeout |
| `headerHTTPSettings.retries` | 2 | Small-response retries |
| `headerHTTPSettings.backoffMs` | 250 | Initial exponential retry delay |

SDK callers use `chunkLimits` on `downloadHeaders` and the HTTP fields in
`headerSource(origin, options)`. Limits must accommodate the publisher's
chunks; insufficient local resources cause a clear refusal rather than weaker
verification. Changing these resources never changes the operator identity or
Bitcoin rules. Legacy v1 archives remain supported until this output file has
seen an authenticated v2 manifest.


Header-distribution versions are separate from the game ruleset and public v:3
collection envelopes. Manifest resource heights/counts/byte lengths can be JSON
numbers. The stable dmw-header-manifest-v1 signature domain is intentional even
for v2 chunk manifests; do not rename it or coerce signed fields.
