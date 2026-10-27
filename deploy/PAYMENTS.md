# Player payment protocol

The server reserves Trac units, verifies each paid fee item, consumes the units once, and only then signs a permanent receiver-bound mint permit. The player pays Bitcoin inscription fees. Ethereum users pay deposit and release gas and still need a Bitcoin wallet to inscribe the mint.

The service has no Bitcoin inscriber, Bitcoin spending wallet, Ethereum relayer or treasury payout runner. Discoverer and landowner shares are paid directly. A recipient who is also the payer keeps that share: `fees` omits it, `fullFees` and `split` show the full price, and `payableAmount` shows the discounted payment.

## Burn payments

The TAP burn share is an ordinary address item to `1BitcoinEaterAddressDontSendf59kuE`. The independent reader requires that exact address, amount, payer and request-bound item data. Wallets pay the full list in one `singleTxTransfer`, or only missing items on a top-up. Ethereum continues to use the escrow token's burn function.

## Runtime setup

Use `deploy/targets/schema.json` and `deploy/inputs/mainnet-inputs.template.json`. Old spending-wallet and relayer slots are rejected. Runtime configurations contain read endpoints, registry/deployment references, Trac writer configuration, gateway signing identity and committee connections. The Ethereum administrator used for one-time escrow deployment is separate from the running service.

Provider connection values belong in the private source files selected by configuration. Use mode 0600 locally; production source loading requires root-owned mode-0600 files. Configuration contains filenames, never credentials or endpoint values. Public clients use the gateway's read API.

Keep the existing network, checkpoint, committee, source verification and Trac funding checks. A changed escrow split changes its ABI, EIP-712 split hash and compiled artifact. Use the artifact built from the selected release. Compile and publish the matching verification artifacts before deployment admission.

## Launch inscription

Follow [LAUNCH-INSCRIPTIONS.md](LAUNCH-INSCRIPTIONS.md). `productionLaunch` saves exact pending content in `paths.output/owner-inscriptions.json` and returns `owner_inscription_required` until the operator supplies confirmed inscription IDs in `runtime.ownerInscriptionsFile`. This is the operator's one-time setup, performed in their TAP wallet. The launcher reads and verifies the supplied contents, receiver, active authority and indexed deployment; it never constructs or sends Bitcoin transactions.

Launch phases are durable. Re-running with the same target reuses completed phases and identical text. The operator activates the privilege authority with the wallet's required transfer. The pattern table starts empty; first minters inscribe their elements and deployments. Allocation collisions cause a new explicit player text plan. Never invent an authority or element ID.

## Player API

1. Send a signed request, receiver, payer, rail and payer authorization to `POST /mint/quote` (the existing `/mint/request` entry remains). The response contains `requestId`, `receiver`, `asset`, `amount`, `fees`, `missing`, `payBy` and reservation status. A bare asset lookup is only a preview; it has no request ID and cannot authorize payment. Wait for reservation acceptance before paying.
2. Pay the missing items. `POST /mint/payment` accepts `requestId`/`id` and `paymentId` or `paymentIds` as lookup hints; each reader independently checks chain evidence. `GET /mint/<requestId>` shows awaiting payment, partial payment or paid status. One inclusion confirmation is required. A seen payment pins the reservation beyond the unpaid deadline.
3. Ethereum checkout returns approval/deposit calldata. After a confirmed deposit, it returns `ethereumRelease`: any payer or recipient may submit it and pay gas. The release must finalize before the mint permit, because an unreleased deposit remains refundable on Ethereum.
4. The committee commits `mc` to consume the reserved units before returning `permit_issued`, `permit`, `mintContent` and `inscriptionText`. Anyone holding the request ID can retrieve the same receiver-bound text indefinitely. Inscribe it from the player's wallet. The indexer observation changes the display to `minted` without another debit.
5. For a first pattern or compound deployment, `GET /mint/deployment/<asset>` returns `awaiting_player_deploy` and exact phase text. The first pattern minter inscribes the element and then its deployment; a compound's first maker inscribes its deployment. Submit each inscription ID and phase with `POST /mint/deployment`. Mint quoting requires the registered, independently verified deployment.

An unpaid expiry releases units through the contract clock. If a payment arrives afterward, the service re-reserves available units; otherwise it records paid items as credit for that owner and rail. A later quote uses matching credit first. Accepted quotes retain their original Bitmap recipient even if ownership later changes. The service never sends a refund. Overpaid items remain accounted as item balances; only allocated amounts are consumed.

Run the unit/integration suites and the separate player wallet rehearsal in [REHEARSAL.md](REHEARSAL.md) before public admission. Local test results do not establish live deployment readiness.
