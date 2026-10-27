# Compound minting and Bitcoin payments

Compound assets use ordinary, privilege-gated TAP tokens. A Bitcoin payment can
reserve the entire price in one HTLC and distribute it in one claim: 30% to the
finder, 15% to the landowner, 20% burned, and 35% to the treasury. Without a
landowner, the burn allocation becomes 35%. An expired HTLC refunds the entire
price to the payer without a committee signature or secret.

These flows are exercised against the pinned ord-tap revision
`b8f6ea35cf6b9d405d4db7c58555e3c8ab33e8cd` on Bitcoin regtest. Feature activation
heights are zero there. The wallet payload matches revision
`9c549de160a2f0594b3b91f86b06aa4cff84cf0b`. The payment proof deploys and funds a
fresh local ticker named `tap`; it uses no external token balances.

## Compound tokens

Create one `privilege-auth` inscription for the test committee's secp256k1 key:

```js
const auth = { name: 'dmw-local' };
const payload = {
  p: 'tap', op: 'privilege-auth', auth,
  ...signMessage(JSON.stringify(auth) + salt, committeeKey), salt
};
```

`signMessage` in [protocol.mjs](../protocol.mjs) signs the SHA256 digest with
recoverable ECDSA. `hash` is hexadecimal; `sig.v`, `sig.r` and `sig.s` are decimal
strings. Inscribe the authority to its owner's address, then send the inscription
back to that same address and confirm it. Creation alone does not activate the
authority. Check `getPrivilegeAuthList` before deploying.

Deploy one ticker per compound type, referencing the activated authority:

```json
{
  "p": "tap",
  "op": "token-deploy",
  "tick": "compound",
  "max": "18446744073709551615",
  "dec": "0",
  "prv": "<privilege-authority-inscription-id>"
}
```

This example uses indivisible units. Omit `lim` to allow variable mint amounts
within the remaining supply; the stored zero limit means no per-mint cap.
Explicit `"lim":"0"` is invalid. This maximum is a local demonstration choice,
not a supply policy for every compound. Confirm the deployment's inscription ID,
authority, decimals and cap before issuing permits; a ticker already deployed
elsewhere cannot be replaced by this operation.

A permitted mint has this shape:

```json
{
  "p": "tap",
  "op": "token-mint",
  "tick": "compound",
  "amt": "137",
  "dta": "<request-id>",
  "prv": {
    "address": "<receive-address>",
    "salt": "<unique-salt>",
    "hash": "<sha256-hex>",
    "sig": { "v": "<recovery-id>", "r": "<decimal-r>", "s": "<decimal-s>" }
  }
}
```

The exact UTF-8 message before SHA256 is:

```text
tap-token-mint-<original-ticker>-<raw-amount-string>-<receive-address>-<salt>
tap-token-mint-<original-ticker>-<raw-amount-string>-<receive-address>-<dta>-<salt>
```

The second form applies when string `dta` is present, including an empty string.
`p` and `op` are lowercased by the indexer; ticker spelling and the raw amount
representation are preserved for signing. Use decimal strings throughout and
never convert large amounts to JavaScript `Number`. `dta` is limited to 512 UTF-8
bytes. Use a fixed request-ID format and a fresh random salt. There is no `blk`
or `dep` field in this message, and no signature expiry or chain domain field.
The application must bind the permit to its expected deployment and request.

[tokenMintPermit](../protocol.mjs) constructs this payload. The inscription must
actually arrive at `prv.address`; changing the receiver, amount, data or signer
does not credit tokens. Successful mints consume the compact `r || s` signature;
reinscribing the same permit cannot mint again. Fresh signatures remain usable,
so the committee must also enforce request idempotency. Unlike DMT, an ordinary
compound mint has no per-block uniqueness rule.

Requested amounts must fit token decimals, the optional per-mint limit and the
remaining supply. The indexer **clamps a mint to the remaining supply** when the
request is larger. Check capacity before signing and verify the actual credited
amount afterward; a valid signature alone does not prove the full requested
amount was minted.

Independent permits can share one commit/reveal:

```js
const entries = requests.map(request => ({
  text: tokenMintPermit({
    tick: 'compound', amt: request.amount,
    address: request.receiver, dta: request.id
  }, committeeKey),
  receiver: request.receiver
}));
const result = await inscribe(manifest, entries);
await mine(manifest);
```

The local inscriber uses separate outputs. Every inscription keeps its own
receiver and permit; batching does not authorize or make all entries succeed
together. Check each successful `getTickerMintList/<tick>` record by inscription
ID, amount, receiver and request data. Missing or `fail:true` records are failures.
The proof batches amounts `17`, `2501` and `9007199254740993` into one reveal.

## Payment construction

Use an HTLC with a fresh random 32-byte secret held by the release service.
The payer receives only its SHA256 hash before locking. With a hex-encoded
secret, hash the decoded bytes:

```js
const preimage = randomBytes(32).toString('hex');
const hash = sha256(Buffer.from(preimage, 'hex'));
```

For even-length hex preimages ord-tap decodes hex before hashing; hashing their
text gives a different condition. Keep each payment's secret independent.

The base `amt` pays the treasury. Native allocations in `al` add the other
shares, so the reserved total is **base amount plus all allocations**. Setting
base `amt` to the whole price would reserve and charge too much.

| Component | For a 100 TAP price | Payload destination |
| --- | ---: | --- |
| Treasury | 35 | `amt`, `claim` |
| Finder | 30 | `al`: `tt:"a"`, `rl:"of"` |
| Landowner | 15 | `al`: `tt:"a"`, `rl:"sr"` |
| Burn | 20 | `al`: `tt:"b"`, `rl:"bn"` |

Use distinct payer, finder, landowner and treasury addresses. Resolve the current
eligible landowner before preparing the signed lock. With no landowner, omit its
allocation and set the burn amount to `35`; this burns both shares in one native
burn allocation. Allocation roles are restricted to `of`, `sr`, `bn`, with each
role used at most once. Here `sr` is the permitted label on an account allocation;
it does not create a staking position. Custom roles such as `landowner` fail.

The burn route is specifically:

```json
{ "tt": "b", "to": "1BitcoinEaterAddressDontSendf59kuE", "amt": "20", "rl": "bn" }
```

The special address is an indexer sentinel, including on regtest. On claim, its
allocation is debited from the owner without crediting any account. An ordinary
address allocation is not a substitute. The burn address has zero credited TAP
balance in the proof, and burning does not restore mint capacity. Do not infer
circulating supply from the deployment cap minus remaining mint capacity alone.

[payments.mjs](../payments.mjs) builds the exact split using `BigInt` atomic
units and formats amounts as token-unit decimal strings. It requires the price
in atomic units to be divisible by 100; fractional-atom rounding policy is not
defined. It checks distinct roles; the indexer checks actual Bitcoin addresses.
Balances, lock records and consume records returned by TAP use atomic-unit
strings, so 35 TAP with 18 decimals is `35000000000000000000` there.

## What the payer wallet signs

The payer needs an active token authority signed by its wallet key and owned at
its funded address. `createTapAuthority('tap')` prepares an authority scoped to
TAP. Complete the authority inscription and its self-transfer activation before
using its inscription ID as `auth`. The release service can use a separate
active authority and key to relay claims.

Pass the following **object** to `window.tapprotocol.redeemTapActions`. Replace
the placeholders and choose an absolute future Bitcoin block height `H`:

```js
const message = {
  auth: '<payer-token-authority-inscription-id>',
  items: [],
  data: '<request-id>',
  actions: [{
    op: 'lock',
    kind: 'htlc',
    tick: 'tap',
    amt: '35',
    claim: '<treasury-address>',
    refund: '<payer-address>',
    condition: { type: 'hashlock', hash: '<sha256-of-secret-bytes>' },
    refund_after: String(H),
    al: [
      { tt: 'a', to: '<finder-address>', amt: '30', rl: 'of' },
      { tt: 'a', to: '<landowner-address>', amt: '15', rl: 'sr' },
      { tt: 'b', to: '1BitcoinEaterAddressDontSendf59kuE', amt: '20', rl: 'bn' }
    ]
  }]
};
await window.tapprotocol.redeemTapActions(message, {
  feeRate: 1, outputValue: 10000, label: 'Make real payment'
});
```

The wallet adds a salt and signs `SHA256(JSON.stringify(message) + salt)` with
the active wallet key, then inscribes this envelope to the active address:

```js
{
  p: 'tap', op: 'token-auth', redeem: message, salt,
  hash: '<sha256-hex>',
  sig: { v: '<decimal-recovery-id>', r: '<decimal-r>', s: '<decimal-s>' }
}
```

Do not pre-wrap `message` in that envelope or pass a JSON string to the wallet
method. Keep the exact serialized message unchanged after signing. The wallet
does not add `auth`, `items`, `data` or `actions` for the caller. `label` affects
the approval display, not the signed protocol payload.

The wallet's `createOrderRedeem` submits the serialized envelope via
`POST /v1/inscribe/order/texts` with `orderType:"REDEEM"`, `connectedAddress`,
`feeRate`, `postage`, `rebar:false` and
`data:[{text:<envelope-json>,receiver:<active-address>}]`. The proof exercises
that route with a real BTC fee payment, commit/reveal, confirmation and indexer
state checks. The local gateway waits for one payment confirmation; a premature
`paid` notification returns 409 and its worker also detects confirmed payments.

A lock ID is `<redeem-inscription-id>:<zero-based-action-index>`, including the
inscription's `i0` suffix before the colon. A one-action inscription creates
`<id>:0`. Wait for `getLock/<lock-id>` and verify the owner, ticker, total, every
allocation, hash, refund address and expiry before issuing the corresponding
mint. Lock creation reserves funds; the owner's overall balance still includes
them. `getLockedBalance/<payer>/tap` reports the reserved total.

Keep the signed request-to-lock mapping. Top-level `redeem.data` is signed
application metadata, not a condition that ord-tap interprets as a mint proof.

## Claim and refund

After the exact successful mint is indexed and sufficiently confirmed, the
release service reveals the secret through a separate redeem:

```js
const claimMessage = {
  auth: '<release-token-authority-inscription-id>',
  items: [], data: '<request-id>',
  actions: [{ op: 'claim', lock: '<lock-id>', preimage: '<secret-hex>' }]
};
```

That service signs and inscribes the same envelope format. The stored lock fixes
all destinations and amounts; claim-time recipient/allocation overrides cannot
redirect it. Anyone who learns the preimage may relay the claim through a valid
redeem, but cannot change the split. One consume record settles the lock, releases
its reserved balance, debits the full price and credits all non-burn shares in
the same operation. `getLockConsume/<lock-id>` identifies the settlement.

Refund uses only the payer's existing wallet authority and key:

```js
await window.tapprotocol.redeemTapActions({
  auth: '<payer-token-authority-inscription-id>',
  items: [], data: '<request-id>',
  actions: [{ op: 'refund', lock: '<lock-id>' }]
}, { feeRate: 1, outputValue: 10000, label: 'Refund expired payment' });
```

There is no preimage or committee signature in the refund. Do not add a
certificate/control policy to these locks; it could introduce another settlement
requirement. Refund restores the full reserved total, including all allocations,
with no recipient payment and no burn. With `refund` equal to the owner, the
overall balance stays the same and the locked balance becomes spendable again.
It is an explicit transaction requiring BTC fees, not an automatic timer.

| At inclusion height | HTLC claim | HTLC refund | Authority escrow claim |
| --- | --- | --- | --- |
| `< H` | Correct secret required | Refused | Designated authority required |
| `>= H` | Refused even with the secret | Allowed if unconsumed | Still allowed if unconsumed |

`refund_after` is a block height, not seconds or a timestamp. Claims and refunds
of a consumed lock fail, including fresh signatures and exact envelope replays.
Historical lock records can remain after settlement; check the consume record.

Escrow supports the same allocations and payer refund, but its authority claim
does not test the expiry height. After expiry it can race the refund. The proof
demonstrates this with separate payer and release authorities. HTLC gives the
strict claim cutoff needed here, so no two-stage custody or split-transfer
fallback is needed.

## Observation and trust boundary

The release service must verify the expected deployment, successful mint
inscription, amount, receiver and request binding, then apply its confirmation
policy before revealing the secret. Leave enough blocks for mint confirmation
and claim inclusion before `H`. The local proof uses a confirmed indexed mint
and checks the amount, receiver and request ID before constructing its claim.

TAP does not enforce “a mint was seen” inside this HTLC. Possession of the secret
authorizes the claim before expiry even if no mint exists. The service therefore
must protect the secret and follow that observation policy. Conversely, a mint
can succeed and the payment still refund if the service fails to claim in time.
Reorganizations can also change what was observed. Existing operations provide
the fixed split and independent refund, not trustless atomic mint-for-payment.
Request authorization, Trac pending/burn settlement, finder eligibility, current
Bitmap ownership and production committee custody remain application concerns.

## Run the proofs

From the repository root, after the [local setup](../README.md):

```sh
source ~/.nvm/nvm.sh
nvm use 23.11.0
export npm_config_userconfig=/dev/null
node --test local/test/*.test.mjs
```

The suite starts fresh services, runs the original DMT/wallet checks plus the
compound and payment proofs, stops them, and checks a fresh restart and exact
wipe. A stopped evidence run is retained at the printed path. It contains
`compound-proof.json`, `payments-proof.json`, the signed wallet message/envelope,
mint and consume records, inscription content, commit/reveal IDs and balances.

To run just the new proofs on a fresh stack:

```sh
./local/up
node local/prove-payments.mjs
./local/down
```

Run `down` even if the proof fails. Do not run interval mining during these
height-boundary tests. The proof expects an undeployed local `tap` ticker, so use
a fresh stack each time. Keys are disposable local test keys. The tests exercise
the wallet signing format and order API, not an interactive browser extension
approval session. The [inscriber recovery limitation](../README.md) still applies.

Implementation references in the pinned source: `tap/ops/deploy.rs` and
`tap/ops/mint.rs`; `tap/mod.rs` functions `build_mint_privilege_message_hash`,
`verify_privilege_signature_with_msg`, `tap_hash_proof_preimage` and constant
`BURN_ADDRESS`; `tap/ops/auth.rs` functions `normalize_token_proof_allocations`,
`validate_token_proof_lock_kind`, `validate_token_proof_release_action` and
`process_token_proof_release_action`. Here `tap/` is under
`src/index/updater/inscription_updater/`. Wallet references are
`src/content-script/tap-script/index.ts`, `src/background/provider.ts`,
`src/background/requests/inscribe-api.ts` and the approval component
`src/ui/pages/approval/components/tap-action.tsx`.
