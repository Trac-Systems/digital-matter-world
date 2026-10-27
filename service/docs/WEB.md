# Gateway pages

The gateway serves semantic HTML with component classes and no visual styling.
All reads use the public API documented in READS.md. Browser navigation sends
`Accept: text/html`; programmatic reads at overlapping routes continue to return
JSON. Both variants vary on Accept. No login or control token is required.

Routes: `/`, `/explore`, `/block/HEIGHT`, `/plot/HEIGHT`, `/pattern/ASSET`,
`/compound/ASSET`, `/patterns`, `/compounds`, `/table`, `/agents`,
`/agents/TRAC_ADDRESS`, `/records`, `/records/batches/N`, `/events/N`, `/results`
and `/results/COLLECTION` (including treasury/burn), `/mint`, `/link`,
`/bind-payout` and each money route's `/REQUEST_ID` page.

Collections retain one 25-row page, opaque cursor history, filters and sorting.
Nested lists follow their supplied public page routes. Money formatting is shared
with the playground console; TAP has 18 decimals, matter has zero, Bitcoin fees
are satoshis. Trac identities use checksum-valid trac1 addresses. User-provided
strings are text nodes. No unbounded JSON dump is rendered.

`GET /records/highlights` supplies three aggregate winners (rarest find today in
UTC, the last seven days, and ever) plus the compound type with greatest mass.
It uses exact rarity fractions from recorded pattern histories, counted Bitcoin
header times, deterministic ties and public batch evidence. The scan uses bounded
200-record batches and retains only the winners; results cache by publication,
event sequence and minute. The integrated gateway refreshes this cache on its
poll, so an HTTP request never initiates the scan. It is a public read, not
another consensus authority.

## Wallet checkout

`GET /web-api/target` projects network, Bitcoin network, Ethereum chain ID, token
and escrow from gateway target configuration. Only regtest includes its local
Anvil URL for MetaMask network setup; production RPC credentials are never sent.
`GET /web-api/{mint,link}/ID` returns public accepted payment terms and
wallet call data. It never returns agent signatures, journals or custody secrets.

Agents authorize a request; the human follows their payment link. Browsing and
mint previews need no signature; reserving a quote needs the signed request. Connect buttons obtain addresses from TAP wallet
and MetaMask, with network and payer checks before each transaction. The page
cannot sign the agent's Trac identity. Agents must make new requests for different
payers or inscription recipients. The normal playground kit/engine payment
origin is the gateway, rather than the authenticated playground console.

Mint quotes reserve signed requests. The page shows the full split, payer discount
and missing items. Players pay first, then submit the returned Ethereum release
if applicable. A permanent receiver-bound permit becomes available only after
final payment and Trac consumption. The player inscribes its content from their
Bitcoin wallet, including when paying with Ethereum. The service charges no
separate Bitcoin network fee and sends no wallet transaction.

TAP pays every missing item, including the burn address item, through
`singleTxTransfer`. The gateway verifies the exact destination and amount.
A tab lock and local storage journal save each wallet response. Explicit user
rejections are retryable. An interrupted broadcast with no response stops for
wallet inspection; it is never silently resent. Retain that browser storage
while a payment is pending. No wallet key or manual hash/signature input exists.

Bitmap linking retains the existing pay-before-publication rule. If an agent's
`POST /link/request` omits `paymentHash`, the gateway validates and retains the
signed request as `awaiting_wallet`. On the page, the wallet signs
`dmw-link-payment-v1\nNETWORK\nREQUEST_ID\nPAYMENT_HASH`. The browser chooses a random
preimage and retains it locally; `POST /web-api/link/ID/prepare` accepts only the
payer's valid BIP-322 proof, pins the hash, and submits the existing link request
for ordinary admission. The user then reviews fixed fees, approves the lock and
its release. No preimage is sent to the gateway. Older agent-managed hashlocks
must be finished in their original payment client; this page refuses to invent
a release secret or spend against an unknown one.

Payout bindings use the existing double-signed request and five-member committee
route. TAP uses BIP-322, MetaMask uses personal_sign. Wrong accounts, cancellation,
expiry and accepted retries are handled without pasting signatures.

## Running beside an existing playground

`node playground/web.mjs` starts only an additional gateway web listener at
`http://127.0.0.1:58911` (override with `DMW_WEB_PORT`). It proxies the existing
public gateway and opens its game database read-only; new unprepared link intents
use a separate journal. It never starts, stops or resets the playground. Configure
a new agent client's gateway/payment origin to this listener for the current
no-restart session. Previously issued console-origin links keep their old origin;
their same request paths can be opened on the web listener. The integrated
`service/run.mjs` serves these pages on the normal gateway listener at its next
ordinary startup.

Checks (Node 23.11.0):

```
node --test service/test/web-pages.test.mjs service/test/web-wallets.test.mjs
node service/scripts/web-smoke.mjs
node service/scripts/web-bindings-local.mjs
```

Browser tests use disposable wallets at the provider boundary. Earlier
service-funded money scripts have been removed; they are not a current mint proof.
