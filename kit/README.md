# Digital Matter World agent kit

Mainnet at https://dmtworld.tap-protocol.com runs **dmw-v2**. Kit **0.2.0**
supports it and existing player homes. Follow
[the upgrade instructions](docs/UPGRADING.md) to keep your wallet, journal, headers,
payout bindings and financial intents. Resume saved actions with the same IDs.

The flat fee policy sets one TAP amount for every pattern mint, public mint,
compound mint and Bitmap link, targeting US $0.50 at the operator's reference
price. This is a fixed TAP setting, not a live USD peg. Read
`public_status.feePolicy` for the effective `baseFee`, `unit` and `feeSettings`.
Flat settings use `tierMultipliers: [1,1,1,1,1]`, `compoundMinimum: 1`, `link: 1`.
Before that settings revision activates, the displayed policy still applies.
Both Bitcoin TAP and bridged TAP payments use the same atomic amount; network
fees are separate. Check the request's quote before paying. Existing requests,
refunds and fee credits keep their original signed amounts.

Use your own local Trac signer to find, discover and craft matter, then reserve, pay and
inscribe authorized mints from your own Bitcoin wallet. Start with `rules`, `address`, `status`,
`public_status` and `hunting`. Read tools work in either launch mode subject to the transport and proof requirements below.

Read [llms.txt](llms.txt) for the game and fee rules, [SKILL.md](SKILL.md) for a
short play loop, [the read reference](docs/READS.md) for filters/sorts/units and
[the action reference](docs/ACTIONS.md) for formats, states and errors.
These documents contain everything a player needs; no outside rulebook is required.

## Local dashboard

Start the dashboard on the machine that holds your agent signer:

```sh
node kit/bin/dmw.mjs dashboard --config /absolute/path/to/mainnet.json
# Optional fixed port:
node kit/bin/dmw.mjs dashboard --config /absolute/path/to/mainnet.json --port 8787
```

Use your existing mainnet config and signer directory. Unlock with the hidden
password prompt or `DMW_SIGNER_PASSWORD` in the local launch environment. The
command prints one private login link and runs until Ctrl-C. Open that link on
this machine; it works once and becomes an HttpOnly session cookie. The server
listens only on `127.0.0.1`, chooses a free port unless `--port` is supplied,
and accepts one dashboard per signer journal. Treat the link as private.

The dashboard lists claimed blocks this agent is eligible to mint, with the
reason (own find or units), required units, current asset balance
and request state. Own finder-week blocks come first, then other eligible blocks
paged by asset and block. Minted blocks are excluded. Short balances remain
visible with a reason and cannot mint. **Mint** signs that block's mint request
immediately through the same `mint_on_chain` tool; **Mint all** prepares eligible
blocks sequentially. Dashboard clicks enable live
mint signing without `--live`; starting the command or viewing a page does not
sign a request. Financial signing does not wait for a mining round.

The receiver and TAP payer are your agent's verified, bound TAP payout address,
shown at the top. Complete `bind_payout_wallet` first if no binding is present.
During the finder's week only the finder mints; afterwards any agent can.
Bitmap holders earn 15% of every mint on their plot. Agents need enough units
of that asset to mint. Minting the official ticker spends the required units. After the per-ticker supply activation, an additional pattern ticker holds the same units until mint completion or refund, then releases them. `transfer` submits unit authorizations after the public-mint settings activation; see
[unit transfers](docs/ACTIONS.md#unit-transfers-on-v2). Unclaimed blocks use a separate website flow.
All mint requests still pass shared validation and accepted reservation.

After a request is ready, approve its quoted TAP fees in the TAP Wallet browser
extension. When payment is confirmed and the permit is issued, choose **Inscribe
mint** and review the Bitcoin miner fee and postage. The initial mint click never
pays or inscribes automatically. If the extension is unavailable on loopback,
**Open payment page** opens the existing website payment page for that request.
Use one payment page at a time; after an uncertain payment, inspect the wallet
and report its redeem inscription ID instead of starting another payment.

Open requests and exact signed intents stay in your private signer journal.
Local browser payment recovery data is also saved there, so changing the HTTP
port or restarting the dashboard does not lose an uncertain-payment marker or
saved inscription. Resume the same request after a timeout. Do not delete the
journal or switch between local and website payment flows to retry an uncertain
payment. If a closed tab leaves a wallet operation busy, restart the dashboard
and reopen the saved request. A changed payout binding never rewrites an already
signed request. Token deployment, when required, opens its existing website
flow; finish deployment, then return and click Mint again.

The kit includes the browser helper and existing site styles. Maintainers can
refresh those bundled assets with `node kit/scripts/build-dashboard.mjs` after
updating the shared wallet source or console stylesheet.

## Discovery with activated v2 rules

Your computer does the search. Download and verify the Bitcoin headers once,
then run `search_patterns` locally. Keep the real matching heights, per-block
counts and search snapshot; a total without named blocks is not a submission.
Read the effective rules and claim allowance first.

Choose at least the configured minimum matching blocks (three in the launch
profile). `propose_pattern` saves the snapshot, witnesses, salt and stable action
ID before sending the commitment. `reveal_pattern` reuses that record in its
original eligibility window. Acceptance makes the pattern playable; its
discoverer attribution can remain provisional until earlier commitments to the
same definition expire. Unrelated unopened commitments never block it.

The public count means matching blocks submitted and checked so far. It is not
a count of all Bitcoin history. `submit_occurrences` adds a bounded page of real
matches without awarding a find. Use submitted-block and found/minted pages,
including historical header-draw metadata, to avoid taken slots. Enter free
claims within the current allowance; the deciding block chooses winners.
Mint only after a verified find and with the required units and right.

After a timeout, keep the original packet and action ID. Existing wallets,
journals, salts and headers stay in place. Legacy commitments add a separate
signed witness attachment. If the service or independent verifier reports
`upgrade_required`, install kit **0.2.0** from the reviewed public repository
before sending again; keep the same player directory and verification settings.
The accepted manifest selects the protocol; live mainnet is already v2. Installing
this checkout does not change consensus or replace independent notary verification.

## Start here: mainnet

Use **Node 24 LTS (24.22.1 or newer 24.x)**. From the cloned repository, install the pinned packages,
then create your local player:

```sh
for package in rules contract kit; do
  (cd "$package" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund) || exit
done
cd kit
node bin/dmw.mjs setup --network mainnet
```

Measured player packages use about 956 MiB, plus roughly 78 MB for headers.
Allow 2 GiB free for setup, temporary files and npm cache, and room for growing
Trac stores. No Bitcoin node is needed. Keep all three packages: `contract`
provides the pinned Trac runtime and read logic; `rules` needs its cryptographic
dependencies. `--omit=dev` skips development tools; no operator install is needed.

Setup privately prompts for a password, creates an encrypted signer (or reuses
it), asks for optional receiver/payer addresses, and prints your `trac1…` address,
config filename and exact next commands. Use `--import` to enter recovery words
privately instead; use `--directory /absolute/player` for a separate identity.
Empty owner addresses are fine for mining. `--skip-addresses` leaves them unset.
Keep the same signer and journal between sessions. Repeating setup preserves
existing owner settings and never replaces a keyring.

Next, [connect your agent](#connect-your-agent) with the printed `mcp` command.
Ask it to read `rules`, `address`, `status`, `world` and `hunting`, then play with
`mine_once`. `post_header` fetches the tip header while the all-history archive downloads.
There is no history-download step before playing. MCP downloads discovery history
in the background and reports `history downloading (x%)` until it is verified.

`networks/mainnet.json` contains the reviewed deployment pins. Setup and preflight
check them before prompting or making connections, and refuse older profiles
containing `TO-BE-FILLED-AT-LAUNCH`. Use the reviewed repository release;
never fill pins from a gateway response or copy RESET's subnet. See the operator
[launch step](#pin-the-public-release-at-launch) below.

The live catalog already has patterns. Read `catalog` (all current pages) or
`patterns` (one wire-format page). V2 records have `number:"0"`, a 64-hex `key`
and `asset:"p2:0"`; imported `p0` identities are nested under `legacy` provenance.
A successfully drained empty catalog returns `discovery_needed` and its next
actions. A 503 index failure is not an empty table. Search and discovery do not
add entries by themselves; wait for accepted reveal before claiming a pattern.

## Mainnet reads and mining

After setup and connecting your agent, these standalone CLI commands offer the
same reads and play pass. They use the default config; setup also prints commands
for custom paths:

```sh
node bin/dmw.mjs preflight --config "$HOME/.dmw-signer/mainnet.json"
node bin/dmw.mjs read rules --config "$HOME/.dmw-signer/mainnet.json"
node bin/dmw.mjs read address --config "$HOME/.dmw-signer/mainnet.json"
node bin/dmw.mjs read status --config "$HOME/.dmw-signer/mainnet.json"
node bin/dmw.mjs read world --config "$HOME/.dmw-signer/mainnet.json" --limit 10
node bin/dmw.mjs once --config "$HOME/.dmw-signer/mainnet.json"
```

`preflight` checks local pins; it does not certify live network readiness.
Dry-run prevents sends/signatures but is not a GET-only transport policy: native
contract reads use Trac P2P, and `mint_quote`, `craft` and `link_bitmap` can POST
unsigned previews. Skip those previews under a GET-only policy. `submit_bitmap`
and `report_custody_payment` are actions and send nothing in dry-run.
The built-in native Trac runtime uses the same trac-peer/MSB stack as RESET's
Pear runtime, directly under Node. It joins network **918**, discovers validators,
replicates DMW's pinned subnet into your private signer directory and waits for
its Bitcoin tip to agree with the public header source. It needs no operator
runtime config, wallet export, account-registration transaction or public HTTP
listener. First synchronization can take time; a timeout preserves the stores
for retry. MCP initializes immediately; the first contract read connects Trac.

`once` and every MCP action default to **dry-run**. To authorize real moves,
launch `once` or `mcp` with `--live`. MCP cannot enable live mode itself. The
`pay_mint`, `inscribe_mint` and `inscribe_deployment` tools use the local Bitcoin signer only in live mode. `once` hunts patterns throughout counted history using the local archive and
excludes materialized found/minted slots through `/patterns/p2:N/claimed-blocks`
with limits at most 50. Missing submitted evidence cannot exclude implicit header
awards; use `window_eligibility` and accepted closure evidence. It selects up to the
configured window budget (100 by default), then adds the tip header. While the
archive loads, it sends that header and reports `claimState:history_downloading`.
Selected headers are checked for proof of work and against the contract chain.
Pre-checkpoint archive claims require verified history overlapping that chain.

MCP starts a resumable background download to `headers.bin` in the signer
directory (`--headers FILE` or config `headers` selects another cache). The gateway
serves a signed `/headers/manifest.json` and authenticated immutable chunks.
Each raw header is 80 bytes, roughly 78 MB for the current chain. Interrupted
chunks resume at their exact byte; updates fetch only changed chunks/tree nodes.
Reorgs replace the divergent tail. Legacy archive compatibility does not change
the active v2 distribution or allow unsigned downgrade.
The download checks free space on the filesystem containing your chosen output,
budgeting additional compressed/raw temporary files plus 10% and a 512 MiB
reserve (about 680 MiB free for a first 78 MB archive). An already verified,
current cache needs no new archive space. It never requires 100 GB free.
V2 downloads authenticate the operator manifest with the installed gateway identity
before fetching immutable chunks. Mirrors cannot choose that identity. Bitcoin
chain verification and the independent tip check remain required. Interrupted
chunks resume; bounded cleanup preserves the active download's files. See the
[header download guide](docs/HEADERS.md).

To download explicitly outside an MCP session:

```sh
node bin/dmw.mjs download --source https://dmtworld.tap-protocol.com --output "$HOME/.dmw-signer/headers.bin"
```

Downloads cross-check the final hash with Blockstream and verify Bitcoin genesis,
PoW, linkage, retargets and median time. Verification runs in a background
computation thread; reads and claims stay available. `search_patterns`,
`propose_pattern` and `reveal_pattern` return `history downloading (x%)` while
loading or catching up, with a retry reason if a source is unavailable. They
submit nothing until the verified history reaches the exact contract tip.
MCP refreshes automatically and uses the completed history without a restart.
A standalone CLI discovery call waits for its download/verification.

The local 12-sends-per-tip limit prints
`waiting for the next Bitcoin block (12/12 used)` on stderr once per full tip,
then resumes when the tip changes. Stopping the command preserves its intent.
An HTTP `429 reveal_capacity` is a refusal before acceptance. Retry the same
action ID after another Bitcoin block; the kit refreshes the refused packet and
keeps its signed history. For older installs with stale `unknown` refused reveals,
follow [the recovery instructions](docs/ACTIONS.md#recover-an-old-refused-reveal).

**TNK: 0 for setup, reading, headers, claims, discoveries and crafts.** Free
moves are signed locally and submitted to the gateway, whose operator submits
the settlement batches. The player does not need an MSB account: the contract
creates its matter account when it credits a win. Crafting requires owned matter.
`transfer {actionId,to,assets}` checks the recipient's `trac1…` address and exact
ledger balances. Use `p2:N`, `c2:COMMITMENT`, or the imported `p0`-style key shown
in your balances. Before the public-mint activation height, live mode saves the
signed intent locally and returns `transfer_v2_unavailable`. After activation,
it submits those exact authorizations as a named move. Dry-run never signs or
sends and reports whether submission is supported. Keep the same action ID and
journal; stale or expired unsent authorizations remain saved and are refused.
V2 transfer moves need no sender TNK. A receipt is not batch acceptance. See
[the transfer arguments and recovery behavior](docs/ACTIONS.md#unit-transfers-on-v2).
Legacy transaction status remains inspectable. TAP payment fees and Bitcoin
miner fees are separate from free game moves.

The local dashboard's My agent page has **Send units on Trac** and **Your Trac
address**. Pick units by name from the agent's available balances, or paste one
line per send (`trac1… address, unit name, amount`). Every row is checked before
signing, then one transfer per recipient (up to 16 units each) runs through this
same `transfer` action with an action ID saved first. Progress shows sent to the
gateway, then confirmed in a batch; Retry reuses the saved IDs. These units move
on Trac, not as Bitcoin or TAP tokens.

**Craft a compound** on the same page lists the agent's `p2`/`c2` units by name
with charge, spectrum and generation. At the compound upgrade activation,
imported pattern units such as florite's `p0` become craftable too. Choose two or more ingredients, amounts and Fusion or
Resonance (offered only for equal charges). The result is the gateway's craft
preview verified against the accepted catalog, exactly as the `craft` action
verifies it, and nothing is signed until you confirm. Warnings name claimed
blocks whose mint needs the units you would use. Confirm runs the `craft`
action with an action ID saved first; Retry reuses it. **Your compounds** lists
each compound with its recipe and offers Refine (`refine_compound`) while its
exact tier is still open.

## Fund and send TNK

Your `address` result (`trac1…`) is also your TNK account address. Fund it by
sending TNK there from any Trac wallet. V2 game moves need **0 TNK**; native TNK
sends pay the MSB transfer fee. TAP fees, Bitcoin fees and matter units are separate.

From kit/, read `node bin/dmw.mjs read tnk_balance --config /absolute/player.json`
for the address, balance and current fee. To send out, put
`{"actionId":"send-tnk-01","to":"RECIPIENT_TRAC_ADDRESS","amount":"1.25"}`
in a JSON file, replacing the recipient with its checksum-valid address:

```sh
node bin/dmw.mjs action tnk_transfer /absolute/tnk-send.json --config /absolute/player.json
```

This previews without signing. Add `--live` for an authorized send. Amounts are
decimal TNK strings with at most 18 fractional digits; `"max"` sends balance
minus fee. Self-transfers are refused. Sending requires three connected
validators. Preserve the action ID and journal: retries resend the exact saved
packet. Check `transaction_status {tx}` or `tnk_transfer_status {actionId}` for
`confirmed`, `pending` or `unknown`. See [TNK actions and library API](docs/ACTIONS.md#native-tnk-transfers).

The local dashboard's My agent page shows the same in **TNK (Trac network gas)**:
balance, the network fee per send and the agent's `trac1…` address to fund it.
**Send TNK** sends to one recipient: Max is balance minus fee, the review names
amount and fee before anything is signed, and **Recent TNK sends** shows pending,
then confirmed. Each send saves its action ID first; Retry reuses it, so the same
signed transfer is sent again and never signed twice.

## Connect your agent

Use absolute paths, replacing `/abs/kit` and `/abs/player/mainnet.json` with the
CLI and config paths printed by setup. The child must use Node 24.22.1 or newer 24.x. Passwords
are never tool arguments or config values. For an MCP client without a terminal,
enter the password privately in the shell that launches that client; for example
in Bash:

```bash
read -r -s -p 'DMW signer password: ' DMW_SIGNER_PASSWORD; printf '\n'
export DMW_SIGNER_PASSWORD
```

Launch the client from that shell, then `unset DMW_SIGNER_PASSWORD` when done.
Do not put the password itself in MCP JSON, TOML, command flags or shell history.
MCP never reads passwords from its protocol stream.

For a local stdio MCP client, configure inherited `DMW_SIGNER_PASSWORD` through
that client's secure environment mechanism and use:

```json
{
  "mcpServers": {
    "dmw": {
      "command": "node",
      "args": ["/abs/kit/bin/dmw.mjs", "mcp", "--config", "/abs/player/mainnet.json"]
    }
  }
}
```

These configurations are dry-run. When the owner authorizes real moves, append
`"--live"` to the argument array, reconnect,
and verify `address.dryRun` is false. Begin by asking the agent to read `rules`,
`address`, `status`, `world` and `hunting`. A GUI client must actually pass the
password to its child; shell inheritance is not automatic for an already running
GUI app. Increase its tool timeout to 180 seconds for the first Trac sync.

## Pin the public release at launch

After launch has generated **public** `kit-public.json` and `deployment.json`,
the operator runs this one offline command from the repository root:

```sh
node kit/bin/pin-mainnet.mjs --public /var/lib/dmw/gateway/launch/kit-public.json --deployment /var/lib/dmw/gateway/deployment.json
```

It validates and writes `kit/networks/mainnet.json`. Review and commit that file
into the player release before distributing it, then run
`node kit/bin/dmw.mjs preflight --network mainnet`. The generated values are the
gateway Ed25519 key, five receipt-signer identities, DMW subnet bootstrap,
admin and committee public keys, and the exact launch Bitcoin checkpoint.
No private file or credential enters the public profile. Players compare their
copied config against this repository file on every launch. A mismatching or
unfilled config fails; the gateway cannot replace the trust pins.

## Playground

From the repository root (`digital-matter-world/`, the parent of `kit/`), use the running local playground:

```sh
node playground/kit.mjs read address
node playground/kit.mjs read patterns --limit 2
node playground/kit.mjs mcp --player my-session
node playground/kit.mjs once --player my-session --live
node playground/kit.mjs read hunting --player my-session
```

**Each invocation gets a fresh key and empty journal unless you select a player.**
The helper prints its generated player name to stderr; reuse it with
`--player NAME`, or choose a name yourself. A single MCP session keeps the same
key across calls. Named players retain their encrypted key and journal across
runs. You can also select your own signer with `--directory` (and its password
through `DMW_SIGNER_PASSWORD` when required). The console owner's key is never
selected implicitly. A fresh key starts with no matter and no TNK funding.

`--live` is allowed on these local test chains. Omit it for dry-run. A live free
claim/discovery/craft needs no TNK; a direct transfer on a legacy network needs
the new player's own MSB account funded. V2 transfers need no sender TNK and submit only after their settings activation. The helper supplies the local network configuration, independently
configured witness keys, adapter and verified regtest history. It does not start,
restart or wipe the playground. MCP stdout contains only protocol messages.

## Reads: MCP, CLI and SDK

| Question | MCP / CLI read | SDK |
|---|---|---|
| How to play, my address, pending local work? | `rules`, `address`, `status`, `hunting` | `agent.status()`, `agent.hunting()` |
| Network clock and fees? | `public_status` | `service.publicStatus()` |
| Historic plots and block details? | `world`, `block` | `service.blocks()`, `agent.block(height)` |
| Catalog and matching blocks? | `patterns`, `pattern_matches`, `compounds` | `service.patterns()`, `service.readPage(route)`, `service.compounds()` |
| Attribution and receipt publications? | `finds`, `receipts` | `service.finds()`, `service.receipts()` |
| Registered tickers for one asset? | `asset_tickers` | `service.assetTickers(asset, page)` |
| Eligible slots, quotes and mint progress? | `mint_rights`, `mint_quote`, `mint_status` | `agent.mintRights()`, `agent.mintQuote(args)`, `agent.mintStatus(id)` |
| Changes since my last sequence? | `events`, `event` | `agent.events(options)`, `service.event(sequence)` |
| Results, payouts, treasury and burn? | `results` | `agent.results(options)` |
| Agent activity, balances and Bitmaps? | `agents`, `agent_profile`, `balance` | `agent.agents()`, `agent.profile(owner, options)`, `agent.balance(asset)` |
| Transfer progress? | `transaction_status` | `agent.trac.transactionStatus(tx)` |
| Discovery/craft/mint suggestions and replay? | `search_patterns`, `compound_idea`, `mint_idea`, `backtest` | Shared tool registry / strategy helpers |
| The rest of a preview? | `read_page` | `service.readPage(route, options)` |

The CLI and MCP share one registry for every tool, including suggestions and
backtest. Run `read TOOL` for reads and `action TOOL` for actions. Unknown names
list valid tools. From `kit/`, read names and typed arguments include
`read address`, `read rules` and `read status`:

```sh
node bin/dmw.mjs read world --config /absolute/path/local-config.json --limit 20
node bin/dmw.mjs read block /absolute/path/block-read.json --config /absolute/path/local-config.json
node bin/dmw.mjs read events /absolute/path/event-read.json --config /absolute/path/local-config.json --cursor TOKEN
```

`block-read.json`: `{"height":123,"collection":"draws","limit":10}`.
`event-read.json`: `{"since":42,"filters":{"category":"chain"}}`.
Use explicit small `limit` values with `cursor`, `sort`, `order` and `filters`.
General schemas accept up to 200; claimed-block tools cap at 50 and server work
budgets may clamp other limits. Follow `collections` or `pages` links with
`read_page`, retaining filters/order and sending `next`/`nextCursor` as `cursor`
until null. Continue empty pages with a cursor. `total:null` means unknown. Full route, field and filter tables are
in [READS.md](docs/READS.md). Catalog loading traverses all `/patterns` pages.

Public SDK reads need neither wallet nor adapter:

```js
import { ServiceClient } from './lib/index.mjs';
const service = new ServiceClient({ origin: 'https://dmtworld.tap-protocol.com', mode: 'mainnet' });
const first = await service.events({ since: 42, limit: 20 });
if (first.next) await service.events({ since: 42, limit: 20, cursor: first.next });
const detail = await service.block('973603');
console.log(detail.header.hash); // Block-list rows do not carry a hash.
```

## Local signer setup

Use Node 24.22.1 and the installed workspace dependencies. From `kit/`:

```sh
npm ci
node bin/dmw.mjs init
node bin/dmw.mjs address
```

The CLI privately prompts for a password of at least 12 characters. `import`
privately prompts for recovery words. For unattended launch use
`DMW_SIGNER_PASSWORD` and, for import only, `DMW_SIGNER_MNEMONIC` in the local
process environment. Never put these in arguments, tools, strategy code or logs.
The default private signer directory is `~/.dmw-signer`; `--directory` or
`DMW_SIGNER_DIRECTORY` selects another. Back up the encrypted keyring and its
journal, and retain the password. Encryption uses scrypt and AES-256-GCM;
secret byte buffers are cleared at shutdown, while JavaScript strings cannot
be reliably erased.

For custom **local test adapters**, use an absolute trusted JSON config. Public
players use setup above, which copies and checks the complete mainnet profile:

| Field | Meaning |
|---|---|
| `localOnly` | Must be `true` for custom local adapters; omitted in pinned mainnet setup |
| `network` | Exact contract network ID |
| `gateway` | Local: loopback HTTP origin without credentials. Mainnet: exactly `https://dmtworld.tap-protocol.com` |
| `gatewayKey` | Independently obtained gateway Ed25519 key, 64 lowercase hex |
| `receiptSigners` | Five independently pinned `{id,identity}` members; never trust a gateway-supplied roster |
| `adapter` | Absolute trusted module for local tests only; mainnet uses the built-in runtime |
| `headers` | Optional discovery-cache filename; mainnet defaults to `headers.bin` in the signer directory |
| `headerSource` | Mainnet pins `https://dmtworld.tap-protocol.com`; custom local adapters may supply their own header source |
| `headerManifestTrust` | Optional trusted network-profile key/epoch list for operator manifest rotation; defaults to the pinned gateway key at epoch `0` |
| `headerChunkLimits` | Local chunk bytes, tree-node bytes and bounded cleanup work |
| `headerHTTPSettings` | Local response-byte, retry, backoff and HTTP timeout budgets |
| `headerCookie` | Optional private local Bitcoin cookie; selects the read-only regtest RPC reader |
| `puzzleBits` | Default 12; local playground uses 0 |
| `powLimitBits` | Default 486604799; regtest 545259519 |
| `paymentOrigin` | Local payment origin, or the pinned production origin; defaults to gateway |
| `bitcoinNetwork` | `mainnet` or `regtest`; defaults from `powLimitBits` |
| `owner` | Owner-set `{receiver:{bitcoin,ethereum},payer:{tap,ethereum}}`; agents may read but never edit this block |
| `strategy` | Optional absolute trusted strategy module |

Read `address.owner` for these public wallet addresses. Mint defaults to
`receiver.bitcoin` on both payment rails and the selected `payer` rail;
link default to `payer.tap`. The playground writes these defaults for
each player from its local test wallet, preserving owner overrides. This is
separate from payout bindings. Use `bind_payout_wallet` to request a binding,
then let the human prove wallet control on its local signing page. Read current
proofs and history with `payout_binding`. The playground binds local test wallets
through the same API and preserves later human replacements.

The adapter exports `create({wallet,network,localOnly,config,service,dryRun})` and returns
`{trac,history?,source?,candidates?,compounds?,close?}`. Construct the bounded
`ServiceClient` **before** creating an adapter that installs global HTTP hooks;
the CLI does this. The service client validates loopback origins for local mode and the exact
allow-listed HTTPS origin for mainnet, along with route, response size and
deadline, and refuses redirects. The wallet stays local.

`candidates(asset,{block?,kind?})` returns fresh candidate data with
`{found,void,minted,pending,time,find,link,currentHolder}`. `time` is Unix seconds.
`find` includes `{asset,block,count,finder,findHeight}` and is required for minting.
General selection traverses all rights pages. Explicit blocks use direct lookup
and verify live context. `compounds()` returns registered type records.

During the finder's week only the finder mints; afterwards any agent can.
Bitmap holders earn 15% of every mint on their plot. The finder week starts at
settlement, and agents need enough units to mint. Mint from the kit or local dashboard
by spending the exact find count in units. Under the current settings, claims never
close: an agent may claim any untaken (block, pattern) pair at any time. A winning
public TAP Wallet mint takes the pair on Trac too; `public_minted` means the agent
should choose another block. Historical settings retain their original rules.

Blocks nobody claims within their first week can then be minted on the website with TAP Wallet, without an agent.
No agent, Trac key or units are required for a public mint. Quotes reserve nothing. The first
complete confirmed TAP payment wins by Bitcoin block and transaction position;
other payments are recorded for refund. Linked and unlinked public blocks are open to any TAP Wallet. Found and already minted blocks are excluded
from public offers. Historical settings retain their original rules.

## Actions and MCP

```sh
node bin/dmw.mjs once --config /absolute/path/local-config.json
node bin/dmw.mjs action mint_on_chain /absolute/path/mint-args.json --config /absolute/path/local-config.json --live
node bin/dmw.mjs mcp --config /absolute/path/local-config.json
```

Actions default to dry-run. Only the launch's `--live` enables sends; MCP cannot
change it. Calls queue and wait for local pacing. See [ACTIONS.md](docs/ACTIONS.md)
for action JSON, stable IDs, proof lookup, payment addresses, status states and
error meanings. Mint payments and inscriptions use the player’s wallet; the service
issues permits and watches the indexer.
Dry-runs omit paymentLink. A live payment URL alone proves neither payment nor page availability.

## Player-paid mints

Activated v2 mints use two journaled signatures: the mint request and its exact
account reservation. After a lost response, retry the same action ID. Wait for
`payable:true` before explicitly paying. See the v2 financial section in
[ACTIONS.md](docs/ACTIONS.md) for confirmation and recovery behavior.

Before your first quote, bind a payout wallet with `bind_payout_wallet` and
complete the wallet signature on its returned `bindingLink`. Confirm the binding
with `payout_binding {rail:"tap"}`. Bind Ethereum independently if needed.
Your profile is `https://dmtworld.tap-protocol.com/agents/<address>` using the `trac1…`
address returned by `address`.

`bitcoin_wallet` reads the local BIP86 Taproot address derived from the same
**encrypted** local recovery words. Its Bitcoin key is separate from the Trac
signing key and never leaves the process. Fund that address with cardinal BTC
and TAP. The payer/receiver for local inscription must be that player's Bitcoin
address. Payout bindings can designate a different wallet you control.

The optional local config `bitcoin` block contains only public values:

```json
{
  "authority": "TOKEN_AUTHORITY_INSCRIPTION_ID",
  "funding": [{"txid":"CONFIRMED_CARDINAL_FUNDING_TXID","vout":0}]
}
```

Replace the placeholders with this wallet's indexed, active token authority and
explicitly selected cardinal BTC outputs. Mainnet reads and broadcasts use the
public mempool API; the kit checks each selected output's script, amount and
spent status before signing. Do not list outputs carrying inscriptions, runes
or other assets. The kit reuses confirmed cardinal change from its saved player
commit transactions; preserve the journal so it can recover that provenance.
The keyring and journal stay private. No wallet secret belongs in config or tool
arguments. A trusted regtest adapter may provide `bitcoinSource`; a loopback
mempool-shaped fixture can be selected with `bitcoin.origin` in local test config.

The flow is:

1. `mint_on_chain` reserves units and obtains the quote with a stable action ID.
2. `pay_mint {id,maxFeeSats,feeRate?}` reads `GET /mint/<id>` and pays only its
   missing items with a locally signed token-auth redeem. Amounts stay exact. Any share owed to the payer stays in their wallet and is
   omitted from `fees`; `fullFees` shows the original split.
3. `poll_mint {id,timeoutMs?}` waits up to 120 seconds. When payment is final,
   the committee issues the permit. Official mints consume the reserved units;
   after independent-supply activation, additional tickers keep them held until
   verified mint completion or refund.
4. `inscribe_mint {id,maxFeeSats,feeRate?}` builds the commit/reveal to
   the player's address.
5. Poll again until the **indexer**, not the broadcast response, reports `minted`.

For a pattern's first mint, a quote returns `deployment_needed`, `payable:false`
and the current deployment plan. No mint payment or reservation exists yet.
The answer also carries a `deploymentLink` to the public `/mint/ASSET?owner=AGENT`
page, where the owner can inscribe the pattern and deploy the token with TAP Wallet
instead. Imported patterns keep their ledger asset (dmwflorite: p0, listed as p2:0).
The first minter uses `inscribe_deployment {asset,maxFeeSats,feeRate?}` from their
bound local Bitcoin wallet. First it inscribes the supplied element text; an
existing indexed element with the same `(pat,fld)` is reused. Once included in a block, repeat the action to register that phase and fetch the exact
`dmt-deploy` JSON with its indexed element ID, allocated ticker and committee
privilege authority. Repeat for the deployment, then request the mint quote.
Occupied names and tickers receive allocated replacements. Keep the same wallet
and journal across retries; each phase has its own durable attempt.

A compound's first maker uses the same action for its `token-deploy`. TAP Wallet
in the console supports both pattern phases and compound deployments. Register
an existing inscription with `register_deployment {asset,phase,inscription}`;
`phase` is `element` or `deployment`. Registration sends no Bitcoin transaction.
The service verifies indexed content, confirmations, receiver and authority
before any mint permit can be issued. All inscriptions remain player-funded;
the kit defaults to dry-run.

CLI and MCP share these tools. For example, `mint-pay.json` contains
`{"id":"REQUEST_ID","maxFeeSats":"10000"}`:

```sh
node bin/dmw.mjs read bitcoin_wallet --config /absolute/player.json
node bin/dmw.mjs action pay_mint /absolute/mint-pay.json --config /absolute/player.json
node bin/dmw.mjs action inscribe_mint /absolute/mint-pay.json --config /absolute/player.json
```

These commands are dry-run. Add `--live` only for the authorized live launch.
Omitting `feeRate` reads the public mempool estimate. `maxFeeSats` caps the total
miner fees for that commit/reveal; postage remains in the player's inscription.
The browser shows the fee rate, total miner fees and postage for confirmation.
The player also pays Ethereum deposit/release gas when using that rail, and
still needs the Bitcoin wallet and BTC to inscribe. The console's Ethereum option
uses the existing escrow checkout: its Ethereum wallet approves the quoted
amount, deposits it, and submits the committee-authorized release. Each step
saves its transaction ID; an interrupted wallet reply never triggers a fresh send.
The kit's `pay_mint` handles TAP; Ethereum deposits/releases use the owner's
Ethereum wallet, after which `inscribe_mint` works with the issued permit.

Keep the journal: the kit saves both signed transactions before broadcasting;
a retry rebroadcasts their exact bytes. It does not make a second payment while
an earlier payment's outcome is uncertain. Browser payment attempts are saved
before calling `singleTxTransfer`; an uncertain extension reply requires wallet
and indexer reconciliation, never another automatic send. Browser inscriptions
save a signed reveal before wallet approval and the signed commit before sending.
Keep that browser profile until the request is indexed. Do not pay the same
request from multiple wallets or independent journals.

TAP Wallet 1.0.48 needs an active global authority for payments. If none exists,
the browser requests an authority covering all TAP tokens, waits for its
inscription, and asks for a separate activation self-send. Review both Bitcoin
fees and the global scope in TAP Wallet. Future payments still require approval.
An existing setup in the wallet must be completed there before continuing.
Ordinary cancellation or popup closure can happen after funding was sent, so
an uncertain attempt remains saved. The specific “No authority found” response
occurs before payment and allows another authority check.

In 1.0.48 a pending action order can fail to load because the wallet queries a
different service from the one that created it. Keep the saved order and resume
after the wallet's order lookup is fixed; do not pay for a replacement order.
Ledger accounts can sign payout bindings, but this release cannot sign TAP
authority/redeem payloads and can return an unsigned inscription PSBT. The
browser refuses that PSBT before broadcasting.

On Bitcoin mainnet the TAP burn share is sent to the unspendable
`1BitcoinEaterAddressDontSendf59kuE` as a `tt:"a"` item (test networks use the
same key hash in their own address encoding). Use the exact quoted
address and amount; it is still burned. Ethereum uses the escrow token's burn
function. Do not invent or substitute a burn recipient.
These address fee items work with TAP Wallet 1.0.48 and ord-tap. Native burn
allocations work in lock actions; ordinary redeem items do not encode them.
Native lock allocations use ord-tap's fixed burn marker on every network;
address-transfer items use the Bitcoin network's address encoding above.
The client stops a quote explicitly requiring a native burn item instead of
substituting a different payment.

Payment precedes the permit. Paid fees are not refunded by us. A permit has no
expiry; its Trac units have either been consumed for the official ticker or
remain held for an additional ticker until verified mint completion. A new quote does not
justify spending units reserved by an unresolved earlier request.

Build the checked-in browser module with `npm run build:player-wallet`. Run
`npm run test:player-bitcoin` for the isolated kit/browser/indexer proof; it uses
ports 59730–59732, CDP 9481, a shared browser lock, and only disposable processes.

## Strategy and replay

Edit [strategies/default.mjs](strategies/default.mjs), or select a trusted module
with `--strategy`. Its four functions are `chooseClaims`, `searchPatterns`,
`chooseCompound` and `chooseMint`. Keep them deterministic and free of network
access. Core validation, signer and journal stay in `lib/`; strategies are trusted
JavaScript, not a security sandbox. Read [AGENTS.md](AGENTS.md) before editing.

`chooseClaims` receives `{history,patterns,owner,taken,claimsPerWindow,claimableHeight,window}`
and returns `[{block,patterns:[patternNumber,...]}]`, sorted by block and pattern.
`taken` maps each pattern number to a Set of found or minted block heights, loaded
by the caller from the paged public index. `history` is local header history.
The default hunts the rarest pattern across history, filling the window budget
before moving to the next pattern. Claims use `{window,plots,header?}` with at
most 1,000 slots, with a default budget of 100. The kit validates the complete bundle before signing.
The tip header enters only that tip's unclaimed-pattern draws. `hunting` tracks
historic claims and observed header wins without finalizing sparse projections
as losses. Discovery follows accepted `settings.values` (including
`minMatchingBlocks` and `occurrencePageSize`); v2 allows constant counts and checks
canonical-definition uniqueness. Public known counts are lower bounds. Compound
suggestions require an authenticated v2 preview to determine the output identity;
legacy rarity formulas do not produce valid v2 compounds. Mint choices require a find.

```sh
node bin/dmw.mjs download --output /absolute/build/path/headers.bin
node bin/dmw.mjs verify-history --headers /absolute/build/path/headers.bin
node bin/dmw.mjs backtest --headers /absolute/build/path/headers.bin --start 100 --end 500
```

Downloads verify genesis, proof of work, linkage, retargets and median time, resume
a `.part` file and cross-check the tip with an independent source. The default
source is the gateway's signed immutable chunk tree; no block metadata crawl is needed.
Discovery needs a snapshot reaching the exact current tip. Mainnet MCP updates
it automatically. Custom local adapters that supply a fixed `history` still need
a fresh snapshot when their tip changes.

The current backtest engine supports legacy fixtures only and rejects v2 settings
or named catalogs. V2 replay requires accepted catalog and claim-state snapshots,
including deferred header awards. Do not interpret a legacy run as v2 earnings.
Legacy backtests make no sends or payments. They exclude future headers and later catalog
entries, leave the last two windows unsettled and record snapshot, catalogIds,
settings and opponents. They model all-history claims, excluding earlier finds.
The CLI defaults to an empty catalog; use `--patterns FILE` for an
accepted catalog with discovery heights. Without opponent strategies this is a
single-agent experiment, not an earnings forecast; TAP fees and TNK fees are
not modeled.

## Checks

`npm test` runs short kit tests with disposable keys and local fixture gateways.
Optional `test:devnet`, `test:bitcoin` and `test:history` scripts exercise a local
Trac network, an isolated Bitcoin regtest node and a supplied verified archive.
They require their respective local dependencies. No test uses mainnet funds.

Use one Trac identity everywhere: the lowercase, checksum-valid `trac1…` address.
The kit `address` tool returns `address` (also the TNK account address). Transfer
recipients, profile routes and identity filters reject raw hex keys. Internal
signed packets and storage retain the protocol key encoding.


Local matching-block pages: `search_patterns` now includes `searchSnapshot`,
`localMatchCount`, real `matches` (decimal height/count and canonical hash),
`localResultId`, and `nextCursor` for each accepted local candidate. Continue with
`pattern_search_matches` using the same proposal and cursor (page size 1 through the accepted
`occurrencePageSize`; that setting also supplies the default). Cursors retain the original snapshot across restarts and later
headers, and refuse a replaced canonical snapshot. These are local search
results, not finds or an exhaustive server catalog. The existing action journal,
salts and signed packets are preserved. When an accepted activation manifest
selects v2, the kit uses signed named-evidence moves and pinned commitment
settings. Its independent notary/proof adapter must support that version;
otherwise it refuses with upgrade_required. Never treat a gateway receipt as
accepted batch inclusion. General saved-v2-move status reconciliation currently
reports an unavailable batch verifier and preserves the packet.

## Copyable discovery prompt

> Work alone. Do not start other agents or workflows. Use my installed DMW kit
> and verified local Bitcoin headers to search for valid patterns and return
> actual matching heights. Read the current rules and budgets first. Save the
> snapshot and stable action IDs. Follow existing send/payment authorization.
> Commit and reveal with the required matching-block evidence, then claim
> eligible named slots within each window's allowance. Keep unresolved actions
> intact, verify accepted receipts/batches, and explain required kit updates.
> Claimed-block lists are submitted evidence, not all matches in history.

For activated v2 crafting, call `craft` with a stable action ID and named
`p2:`/`c2:` inputs (also authenticated legacy pattern keys after the compound
upgrade activation). The kit verifies the exact recipe preview against the accepted
catalog, saves the signed spend and resumes the same packet after a timeout.
Accepted batches debit ingredients, credit proportional output and consume the
nonce atomically. Compound properties retain their input revisions and canonical
snapshot from the first craft. After the compound upgrade, the recipe and reduced
canonical input ratio determine identity; later crafts add units to that same
asset. If exact tier comparison is still pending, `refine_compound` continues
bounded work from its accepted cursor; it never spends matter or changes the
compound identity. See [ACTIONS.md](docs/ACTIONS.md#crafting-with-activated-v2-rules).


V2 public evidence tools: `claimed_blocks({asset:"p2:0",limit:20})` pages
verified submitted matching blocks. `pattern_matches` selects this route for
v2 asset IDs. `submit_bitmap({block:HEIGHT,inscription:OPTIONAL_ID})` asks the
service to verify one named Bitmap and its current agent binding. It never
subscribes to wallet history; inventory completeness is `submitted_items_only`.
`claimed_blocks` and `window_eligibility` are GET reads. `submit_bitmap` is an
action: its dry-run returns `sent:false`; a live call submits evidence even though
it needs no wallet signing or payment. Mint admission independently
rechecks the named ownership evidence. Follow `next` / `nextCursor` even when
an indexed work page is empty; `total:null` means no exact total was computed.

After coordinated multi-ticker activation, `dmw deploy-ticker ASSET TICKER --config FILE` previews an additional ticker. Use `--live` to prepare it and review the fee; `deploy_ticker` and `report_ticker_payment` expose the same actions through MCP. Pattern and compound mints accept an optional deployment choice, defaulting to official. After independent-supply activation, each pattern or compound ticker has its own full supply. Each pattern block can be minted once into each ticker; each compound ticker is capped by the total units ever produced of that compound. Additional tickers hold units and release them on verified completion or refund. Full workflow and refund funding: [docs/ACTIONS.md](docs/ACTIONS.md#additional-tap-tickers).
