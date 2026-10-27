# Storage measurement

## All-history claims, 500 active agents (2026-10-27)

Run `nice -n 20 node contract/scripts/measure-open-history.mjs` from the repository
root. An optional output pathname replaces `measurements-open-history.json`.
The script verifies real signed moves, gateway receipts and witness signatures,
settles 2,000 historical slots for 500 registered agents, builds the real rules
batch, applies the actual contract transition and checks per-asset conservation.
Puzzle search is disabled for this synthetic workload. It opens no network port.

This measurement uses **four distinct claims per agent per window**. The game
default is 100, configurable from 1 to 1,000; this smaller workload does not
measure a full window at that default. A default batch allows 98,304 signed bytes,
512 operations, 4,096 asset touches and 16 notary entries. Both workload variants
fit in one batch, with room for additional records. Raising the claim setting
requires remeasuring the expected active agents and distinct assets; transport
limits defer remaining winners without cancelling finds or choosing a subset.

| 500-agent workload, four claims each | One asset per agent | Four assets per agent |
|---|---:|---:|
| Finds | 2,000 | 2,000 |
| Grouped `ac` operations | 500 | 500 |
| Asset touches | 500 | 2,000 |
| Signed batch JSON bytes | 53,976 | 69,998 |
| Complete command envelope bytes | 54,028 | 70,050 |
| Contract logical key/value write bytes | 6,128 | 21,826 |
| Standalone Hyperbee view-log bytes | 11,212 | 40,590 |
| New view keys | 3 | 1,503 |
| Total audit bytes, nine observations | 391,486 | 400,510 |
| Largest audit file | 213,408 | 222,432 |
| Largest viewer summary | 372,827 | 372,827 |

The three constant new keys are the batch audit root, finds-file commitment and
receipt commitment; `bt/last` is updated. The four-asset case also creates 1,500
previously absent owner/asset balances. Existing balances are overwritten. Finds
never create individual contract records. Credits aggregate by owner/asset;
vector chunks have at most 16 assets and preserve debit/reservation barriers.
Growth is bounded by active owner/asset pairs and fixed batch limits, independent
of how many historical matches contributed to each amount. The existing finite
pattern registry and claim setting bound those pairs; header fallback may require
continuation for many distinct assets. Normal mint receipts, payment allocations,
nonces and paid actions keep their existing independent storage costs.

RESET's successive retained-window rewrite measured **1,426,484 logical bytes**
and **1,426,497 standalone Hyperbee view-log bytes**. The all-history credit batch
uses 0.43–1.53% of that logical volume and 0.79–2.85% of that view-log volume. The
reference uses a 2,201-header regtest sequence; both physical view measurements
use the installed Hyperbee/Hypercore encoding, with a populated baseline and one
batch of actual buffered writes. Temporary stores are closed and removed.

These are **not total peer-log or disk-growth measurements**. The new standalone
view measurement excludes trac-peer bookkeeping, input/system logs, replication,
Merkle/index files, WAL and disk allocation. Header ingestion and initial agent
registration are excluded from the credit batch. The signed input bytes are
reported separately. Nine observations processed in roughly 6–10 seconds on this
development machine at low priority; preparation/signing and storage measurement are separate.
The older full peer benchmark below remains a different workload and cannot be
used as a physical measurement of the new 500-agent batch.

## Earlier full-peer workload

At 16 credits, one paid transfer and one paid lock per Bitcoin block, measured
peer-log growth is **14,729.653 bytes per block**, compared with a 4 KB target.
Combined header/batch messages remove one normal dispatch. Runtime bodies,
indexes and physical encoding account for most of the remaining bytes.

## Reproduce

Use Node 23.11.0 and the committed dependency lock, then run from `contract/`:

```sh
npm run measure
npm run measure:devnet
```

The first command writes `measurements.json` with logical key/value measurements.
The second writes `measurements-devnet.json` using a real local MSB validator/client,
an indexer, a writer and loopback DHT. It checks disk free space, records its PID,
closes its peers and removes its own temporary network directory on success.
No public services or real funds are involved.

## Physical devnet run

Measured **1,000 regtest blocks**, after 2,055 warm-up headers and registration of
**500 agents**. Each measured block submits one combined committee `bt`, including
its required signed epoch and deadline, with one header and 16 credits distributed
across those agents. One actual writer also
submits a paid transfer and a paid hashlock to the indexer per block. Locks remain
active, representing 1,000 retained lock records; there are 2,000 accepted paid
transactions. The 500 accounts are synthetic identities, not 500 network processes. Credits use
one fungible asset (`load`), unit amounts and a fixed-size placeholder audit root;
more assets, varied amounts and more active senders may change encoding/compaction.

The peers finish with identical signed views. Independent supply accounting checks
500,016,000 units across balances and locks, with no negative balances. Both sender
logs are counted once; view and system logs are counted for one replica. Bootstrap,
registration and retained-window fill are excluded by the baseline snapshot.

| Metric | Bytes/block | Total over 1,000 blocks |
|---|---:|---:|
| Contract history writes, logical key/value bytes | 1,519.217 | 1,519,217 |
| trac-peer bookkeeping, logical key/value bytes | 4,335.796 | 4,335,796 |
| Input logs, both writers counted once | 4,151.209 | 4,151,209 |
| Materialized Hyperbee view log, one replica | 10,029.095 | 10,029,095 |
| Autobase system log, one replica | 549.349 | 549,349 |
| **Peer logs: input + view + system** | **14,729.653** | **14,729,653** |
| Indexer disk file sizes after close | 27,717.284 | 27,717,284 |
| Indexer allocated disk blocks | 27,725.824 | 27,725,824 |
| Writer disk file sizes after close | 27,797.368 | 27,797,368 |
| Writer allocated disk blocks | 27,803.648 | 27,803,648 |
| Local MSB validator disk, separate | 37,479.231 | 37,479,231 |

Logical history is read from the indexer's committed Hyperbee version range, split
by contract namespace versus runtime namespace. Puts count UTF-8 key bytes plus
JSON value bytes; deletes count key bytes. The range has 35,000 contract history
records and 15,000 runtime bookkeeping records. History batching/overwrites can
change put/delete classification; these are committed history records, not a count
of every speculative transition or raw storage page.

Physical log numbers are observed `byteLength` deltas for the actual writer cores,
view core and Autobase system core. They include encoded log blocks, but not all
Merkle-tree, signature, database-index or WAL costs. Directory file sizes and
allocated 512-byte filesystem blocks provide the separate disk measurements.
Database flushes bracket the snapshots; final after-close disk figures also include
close-time writes. The two peer directories are measured separately; the MSB
validator is excluded from the peer-log target and reported separately. Neither
network traffic nor every replicated copy is summed into the one-replica figure.

The measured loop took 113.997 seconds; validation, flush and shutdown brought the
interval to 128.125 seconds. It accelerates Bitcoin time and is not a long-duration
soak. Small-file allocation, compaction, replication ordering and acknowledgement
timing may vary subsequent results. At 144 blocks/day, linear extrapolation is
about 774 MB/year of peer logs or 1.46 GB/year of indexer file growth for this exact
activity rate; that is an estimate, not a long-term compaction measurement.

The pinned MSB sender rotates its connection after 1,000 sends. The local harness
reconnected four times and rebroadcast two missing transactions with the same
transaction IDs; all 2,000 paid operations ultimately settled exactly once. This
is client retry handling, with no changes to Trac dependencies or consensus.

## Logical contract comparison

Separate in-memory measurements register 500 agents and fill the retained window.
Credits use asset `matter` and already-registered owners.

| Credits per combined header/batch | Contract bytes | Signed batch JSON bytes |
|---|---:|---:|
| 1 | 984 | 561 |
| 3 | 1,014 | 792 |
| 8 | 1,089 | 1,362 |
| 16 | 1,216 | 2,274 |
| 64 | 1,986 | 7,747 |
| 128 | 3,039 | 15,043 |

A standalone steady-state regtest header writes 875 logical bytes (eight puts and
four deletes); the reused mainnet retarget fixture writes 938 bytes. RESET's
retained-window rewrite in the same regtest comparison writes 1,426,484 bytes per
header. Per-record storage avoids that repeated window cost. The mainnet fixture
uses longer work/height values, so regtest numbers are not exact mainnet forecasts.

These figures exclude paid activity and runtime bookkeeping. They cannot be added
to physical log totals as independent costs: the physical view already encodes the
logical writes. Likewise deleting a record does not erase its input history.

## Implications

Fungible credits usually update an existing balance instead of creating a per-find
record. This removes item/tombstone growth. Permanent nonce markers, completed mint
receipts, roots and historical hashes remain, and runtime message/transaction
history grows with activity. Expired mint metadata needs explicit cleanup even
though the units return automatically; locks persist until their exit is submitted.

Meeting 4 KB total peer-log growth at the measured activity rate needs a different
encoding, transport or upstream storage design, or a changed workload/budget.
The required reduction exceeds the savings from contract key shortening. Dependency changes,
retention changes and compact binary wire formats require explicit compatibility
work before freeze; they are not included in these measurements.
