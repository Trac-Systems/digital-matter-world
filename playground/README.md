# Local mechanics playground

Run from the repository root with the existing local toolchain:

```sh
source ~/.nvm/nvm.sh
nvm use 23.11.0
export npm_config_userconfig=/dev/null
export DMW_BUILD_ROOT=/path/to/your/build
node playground/run.mjs up
node playground/run.mjs status
node playground/tour.mjs
node playground/run.mjs down
```

`up` creates the game on its first run and restores it thereafter. It prints one
local login link, `http://127.0.0.1:59000/?t=…`. Open that link to connect: the
server sets an HttpOnly, SameSite=Strict session cookie and redirects immediately
to `/`. The token is never delivered to page scripts or placed in page storage.
Nothing opens a browser automatically and no key or token needs to be pasted.
Run `node playground/run.mjs link` to print the login link again while the game
is ready; `up` also prints it when the game is already running. Links remain
valid until `wipe` replaces the private control token. A server restart ends the
browser session; open the link again to reconnect. Keep the login link private.
Startup normally takes under two minutes. `down` preserves the game. `wipe` stops
it and deletes only this playground's marked data and test wallets. The tour
pauses mining and bots and leaves them paused; use the console or control API to
resume. Fresh games auto-mine every 30 seconds, with one bot tick each minute.

Prerequisites are the same installed tools as the local soak: Node 23.11.0,
Bitcoin Core, Anvil, the built ord-tap binary and TSS sidecar, installed
`contract/`, `kit/`, `service/` dependencies, and the compiled `LocalTap` and
`DmwEscrow` artifacts under `$DMW_BUILD_ROOT/target`. Without `DMW_BUILD_ROOT`,
the build directory defaults to `../build` beside this repository.
The console browser checks use the pinned Playwright development dependency.
Run `npm --prefix playground ci --ignore-scripts` and install Chromium with
`cd playground && npx --no-install playwright install chromium` before those checks.
Free disk space must remain above 100 GiB.
The startup command refuses occupied ports and does not stop unrelated apps.

The game uses 2,048 actual Bitcoin regtest blocks as its initial history.
The same chain is extended during play. Pattern rarity, historical selections,
proofs, finds and draw credits are computed from these real headers. Mainnet
history is not fabricated into regtest. The kit verifies the pinned regtest
genesis, links, proof of work and median time; its ordinary mainnet verifier
remains strict. A fresh local game starts with an empty table and no player claims.
Use the kit's search, commit and reveal actions to discover the first patterns;
the ordinary bots can also discover them once play begins.

The local kit adapter supports the kit's encrypted Bitcoin signer. Select its
cardinal coins explicitly in the kit config's `bitcoin.funding` array as
`{ "txid": "...", "vout": 0 }`; the adapter also follows change saved in the kit
journal. It verifies that every selected output belongs to the signer and has
one confirmation. TAP payments additionally need the wallet's indexed
`bitcoin.authority`. The signer pays for deployment, payment and mint inscriptions.

Bitcoin/ord files, Trac logs and contract state, TSS/signers, receipts, payout
records, kit journals and wallets persist until `wipe`. Anvil runs in memory.
A journal of local raw transactions and block metadata is replayed at startup,
with state-root and block-hash checks; no Anvil state snapshot is written.
An external Ethereum transaction survives a clean `down`; an abrupt system
failure can lose transactions since the last ten-second journal checkpoint.

The private manifest is `playground/.data/manifest.json`. Its runtime directory
is below `$DMW_BUILD_ROOT/playground/`. Wallet passwords,
API tokens and test keys use private files. Each process is recorded with its
PID and process identity. A crashed component stops the stack; inspect its log
before starting again. Interrupted jobs are marked failed and never replayed
by the supervisor. Use the same `actionId` to resume a reviewed kit action;
`player/pay` retains known payment IDs. Ambiguous payment broadcasts require
inspection instead of a second deposit.

| Component | Loopback port |
| --- | --- |
| Console/control API | 59000 |
| Bitcoin regtest RPC, cookie authentication | 18443 |
| ord-tap | 55888 |
| TAP wallet gateway | 55999 |
| Anvil, chain ID 31337 | 58545 |
| Trac control RPC | 58900 |
| DMW gateway | 58910 |
| Local DHT bootstrap | 58920 (plus local ephemeral peer sockets) |
| Five TSS sidecars | 58700–58704 |
| Five signer services | 58800–58804 |

The 12 default bots are real encrypted kit identities with local TNK for their
transaction fees. Prospector, discoverer and crafter strategies submit
claims, commit/reveal patterns, craft and make compounds real, transfer matter,
mint through both payment rails and link Bitmaps. They share the local payment faucet. Every bot claims first, then
one economic action runs per tick. Evidence is final when included in one block. First deployment needs the deploying
player’s wallet; bots report that step until the asset is registered. Successful economic demonstrations run once per bot; claims continue.
Changing count/speed is persistent. A failed spend halts that bot's economic
strategy until `POST /api/bots {"resetErrors":true}`; the error remains visible.
Startup verifies saved payout bindings and automatically binds the playground's
own bots and saved kit players through the ordinary two-signature wallet flow.
Only `trac1` binding messages are accepted. Other agents with invalid bindings
remain unbound until their owners bind again.

The owner uses the same identity in the console and kit CLI:

```sh
node playground/kit.mjs status
node playground/kit.mjs once
node playground/kit.mjs once --live
node playground/kit.mjs action /absolute/path/to/action.json --live
```

The wrapper reads the owner's 0600 password file and supplies the existing kit
CLI with `--directory playground/.data/players/owner` and the local config.
`once` is dry-run unless `--live` is supplied. An action file follows the kit README, for example:

```json
{"type":"transaction","args":{"actionId":"my-transfer","op":"tf","value":{"to":"AGENT_PUBLIC_KEY","assets":[["p0","1"]]}}}
```

Console and CLI share the SQLite intent journal and the same signing identity.
Avoid issuing concurrent writes from both interfaces for the same action.
Use a fresh claim window for `once --live` if the console already claimed the
current round; the kit refuses conflicting claims for the same round.

See [API.md](API.md) for all reads/actions and [WALLETS.md](WALLETS.md) for
external wallets. `node playground/tour.mjs` is the mechanics walkthrough;
it prints each successful mechanic and saves `playground/.data/tour.json`.
After inspecting a failed step, `node playground/tour.mjs --resume` retains
completed steps and payment IDs. If a mint needs its first deployment, deploy the
asset through the console wallet flow and resume the tour. `node --test playground/test/*.test.mjs`
runs the focused tests without a live stack.

Additional local walkthroughs (mint steps require player-funded deployment first):

```sh
node playground/bot-tour.mjs
node playground/tour.mjs
node playground/wallet-tour.mjs
```

The bot tour temporarily uses three bots, one of each strategy, then restores
the configured count and leaves them paused. The wallet tour funds a separate
local payer and submits its own escrow transactions through the public payment
plan, including the payer release. It stops at the permanent mint permit so the
receiver wallet can perform the final inscription. Both write their evidence under `.data/`. All counted history
remains claimable. Initial owner/bot wallets remain separate from the game treasury.
