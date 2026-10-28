# Read-only host snapshot export

Run this from the reviewed release with Node 24.22.1 and `nice -n 20`. It never
opens the original gateway as a writer, reads a credential file, starts a
service, contacts a network, signs, or sends a transaction. Output must be a new
directory outside the source state. Reserve defaults to 40 GiB and cannot be
lowered. A failed run leaves its partial directory for inspection and never
writes the successful `snapshot.json` marker.

The primary supplies one JSON plan with exact, absolute paths:

```json
{
  "gatewayDirectory": "/approved-state/gateway",
  "contractFile": "/approved-export/notary.json",
  "headersFile": "/approved-state/headers.bin",
  "operatorFiles": [
    {"id":"operator1","path":"/approved-export/operator1.json"},
    {"id":"operator2","path":"/approved-export/operator2.json"},
    {"id":"operator3","path":"/approved-export/operator3.json"},
    {"id":"operator4","path":"/approved-export/operator4.json"},
    {"id":"operator5","path":"/approved-export/operator5.json"}
  ],
  "publicFiles": [
    {"name":"registry.json","path":"/approved-export/registry.json"}
  ],
  "output": "/approved-export/pm1-snapshot",
  "reserveGiB": 40,
  "maxBytes": 12884901888,
  "maxFrameBytes": 4000000
}
```

```sh
nice -n 20 node deploy/rehearsal/export.mjs /approved-export/plan.json
```

`notary.json` contains `{options, records, revision}`: public deployment options
and every terminal key/value, not gateway balance estimates. The exported
`exportNotaryView({view, options, output})` helper obtains those records from an
**already open** notary view at one immutable revision. The host operator must
provide that view through the established host context or supply an independently
approved export. This CLI deliberately has no runtime bootstrap/config reader:
the existing bootstrap reads wallets and would violate the no-key requirement.
Opening the host's raw Corestore is also not a credential-free alternative.

Each operator file contains approved non-secret reservation, retirement and
checkpoint evidence. Do not supply operator configuration, shares or credentials.
All five files are required; the tool preserves them but cannot authenticate
their private journal MACs without a separate signer verification. Public
registry/fee-history/source-progress exports are explicit additional files.
Original player wallets and private journals remain in their established custody.

The gateway database and WAL are copied with ordinary read-only file handles,
with source/copy hashes checked before SQLite opens only the disposable copy.
This avoids changing the live WAL's shared-memory read marks. That copied
transaction is checked against the source's checksummed durable journal.
No unapplied journal frames, incomplete
transactions or changing journal are accepted. Retry a busy capture; the tool
never stops the game or repairs a live store. It rebuilds a new gateway copy
from logical records so deleted SQLite cells cannot disclose retired data.
This changes physical file layout while retaining all logical records. The new
checkpoint uses the neutral legacy records/progress schema, so opening it with
the archived legacy binary does not require v2 SQLite functions or triggers.
The source's safe-integer v1 journal position is retained; its applied journal
is compacted to an empty log in the copy.

The output matches the rehearsal directory layout. `export-files.json` lists
every output file's relative path, byte size and SHA-256, except itself; its
inventory hash is printed. Input artifact hashes, the gateway logical-row hash,
and its journal position are retained in `snapshot.json`. Input paths and
record values are never printed on failure. Symlinks, special files,
credential-like filenames and private JSON fields fail closed.

Export is **not reconciliation**: `snapshot.json` deliberately says
`reconciled:false`. Independently verify notary head/header ancestry, every
pending job and payment identity, the five signer checkpoints and resulting
import roots before approving a reconciled copy for `run.mjs --snapshot`.
Neither the exporter nor the harness changes mainnet identity to make test
shares work. Keep the original export unchanged for hash comparisons.

PM2 adds the single [host capture command](../host-157/capture-pending.mjs) and
[one-page run sheet](../host-157/PENDING-CAPTURE.md). It preserves the active
external draft and accepts optional reviewed reconciliation pins. Only successful
five-export derivation writes `reconciled:true`; capture-only behavior above is
unchanged. The script consumes public exports and never reads private journals.
