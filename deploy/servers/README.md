# Server installation files

These definitions are preparation artifacts. No script installs them, connects
over SSH, changes DNS, obtains certificates or starts a real service.

[GO-LIVE-TODAY.md](../GO-LIVE-TODAY.md) gives the server-console installation
commands and the annotated input worksheet. The current deployment uses one
Ubuntu host, `Caddyfile.gateway`, five local operator accounts and no operator
DNS names. `Caddyfile.operator` is an optional remote-host example.
Keep `admission.closed.caddy` installed as
`/etc/dmw/admission.caddy` until acceptance. It blocks new mutations while
allowing reads, authenticated operator evidence and payment notices for existing
mint/link requests. Gateway private-route
denial includes `/operator`, `/operator.js` and `/internal` themselves.
Keep these handlers inside `route`: [Caddy preserves their explicit order there](https://caddyserver.com/docs/caddyfile/directives/route).
Without it, automatic directive sorting can place a catch-all proxy before the denials.

Pin Node 24.22.1 at `/usr/bin/node`. Linux native database bindings also require
`libatomic1` (verified on Ubuntu 24.04). Install reviewed source at
`/opt/dmw/current`, and the reviewed sidecar at `/opt/dmw/bin/dmw-tss`.
Provision one service account and one private directory per operator on the same
host. A gateway account must not read operator share directories. Local listeners
remain on loopback: gateway 58910, headers 58912, signers 58800–58804 and sidecars
58700–58704. Only the public gateway domain needs TLS. The
gateway `/health` route remains available; `/operator/*` and `/internal/*` are
never exposed. Do not log authorization headers or request bodies.

Render `/var/lib/dmw/gateway/runtime.json` with `deploy/runtime.mjs` from the private target.
Its directories and credentials must be owned 0700/0600, outside checkouts.
The unit's writable path must contain the rendered runtime's data, contexts,
reader caches and permanent permit journal. The registry is writable only if operator
provisioning is enabled; put it inside that private tree. Set `DMW_BUILD_ROOT`
in the private environment file. Verify free space, memory, file limits and
service health before admitting users. An empty target cannot pass admission.

`dmw-trac-host.service` keeps the emitted
`/var/lib/dmw/gateway/trac/host/runtime.json` alive after the launch process
exits. Start it before the gateway. The launch and standalone admission funding
reader uses a separate `fundingDirectory`; never point it at the live writer
or host store. A completed launch resume leaves those live writers alone.

`node deploy/operator-inputs.mjs --inputs OWNED_WORKSHEET --id MEMBER` renders
one operator's public URL files and local target/reader/native-Trac references
without reading any key or contacting services. It refuses an identity change.
Run it before `configureOperator`, and again with the resolved public deployment
pins and local deployment file before `bindOperator`. Install private reader
credentials and native wallets separately on that host.

As each operator's Unix user call `provisionOperator` once, collect only public
descriptors, then call `configureOperator` with the roster and that host's
reader/listener config. It creates the sidecar configuration before any
deployment exists. Complete DKG and deployment, configure the authenticated evidence endpoint,
then call `bindOperator` with the completed target. Both configuration stages
refuse changed existing operator identity/configuration. Never gather five credentials in a shared file.
The sidecar authenticates every peer message cryptographically and binds it to
the ceremony/network. HTTPS authenticates remote servers; operator control
routes also require separate bearer credentials. Keep the public DKG decision
certificate so `recoverCommit` can finish a partially committed ceremony.

For backups, stop the affected units during an operator-selected maintenance
window, then run `backup.py create --unit UNIT --source PRIVATE_DIRECTORY
--destination NEW_BACKUP_DIRECTORY`. Include both signer and sidecar units for
an operator. Store each operator's backup under that operator's custody; use
encrypted storage with the same access restrictions. The script refuses a live
unit, symlinks, repositories or an existing destination, checks source stability,
and records every file's checksum. `restore` verifies a snapshot and requires a
new destination. Review absolute config paths before starting restored services.
No script erases live state. Test recovery on isolated local data first.

The header unit supplies the public kit's bounded header routes from the same
Bitcoin source as the gateway. It exposes no generic RPC or wallet calls.
The source's credentials remain in the gateway account. No second source is
introduced by the public header feed.

Validate the proxy routes and service-account permissions on the deployment
host. Run `systemd-analyze verify` for the unit definitions, then exercise startup,
restart and backup restoration during service setup. The TLS harness uses
fixture chain and Trac sources; it does not validate production providers.
See [VALIDATION.md](../VALIDATION.md) and [PRODUCTION.md](../PRODUCTION.md).

The public `/operator-evidence` route is intentionally proxied. It accepts only
bounded identity-signed operator challenges and returns signed public reader
evidence. It does not expose `/operator/*` management routes. Preserve this
distinction when adapting the proxy file.
