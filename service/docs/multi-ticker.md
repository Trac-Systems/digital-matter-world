# Additional ticker API

All new routes require `MULTI_TICKER_HEIGHT` at the execution clock. The official
deployment remains the default when the caller omits `deployment`. The rule
constant is a coordinated-release placeholder, not an operator deployment date.

## Public service and gateway

| Method and route | Input | Result |
| --- | --- | --- |
| `GET /assets/:asset/tickers` (also `/api/assets/:asset/tickers`) | Optional `after` cursor and `limit` (up to registry pageRows) | `{asset,catalogAsset,rows,next}`; rows contain `ticker`, bare `tick`, string `ordinal`, `deploymentId`, `element`, `deployer`, `holder`, `unitsMinted` |
| `GET /mint/ticker-state/:asset?selector=...` | Request ID, deployment inscription ID, chosen ticker or `official` | Current provisioning job, or `{asset,catalogAsset,state:'registered',entry}` |
| `POST /mint/deploy-ticker` (also `/api/deploy-ticker`) | `{asset,ticker,receiver,feeQuote?,paymentIds?,retry?}` | Prepares an additional deployment; existing identical requests resume |
| Same deploy route | `{asset,requestId,inscription,phase:'deployment'}` | Independently verifies and registers the player's inscription |
| `POST /mint/ticker-payment` (also `/api/ticker-payment`) | `{id,paymentIds:[inscriptionId,...]}` or `{id,expire:true}` | Verifies explicit fee references, or expires an unpaid reservation and queues accepted refunds |
| Existing `POST /mint/quote` | Add optional `deployment` to preview; put canonical inscription ID in signed v2 `request.deployment` | Quote, fees and permit bind that registered deployment |
| `POST /public-mints/quote` and `/public-mints/start` | `{asset,block,tapAddress,deployment?}` | Public intent and quote bind the canonical deployment ID; start retains the existing requester-secret rules |

Catalog aliases resolve to the same ledger asset. `ordinal` 1 is the official
entry, 2 and later are additional registrations. The list includes the official
entry on its first page; `after` advances only the additional-entry page. There
is no lifetime list/count scan. `unitsMinted` is the accepted per-deployment
capacity counter, or null before initialization; it is not a TAP lifetime query.
`holder` is currently null: current ownership is resolved only when financially
necessary under the canonical snapshot fence. `deployer` is the registration
receiver, not a promise of current ownership.

Use the canonical deployment inscription ID for an unambiguous choice. A
registered ticker named `official` or `1` takes precedence over those convenience
aliases; an omitted choice always selects the official deployment.

Provisioning states: `awaiting_fee`, `awaiting_player_deploy`, `registered`,
`refused`. A fee view supplies `price`, `split`, `fees`, `missing`, `redeem`,
`settingsHash`, `feeQuote`, `payable` and its own `state`. Pay only the supplied
request-bound wallet items. A paid request has no expiry horizon. An unpaid or
partly paid request can be expired explicitly; refund records retain their old
identity and use the existing public-refund sender. After terminal expiry,
`retry:true` prepares a fresh fee request for the same chosen ticker. It refuses
while the old request is live or refund acceptance is incomplete. Refund
delivery itself may still be pending; no old obligation is discarded.

Only expose inscription content after the fee is verified. The `content` and
`inscriptionText` fields are the exact player inscription payload. DMT patterns
reuse the official element and `prv`; existing compound `token-deploy` semantics
reuse the official authority/options. Registration requires the exact content,
receiver, confirmed inclusion and winning TAP ticker. Case-insensitive name and
reservation checks come from the naming/payment components. A taken ticker is refused before charging;
a later competing winner invokes the accepted refund path.

Useful refusals include `multi_ticker_inactive`, `official_deployment_required`,
`ticker_official_lookup_required`, `ticker_name_index_required`,
`ticker_occupied`, `ticker_reserved`, `ticker_retry_not_terminal`,
`ticker_payment_binding`, `ticker_refund_pending`, `asset_unregistered`,
`additional_deployment_binding`, `financial_deployment_binding` and the naming/payment
name/payment error codes. A pending refund must be retried with the same request.

## Local dashboard backend

No layout, CSS or browser flow is changed. Designer-facing additions:

- `GET /api/tickers?asset=...&after=...&limit=...` forwards the list above.
- `POST /api/deploy-ticker` accepts `{asset,ticker,retry?}` and supplies the
  connected player's bound TAP address. It prepares a fee/payload only.
- `POST /api/ticker-payment` forwards explicit payment references or expiry.
- Existing `POST /api/mint` and `/api/mint-compound` accept optional `deployment`
  as a canonical deployment inscription ID. Saved intents retain it on retry.

## Settings and release preparation

`deployerShareBps` is a new optional settings group, absent/zero by default.
A share such as 500 is an operator settings-successor choice, never a code
default. `--deployer-share-bps` sets it; `--legacy-deploy-payout-min-atoms` sets
the shared native TAP payout minimum. Positive shares require a positive minimum.
Validation requires deployer + legacy share <= find burn and deployer <= compound
burn. Bitmap links have no deployer share. Deployer and legacy liabilities are
backed by the treasury payment, then accrued separately only on confirmed mint.

The settings successor can combine `--deployer-share-bps` with the complete
`--ticker-deploy-multiplier` / `--ticker-deploy-burn-bps` pair and optional
`--link-burn-bps` at one `--activation-height`. Existing legacy share and payout
minimum are retained unless explicitly amended. All unrelated economic and
resource settings are preserved. The multiplier remains an operator choice;
the integration tests' value of 7 is test data only. Review the default dry-run
JSON before using the existing saved-proposal procedure.

Before activation, run the explicit offline maintenance command on the gateway
and signer retained stores and keyed registries:

```
node service/scripts/index-official-ticker-names.mjs /absolute/store /absolute/registry.json
```

This indexes retained catalog names and official/fallback tickers without
changing existing asset entries or hashes. Runtime readers use point lookups
and fail closed until the catalog index is ready. Accepted catalog writes keep
the index current. Existing legacy registry JSON must first undergo its existing
explicit keyed migration.

The coordinated release must include `ticker-names.js`,
`ticker-availability.mjs`, `ticker-payments.mjs`, ticker fee/settings changes and
matching settings-successor support. These modules are loaded lazily, with no
permissive production stubs. The integrated release runs the deployment/payment,
Unicode compound and cold-signer tests unconditionally; missing modules fail
the suite.

When the existing refund sender is enabled and ready, a payable fee also exposes
`refundFunding: {address,satoshis,feeRate,label}`. The wallet must attach this as
a Bitcoin extra output in the same payment's commit transaction, using the
existing TAP Wallet extraOutputs flow. It funds a possible refund inscription;
it is separate from the TAP fee. Each payment has its own set-aside. A successful
registration queues each unused set-aside for return to the payer (minus the
Bitcoin transaction fee). A refusal uses the existing accepted TAP refund and
returns remaining Bitcoin as change. Missing set-asides keep the existing
`refund_needs_operator` state; no refund obligation is silently discarded.
The amounts and limits come from the existing operator refund-sender settings.

Sender-only authenticated GET routes `/internal/mint-sender/ticker-returns`
(`after`, `limit`) and `/internal/mint-sender/ticker-returns/:id` carry confirmed
registration return jobs. The existing requests feed advertises their presence
only after activation. These routes cannot produce a mint permit.

Additional compound mint permits use the full chosen TAP ticker grammar, including
valid Unicode and one-character tickers. Official permit serialization retains
its original grammar and bytes. Wallet code invoking `deploymentContent` for
an additional ticker supplies `{validateTicker: validateChosenTicker}`; the kit
player does this after checking the job's activation height.

## Independent ticker supply

At `PER_TICKER_SUPPLY_HEIGHT`, additional pattern tickers use independent accepted
block markers and public payment scans. Official tickers retain their existing
keys. Every mint keeps the full rewards and its selected deployment-holder share.
The finder week is taken from the original find, never the ticker deployment.
Additional pattern and compound agent mints hold units through permit issuance
and release them on verified completion or refund; official mints continue
consuming them. Each additional compound ticker is bounded by the authenticated
account supply leaf’s cumulative `issued` counter, never the uint64 TAP maximum
alone. The reservation’s account operation touches that leaf and records
`supplyIssued` and `supplyDeployment` in its obligation. Capacity admission checks
`minted + reserved + amount <= supplyIssued` and retains the checked counter.
Later production can raise the cap; burns cannot lower it. A merged old id keeps
its own production cap, while the new id receives the merged production.
Reservations admitted before activation retain their original burn behavior.

`GET /mint-rights`, owner/block mint-rights routes, and
`GET /patterns/:asset/claimed-blocks` accept `deployment` as an immutable
deployment inscription ID, together with the named asset where required.
`GET /public-mints?asset=...&deployment=...` and
`GET /public-mints/:asset/:block?deployment=...` use the same selector. Omission
means official. Existing ticker lists report each deployment’s own `fd` counter.
No state migration or historical scan is required.
