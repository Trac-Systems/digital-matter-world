# Test wallets

The console mint flow uses the player’s connected Bitcoin and Ethereum wallets.
The local automation API has separate funded test wallets. The owner's game identity is a separate encrypted
kit identity. `GET /api/player` gives the public payer/receiver addresses, token
and escrow addresses. It never returns signing keys. All values are test funds.

TAP on Bitcoin regtest and bridged TAP on Anvil both have **18 decimals**.
Protocol fees, quotes, splits, deposits and balances are integer atomic strings:
`"22600000000000000000"` is 22.6 TAP on either payment rail. TAP inscription
amounts are decimal TAP strings; the payment plan performs that conversion.
The base-price input accepts decimal TAP, such as `"22.6"`, and responses include
unit metadata. Test ETH pays gas. BTC balances use BTC units;
`networkFeeSats` uses satoshis. Matter balances are indivisible integer units.
`GET /api/status.units` makes these scales explicit. There is no exchange rate
or market-price feed.

## External wallet funding

Keep the playground running. Create a fresh test account in your wallet. With
the control bearer token, submit:

```http
POST /api/wallets/fund
Content-Type: application/json
Authorization: Bearer TOKEN

{"bitcoin":"bcrt1...","ethereum":"0x..."}
```

Either address may be omitted. The job sends 1 regtest BTC plus 10,000 TAP to
the Bitcoin address, and 10 test ETH plus 10,000 bridged TAP to the Ethereum
address. Only regtest Bitcoin addresses are accepted. Funding is idempotent
for the same address pair; ambiguous partial funding stops for inspection.
Poll `/api/jobs/ID` until complete. Use fresh test accounts rather than moving
an existing wallet's funds or keys.

## MetaMask on Anvil

Add a network with RPC `http://127.0.0.1:58545`, chain ID **31337**, currency
symbol **ETH**, and no explorer URL. Add the bridged TAP token address from
`player.wallets.ethereum.token` with 18 decimals. Use your newly funded account;
there is no need to import the playground's unlocked account or recovery words.

1. Choose an allowed entry in `GET /api/player.mintRights` or
   `GET /api/blocks/HEIGHT`. Ask `/api/player/mint/quote` for kind `ethereum`.
2. POST `/api/player/mint` with `asset`, `block`, exact `amount`,
   `kind:"ethereum"`, `payer:YOUR_METAMASK_ADDRESS`, and a stable `actionId`.
   The optional `receiver` is a **Bitcoin regtest address** for the resulting
   TAP inscription. The kit still signs the owner's game request.
3. GET `/api/payment-plan/REQUEST_ID`. It returns two exact transaction objects:
   the ERC-20 approval and the escrow deposit, including the quoted split.
   In a page with MetaMask injected, send each in order through
   `window.ethereum.request({method:"eth_sendTransaction",params:[tx]})`.
   Check both transactions succeeded. Use the account matching `payer`.
4. POST `/api/player/payment` with `{id:REQUEST_ID,paymentId:REQUEST_ID}`.
   Inclusion in one Ethereum block is enough. The committee returns signed
   release calldata; submit it from the payer wallet and pay its gas.
5. When the request reaches `permit_issued`, inscribe `mintContent` from your
   Bitcoin wallet to the bound receiver. Report its inscription ID with
   `{id:REQUEST_ID,inscription:INSCRIPTION_ID}`. Your wallet pays Bitcoin fees.

## TAP wallet dev build

The read-only reference build is at
`${DMW_BUILD_ROOT}/tap-wallet-next`. Its README describes
loading its unpacked `dist/` extension. Select **regtest** and set its single
regtest gateway to `http://127.0.0.1:55999`. The provider call is
`await window.tapprotocol.switchNetwork('regtest')`. Request the fresh account
with `requestAccounts()` and fund its `bcrt1` address as above.

The pinned wallet still has non-local BTC-price and Trac routing call sites,
as documented in `local/README.md`. Its extension UI has **not** been certified
as entirely local. Keep external network access blocked when using this build;
do not use its Trac provider for this playground. The local wallet gateway's
Trac routes are stubs; the actual game Trac devnet is reached through the kit.
No extension or visible browser is launched by this playground.

For an external TAP mint payment:

1. Create a token-limited authority with
   `createTapAuthority('tap', {feeRate:1,outputValue:546})`. Mine a block through
   the control API as needed while the local inscription order is pending.
   The wallet's `getTapActionOrderResult(orderId)` reports its inscription ID.
   Activate the authority with the wallet's self-send/tap step; include it in one block.
2. Request the mint as above with `kind:"tap"` and your Bitcoin `payer` address.
3. GET `/api/payment-plan/REQUEST_ID`. Set
   `plan.redeem.redeem.auth` to the activated authority inscription ID. Pass
   `plan.redeem` to `window.tapprotocol.redeemTapActions` with local fee options.
   The provider signs the exact recipient items, including the burn-address
   transfer. Payer-self shares are omitted.
4. Complete the wallet’s inscription order and include it in a Bitcoin block.
5. POST `/api/player/payment` with
   `{id:REQUEST_ID,paymentId:"REDEEM_INSCRIPTION_ID"}`. Once the committee issues
   the permit, your wallet inscribes it and reports the mint inscription ID.

The payment plan contains public transaction data only. Never send a wallet
seed or private key to the control API. The normal `/api/player/pay` button
only signs for the playground's own payer and refuses an external payer.
Bitmap-link one-click payments currently use the built-in wallet.
