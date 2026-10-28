# Resumable source lookups

Each gateway and signer keeps its own derived Bitcoin, TAP and Ethereum indexes.
They store locations and progress, never authorization. A named read checks the
source record again, including its canonical chain snapshot. Missing progress
returns a retryable catch-up error; it never means that an older payment or mint
does not exist.

## Startup and recovery

Production reader data contains `bitcoin.sqlite`, `tap-lookups.sqlite` and
`ethereum-events.sqlite`. Keep these databases and their SQLite WAL files with
the reader's private data. A reader resumes after interruption. Do not share a
reader data directory between processes or run a bootstrap tool beside its
reader. These caches can be rebuilt without changing accepted financial state,
but rebuilding delays reads until the relevant cursor has caught up.

The registry/evidence v2 conversion in [EVIDENCE.md](EVIDENCE.md) still runs
explicitly before upgrading old reader data. The new source indexes need no
conversion of accepted audits, permits, payment keys or fee revisions. To warm
global authority/element locations and Ethereum events on a stopped reader:

```sh
nice -n 20 node service/scripts/index-source-lookups.mjs /absolute/private-config.json
```

`--once` performs one bounded unit and exits. Repeating it resumes the same
databases. Without it the command runs until both global TAP streams and
Ethereum reach their observed tips. The tool opens source readers only. It
does not open a signer, wallet or Trac writer. It reads source references from
the private configuration and prints counts/booleans, never endpoints.

Production maintenance runs separately from Bitcoin observation and public
requests. `reads.refreshLookups()` runs one serialized maintenance unit;
`reads.lookupStatus()` reports sanitized source status. Reader shutdown waits
for its in-flight maintenance. A failed stream yields its fair turn so another
stream can progress. Wallets and account/ticker discovery streams register on
first use and keep their own cursors.

## Source contracts

The pinned ord-tap version has paged native lists, with a provider page maximum
of 500, but lacks authority/element/transaction-item lookup routes by inscription
ID. `TapLookupIndex` explicitly indexes those lists once, storing exact offsets.
Authority and element requests never rebuild the global catalog. A warm named
read fetches `offset=<saved location>&max=1` inside a checked TAP snapshot.
Cancellation, payload/signature, deployment and Bitcoin inclusion checks remain
in the independent readers. Set `pageRows` no higher than the provider's page
capability; larger individual records also require compatible HTTP byte budgets.

Explicit TAP payment IDs bypass payer-history discovery. Transaction transfer
locations retain the original list index, so legacy payment-item keys remain
identical. Without IDs, recovery advances the payer's redeem history from its
persisted cursor. A compound permit's data/amount resolves through a durable
recipient/ticker index, including mints older than the former recent-1,000
window. The resulting inscription still needs exact payload and inclusion
verification. Account/transaction discovery is bounded and can require retries.

Wallet pages seek the local owner/height/inscription indexes. Initial historical
ownership imports and later shared per-block Bitmap events run in maintenance;
transfers back do not require another historical-list entry. Responses include
`syncing`, `indexedHeight`, `snapshotHash`, `total: null` and a continuation cursor.
Restart pagination after `bitmap_cursor_changed`. A changed canonical branch
invalidates the old inventory before rebuilding. Wallet projections never
authorize mint/link actions; those retain their direct ownership checks.

Ethereum deposit, release and refund locations come from named successful
transaction receipts or a persistent contract-event cursor. Optional Ethereum
payment transaction IDs (`0x` plus 64 hex digits) skip historical discovery.
The reader checks contract/payer/request bindings, getter/event agreement,
successful receipt and canonical block before accepting evidence. Log-range
limits apply to one request, not the contract's age. Reorg rollback consumes
bounded checkpoint pages and has no fixed depth cutoff. The existing trusted
RPC model and one-confirmation policy are unchanged.

Bitcoin catch-up persists a bounded backward spool, then verifies and commits
forward chunks against genesis or a validated ancestor. Hash, PoW, link,
difficulty and median-time checks precede admission to the verified header
table. Work-budget exhaustion preserves both cursors. Orphaned unfinished
branches and invalid spools are discarded in bounded chunks. The replay-worker
database descriptor introduced by the signer replay fix remains available.

## Resource settings

These settings bound a page, individual request, object or maintenance unit;
none caps retained history. Unknown keys and nonpositive/unsafe integers fail.

| Configuration | Defaults |
|---|---|
| `prod.lookupSettings` / `local.lookupSettings` | `pageRows=500`, `pagesPerTick=4`, `pageBytes=2000000`, `contentBytes=200000`, `walletItemsPerTick=16`, `walletBlocksPerTick=1`, `refreshMs=1000`, `headerPageRows=1024`, `headerCachePages=4`, `headerCacheKiB=4096`, `seedChunkRows=4096`, `paymentIds=64`, `creditSources=32`, `inscriptionBytes=65536` |
| `prod.maxHeadersPerView` | `4096` header work units per call |
| `prod.ethereum.eventSettings` / `local.escrow.eventSettings` | `blockRange=2000` (production inherits `ethereum.maxLogRange`), `pagesPerTick=4`, `pageLogs=10000`, `receiptLogs=10000`, `receiptTransactions=64` |

`refreshMs` must fit the runtime's signed 32-bit timer. Existing
`ethereum.maxLogRange` and `maxLogPages` remain per-call transport budgets;
generated host configurations set `eventSettings.pagesPerTick=4` separately.
Deployment preflight accepts a `lookupSettings` option and persists its own
`preflight-tap-lookups.sqlite`; launch authority checks persist
`launch-tap-lookups.sqlite`. A still-catching-up preflight fails and resumes on
retry. Keep per-request payment/allocation settings aligned with the rules and
transport version; changing a local limit cannot reinterpret accepted batches.

## Integration boundaries

R1 owns consolidated settings and activation. R3 owns public projection routes;
the Bitmap source supplies the existing page interface and syncing metadata.
R4 owns financial scheduling, refunds and expiry transitions; it can call the
bounded maintenance hook and consume canonical `escrowSettled` receipt locations.
This change does not alter those economic decisions. It also does not replace
legacy hot catalogs/contexts, header-seed file traversal or signer journal
archival. Live-state migration rehearsal and mixed-load deployment validation
remain coordinated release checks.
