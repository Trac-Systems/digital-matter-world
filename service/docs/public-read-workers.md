# Public HTTP read workers

The gateway starts a public worker pool by default. Configure it with
`listen.publicReads` in the local gateway config. These are service resource
settings, outside consensus documents.

| Setting | Default | Meaning |
| --- | --- | --- |
| threads | max(1, min(4, available CPUs - 1)) | Worker threads |
| queuePerWorker | 64 | Waiting requests per worker, plus one active request |
| restartDelayMs | 100 | Backoff before replacing a failed worker |
| startupTimeoutMs | 10000 | Pool initialization deadline |
| sqliteCacheKiB | 4096 | SQLite page cache per worker |
| streamChunkBytes | 65536 | Maximum chunk awaiting socket acknowledgement |
| identityCacheEntries | 8192 | Entries in each scalar address/route LRU; zero disables |
| bindingCacheEntries | 4096 | Verified certificates per Bindings instance; zero disables |
| pendingWaitMs | 3000 | How long a worker waits for a batch's public projection update before answering |
| pendingPollMs | 100 | Poll interval while waiting for that update |

Existing feed settings still control public page size, byte budgets and
`publicCachePages`. Existing HTTP read admission, connection limits and response
deadlines remain on the listener. Worker queue admission rejects immediately
with `503`, `Retry-After: 1`, and `{"error":"service_busy","retryable":true}`.

Each worker opens `index.sqlite` with `DatabaseSync({readOnly:true})` and
`PRAGMA query_only=ON`. It never runs Store initialization, migrations, a writer
lock, adapter initialization, or publication. One request at a time reads one WAL
snapshot. The existing public API owns each worker's URL/projection-revision
response cache. The process-local pagination key is inherited by replacements,
so legacy list and binding-history cursors work across threads.

The dispatcher uses the existing web page matcher before classifying JSON.
Public v2 projections, safe nested lists, web assets/HTML, immutable artifacts,
header reads, receipt-renewal descriptors, payout-binding reads, wallet lookups,
bulk terms/member pages, financial-action status, and operator HTML/JS run in workers. Header publishers still run in the gateway;
workers only read their committed manifests/files.

Live status/health, mint/public-mint operations, bulk status/permits, checkout, operator/internal
state, intake-context proofs, and all POSTs stay on the gateway. `/mint-rights`
stays there when `mints.publicMints` exists, including nested list sources. Legacy
v1 public views stay there because they call adapters and maintain writable
indexes; the legacy header-manifest route can also build/publish an archive.

Response data uses acknowledged MessagePort chunks. A slow socket holds at most
one transport chunk per worker and does not grow its message queue. Disconnects
and response-deadline expiry remove queued requests; cancellation of active work
replaces that worker. A crash fails its active request and retains the waiting
queue. After HTTP headers have already been sent, an interrupted stream closes
its connection, as with the existing file handlers. Shutdown terminates and joins
the pool before closing the writer store.

Run the local, synthetic load comparison with Node 24.22.1:

```sh
node service/scripts/measure-public-workers.mjs
```

It sends 200 concurrent, distinct world-page requests and reports
`monitorEventLoopDelay` p99/max, elapsed time, status counts and byte/ETag
parity. It cannot target a remote URL. Optional settings include
`--requests=200 --rows=2000 --threads=4 --window=100 --resolutionMs=1`.
`--baselineRoot=/absolute/path/to/base-source` compares the base source's HTTP
handler/API against the worker pool on the same fixture database. Without it,
the comparison uses the current in-process handler. Existing page caps still
apply. This measures fixture load, not production traffic or Trac latency.
