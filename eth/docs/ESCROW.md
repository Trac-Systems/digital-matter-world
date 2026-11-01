# TAP escrow

`DmwEscrow` holds TAP until the current committee authorizes the payer's fixed
payment split, or the payment expires and anyone returns it to the payer. Release
pays all recipients and burns the burn allocation in one transaction. There is no
partial settlement. Failed transfers or burns revert the complete transaction.

The deployment is immutable: Solidity **0.8.26**, Cancun EVM, optimizer **200**,
OpenZeppelin Contracts **5.4.0**. The token address, signing formats and time bounds
cannot change. There is no proxy, upgrade, self-destruct, delegatecall, arbitrary
execution, withdrawal, rescue or pause function. The escrow calls only its fixed
token's ERC20 methods and `burn(uint256)`.

The committee address represents a secp256k1 threshold key. The contract verifies
one ordinary ECDSA signature; the external signing system enforces the 3-of-5
threshold. It does not verify Bitcoin transactions or prove that a mint happened.
For mint payments, the committee verifies the request and fixed split before release.
Release must be final before a permit is issued. Official mints consume Trac
units; after independent-supply activation, additional tickers hold them until
verified mint completion or refund.
A valid committee signature suffices for a live payment's fixed split; the escrow
does not separately check delivery. This applies to replacement committees too.

## Deposit and split

Approve the escrow to spend the required TAP amount, then call:

```solidity
deposit(bytes32 requestId, uint256 amount, Split split, uint256 expiry)
```

`msg.sender` is both the payer and the only refund destination. Storage is keyed
on-chain by **`(payer, requestId)`**. `requestId` must be nonzero and unused for
that payer in this deployment. The pair remains used forever, including after
release or refund. Another payer may use the same request ID without reserving,
overwriting or settling this payer's deposit. A reverted deposit does not consume
its pair. Store the application request-to-payment mapping with the payer address;
an ID alone does not identify a payment or prove what was purchased.

All reads and exits name the pair explicitly; a relayer's own address is never
substituted for the payer:

```solidity
getDeposit(address payer, bytes32 requestId) // returns Deposit
releaseDigest(address payer, bytes32 requestId) // returns bytes32
release(address payer, bytes32 requestId, bytes committeeSig)
refund(address payer, bytes32 requestId)
```

There are no request-ID-only overloads. Deposit still derives the payer from
`msg.sender`; it cannot accept funds on behalf of a different payer namespace.

Amounts are integer token base units (18 decimals for TAP). There are no floating
point calculations, percentages or implicit rounding in the contract. The fixed
tuple order is:

```text
(treasury, treasuryAmount, finder, finderAmount,
 landowner, landownerAmount, discoverer, discovererAmount, burnAmount)
```

The five amounts must sum exactly to the positive deposit amount. Each recipient
must be zero exactly when its amount is zero. A positive allocation cannot target
the escrow itself. Other recipients may coincide, including with the payer; the
service must apply any stricter role policy before accepting payment. Discoverer is a direct allocation. The application sets a role's
amount to zero when its recipient is the payer; that share stays with them.

For a 100 TAP find fee, the split is 30 treasury, 30 finder,
15 landowner, 5 discoverer and 20 burn. With no landowner, use a zero landowner/address pair and
35 burn. The same tuple can represent compound payments (maker in the finder
slot) and links without changing custody code. The contract does not
enforce these economic rules; committee verification does.

Deposit uses `SafeERC20.safeTransferFrom` and requires the escrow's balance to
increase by exactly `amount`. This rejects taxed or bonus transfers. Release and
refund use `SafeERC20.safeTransfer`, including compatibility with tokens that
return no Boolean value. Burn calls `burn(amount)` on the escrow's own balance;
it never calls `burnFrom` or transfers to a symbolic burn address.

## States and exits

All escrow times are **Ethereum timestamps in seconds**. Deposits require
`now + 3,600 <= expiry <= now + 2,592,000` (one hour through 30 days, inclusive).
There is no extension, early payer cancellation or modification of a live split.

| State | Entry | Exit |
| --- | --- | --- |
| Unused (`0`) | No successful deposit under `(payer, requestId)` | Payer deposits the complete amount |
| Open (`1`), before expiry | Successful deposit | Anyone relays a valid current-committee release; time reaches expiry |
| Open (`1`), refundable | `block.timestamp >= expiry` | Anyone calls `refund(payer, requestId)`; entire amount goes to payer |
| Released (`2`) | Atomic recipient transfers and burn | Terminal; same payer cannot reuse the ID |
| Refunded (`3`) | Atomic full return to payer | Terminal; same payer cannot reuse the ID |

`release` requires `block.timestamp < expiry`. At exactly `expiry`, only refund
is possible. Expiry does not automatically submit a transaction or change the
stored status. A payer or relayer must pay Ethereum gas. There is no last date
for refund and no committee/admin approval for it. Loss of both authority keys
does not remove this exit. Ethereum transaction inclusion and token behavior
remain necessary for execution.

`totalOpen` is the sum of amounts in state `Open`, including expired requests not
yet refunded. With deposits and settlements alone:

```text
token.balanceOf(escrow) = totalOpen = sum(open deposit amounts)
deposited = open + released + refunded
```

ERC20 holders can transfer tokens directly to any contract address. Such donations
do not create deposits and make `balance = totalOpen + unsolicited surplus`.
No authority can withdraw that surplus. Other accidentally sent assets, including
forced ETH, have no recovery function. Exact balance equality is therefore an
invariant of the supported custody operations, not of arbitrary external token
transfers.

## Signatures and replay protection

The EIP-712 domain is:

```json
{
  "name": "DmwEscrow",
  "version": "1",
  "chainId": "<current Ethereum chain ID>",
  "verifyingContract": "<escrow deployment address>"
}
```

Use ordinary ABI encoding, not packed encoding, for struct hashes. Exact type
strings are exposed through the three public type-hash constants:

```text
Split(address treasury,uint256 treasuryAmount,address finder,uint256 finderAmount,address landowner,uint256 landownerAmount,address discoverer,uint256 discovererAmount,uint256 burnAmount)
Release(bytes32 requestId,address payer,uint256 amount,bytes32 splitHash,uint256 expiry,uint256 committeeEpoch)
RotateCommittee(address newCommittee,uint256 nonce,uint256 committeeEpoch,uint256 deadline)
```

`splitHash = keccak256(abi.encode(SPLIT_TYPEHASH, split))`, where `split` is the
static tuple above. In the release typed data, `splitHash` is a `bytes32` value,
not a nested typed-data struct. Include only `EIP712Domain` and `Release` in that
signing request's `types` object. Read the immutable payer, amount, split and
expiry with `getDeposit(payer, requestId)`, and the active epoch with
`committeeEpoch`. `Release.payer` must equal that namespace address. A release
signature cannot authorize another payer's deposit even if its request ID,
amount, split and expiry are identical. The Release type already includes payer;
its exact type string and field order above are unchanged.

`releaseDigest(payer, requestId)` returns the final EIP-712 digest, including the
`0x1901` envelope. It is suitable for direct threshold ECDSA signing. Do not add
an Ethereum personal-message prefix or hash it a second time. Alternatively,
sign the complete typed object with `eth_signTypedData_v4`, as the local flow
demonstrates. Signatures are exactly 65 bytes, `r || s || v`, with low `s` and
`v` equal to 27 or 28. Normalize a threshold signer's recovery bit and high `s`
before submission, including flipping the recovery bit if `s` is normalized.
Compact 64-byte signatures and ERC-1271 contract-signature validation are not
supported.

Any relayer may call `release(payer, requestId, signature)`; it has no destination or
amount override. The signer must be the committee active **when release executes**.
The domain rejects another chain ID or contract, and the body binds the request,
payer, amount, complete split, expiry and current rotation epoch. Terminal status
prevents repeated settlement. Epoch changes also prevent an old signature from
becoming valid when a former committee key is installed again. A fork that keeps
the same chain ID and copies contract state does not gain distinct EIP-712 replay
protection.

The digest helpers also return hashes for unknown or terminal requests. A hash
being available is not authorization: signers must first check state `Open`,
payment policy, remaining time and the mint evidence.

## Committee rotation and administration

`ROTATION_DELAY = 259,200` seconds (three days), fixed for both rotation routes
and admin handover. This is a wall-clock choice comparable to 432 nominal Bitcoin
blocks, not synchronization with the Trac counted-height clock.

| Governance state | Exit |
| --- | --- |
| No committee proposal | Current committee signs a proposal, or current admin submits one |
| Waiting committee-origin proposal | Anyone applies after the delay; either authority may replace it with a new full delay; admin acceptance clears it |
| Waiting admin-origin recovery | Anyone applies after the delay; only a new admin proposal may replace it, with a new full delay; admin acceptance clears it |
| Mature committee proposal | Anyone calls `applyCommittee`; there is no automatic activation or final deadline |
| No admin proposal | Current admin calls `proposeAdmin(successor)` |
| Waiting admin proposal | Successor accepts after the delay; current admin may replace it and restart the delay |
| Mature admin proposal | Only the named successor calls `acceptAdmin`; current admin remains in office until then |

The committee route is `proposeCommittee(successor, deadline, signature)`. Sign
`RotateCommittee` using the current `rotationNonce`, `committeeEpoch` and
submission deadline. `rotationDigest(successor, deadline)` returns that final
digest. Submission is allowed through `deadline` inclusive; activation time is
submission timestamp plus the full fixed delay. The deadline is not an activation
deadline. Anyone can relay the signature. A late relay cannot shorten the delay.

The admin route is `proposeCommitteeByAdmin(successor)`, called by the current
admin itself. Both routes share one proposal slot, with the explicit getter shape
`pendingCommittee() -> (address successor, uint256 executableAt, uint256 nonce,
bool adminOrigin)`. Origin records the entry point, even if the admin and committee
happen to be the same address.

A committee-origin proposal **cannot replace a pending admin-origin recovery**,
either during its delay or after maturity. A valid attempt reverts
`AdminRecoveryPending()` without changing the proposal, its activation time or
the next nonce. The admin may replace either origin, and every accepted admin
proposal starts the full three-day delay again, even when replacing a mature
proposal. Committee proposals can still replace other committee proposals with
the full delay. Every accepted proposal consumes a nonce, even if later replaced.
Application changes the committee, increments its epoch and clears the proposal
and origin. The old key remains authoritative while a proposal waits, even after
its delay has matured, until application actually executes.

Admin handover is two-step, cannot target zero or the escrow, and has the same
delay. Acceptance clears both the admin proposal and any pending committee
proposal, and advances the rotation nonce to invalidate unsubmitted proposals
signed before handover. The outgoing admin loses its powers immediately. There
is no admin renunciation or privileged token transfer.

The committee authorizes release **to the existing payer-selected split** before
expiry, with delivery verification performed outside the escrow. The admin can
replace this authority after the delay. Neither authority can change a deposit's
payer, amount, split or deadline, release after expiry, redirect refunds or pause
refunds. The current
committee cannot delay a pending admin recovery by submitting competing proposals.
Recovery still needs Ethereum inclusion of a permissionless `applyCommittee`
transaction. The three-day notice is not a promise that a live deposit can be
withdrawn early.

## Observability and service integration

`getDeposit(payer, requestId)` exposes the full permanent record, including
terminal status and split. `pendingCommittee`, `pendingAdmin`, `committee`,
`committeeEpoch`, `admin` and `rotationNonce` expose all governance state. The
inherited `eip712Domain()` exposes the signing domain.

`Deposited` includes request ID, payer, amount, absolute expiry, split hash and
every recipient/allocation. `Released` includes request ID, payer, relayer, split
hash, amount and signing committee/epoch. `Refunded` includes request ID, payer,
relayer and amount. Rotation events include authority, successor, nonce, epoch,
activation time and `adminOrigin`; replacement and handover cancellation emit
cancellation events. Admin scheduling and acceptance each emit an event.
Constructor events announce the initial authorities. Deposit, release and refund all index both
request ID and payer; release/refund also index the relayer. Join settlement events
to the permanent deposit record by **both** payer and request ID, scoped to the
chain and deployment. Replay events in transaction/log order and account for
Ethereum reorgs.

Before signing release, each committee reader checks the chain, escrow, token,
current committee, original owner/payer intent, verified mint deployment,
confirmed deposit and exact remaining fee split. Existing same-owner/same-rail
credit reduces the new deposit. Compounds put the first maker in the finder slot.
Anyone may submit the returned signature; that caller pays gas and cannot change
the recipients or amounts. The service has no Ethereum transaction sender.

An open deposit only pins the Trac reservation. It remains refundable at its
Ethereum deadline and cannot authorize a permanent permit. After release and all
its items have one confirmation, the committee signs the receiver-bound permit.
Official mints consume the units exactly once; after independent-supply
activation, additional pattern and compound tickers retain their hold until
verified mint completion or refund. The player inscribes from their own
Bitcoin wallet whenever ready. A refunded deposit never produces a permit.
The service never pays a refund or inscription fee on the player's behalf.

## Fixed deployment requirements

- **Token behavior or address changes:** this deployment accepts only its fixed
  ERC20 plus `burn(uint256)` token. Rebasing, outbound transfer fees, blacklists,
  changed burn or balance semantics, or token migration require a new deployment.
  The specified TAP implementation lacks those features; the constructor checks
  code presence, not semantic correctness. Select and verify the token before
  deployment. A token failure may also prevent refunds.
- **Signing/cryptography changes:** the domain/version, secp256k1, low-`s` ECDSA
  format and Keccak commitments are fixed. Membership resharing with the same
  threshold key needs no on-chain change; a new key uses delayed rotation.
  A different algorithm or verification primitive requires a different design.
- **Both authority keys lost:** no new approvals or recovery changes are possible;
  open deposits still become permissionlessly refundable. A lost payer key has
  no recovery here; refund returns to that same address.
- **Invalid successor:** key possession is checked off-chain for committee
  rotation. A nonzero address without a usable secp256k1 key can be installed;
  admin recovery remains delayed. Two-step admin acceptance protects against
  an unaccepted typo, not future key loss.
- **New economics or recipients:** prices and role allocations can change in the
  service while fitting four recipients plus burn. More independent recipients,
  partial releases, cancellation or recipient changes cannot be introduced for
  existing deposits. Round base-unit amounts before deposit and display the exact
  accepted split to the payer.
- **Timing requirements:** the one-hour minimum, 30-day maximum, three-day delay
  and timestamp clock are fixed. Ethereum stalls/censorship delay exits. Bitcoin
  stalls and late mints can violate external timing assumptions; a strict
  cross-chain height guarantee would need a different verification mechanism.
- **Payment identity:** uniqueness is per payer and request ID. Clients, services
  and indexers that join by request ID alone can confuse independent deposits.
  Verify the payer as well as the complete payment. Neither settlement nor admin
  action can recycle a previously used pair.
- **Storage growth and gas changes:** every request retains its permanent record.
  Release work is bounded to four transfers and one burn, but future gas costs
  and Ethereum execution changes can affect affordability or compatibility.
- **Bugs and accidental deposits:** no patch, emergency pause, drain or rescue
  exists. Keep unsolicited transfers out of accounting. These tests are local
  implementation evidence, not an independent security audit or a production
  deployment approval.

## Local build and proof

The pinned dependency/compiler are prepared by the repository's local setup.
No additional dependency or signing library is needed. From `eth/`:

```sh
./foundry build --offline --sizes
forge test --offline -vv
forge test --offline --gas-report
python3 script/anvil-flow.py
```

The tests include fuzzing (512 cases per fuzz test) and a stateful invariant
(128 runs, 96 actions each, unexpected reverts fail). The invariant mixes deposits,
both exits, time movement, committee rotation, admin handover and attempted
committee interference. It deliberately reuses request IDs across distinct payer
namespaces. Its independent accounting checks escrow balance, remaining
obligations, recipient balances, burned supply and permanent terminal states.
After every invariant run it expires
and refunds all remaining deposits, checking that every request reaches exactly
one terminal state. Token compatibility tests cover missing/false return values,
tax/bonus deposits, reverting later transfers/burns and reentrant callbacks.

The flow script starts a fresh Anvil bound to loopback with chain ID 31337,
deploys unchanged `LocalTap` plus `DmwEscrow`, signs EIP-712 messages through
unlocked disposable accounts, sends real local transactions, and checks release,
both rotation routes, admin handover and refund. It also checks one-unit
a prior deposit using another payer's request ID, separate settlement under that ID
and committee interference with admin recovery, including at maturity. It records
receipts, per-call gas, assertions and the Anvil PID under the shared build target,
stops that exact process in a `finally` block and records its exit. It never persists Anvil state.
It checks for at least 100 GB free before starting. There are no public RPCs or
real keys in the script.

To use the deployment script on an already running local Anvil:

```sh
forge script script/DeployEscrow.s.sol:DeployEscrow --offline \
  --sig 'run(address,address,address)' "$LOCAL_ADMIN" "$LOCAL_COMMITTEE" "$LOCAL_PAYER" \
  --rpc-url http://127.0.0.1:58545 --unlocked --sender "$LOCAL_ADMIN" --broadcast
```

Use unlocked disposable addresses from that Anvil. The script rejects other
chain IDs and mints 1,000 local TAP to the payer. The token-only deployment script
and existing local token behavior remain available. If Slither is installed,
run `slither . --filter-paths 'node_modules|test|script'` from `eth/`. These scripts
do not install Slither.
