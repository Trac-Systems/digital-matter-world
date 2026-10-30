# Additional ticker naming and deployment fees

These APIs support the additional-deployment flow. The deployment owner must
authenticate requests, require a registered official deployment, reuse its TAP
element and mint authority, and register the selected ticker independently.
The helpers do not create a second official deployment or change its payload.

## Activation and settings

`rules/src/multi-ticker-activation.js` is the only activation declaration.
Consensus callers pass the batch execution height, not a receipt, quote or
payment height. Quotes may preview admission using the current counted height.
The optional complete settings group is:

```js
{ tickerDeployMultiplier: 0, tickerDeployBurnBps: 0 }
```

An absent group preserves retained document hashes and charges no deploy fee.
The multiplier is a nonnegative safe integer; burn is 0–10000 basis points.
Price is base fee times multiplier, burn floors independently, and treasury
receives the remainder. No finder, landowner, discoverer or deploy-holder share
is charged on deployment fees. The treasury destination is the operator's
existing link treasury. Fees are denominated in atomic TAP, with decimal
conversion only at the wallet boundary.

The rules API is `feeFor('ticker', base, 1, document.values, executionHeight)`
and `financialSplit(price, { kind: 'ticker', executionHeight }, document)`.
Both refuse the new kind before activation. Existing fee kinds are unchanged.

The settings successor accepts either:

```text
--ticker-deploy-multiplier N --ticker-deploy-burn-bps BPS --activation-height HEIGHT
--link-burn-bps BPS --activation-height HEIGHT
```

The first form may also include `--link-burn-bps`. Other settings and local
resources are preserved. Installing a document cannot cross the code gate.
Either form can accompany a holder-share amendment such as
`--deployer-share-bps 500`; the existing legacy share and positive payout minimum
are preserved unless explicitly changed. The combined proposal uses the same
review, settings validation, and batch/Bitcoin boundaries as individual amendments.

## Names and availability

`validateChosenTicker(tick)` returns the lowercased **bare inscription ticker**
or throws `ticker_invalid`. The pinned ord-tap source uses 1–32 grapheme
clusters, JavaScript lowercasing, and rejects leading `-` or `dmt-`. Whitespace,
punctuation and valid Unicode are not silently stripped or normalized. Lone
UTF-16 surrogates cannot enter DMW canonical JSON and are rejected.

`await tickerConflicts(tick, { officialName })` checks the bare and `dmt-`
names through the supplied point resolver. The resolver must cover official
pattern names, compound names and allocated official tickers, including
collision fallbacks. Return **null or false** for absence; every other result
is occupied or unknown and refuses `ticker_conflict`. Missing resolvers refuse
`ticker_official_lookup_required`. There is no name enumeration.

The service helpers take the **indexed TAP ticker**: `dmt-foo` for a DMT
deployment and `foo` for an ordinary compound token deployment.

- `tickerAvailable(reads, tick)` uses one encoded `getDeployment/TICKER`
  point read. Only an explicit null result means available. Transport errors,
  missing adapters and mismatched responses fail closed.
- `reserveTicker(store, tick, requestId)` serializes competing calls sharing
  the durable Store writer. The same owner is idempotent; another request gets
  `ticker_reserved`.
- `releaseTicker(store, tick, requestId)` removes only that owner's reservation
  and returns whether it did so. Reservations do not expire implicitly.

Core registration must still arbitrate races across gateways and TAP itself.
Before paying, the request helper checks official-name conflicts and current
TAP availability; a competing confirmed deployment can still win afterwards.

The existing official compound permit and wallet-package validators use
stricter historical ASCII grammars. The additional-deployment integration must
route chosen tickers through the new validator in those paths, gated by the
same execution height; this helper does not change official names or wallet
bundles.

## Payment integration

`tickerDeployQuote(reads, input, at, options)` accepts
`{ asset, tick, payer, id = null, feeQuote }`. `at` has `counted` and, for
execution, `executionHeight`. Options include `network`, `bitcoinNetwork` and
optional local `lookupSettings`. The quote contains `feeQuote`, `price`,
`split`, `fees`, `destinations`, `settingsHash` and `unit`. All settings and
base-fee policy values are authenticated by the signed quote. A preliminary
quote can omit the core request id; request admission creates the final items.
The signed treasury destination is retained for payment verification and
refund recovery even if the operator later rotates the current treasury.

`TickerPayments` takes `{ store, reads, network, bitcoinNetwork, lookupSettings,
officialName, refund }` and provides:

| Method | Purpose |
| --- | --- |
| `request({ id, asset, tick, payer, until, feeQuote }, at)` | Retain authenticated core request terms and reserve the ticker before presenting payment items. |
| `payment({ id, paymentIds }, at)` | Point-verify explicit confirmed TAP inscription references and retain partial or full funding. |
| `view(id)` | Return the bounded payment state and wallet plan. |
| `expire(id, at)` | Reconcile an unpaid expired request by id; a fully paid request remains available for registration. |
| `refuse(id, reason, at)` | Verify known payments, retain the recovery obligation, and invoke the accepted refund adapter. |
| `complete(id, registration)` | Mark the local payment projection complete after core registration independently succeeds. |

Each registry verifier must independently call
`verifyTickerDeployPayment(reads, savedRow, at, options)` and require `final`
before registering an additional ticker. It reconstructs the quote and fee
items, validates acceptance, and reads confirmed transfers under
`reads.withTapSnapshot`. It never discovers payment ids through wallet
history. Explicit references are read in settings-sized pages; their total
count has no lifetime cap.

Ticker transfers use a separate `dmw-ticker-pay-v1` data domain, binding the
network, asset, indexed ticker, payer, core request id, quote, role and
destination. A mint/link transfer, another ticker, wrong payer, failed
transfer, mempool transaction or moving snapshot cannot satisfy the fee.

`complete` is a projection update, not a registration verifier. Core must
verify the exact inscription, element, authority and asset/ticker race before
calling it. It must not expose `complete` as an unauthenticated HTTP action.

## Refund adapter and UI fields

`tickerPaymentRefunds(row, verified, reason)` builds sender-compatible records
with `{ id, reference, tapAddress, asset, ticker, fees, state: 'owed', reason,
refundId }`. Records use the existing `publicRefundKey` identity and
`refundAmounts`/`refundRedeem` representation. Fragmented items in one
inscription aggregate by fee identity, including actual overpayment.

The supplied `refund(record, { row, verified, at })` callback must independently
authorize the refusal, persist the record in the **accepted refund ledger**,
and expose it to the existing refund sender projection. A successful callback
means the obligation is durably accepted, not that Bitcoin settlement has
occurred. It must be idempotent by `refundId`. Missing or failed callbacks keep
state `recovery` and preserve the reservation. Success releases the local
reservation and reports `refund_pending`. Late references on refused requests
continue through the same adapter. The module never writes unauthenticated
account records or broadcasts a refund.

The payment view contains `id`, `asset`, `ticker`, `payer`, `state`, `price`,
`split`, `fees`, `missing`, `unit`, `settingsHash`, `feeQuote`, `payable`,
`redeem: { items, data, actions }`, and optional `reason`/`refunds`. Wallet
items use the existing native TAP one-transaction transfer flow. A zero price
produces no wallet items. States are `awaiting_payment`, `partly_paid`, `paid`,
`completed`, `refused`, `recovery` and `refund_pending`.

No new HTTP route or layout is introduced by this module. The core deployment
routes must expose these views and call the methods above after their existing
authentication. Additional deployment and ticker-list route documentation
belongs with that integration.

## Bitmap link split compatibility

`linkPaymentSplit(total, document, executionHeight)` retains the fixed legacy
split before activation, then reads `document.values.linkBurnBps`. Retained
quote, checkout, verification and migration paths use this helper and bind the
document hash. Already accepted imported locks retain their original split.
Native v2 links already used settings and remain unchanged. New v2 mint
admission refuses unpinned fee quotes at activation; accepted legacy funding
and permits retain their original terms.

The existing public `GET /status` response adds `feePolicy.linkBurnBps` at
activation, taken from its pinned settings document. It is absent before the
gate. The playground's fee preview consumes this field, and its local payment
builder uses the same pinned link split. No layout or style changes are needed.
