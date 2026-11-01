# Incremental mining reads

Deploy the gateway change before the kit change. This adds one public GET route,
`/patterns/taken`, and disposable SQLite read indexes. It changes no operation,
consensus/resource document, digest, journal format or activation height.

The route represents the same explicit found-slot index as
`/patterns/<p2:NUMBER>/claimed-blocks?found=true`. Occurrences without a find,
mint-only rows and unmaterialized window awards are not newly excluded. The
existing public projection readiness fences apply. A gateway read remains a
projection, not an independent consensus proof.

Without parameters, the route returns a snapshot:

```json
{"v":1,"mode":"snapshot","revision":"opaque","slots":[["p2:0",["1","10"]]],"nextCursor":null,"next":null}
```

Pass `cursor` to continue a snapshot. It is pinned to one membership revision;
a change during paging returns `409 taken_snapshot_stale`. Do not use an
incomplete snapshot to select claims. Grouped heights keep snapshots compact.

Once complete, pass `since=<revision>`:

```json
{"v":1,"mode":"delta","from":"old-token","revision":"new-token","changes":[["p2:0","11",true]],"more":false}
```

Each change is `[asset, decimalHeight, taken]`. `false` removes the slot. A client
can persist each validated delta page and continue with its new revision. While
`more` is true, continue before selecting claims. An unchanged world returns no
changes in one request. Optional `limit` bounds rows, never bytes; the configured
public page byte budget still applies.

A revision encodes `[epoch, decimalSequence, hash]` as base64url JSON. For each
delta row, increment the sequence and compute SHA-256 of the UTF-8 JSON array
`[previousHash, sequence, asset, decimalHeight, taken]`. The final hash and
sequence must match the returned revision. The server checks the caller's hash
against the retained chain. Expired, divergent or rebuilt-index tokens return
`409 taken_revision_gone`; only then start a new snapshot. Transport errors,
429 and projection 503 responses are not empty sets or rebuild instructions.

The new read indexes update in the original record transaction, including
journal recovery. First startup fills existing found rows in bounded, resumable
pages before accepting reads. Normal restarts preserve revisions. Retention is
bounded, with a snapshot fallback for players offline beyond the retained log.
Persistent SQL invalidations detect writes made by an older gateway binary;
startup drains those changed keys before the new route becomes available again.
No immutable claimed-page files or block publications are changed. Existing
claimed-page manifests lack a changed-since listing, can lag projection work,
and their old versions are garbage collected; block summaries are not a durable
complete membership delta chain.

Local gateway configuration:

```json
{
  "takenReads": { "changeRows": 16384, "pageRows": 4096 },
  "listen": {
    "host": "127.0.0.1", "port": 5570,
    "readBudget": {
      "enabled": true, "capacity": 16384, "burst": 1200,
      "perSecond": 60, "ttlMs": 120000
    }
  }
}
```

These settings have defaults and are separate from signed r3 documents.
`takenReads.pageRows` and the existing public response byte limit both bound
snapshot/delta work. `changeRows` is the maximum retained membership changes,
not a limit on total found slots. Direct Store callers can set `takenChangeRows`.

The GET/HEAD budget runs before website, room, dashboard, API and file handlers.
It uses the existing trusted loopback proxy's last forwarded IP, normalizes
equivalent IP spellings, and ignores caller-supplied earlier hops. It returns
`429 read_request_rate` with `Retry-After` on exhaustion, without changing POST
budgets. The default permits a 1,200-request burst and 60 reads/second per IP;
operators can increase it for unusually large shared NATs or disable it with
`enabled:false`. Capacity and idle retention bound limiter memory.
