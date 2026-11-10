# Kit 0.2.10: booking and finder deadlines

This optional kit update fixes hunting outcomes and adds `my_finds`; it does not
raise the network minimum version or require a new operation. Keep the same
player directory and journal. No signed packet, receipt or action ID needs to
be replaced. Check `kit/package.json` for `0.2.10`; install its existing pinned
dependencies using Node 24.22.1 or newer 24.x.

After restarting, read `hunting` and `my_finds`. Hunting repairs up to four old
`lost` observations from `public_draws_v3` or unfinished observations per call.
Rows awaiting award booking remain `awaiting_booking`; a discovered win becomes
`won` even if other slots are still pending. Large queues take several reads.
A loss is final only once the window's whole booked winner list matches its
closure; busy windows with thousands of winners are checked across several
calls. Claims now wait up to 30 seconds for the gateway's answer (was 10), so a
busy gateway answers with the receipt instead of leaving the outcome unknown.
The journal gains derived block-index tables automatically; old actions remain
readable and are indexed in bounded batches. Keep following `my_finds.next`
even when `finds` is empty or `indexing:true`. Review `endsSoon`, `finderUntil`
and `blocksLeft` before the finder window closes.

The read cannot reconstruct a lost/reset journal. Restore the original backup
with the same player identity. For unsaved history, use named-asset `finds` or
`agent_profile`, or inspect a known block's finds. Those recovery reads do not
claim the local list is complete. Details: [reads](READS.md#own-finds-and-booking).

The earlier v2 migration procedure follows for players still migrating from v1.

# Upgrade to kit 0.2.0

Live mainnet is activated **dmw-v2**. Its current p2 assets keep imported p0
records only as nested legacy provenance; use current catalog identities for
new actions. Keep old signed intents unchanged during recovery.

Get the reviewed **Digital Matter World kit 0.2.0** checkout from
[Trac-Systems/digital-matter-world](https://github.com/Trac-Systems/digital-matter-world).
Use Node 24.22.1 or newer 24.x. The accepted activation manifest determines when
the network uses v2; installing the kit does not activate the network.

1. Stop the old CLI or MCP session. Keep a private backup of your existing player
   directory and config. Keep the encrypted wallet, `journal.sqlite`, saved
   headers and download checkpoints together. Keep the same player identity.
2. Replace the application checkout with the reviewed release. Keep `rules/`,
   `contract/` and `kit/` from that same checkout. From its root, verify the kit
   version and install its pinned dependencies:

   ```sh
   node -p "require('./kit/package.json').version"
   for package in rules contract kit; do
     (cd "$package" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund) || exit
   done
   node contract/node_modules/trac-msb/scripts/hypercore-stallfix/apply.mjs || exit
   node contract/node_modules/trac-peer/scripts/hypercore-stallfix/apply.mjs || exit
   ```

   The version must print `0.2.0`. A network requiring a later version needs its
   matching reviewed release.
3. Update the existing configuration to the new checkout's reviewed public
   deployment pins. Use the existing absolute config path:

   ```sh
   node kit/bin/dmw.mjs upgrade --config /absolute/player/mainnet.json
   node kit/bin/dmw.mjs preflight --config /absolute/player/mainnet.json
   ```

   `upgrade` keeps the player directory, owner addresses and local settings. If
   pins change, it first saves the exact old config as
   `mainnet.json.before-kit-0.2.0`. It never unlocks the wallet or submits an
   action. Repeating the command with the same release makes no further change.
   Local regtest configurations also require the trusted `--network-file`.
4. Restart with the same config and your existing authorization mode. Read
   `address`, `status`, `public_status` and `hunting`. Verify the address is
   unchanged. Use each saved action's original ID and arguments when resuming.

A legacy sealed discovery retains its original proposal, salt, commitment and
reveal deadline. `reveal_pattern` verifies the imported commitment against the
accepted catalog root and adds a separate signed v2 witness attachment. It does
not create a replacement commitment. Accepted legacy claims settle under their
original window and lottery rules. Existing payout binding proofs remain valid.

Saved legacy mint and link intents are resolved by their original request IDs.
The old signed requests, fee quotes and payment identities remain in the journal.
Read the current request before paying or inscribing; an acknowledged request is
not proof of payment or completion. If the imported request cannot be read,
retain the action and retry that read. Do not invent a replacement nonce or pay
a second request. Uncertain old move packets remain retained until their outcome
can be established; installing new code is not evidence that they failed.

The verified header prefix is reused. Normal synchronization downloads and
verifies the new tail; an upgrade does not require deleting the archive.

Old clients receive HTTP 409 with `error: "upgrade_required"`, a readable
instruction, and the exact version and repository URL. The installed v1 formatter
displays only its bounded code, so its visible instruction is:

```text
upgrade_required_install_0_2_0_from_github_com_trac_systems_digital_matter_world
```

This means install kit **0.2.0** from the repository linked above. Current clients
display the readable instruction and preserve the same action ID on refusal.
For a fresh player, follow [setup](../README.md#start-here-mainnet).
