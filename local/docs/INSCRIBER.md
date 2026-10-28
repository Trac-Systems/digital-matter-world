# Cancellable Bitcoin batch inscriber

[cancellable-inscriber.mjs](../cancellable-inscriber.mjs) exports
`CancellableInscriber`, a persistent regtest adapter for up to 100 inscriptions.
It signs and durably saves four transactions before broadcasting anything:

| Transaction | Inputs | Outputs |
| --- | --- | --- |
| `commit` | Dedicated wallet's confirmed BTC | One Taproot output per inscription, plus change |
| `reveal` | All inscription outputs of the commit | Each specified receiver, plus change |
| `cancelCommit` | Exactly the commit's funding inputs | BTC back to the wallet |
| `cancelReveal` | All inscription outputs of the commit | BTC back to the wallet without inscriptions |

Commit and reveal signal replacement. The parent cancellation replaces an
unconfirmed commit and its reveal descendant. After the commit confirms, the
child cancellation spends its outputs through Taproot's key path, replacing or
preempting an unconfirmed reveal. A confirmed reveal cannot be cancelled.

Bitcoin Core signs descriptor-wallet funding inputs using PSBT. Pinned
`@scure/btc-signer` **1.8.1** constructs and signs the Taproot spends. The adapter
generates and persists its own internal and script keys. It does not use ord's
recovery-key import or `--no-backup` path.

## Open and fund

Use Node **24.22.1** and the existing local stack:

```js
import { CancellableInscriber } from './local/cancellable-inscriber.mjs';
import { current, bitcoin } from './local/common.mjs';

const manifest = await current();
const inscriber = await CancellableInscriber.open({
  manifest,
  directory: manifest.root + '/cancellable-inscriber',
  countedHeight: async () => readCurrentCountedHeight(),
  feeRate: 2,
  cancelFeeRate: 20,
  postage: 10000,
  maxBodyBytes: 4096,
  quoteSats: networkFeePolicyQuote
});
const address = await inscriber.receiveAddress();
await bitcoin(manifest, 'sendtoaddress', [address, 1], 'faucet');
// Mine a confirmation before preparing a batch.
```

The mandatory `countedHeight` reader supplies the service's authoritative counted
height, which can differ from Bitcoin height. Tests use raw Bitcoin height only
as an explicit fixture. This module starts no miner or background poller.

The directory must be an absolute private path under the external build root
configured by `local/common.mjs`. Opening verifies regtest, synced txindex,
private directory permissions and exclusive writer ownership. A dedicated Core
descriptor wallet is named from that directory. Fund it only with confirmed
cardinal BTC; do not receive unrelated inscriptions or share its spending keys
with another transaction producer. It never funds from the ord wallet and uses
at most sixteen confirmed native SegWit funding inputs per batch.

Fee rates are integer sat/vbyte; postage is satoshis per inscription. `quoteSats`
is an optional positive decimal string supplied by operator fee policy.
`quote(input)` returns that string and fails if unconfigured. It is not a live
fee estimate, does not convert TAP to BTC and does not verify fee payments.
Configure it before connecting the service quote route. Postage and refundable
cancellation reserves also require wallet funding.

## Prepare and resume

The service queue's API is supported directly:

```js
const prepared = await inscriber.prepareBatch(batchId, [{
  id: requestDigest,
  permit: signedTapPayload,
  receiver: regtestReceiveAddress,
  created: acceptedCreationCountedHeight,
  expiry: acceptedExpiryCountedHeight
}]);
```

`batchId` is 64 lowercase hex characters. The adapter inscribes the supplied
permit; it never issues or re-signs a TAP permit. Request IDs bind the exact
content, receiver and accepted lifetime and cannot move to another durable
batch. Retrying the same batch and requests returns its original saved package;
changed content under an existing ID fails.

The lower-level API accepts text or JSON objects and optional shared windows:

```js
const prepared = await inscriber.prepare([
  { text: payload, receiver: receiverA },
  { text: anotherPayload, receiver: receiverB }
], { id: batchId, created, expiry });
```

Entries may supply their own `id`, `created` and `expiry`. Without a batch ID,
`prepare` derives one from the normalized entries. Limits are 100 entries,
4096 bytes per body by default, 80,000 aggregate body bytes, and Bitcoin's
standard transaction weight limit. Content type is `text/plain;charset=utf-8`.
Ordinal pointers place inscriptions at the intended receiver outputs even
though commit inputs include fee reserves.

The result is JSON-serializable:

```js
{
  version: 1, id: batchId, cancellable: true,
  commit:       { txid, hex, feeSats, vsize },
  reveal:       { txid, hex, feeSats, vsize },
  cancelCommit: { txid, hex, feeSats, vsize },
  cancelReveal: { txid, hex, feeSats, vsize },
  inscriptions: [{ requestId, id: revealTxid + 'i0', receiver, contentHash }],
  windows: [{ id: requestId, created, expiry }],
  digest
}
```

`feeSats` is a decimal string; `vsize` is an integer. Before returning,
`testmempoolaccept` verifies signatures and current policy for the commit/reveal
branch, the parent cancellation, and the commit/child-cancellation branch.
All raw bytes and identities are persisted before `cancellable:true` is returned.

After reopening the same directory, call `load(batchId)` or repeat
`prepareBatch(batchId, sameRequests)`. A completed package is reused byte-for-byte.
An interrupted preparation resumes its saved keys and funding selection.
`load` refuses incomplete packages. Preparation after half lifetime fails closed;
an incomplete preparation retained past that window requires operator
reconciliation and cannot have broadcast through this adapter. RPC failure does
not automatically create a replacement batch, permit or transaction identity.

## Broadcast, status and cancellation

```js
await inscriber.broadcast(prepared);
const status = await inscriber.status(prepared);
await inscriber.cancel(prepared);
```

These methods also accept a saved batch ID. A complete handle is checked against
the durable package; reordered object keys are accepted, changed fields are not.

Broadcast intent is saved before the first send. The adapter sends the saved
commit, then the saved reveal, reading the counted clock before each. For every
request, new broadcasts require:

```text
counted >= created
2 * (counted - created) <= expiry - created
```

An ambiguous send is conservatively reported as possibly broadcast. Retrying
resends the same bytes. A reveal already in the mempool or chain is reported
without another send. `broadcast(prepared, {commitOnly:true})` stages just the
commit for tests or controlled orchestration; a later ordinary call sends the
same reveal only while its broadcast window remains open.

`cancel` saves permanent cancellation intent before sending `cancelCommit` or,
if the commit has confirmed, `cancelReveal`. If a parent cancellation loses a
race to commit confirmation, it rereads state and tries the prepared child
cancellation. The result includes `commitAlreadyConfirmed` and `tooLate`.
`tooLate:true` means the reveal already confirmed; it does not fabricate a safe
cancellation. Cancellation intent blocks every later normal broadcast, including
after a process restart.

The parent cancellation fee exceeds **commit plus reveal fees** and incremental
relay cost, so it can evict both. The child cancellation exceeds reveal fee plus
incremental relay cost. Both also meet the configured cancellation fee rate;
funding is reserved in advance. Future fee/policy changes may still cause
rejection. This implementation retains the signed bytes and reports the error;
it does not automatically reprice transactions.

Status returns:

```js
{
  id,
  commit:       { txid, known, mempool, confirmations },
  reveal:       { txid, known, mempool, confirmations },
  cancelCommit: { txid, known, mempool, confirmations },
  cancelReveal: { txid, known, mempool, confirmations },
  broadcast, cancellationRequested, cancelConfirmations, safeToReturn,
  state, // prepared, broadcast, cancelling, cancelled, minted
  counted, mayBroadcast, cancelDue, inscriptions
}
```

Confirmations come from the active Bitcoin chain. Reads retry if the tip changes.
`cancelConfirmations` is the winning cancellation's observed depth;
`safeToReturn` is a regtest cancellation-tool field with its own six-confirmation
threshold; it is not part of the player-paid mint service or its one-confirmation
payment policy. Missing, rejected or mempool
transactions never count as confirmed. Reorganizations can reduce the count
again. `state:"cancelled"` alone is insufficient for returning units.

`cancelDue` becomes true when any request reaches three quarters of its lifetime.
The service must poll and call `cancel` then if the mint is not safely confirmed.
Status is read-only. The library does not run the queue or issue `rx`; the service
must require six actual cancellation confirmations before `rx` and independently
verify successful mints and confirmation depth before settlement.

## Durability and limits

Mode-0600 JSON journals contain checksums. Updates write and fsync a temporary
file, rename it, then fsync the directory. Keys and selected inputs precede signed
package persistence; broadcast/cancellation intents precede network sends.
Checksums detect accidental corruption and fail closed, but are not protection
when another process can rewrite the private directory.

A PID/start-time writer lock excludes concurrent adapters and allows reclaiming
a dead writer's lock. Stale-lock replacement is serialized. A crash during lock
acquisition or a malformed lock requires operator recovery instead of guessing
that another writer is absent. Never remove an active lock. Call
`await inscriber.close()` to release ownership; it does not stop Core or remove
saved packages.

Back up both the journal directory and dedicated Core wallet. Prepared bytes
survive a crash after signing; saved Taproot keys control committed outputs
without an ord import. Journal reservations prevent funding-input reuse even
after a Core restart loses in-memory wallet locks. External wallet spending,
missing backups, fee changes and a confirmed reveal can prevent cancellation.
A Bitcoin double-spend cannot revoke a leaked TAP permit independently inscribed
with different inputs: protect permits and retain request deduplication rules.

Run the proofs with the existing stack tests:

```sh
source ~/.nvm/nvm.sh
nvm use 24.22.1
export npm_config_userconfig=/dev/null
node --test local/test/*.test.mjs
```

Six added proofs cover 100 DMT mints in one reveal, parent replacement with a
live descendant, committed-output cancellation before reveal, replacement of a
live reveal, timing/six-confirmation gates, and SIGKILL after durable prepare.
Cancelled inscriptions and DMT records remain absent after another ten blocks.
Restart preserves the exact signed transaction bytes. The stopped run retains
`cancellable-proof.json` and `cancellable-processes.json` as evidence.

This adapter does not change the service queue or complete the separate operation
replay, permit issuance, payment verification and full make-real integration.
