# Reader evidence and registry storage v2

Signers fetch the records required by their current operation. They no longer
receive the gateway's accumulated records and audit files in one envelope.
The gateway retains old evidence, and registry migration retains every old
deployment generation and fee revision.

## Protocol and trust

`POST /operator-evidence` requires `version: 2` and a signed challenge containing
`network, epoch, member, nonce, time, query`. The operations are `open`, `get`,
`page`, `blob`, `claim-node`, and `close`. V1 requests fail with `evidence_version`; a v1
publisher refuses the extra v2 fields. There is no fallback to unverified data.

`open` returns a signed snapshot ID, authenticated AVL root, storage revision,
independently checked Trac/Bitcoin stamp, observation time and expiry. A SQLite
WAL read transaction pins the root and records while the gateway keeps writing.
An expiry timer releases abandoned snapshots. A member's next `open` releases
its previous snapshot.

`get` proves an exact `(space,id)` including absence. `page` proves the complete
requested interval, including the end of a short page. Pruned subtrees are
accepted only outside that interval. Proofs commit to canonical projected JSON;
the same database transaction updates source rows, projections and AVL nodes.
The projection allowlist excludes credentials and private transaction material.

The snapshot root authenticates gateway hints; it is **not** a new consensus
root or a substitute for independent verification. Existing signers still check
accepted audit Merkle roots against Trac, signatures, receipts, contract state,
Bitcoin inclusion and external financial evidence. Legacy v4 audit bytes and
batch/rules semantics are unchanged.

Audit and context blobs are requested by expected hash in bounded chunks. The
signer verifies the full hash before caching the immutable object on disk.
`evidence-checkpoint.json` retains the signed snapshot envelope. After restart,
mutable lookups require a fresh independently checked snapshot; cached blobs
remain reusable by hash. Missing/corrupt evidence fails closed.

Mint admission has a durable `mintAdmissions` request-to-batch/file/input index.
The reader verifies its named audit and accepted creation height; there is no
all-batches request fallback. Pattern and payout-address evidence also have
point indexes. Gateway legacy replay still uses its original hot state/catalog;
changing those consensus representations is a separate activation.

## Activated claim continuation

Activated v2 batches bind `previousClaims` and `claims`; the notary checks the
predecessor and installs `v2/claims` atomically with the batch. `dmwRulesContext`
returns it as `claimsRoot`. Signers compare this independent accepted root with
the context checkpoint before replay. V1 files and prototype v2 fixtures do not
activate this format.

The checkpoint commits rounds, receipt-chain positions, observation clocks,
receipt sequence and settlement cursors. It also commits separate radix roots
for receipt segments, claim budgets/inputs/slots/reservations, settlement pages,
header inputs/tickets/pools/awards and delivered finds. Every membership and
absence read follows a content-addressed path from those roots. Missing or
malformed nodes abort replay; they cannot become an ordinary move rejection.
Gateway-supplied flat maps are not authority for these reads.

Replay bundles a cache of touched nodes under the consensus `auditTotalBytes`
setting. Additional nodes use `query: {op:"claim-node",snapshot,id}`, with the
node's storage hash as `id`. The signed snapshot pins availability, while the
accepted claim root and storage/child hashes authenticate the contents. An
unavailable node is an error, never evidence of nonmembership. These immutable
nodes are kept in `claimNodes` outside the mutable evidence AVL. This avoids
duplicating the entire claim history or packing it into a single context blob.
The existing evidence page, depth, cache and request settings bound transport;
`auditTotalBytes` also bounds each individual claim node, and `proofDepth`
supplies the replay node-cache size. There is no lifetime node-count limit.

The gateway writes new nodes with its accepted checkpoint in the existing
atomic journal transaction. Restart loads the checkpoint and requested paths;
it does not reconstruct all claim maps. The current terminal-import route
still requires reconciled legacy work and initializes an empty claim domain
from the pinned Bitcoin anchor and accepted predecessor height. Importing live
pending claim windows is not supported by that route. Gateway, signers and
notary must use this format together; production activation remains disabled
until the other v2 release gates are closed.

## Registry

After explicit migration, the configured registry JSON contains only
`{"version":2}`. Its sibling `<registry>.records/index.sqlite` stores current
assets, immutable generations keyed by asset/deployment ID, retained fee
revisions, distinct treasury addresses and small metadata. `<registry>.legacy`
retains the original document. Readers pin a registry revision and refuse
mixed reads after a concurrent mutation.

Named reads use `asset(asset, deploymentId?)`, `feeRevision(id)` and
`currentFee()`. `page(space,{after,limit})` seeks an indexed page. Enumerating
`Object.values(registry.assets)` deliberately fails after migration so an old
consumer cannot silently rebuild the lifetime object. Provisioning and fee
updates use atomic keyed transactions; a generic whole-document writer fails
with `registry_keyed_update_required`.

The host registry exchange uses `dmw-host-registry-request-v2` and
`dmw-host-registry-v2`. Evidence refresh installs a resolver instead of syncing
every asset. Each requested generation is independently verified before local
retention. The gateway cannot authorize a signer's fee-policy change: its
current revision must match the signer's locally authorized revision, and the
launch history pins must remain present.

`/operator/deployments` now returns a page with `entries`, `revision` and
`nextCursor`. Parameters: `collection=assets|fees|generations`, `asset` for
generations, `after`, `limit`, and optional `revision`. An assets page also
includes the corresponding bounded `assets` object. Carry `revision` across
pages; restart pagination when it changes.

## Coordinated switch and offline migration

No migration or deployment runs automatically. Production reader startup requires the v2 registry; the local regtest adapter still accepts legacy fixtures. Resolve outstanding signing
work and use the operator's normal backup/maintenance process before switching
the gateway and every signer together. Upgrade the host registry endpoint too.
Do not run old readers/writers against the v2 registry marker.

With Node 24.22.1, on **stopped copies first**, run:

```sh
nice -n 20 node service/scripts/migrate-reader-storage.mjs \
  --data /absolute/copied-gateway-data \
  --contexts /absolute/copied-contexts \
  --network NETWORK \
  --registry /absolute/copied-registry.json
```

Run registry conversion for each signer's locally authorized registry too.
The migration acquires the existing writer locks, checks audit hashes/roots,
indexes accepted admissions with a resumable batch cursor, copies contexts by
hash, and explicitly rebuilds the projection tree. It leaves original source
records and audit bytes intact. An old database without a ready evidence index
fails with `evidence_index_required`; requests never trigger an implicit rebuild.
The registry's small marker switches only after its database is durable.

Optional `--settings /absolute/settings.json` supplies `settings` (evidence),
`storeSettings` and `registrySettings`. Those local limits do not reinterpret
accepted rules. The final tree rebuild is an offline transaction; large stores
need a measured maintenance window and sufficient disk/WAL space.

## Operator settings

All numbers below are defaults for bounded work, not total-history limits.
Unknown keys and invalid values are rejected.

| Configuration | Defaults |
|---|---|
| Gateway `prod.evidenceSettings`; signer `prod.evidence.settings` | `pageRows=128`, `pageBytes=2000000`, `chunkBytes=256000`, `requestBytes=16384`, `maxAgeMs=30000`, `clockSkewMs=1000`, `maxSnapshots=16`, `maxChallenges=4096`, `maxProofNodes=8192`, `maxDepth=100`, `maxIdBytes=1024`, `cacheEntries=256`, `maxObjectBytes=8000000`, `requestsPerSecond=10` |
| `prod.readerSettings` | `auditFileBytes=1500000`, `auditTotalBytes=1800000`, `auditFiles=512`, `auditCacheEntries=16`, `contextBytes=8000000`, `legacyActivePageRows=256`, `contextRetentionBatches=8` |
| `prod.registrySettings` / `local.registrySettings` | `pageRows=128`, `recordBytes=2000000`, `pageBytes=4000000`, `manifestBytes=65536` |
| Host public configuration `registryTransportSettings` | `maxAgeMs=30000` |
| `prod.http` / `HttpSource` | `requestsPerSecond=2`, `timeoutMs=15000`, `maxBytes=2000000`, `retries=2`, `backoffMs=250`, `maxBackoffMs=10000`, `maxQueue=64`; timeout/backoff timers must fit the runtime’s signed 32-bit millisecond encoding |
| `storeSettings` | `queueLimit=4096`, `groupSize=128`, `groupDelay=3` ms, `pageLimit=4096`, `defaultPageRows=100`, `maxFrameBytes=4000000`, `checkpointBytes=2000000`, `cacheKiB=4096` |

The 8 MB object/context settings apply to one legacy batch context, never to
accumulated historical evidence. Legacy decoder and consensus transport budgets
still constrain individual accepted batches. Keep configured page/object sizes
compatible across HTTP transport settings and signer capabilities. Increasing a
local budget does not upgrade an older decoder.

The subsequent R2b changes provide resumable Ethereum/TAP lookups, wallet
inventory, header catch-up and permit-to-inscription recovery. See
[SOURCE-LOOKUPS.md](SOURCE-LOOKUPS.md) for bootstrap, settings and integration.
