# Console API behavior

See [API.md](API.md) for routes and authentication.

World and block reads include `minted` flags for each plot and find, based on
completed mint records. Every counted historical block is available to claim.
Mint requests expose `awaiting_payment`, `partly_paid`, `paid`, `permit_issued`
and `minted`; `payable` stays false while the reservation is being published.
Unknown requests preserve the gateway's HTTP 404.

Compounds use recipe names such as `Fusion: 1 Ember + 1 Tide`, retaining the
original input quantities. Player Bitmap reads page `{height, inscription,
linked}` records and include only currently owned holdings.

`run.mjs up` and `run.mjs link` print a local login link. Its HTTP 303 response
sets an opaque HttpOnly, SameSite=Strict, Path=/api cookie and redirects to `/`.
API and event-stream requests use that cookie; page storage never receives the
login token.

Amounts include units in `status.units`; both TAP routes use 18 decimals.
Pattern reads include `supply`, `minted` and `madeReal`; compound reads include
`token` and `supply`. Blocks expose historical claims and finds, block events expose round
and find updates, and bot events identify their strategy. Player reads include
discoveries and pending payments with asset, block and state.
