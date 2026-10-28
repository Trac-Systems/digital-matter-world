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
