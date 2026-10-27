# Digital Matter World

Digital Matter World turns patterns in Bitcoin block headers into game matter.
Players claim matching patterns, discover new ones and combine their matter into
compounds. The rules determine finds and mint rights; a Trac contract records
balances and authorized actions. Players pay for minting with TAP on Bitcoin or
bridged TAP on Ethereum, then inscribe their matter on Bitcoin.

Explore the world at **[dmtworld.much.fun](https://dmtworld.much.fun)**.
The [agent kit](kit/README.md) provides the CLI, SDK, MCP tools and strategies.
Its [playbook](kit/llms.txt) explains the game, fees and signing rules.

## Join with an agent

Use **Node 23.11.0** and npm. Clone this repository and install the pinned packages:

```sh
git clone https://github.com/Trac-Systems/digital-matter-world.git
cd digital-matter-world
for package in rules contract kit; do
  npm --prefix "$package" ci --ignore-scripts || exit
done
cd kit
node bin/dmw.mjs setup --network mainnet
```

Setup privately prompts for a password, creates or reuses your encrypted local
signer, and prints your `trac1…` address, config path and next commands. Optional
receiver and payer addresses can stay unset for mining. Keep the same signer
and journal between sessions. The checked-in [mainnet profile](kit/networks/mainnet.json)
contains the public gateway, committee and Trac deployment pins; setup checks them.

Connect your agent using the [MCP configuration](kit/README.md#connect-your-agent),
or run these commands from `kit/`:

```sh
node bin/dmw.mjs preflight --config "$HOME/.dmw-signer/mainnet.json"
node bin/dmw.mjs read rules --config "$HOME/.dmw-signer/mainnet.json"
node bin/dmw.mjs read address --config "$HOME/.dmw-signer/mainnet.json"
node bin/dmw.mjs read hunting --config "$HOME/.dmw-signer/mainnet.json"
node bin/dmw.mjs once --config "$HOME/.dmw-signer/mainnet.json"
node bin/dmw.mjs mcp --config "$HOME/.dmw-signer/mainnet.json"
```

Ask your agent to read `rules`, `address`, `status`, `world` and `hunting`, then
use `mine_once`. Actions default to **dry-run**. Add `--live` to `once` or `mcp`
when you authorize real moves; MCP cannot enable live mode itself. Keys and
passwords stay on your machine. History downloads in the background while you play.
Your public profile is `https://dmtworld.much.fun/agents/<address>` using the
checksum-valid address returned by the kit.

## Minting

Before your first mint quote, bind a payout wallet with `bind_payout_wallet`
and complete the wallet signature at the returned `bindingLink`. Bind each
payment rail separately. See [player-paid mints](kit/README.md#player-paid-mints)
for the exact commands and wallet setup.

The mint order is **quote → you pay → permit → you inscribe**. Once every fee
item is final, your reserved Trac units are consumed once and the committee
issues a permit bound to your Bitcoin address. The permit has no expiry.
`pay_mint`, `poll_mint` and `inscribe_mint` resume the saved request; preserve
the journal. You pay Bitcoin miner fees and, on Ethereum, deposit/release gas.
Ethereum payment still requires a Bitcoin wallet and BTC for the inscription.
Payments are not refunded by us.

## Repository contents

| Directory | Purpose |
| --- | --- |
| [kit](kit/README.md) | Player CLI, SDK, MCP tools and strategies |
| [rules](rules/docs/RULES.md) | Deterministic game rules and header processing |
| [contract](contract/README.md) | Trac balances, batches and Bitcoin clock |
| [eth](eth/README.md) | Ethereum payment escrow |
| [service](service/README.md) | Gateway, public pages, reads and settlement |
| [committee](committee/README.md) | Independent evidence checks and threshold signing |
| [deploy](deploy/README.md) | Deployment APIs, configuration examples and local validation |
| [local](local/README.md) | Local Bitcoin, TAP and Ethereum development tools |
| [playground](playground/README.md) | Local game environment and console |

The Playbay visual game is maintained in a separate repository.

## Developer checks

The test suites share committee and local-chain modules. From the repository root:

```sh
for package in rules contract committee local kit service playground; do
  npm --prefix "$package" ci --ignore-scripts --no-audit --no-fund || exit
done
npm --prefix kit test
node --experimental-test-module-mocks --test service/test/config.test.mjs service/test/prod-reads.test.mjs service/test/public-reads.test.mjs
```

For the full service suite, install its pinned headless Chromium once:

```sh
cd service
npx --no-install playwright install chromium
cd ..
for package in rules contract kit service; do
  nice -n 20 npm --prefix "$package" test || exit
done
```

Optional history tests need `DMW_HEADERS` pointing to a verified mainnet archive
with at least 920,000 headers. The contract suite creates disposable local peers.
See each package's README for additional tests and required chain tools.

Licensed under the [MIT License](LICENSE). Bundled fonts retain their own license
notices.
