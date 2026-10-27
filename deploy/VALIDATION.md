# Deployment validation

Use Node 23.11.0 and the checked-in dependency locks. Run the rules, contract,
kit and service suites as described in the [repository README](../README.md).
Then run the deployment and production adapter suites:

```sh
nice -n 20 node --test deploy/*.test.mjs service/prod/test/*.test.mjs
nice -n 20 python3 -m unittest discover -s deploy/servers -p 'test_*.py'
```

These tests use generated inputs and local fixtures. They cover exact transaction
admission, cumulative budgets, identity pins, runtime configuration, public
evidence, publication receipts and recovery. They do not connect to production
providers or submit mainnet transactions.

`deploy/rehearsal-tls.mjs` exercises six production readers, five signer services,
threshold sidecars and the player kit with a disposable certificate authority.
Build the Go sidecar first and set `DMW_BUILD_ROOT` to a private build directory.
The rehearsal uses fixture chain sources, allocates its own run directory and
stops its processes. Use [REHEARSAL.md](REHEARSAL.md) for real local-chain flows.

## Public admission

On the deployment host, validate provider responses and chain identities, DNS,
TLS, proxy routes and account permissions. Exercise systemd startup, reboot
and backup restoration on an isolated disposable host. Check the production
checkpoint and public pins independently.
Verify current funds and fees before executing transactions. A local fixture
result does not establish provider or mainnet behavior. Open admission only
after the configured installation passes its checks. Maintain a way to close
new requests while preserving journals, paid requests and issued permits.

Evidence snapshots accept at most 4,095 rows and 8 MB, with individual audits
limited to 200 KB. Size the deployment within these bounds. A larger history
requires a scoped or paginated evidence implementation before admission.

Publication verification accepts direct contracts and EIP-1167 or EIP-1967 token
proxies, with IPFS metadata up to 256 KiB. Other formats are refused. Compiler
and runtime identity checks are separate from review of token behavior and
governance.

For restart checks, compare registry and state hashes, deployment identities,
escrow code and deployment-sender nonce before and after restarting only the
isolated test stack. Retain the stack's original checkpoint and journal.
