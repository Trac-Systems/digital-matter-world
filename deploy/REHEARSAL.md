# Pay-first verification

Use Node 23.11.0 and installed lockfile dependencies to verify the player-paid
protocol on isolated local chains.

Run these suites with unused loopback ports and disposable state:

```sh
nice -n 20 node --test service/test/mints.test.mjs service/test/mint-payments.test.mjs service/test/provisioning.test.mjs
nice -n 20 node --test service/prod/test/*.test.mjs committee/test/*.test.mjs
nice -n 20 node --test contract/tests/pay-first.test.mjs contract/tests/state.test.mjs rules/test/*.test.js
nice -n 20 node --test deploy/*.test.mjs
nice -n 20 forge test --root eth --offline --threads 1
```

The checks cover no permit before final payment, partial items and top-ups,
payment-held reservations, late re-reservation and credit, once-only consumption,
permanent permit recovery, deployment verification, five escrow destinations and
permissionless release. Reader and orchestration fixtures are not a live chain
proof. Existing raw-header, receipt-witness, batch recovery and monetary
conservation suites remain relevant.

For a real local-chain rehearsal, have a player wallet pay the quote, submit the
Ethereum release if using that rail, retrieve the permanent permit and inscribe
it from the player's funds. Confirm that Trac consumes exactly once before the
permit and that later indexing changes display only. Ethereum users still need
a Bitcoin wallet. Verify missing-only top-ups and credit carryover separately.

For TAP, include the burn address item exactly as quoted. The independent reader
requires the network-specific encoding of `1BitcoinEaterAddressDontSendf59kuE`,
the correct amount, payer and request data. The scriptPubKey stays the same on
mainnet and regtest. Ethereum uses token burn.

Run the isolated discovery-to-first-mint test with:

```sh
nice -n 20 node --test kit/test/pattern-first-mint-regtest.mjs
```

It uses disposable Bitcoin regtest, ord-tap and Anvil on loopback ports
59770–59773, plus headless Chromium on CDP 9511 while holding the shared browser lock.
It starts with an empty table, accepts discovery 0, settles a claim, and has the
player inscribe the element, deployment and mint. It checks element reuse,
occupied ticker replacement, both browser deployment phases and recovery after
a lost reveal reply. All processes and generated wallets belong to that test.

The test pays the fee split through the real local Ethereum escrow and verifies
the native token burn. It also checks that the TAP quote uses the regtest encoding
of the same burn destination; it does not execute a TAP fee payment. It runs the
production payment and permit checks and the contract reducer with local adapters
and one disposable committee key. It does not prove a live Trac peer, the threshold
ceremony, an installed TAP Wallet extension or mainnet settlement.

The all-history and one-block regression is `node --test service/test/all-history-regtest.mjs`. It uses disposable loopback ports 59790–59793 and no browser. It claims 61 historic slots in one window, including a block over ten years old, contests one slot, applies grouped credits and completes the first-minter Ethereum payment and Bitcoin mint path. The same local-key and payment-rail coverage limits described above apply. `DMW_TEST_PORT_BASE` selects a different consecutive four-port range.
