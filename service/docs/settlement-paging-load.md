# Measuring settlement throughput

`scripts/benchmark-settlement-paging.mjs` creates synthetic accepted claim
snapshots in SQLite. Each batch runs the gateway's `Replay`, builds real credit
account proofs, rebuilds the batch in the independent signer `BatchReplay`, and
runs the signer's contract preflight. Replay must reproduce the exact audit file
and signing digest. No network adapter, transaction signing or broadcast is used.

Use a fresh output directory for each run; an existing `index.sqlite` is never
overwritten. Run from the repository root with Node 24:

```sh
BENCH_OUT=.test-tmp/paging-cost BENCH_PAGES=64 BENCH_KIND=winners \
  BENCH_PAIRS=10000 node service/scripts/benchmark-settlement-paging.mjs

BENCH_OUT=.test-tmp/paging-stream BENCH_MODE=stream BENCH_READY=1 \
  BENCH_BATCHES=120 BENCH_PAGES=64 \
  BENCH_BACKLOG_WINDOWS=60 BENCH_BACKLOG_PAGES=450 \
  node service/scripts/benchmark-settlement-paging.mjs
```

The default `cost` mode starts with one closed 3,600-pair window and measures one
batch. `BENCH_KIND=winners` starts at its winner pages; otherwise claim outcomes
are delivered first. `BENCH_ASSETS` (default 4) and `BENCH_OWNER_PAIRS` (default
100) vary credit aggregation and account proof pressure. Each pair names one
distinct block and one pattern. This deliberately retains all winners rather
than assuming that competing claims or earlier reservations reduce the work.

`closure` mode starts with an unclosed window and runs until its payout pages
are delivered, or `BENCH_BATCHES` is reached. `stream` mode injects one accepted
window every ten simulated minutes, advances a batch every three minutes, and
retains the two-tip close delay. Its repeating window sizes are
2,000/3,600/3,600/3,600/3,600/10,000 pairs; use `BENCH_SIZES` to change them.
The virtual clock advances independently of the measured wall time.
`BENCH_READY=1` injects already closed windows at their eligible height, isolating
paging service capacity from closure throughput. Keep these results separate
from the default combined closure-and-paging stream.
For a combined stream, omit `BENCH_READY`; `BENCH_WORK`, `BENCH_READS` and
`BENCH_BYTES` select closure budgets under evaluation. Their defaults are
2,048 work units, 131,072 reads and 67,108,864 charged bytes. Charged bytes
include repeated authenticated accesses even when cached, not just transport.

`BENCH_BACKLOG_WINDOWS` adds initial unfinished windows. With
`BENCH_BACKLOG_PAGES=450`, they are already closed and divide exactly 450 pending
pages. Without that option, stream and closure modes seed unclosed windows of
`BENCH_PAIRS` each. Admission is intentionally bypassed to measure the drain of
an already accepted backlog; reported pair/window totals expose whether a
scenario would hit ordinary intake limits. Synthetic seeding time is excluded.
`BENCH_UNCLOSED_WINDOWS` adds unclosed windows of `BENCH_PAIRS` each after that
backlog. For example, ten closed windows sharing 450 pages plus fifty unclosed
3,400-pair windows retain 60 windows and 193,000 pairs initially. This mixed
backlog is a materially harder closure test than sixty already-closed windows.

`BENCH_ROOT` selects a retained source checkout for comparisons. All imports,
gateway and signer workers, and contract checks then use that checkout.
Between batches the fixture keeps the same hot state projection as production;
the authenticated cold records remain in SQLite.
`BENCH_VALUES` accepts additional JSON settings overrides. It changes only the
synthetic fixture; this script never writes deployed settings.
`BENCH_SWITCH_BATCH` schedules a successor at that batch sequence and Bitcoin
height 10,000,002. `BENCH_SWITCH_VALUES` supplies its value changes; the default
raises closure work to 12,288, reads to 262,144, charged bytes to 536,870,912 and
settlement pages to 64. Both replay paths and
contract preflight select the document at the same two boundaries.
`BENCH_TRACK_SETTLEMENTS=1` records the before/after rounds and complete settlement
results for continuation comparisons, including an unchanged-settings control.
`BENCH_PUBLIC=1` enables permanent claims and the public winner prefetch/read
path. A local adapter returns synthetic absence fixtures and counts the
requested pages/pairs; it does not model remote source latency.
The signer uses the production `EvidenceStore` cache, hash checks and neighbor
prefetch with a local SQLite transport. Transport signatures and lease refresh
are outside the benchmark. `BENCH_CAPTURE=1` saves full canonical batch/audit/
summary/checkpoint/write bytes; `BENCH_REFERENCE` compares a later run against
those files byte for byte, independently of the timing measurements.
`contextBytes` measures the separate replay context against the existing archive
limit; optional `claimReadHints` remain outside the consensus proof and audit.
The gateway can retain up to 65,536 supplemental hashes after proof packing
fills. They schedule authenticated reads and never supply answers. The reader
applies its existing `nodeHintEntries` limit and ignores malformed supplemental
hints. The publisher drops this optional metadata if it would exceed the
existing archive limit; the original context and ordinary reads still work.
`BENCH_SIGNER_CACHE` overrides the signer's local node cache entry limit for
resource experiments; the default is the checked-out resource profile. Record
this override when comparing timings, since it is separate from consensus
closure and paging settings.
`BENCH_EVIDENCE_VALUES` accepts JSON overrides for the local evidence cache and
response limits. Output records these values, unique demanded source nodes,
request count, and response row/byte totals to expose repeated transport work.
The local adapter does not apply HTTP dispatch pacing. `pacedLowerBoundMs` is
gateway time plus the larger of measured signer time and the source-rate floor
for those requests. It is a lower bound, not simulated network latency; it can
reject an otherwise promising local timing at the configured source rate.
Sampled `residentBytes` includes the synthetic fixture, SQLite and both workers
in one process; it is useful for comparisons, not a production memory estimate.

The output directory holds `index.sqlite`, an updated `progress.json`, and a
final `summary.json` with individual batch timings, retries, closure budgets,
backlog, page sizes, and wire sizes. Gateway time includes replay, account proof
construction and batch assembly; signer time includes replay and contract
preflight. CPU contention, source latency, transport, persistence, quorum/TSS
and receipt admission are outside these timings. Run comparisons serially on
the same machine. Keep output directories disposable and out of commits.

Page allowance is not a guaranteed delivery rate. Credit and account proof
limits can split pages, and every partial delivery consumes a page allowance.
The rules halve delivery rows on an audit/summary overflow; the account planner
can also halve rows. `auditChunkBytes` bounds a stored settlement page, while
`auditTotalBytes` bounds the complete observation audit. The latter may contain
many pages. Signer proposal bytes include the hexadecimal audit encoding and
must fit the local signer request limit separately from the signed batch.
The script also checks the contract's outer wire limit and reserves the settings
envelope allowance above the raw proposal for the prepare ceremony wrapper.
