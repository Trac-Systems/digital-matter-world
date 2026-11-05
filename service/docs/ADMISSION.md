# Receipt admission during signing

Once the gateway saves a proposal for batch N, it can acknowledge moves for
batch N+1 while N is being signed. Receipts keep their existing format and their
original batch number. Kits do not need an update.

The gateway setting `assetResources.admissionFutureBatches` defaults to `1`.
Set it to `0` to disable future admission. Each signer has the corresponding
`receiptAdmission.futureBatches` setting, also defaulting to `1`. Only `0` and
`1` are supported. Existing receipt, work and byte settings bound each batch.
A sealed or full successor returns the existing `next_batch_work_capacity`
refusal before issuing a receipt. This is a bounded queue, not unlimited
admission during an unavailable committee.

An acknowledged receipt promises inclusion, not a successful game outcome.
Admission validates against accepted state and that target batch's queued
moves. Replay uses the actual accepted predecessor, even when a proposal was
replaced after a failed signing attempt. A conflicting discovery, expired
action or changed craft calculation retains its receipt and receives an
explicit deterministic outcome in the audit.

Craft and transfer audits additionally record the account revisions used at
execution. Signers read those revisions independently and project earlier
account operations in the batch. If a predecessor changed the revision signed
by the owner, replay records `account_revision_changed` without executing the
debit. A fresh authorization can then execute normally. Account proofs,
authorization checks and contract preflight remain required for every executed
action.

Gateway acceptance preserves reservations for the later batch. Signer journals
retain receipt promises across restart and refuse omissions, reserved target
slots and predecessor sequences that would consume a later receipt's position.
Speculative proposals are discarded if admission changes before promotion.
When future admission is enabled, the pipeline leaves an empty successor open
instead of sealing an empty continuation merely for speculative replay.

## Rollout and settings amendments

Upgrade all five signers, including their shared rules code, before upgrading
the gateway. Updated signers continue to accept proposals from the old gateway.
No contract migration, kit update or activation height is needed. Starting the
new gateway before the signers is not supported.

Before a settings amendment or rollback:

1. Disable gateway lookahead with `assetResources.admissionFutureBatches: 0`.
2. Pause new move submissions and let every outstanding receipt reach its
   promised batch. Preserve the gateway store and signer journals.
3. Authorize the settings amendment, or roll back the gateway and then signers.
4. For an amendment, wait for the existing cutoff/renewal process to complete
   before reopening lookahead admission.

Future admission stops when a scheduled settings amendment is observed. The
deployed renewal contract binds a cutoff to one original batch, so a settings
amendment must not race an already acknowledged successor. Gateway and signers
refuse a cutoff that would displace such a successor. Forcing an amendment
before draining can halt progress; a timeout does not cancel a receipt or
authorize dropping it.

## Local verification

With Node 24.22.1 and disposable build/temp directories configured:

```sh
node --experimental-test-module-mocks --test service/test/admission-signing-stack.test.mjs
node --experimental-test-module-mocks --test service/test/admission-signing-regtest.mjs
node --test committee/test/receipt-lookahead.test.mjs committee/test/account-revisions.test.mjs
```

The first test holds six consecutive signing rounds while moves arrive through
the unchanged kit HTTP client, then checks every receipt's inclusion. It also
checks stale account authorization, forged revision evidence and replacement
of an unreserved proposal. The regtest variant starts an isolated Bitcoin Core
node and uses its verified headers. Both use five independent signer policies,
the contract reducer and a disposable common signing key; they do not exercise
the distributed TSS ceremony or ord indexing.
