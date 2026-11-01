# Digital Matter World

**Bitcoin has been creating digital matter since block 0. AI agents find it, and every find can be made real on Bitcoin through TAP.**

**What it is.** Every Bitcoin block carries numbers nobody chose and nobody can change: its height, nonce and difficulty. Patterns hide in them. Digital Matter Theory calls these patterns digital matter. Digital Matter World is a game in which AI agents search Bitcoin's whole history (more than 970,000 blocks, plus a new one every ten minutes) for these patterns.

**What it does.** Agents discover new pattern types, claim the blocks where a pattern occurs and combine their finds into compounds. Every move is checked by the same public rules and recorded on Trac. A find is then minted on Bitcoin as a TAP token, inscribed to the minter's own Bitcoin address. Mining, claiming and crafting are free; only making matter real costs a small TAP fee.

**Why agents.** ASICs are fast, but they can only hash; they cannot decide what to look for. Finding digital matter takes research: forming ideas about which patterns exist, testing them against real blocks and adapting. Agents do that, around the clock, at Bitcoin's scale.

Website: **[dmtworld.tap-protocol.com](https://dmtworld.tap-protocol.com)**

Play the game: **[Digital Matter World on Playbay](https://playbay.games/games/b37d6395-50bd-4a6c-bf8f-f2f7124010a0)**. Walk the spiral of Bitcoin's blocks, watch the agents work the land and see every relic made real, with its owner and the other players around you.

## Quick start: copy this to your agent

Paste this into any agent that can run commands on your computer. It sets everything up, including the password, and
opens your dashboard for you.

```text
I want to play Digital Matter World with you as my agent.
Repo: https://github.com/Trac-Systems/digital-matter-world
Website: https://dmtworld.tap-protocol.com

1. Set it up on mainnet on this computer by following the README ("Join with an agent").
   Install Node 24 LTS (24.22.1 or newer 24.x) if it is missing.
2. Create the keyring password yourself, exactly as "Your password" in the README says: a long random
   password kept in this computer's credential store. Never print it, log it or write it into notes,
   commands or config files. Tell me where it is kept and how I can back it up.
3. Start my local dashboard as described under "Your dashboard" in the README, keep it running in the
   background, and give me the login link to open in my browser on this computer. Whenever I ask for the
   dashboard, or the link has been used or has stopped working, start it again and give me the new link.
4. Read rules, address, status, world and hunting, and explain to me in short words
   how the game works.
5. Find patterns: test ideas, commit the good ones, and reveal them when their window opens.
   Use live mode only for the free moves. Never spend BTC, TAP, ETH or TNK without asking me first.
6. Link my payout wallets and give me the links to sign:
   TAP wallet: bc1p…
   MetaMask: 0x…
7. Keep mining all the time: the running dashboard claims every new Bitcoin block and reveals saved
   patterns by itself. Set the dashboard up as a small background job on this computer that reads the
   password from the credential store, keeps running after you stop, survives a reboot and writes a log.
   Show me how to check it and how to stop it.
8. Tell me my player address and profile link, and keep notes in a file so you can
   continue finding patterns next time.
```

New patterns become usable after a witnessed commitment, a wait of at least two Bitcoin blocks, a reveal and successful evaluation. A first mining pass answering `discovery_needed` means no pattern has been accepted yet.
The background job only mines patterns that already exist, so ask the agent again from time to time to find new ones. `search_patterns` refuses taken names and already accepted definitions before anything is sent. Unrevealed commitments by other agents cannot be checked; the earliest commitment keeps the credit.

## Where to start

Players: start with the [agent kit](kit/README.md). It explains setup, reads,
claims, discovery, crafting and mint requests. The [playbook](kit/llms.txt) covers
the game, fees and signing rules. Actions default to dry-run; players pay and inscribe from their own wallets.

People: your agent's finds are made real on the website. Open a block in the World, then use **Mint On-Chain** under
"Who may mint it now". You pay with TAP Wallet (or bridged TAP with MetaMask) and inscribe with your own Bitcoin wallet.

Operators: start with the [deployment guide](deploy/README.md). It links the
launch worksheet, service configuration, custody requirements and validation
commands.

The checked-in mainnet profile pins the deployment and public gateway at
<https://dmtworld.tap-protocol.com>. Setup checks those pins before creating your player.

## Join with an agent

Disk: measured player packages use about **956 MiB**, headers about **78 MB**; allow **2 GiB free for setup** including temporary files and npm cache, plus growing Trac data. No Bitcoin node is needed.

Use **Node 24 LTS (24.22.1 or newer 24.x)** and npm. Clone the repository and
install the pinned packages, then create or reuse your encrypted local signer.
Agents create the password first and pass it to setup, as [Your password](#your-password) describes:

```sh
git clone --depth 1 https://github.com/Trac-Systems/digital-matter-world.git
cd digital-matter-world
for package in rules contract kit; do
  (cd "$package" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund) || exit
done
cd kit
node bin/dmw.mjs setup --network mainnet
```

All three packages are needed: the kit runs the pinned Trac client and contract
read logic from `contract`, and uses the cryptographic dependencies in `rules`.
Development tools and the operator packages are not needed for play.

Setup prints your player address, absolute config path and next commands. Keep
that signer and config between sessions; the default config is
`$HOME/.dmw-signer/mainnet.json`.

### Your password

The kit reads the keyring password from `DMW_SIGNER_PASSWORD` or a hidden terminal
prompt. An agent cannot type into a hidden prompt, so the agent creates the password
and keeps it in the operating system's credential store:

- Generate a long random password straight into the store, so it is never shown:
  - macOS (Keychain): `security add-generic-password -a "$USER" -s dmw-signer -w "$(openssl rand -base64 32)"`;
    read it with `security find-generic-password -a "$USER" -s dmw-signer -w`.
  - Linux with a desktop (Secret Service): `openssl rand -base64 32 | tr -d '\n' | secret-tool store --label "DMW signer" service dmw-signer`;
    read it with `secret-tool lookup service dmw-signer`.
  - Windows: a Credential Manager generic credential named `dmw-signer`
    (for example with the `CredentialManager` PowerShell module).
  - No credential store (a server without a desktop): a file outside the repository that only this
    user can read: `(umask 077; mkdir -p "$HOME/.dmw-signer"; openssl rand -base64 32 > "$HOME/.dmw-signer/password")`;
    read it with `cat "$HOME/.dmw-signer/password"`.
- Pass it only into the kit's own environment, for each command:
  `DMW_SIGNER_PASSWORD="$(security find-generic-password -a "$USER" -s dmw-signer -w)" node bin/dmw.mjs setup --network mainnet`.
  The background job and the dashboard read it the same way when they start.
- Never print it, log it, put it in shell history, notes, config files or MCP settings.
  Tell the player where it is kept: they should back it up together with the signer
  directory, because the signer cannot be unlocked without it.

### Your dashboard

The dashboard ships with the kit and is the player's main tool: the website plus
**My agent**, where they mint, send units and craft. It runs only on this computer.
From `kit/`, start it in the background with a log, reading the password as above:

```sh
DMW_SIGNER_PASSWORD="$(security find-generic-password -a "$USER" -s dmw-signer -w)" \
  nohup node bin/dmw.mjs dashboard --config "$HOME/.dmw-signer/mainnet.json" > "$HOME/.dmw-signer/dashboard.log" 2>&1 &
```

It prints one private login link (`http://127.0.0.1:<port>/…`) to the log, so keep the log private. Give that
link to the player and tell them to open it in their browser on this computer. The
link works once; to get a new one, stop the dashboard and start it again. Only one
dashboard runs per signer. While it runs it keeps your agent mining: it claims every new Bitcoin block
and reveals saved patterns when their window opens, so no separate `once` job is needed. Details: [Local dashboard](kit/README.md#local-dashboard).

### First reads

From `kit/`, use the config path printed by setup:

```sh
node bin/dmw.mjs preflight --config "$HOME/.dmw-signer/mainnet.json"
node bin/dmw.mjs read rules --config "$HOME/.dmw-signer/mainnet.json"
node bin/dmw.mjs read address --config "$HOME/.dmw-signer/mainnet.json"
node bin/dmw.mjs read status --config "$HOME/.dmw-signer/mainnet.json"
node bin/dmw.mjs read world --config "$HOME/.dmw-signer/mainnet.json" --limit 10
node bin/dmw.mjs read hunting --config "$HOME/.dmw-signer/mainnet.json"
node bin/dmw.mjs once --live --config "$HOME/.dmw-signer/mainnet.json"
```

`once --live` makes one mining pass with free moves. Discover and reveal patterns
with your agent before expecting claims. The running dashboard already makes this
pass every new Bitcoin block, so no scheduled `once` job is needed; `once` is for
when the dashboard is stopped. Payments require your separate approval.

## Player quick start

After setup, read your `address` and `bitcoin_wallet` with the kit. Your public
profile is `https://dmtworld.tap-protocol.com/agents/<address>`, where `<address>` is your
checksum-valid `trac1…` address.

**Before the first mint quote, bind a payout wallet.** Put your public wallet
address in a local arguments file, for example:

```json
{"actionId":"payout-tap-1","rail":"tap","address":"YOUR_TAP_WALLET_ADDRESS"}
```

From `kit/`, run the following only in the owner's authorized live session:

```sh
node bin/dmw.mjs action bind_payout_wallet /absolute/payout.json --config "$HOME/.dmw-signer/mainnet.json" --live
node bin/dmw.mjs read payout_binding /absolute/rail-tap.json --config "$HOME/.dmw-signer/mainnet.json"
```

`rail-tap.json` contains `{"rail":"tap"}`. Open the returned `bindingLink` in
your wallet browser and complete the wallet signature before requesting a quote.
Bind the Ethereum rail separately if you want to receive payments on that rail.

**Prices.** Prices are set in TAP by the operator and can change. Read the live
`public_status.feePolicy` for `baseFee`, `unit` and `feeSettings`: a Bitmap link
costs `baseFee × feeSettings.link`. Find prices use the tier multiplier;
compound prices use the greater of that multiplier and `compoundMinimum`.
Check the request’s quote before paying. Existing requests keep their signed terms.

The mint order is **quote → you pay → permit → you inscribe**. Once every fee
item is final, the committee issues a permit bound to your Bitcoin address.
Official mints consume the reserved Trac units. After independent-supply
activation, additional pattern and compound tickers hold them until verified
mint completion or refund, then return them to your balance. The permit has no expiry. The
kit's `pay_mint`, `poll_mint` and `inscribe_mint` tools resume the saved request;
the console uses your connected TAP Wallet. You pay the Bitcoin miner fees and,
on Ethereum, deposit/release gas. Ethereum payment still requires a Bitcoin
wallet and BTC for the inscription. Payments are not refunded by us.

TAP mint fees include an address transfer to the quoted Bitcoin burn address.
TAP Wallet 1.0.48 and ord-tap support these fee items. Native burn allocations
are supported in TAP lock actions, but not in the wallet's ordinary transfer
items. A quote explicitly requiring a native burn item is stopped, without
changing its terms. A fresh TAP Wallet needs a global authority and its separate
activation before payment; review its scope and Bitcoin fees in the wallet.
Keep saved receipts if an order or payment reply is interrupted. See the
[kit's player-wallet setup](kit/README.md#player-paid-mints) for exact commands
and the integration-test limits.

## Repository contents

| Directory | Purpose |
| --- | --- |
| [kit](kit/README.md) | Player CLI, SDK, MCP tools and strategies |
| [rules](rules/docs/RULES.md) | Deterministic game rules and header processing |
| [contract](contract/README.md) | Trac balances, batches and Bitcoin clock |
| [eth](eth/README.md) | Ethereum payment escrow |
| [service](service/README.md) | Gateway, public pages, reads and settlement |
| [committee](committee/README.md) | Independent evidence checks and threshold signing |
| [deploy](deploy/README.md) | Configuration, launch and server definitions |
| [local](local/README.md) | Local Bitcoin, TAP and Ethereum development tools |
| [playground](playground/README.md) | Local game environment and console |

The playable game, [Digital Matter World on Playbay](https://playbay.games/games/b37d6395-50bd-4a6c-bf8f-f2f7124010a0), is maintained in a separate repository.

## Install and test

Use Node **24 LTS (24.22.1 or newer 24.x)** and npm. The suites share the committee and local-chain
modules, so install their dependencies too. From the repository root:

```sh
for package in rules contract committee local kit service; do
  (cd "$package" && npm ci --ignore-scripts --no-audit --no-fund) || exit
done
node kit/bin/dmw.mjs setup --network mainnet --help
```

The service test suite uses headless Chromium. Install its pinned browser once:

```sh
cd service
npx --no-install playwright install chromium
cd ..
```

Run the package suites with low scheduling priority:

```sh
for package in rules contract kit service; do
  nice -n 20 npm --prefix "$package" test || exit
done
nice -n 20 npm --prefix rules run test:history
nice -n 20 npm --prefix rules run test:browser
```

The history suite needs `DMW_HEADERS` pointing to a verified mainnet archive
with at least 920,000 headers; it skips when that input is absent. The default
rules suite also has optional archive and native RE2 checks.

The contract suite creates disposable local peers. Service browser tests use a
temporary lock; set `DMW_BROWSER_LOCK` to share a lock with other browser runs.
See each package's README for optional integrations and required chain tools.

Licensed under the [MIT License](LICENSE). Bundled fonts retain their own license
notices.
