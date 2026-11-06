# Bulk Bitmap linking

A bulk job keeps its block list, payer, item states and attempts in the same
private `journal.sqlite` as the agent's signed actions. Keep the signer directory
when restarting or moving the agent. No wallet payment or prior Bitmap
registration is needed. The gateway reads TAP's current Bitmap holder and that
wallet's agent binding directly; `/bitmaps/submit` only updates public inventory.

## Local dashboard API

All routes require the dashboard's existing login/session. POSTs require the
same local origin checks as `/api/link`. Bodies and responses are JSON. Block
numbers are canonical decimal strings, including numbers larger than JavaScript's
safe integer range. IDs are opaque strings. No UI assets are supplied by this API.

| Request | Response |
| --- | --- |
| `POST /api/link-bulk` with `{ "blocks": ["611638","611639"], "payer"?: "ADDRESS" }` | `{ "job": Job }` immediately after saving. Payer defaults to the bound TAP Wallet. |
| `GET /api/link-bulk?offset=0&limit=10` | `{ "jobs": [Job], "next": offset_or_null }`, newest first. |
| `GET /api/link-bulk/JOB_ID?offset=0&limit=25` | `{ "job": Job, "items": [Item], "next": offset_or_null }`. |
| `POST /api/link-bulk/JOB_ID/cancel` with `{}` or no body | `{ "job": Job }`. Waiting items become cancelled. Sent requests continue. |
| `GET /api/link-bulk/candidates` | `404`: optional candidate inventory is not implemented. |

Offsets are nonnegative safe integers; limits are integers from 1 to 200.
Unknown job IDs return 404. Invalid block lists return
`400 { "error":"invalid_blocks" }`; exceeding `maxBlocks` entries returns
`400 { "error":"too_many_blocks" }`. Duplicate blocks are merged after validating
the entry limit. Invalid payer addresses return `400 { "error":"invalid_payer" }`.
An identical unfinished block set and payer returns
`409 { "error":"link_job_running", "job": Job }`. A stopping agent returns 503
for job creation and cancellation.

`Job` contains `id`, ISO `createdAt`, `payer`, `state` (`running`, `done`,
`cancelled`), `total`, and `counts` with `waiting`, `inProgress`, `linked`, `failed`,
`cancelled`. Cancellation keeps a job running until its sent items finish, then
sets its state to cancelled. A job with failed items can still be done.

`Item` contains decimal-string `block`, `state` (`waiting`, `in_progress`,
`linked`, `failed`, `cancelled`), ISO `updatedAt`, and optional 64-hex `requestId`.
Only failed items include `reason`. Use these descriptions:

| Reason | Meaning |
| --- | --- |
| `not_in_wallet` | The Bitmap is not held by the payer wallet bound to this agent. |
| `already_linked` | This Bitmap is already linked. |
| `not_a_bitmap` | No Bitmap exists for this block. |
| Other code | Could not link (code). |

Expiry retries never expose `expired_retrying`. Gateway overload and rate limits
never fail an item. A non-free quote ends as `link_not_free`; this worker never
pays it. A job's linked state reports gateway completion and does not replace
independent Trac or witness verification elsewhere in the kit.

## MCP and CLI

`link_bitmaps` takes `{blocks:["1","2"],payer?:"ADDRESS"}`. The launch mode
controls whether it runs live. Dry-run only validates locally: no POST preview,
no signing and no job. A live call returns `{job}` immediately (and
`existing:true` when reusing an unfinished job). `link_bitmaps_status` takes
`{jobId?:"ID",offset?:0,limit?:25}` and returns the same list/detail shapes as
HTTP; its jobs-list default limit is 10. CLI/MCP payer defaults to `owner.payer.tap`.

From `kit/`, `node bin/dmw.mjs link-bitmaps --blocks 1,2,3 --config
/absolute/player/mainnet.json --live` waits for the job to finish. Add `--payer
ADDRESS` if needed. Ctrl-C stops this process without cancelling saved work.
Repeating the same set and payer resumes it. With a matching dashboard running,
the command forwards work to that dashboard and waits for its job. Generic
`dmw action link_bitmaps ARGS.json --live` queues and returns; use the dedicated
foreground command, dashboard or live MCP to keep processing.

## Resume, pacing and limits

Dashboard activation and live MCP startup acquire one local worker lease and
resume all unfinished jobs in that journal scope. A browser tab need not remain
open. When the process is off, waiting items remain saved and submitted requests
can finish remotely. Startup polls those requests, including attempts interrupted
between signing, sending and saving a response. It derives any missing request ID
from the exact journaled packet. No job history or signed attempt is deleted.

Every item has a stable action ID of at most 64 permitted characters. A confirmed
terminal expiry or definite pre-acceptance stale-quote refusal creates a new
attempt. A missing request can be renewed only after the independently read
counted height passes its signed deadline. A timeout or later refusal alone never
clears earlier uncertainty. Requests still authorizing resume their saved
reservation. Cancelled jobs do not create replacement attempts.

Optional top-level player config fields:

```json
{
  "maxBlocks": 500,
  "linkConcurrency": 8,
  "linkPacing": { "intervalMs": 500, "perTip": 120 },
  "journalPacing": { "intervalMs": 1000, "perTip": 12 }
}
```

Omitted keys use those defaults. Values must be safe integers; `intervalMs` may
be zero, and the others must be positive. These are local settings, not gateway
or contract changes. All jobs share one concurrency allowance. In-progress items
count even while the response is uncertain. The worker submits one item at a time
through the agent's FIFO turn queue and releases that queue when rate-limited,
so queued mining can run. Links use their own durable interval and per-block
allowance (`linkPacing`); mining moves use `journalPacing`. Neither uses up the
other's allowance. Dashboard human financial clicks retain their prior pacing behavior.

The gateway independently caps pending links at eight per agent and also has a
global capacity bound. A completed or expired request frees its place. Increasing
local concurrency cannot override that cap. A quote and its two signed exchanges prepare and
reserve one link; they share one journal turn. Refused quotes also consume that
turn, so invalid lists cannot flood the gateway with previews. Batch/Bitcoin progress,
current ownership reads and `pendingBlocks` expiry can dominate throughput.
Status polls normally run every five seconds. A gateway busy response delays
all jobs, honoring Retry-After across restart. Local pacing delays only new
attempts; status polling can still observe links finishing.
