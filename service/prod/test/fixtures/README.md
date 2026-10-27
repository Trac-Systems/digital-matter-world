These are responses captured from a disposable, loopback-only regtest ord-tap
run by `service/test/ord-regtest.mjs` and `service/test/ord-only.e2e.mjs`.
No production source was contacted. All transactions and signatures are test
transactions; no wallet secrets are included.

Inspected ord-tap source commit: `b8f6ea35cf6b9d405d4db7c58555e3c8ab33e8cd`.
Used ord executable SHA-256:
`15e9a98b34bf0006eac0b4190b1062a1fcafa197bfecc471522dec5570581c3a`.
The existing executable was used without rebuilding or changing the source.

- `ord-regtest.json`: block height/hash, blockinfo, the full ordered block JSON,
  raw transactions, and the producer's raw block for an independent byte check.
- `ord-redeem-raw.json`: an actual unconfirmed redeem returned by `/r/tx`, with
  ord's empty pointer tag preceding the inscription body.
- `ord-routes.json`: actual height/hash, blockinfo, block, raw transaction,
  inscription metadata, plain element content and JSON mint content responses.
- `ord-payment.mjs`: successful regtest internal TAP transfer and redeem records,
  their signed payload and the full quoted fee list. The mainnet burn recipient
  is deliberately left missing: ord's regtest address checks reject it. Tests
  must not substitute a different recipient or claim the complete quote paid.
  The JSON object is exported as JavaScript only to annotate two scanner false
  positives: the `auth` values are public inscription IDs, not credentials.
