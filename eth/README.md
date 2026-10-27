# Local bridged TAP

The immutable TAP payment contract, signing formats, states, update risks and
local end-to-end proof are documented in [TAP escrow](docs/ESCROW.md).

`LocalTap` uses OpenZeppelin Contracts **5.4.0** `ERC20`, `ERC20Burnable` and
`AccessControl`. It has 18 decimals, name `Tap Protocol`, symbol `TAP`, and a
`MINTER_ROLE`. Transfers have no fee, pause or blacklist. The constructor grants
the deployer admin and mint roles. The local token is a direct deployment, not
an EIP-1167 clone; its token behavior is the stand-in used for local testing.

`../local/setup` installs the pinned dependency and prepares Solidity **0.8.26**.
`../local/up` starts Anvil in memory, deploys the token and mints one million TAP
to each of its first three disposable accounts. The run manifest records the
address. Build outputs and compiler cache live under the shared build target.

```sh
forge test
```

The Foundry deployment script can also deploy to an already running local chain:

```sh
forge script script/Deploy.s.sol:Deploy --sig 'run(address,address)' \
  "$LOCAL_ADMIN" "$LOCAL_RECIPIENT" \
  --rpc-url http://127.0.0.1:58545 --unlocked --sender "$LOCAL_ADMIN" --broadcast
```

Use two addresses from the local manifest. The script refuses any chain ID other
than 31337. It gives those two accounts one million TAP each. No private key is
needed because the local Anvil accounts are unlocked.
