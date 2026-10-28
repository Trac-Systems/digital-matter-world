# Operator

The gateway keeps durable player deployment jobs through
`service/src/provisioning.mjs`. Configure `operator.provisioning` in the private
registry with the activated privilege inscription, authority key, treasury
destinations and `confirmations:1`. The pattern table starts empty. The first
minter inscribes each pattern element and deployment; the first maker inscribes
a compound deployment. The service returns exact content, accepts the supplied
inscription IDs and independently verifies inclusion, receiver and authority.
Collisions retain the job and allocate a new explicit attempt.

`node service/scripts/operator.mjs CONFIG status` reads status.
`node service/scripts/operator.mjs CONFIG provision [ASSET]` reconciles a job.
The gateway must be running; commands use a private filesystem inbox.
`/operator` and `/operator/status` are read-only.

Players pay the quoted recipients directly. Ethereum payers also submit the
committee-authorized escrow release and pay gas. Payment must be final before
Trac consumes the reserved units and the committee issues a permanent
receiver-bound mint permit. The player then inscribes it from their own wallet.
Retain request IDs, payment credits, fixed payout bindings and signed permits
through retries and downtime; the service does not send refunds or payouts.

## Committee replacement

`node committee/rotate.mjs CONFIG OLD_ID REPLACEMENT_JSON --dry-run` checks a
single-member change. `--execute` requires the replacement's health and unchanged
threshold public key, obtains three old-member attestations, retains every roster,
and writes the gateway configuration. For a local share replacement, include
`sharePlan: {oldGroup, newGroup, signerConfigs}` in the replacement JSON. Group
paths are directories containing `group.json`; `signerConfigs` maps each of the
five resulting service IDs to its private signer configuration. Start the five
fresh sidecars with the existing `createGroup`/`startSidecar` helpers and quiesce
gateway signing first. The command invokes the existing disjoint five-to-five
resharing protocol, proves continuity with a real threshold signature, updates
all signer configurations and preserves their historical rosters and journals.
Only one receipt/custody member changes. Internal threshold identities refresh
for all five; `tssEpoch` advances independently of the unchanged contract epoch.
Restart the signer services and gateway after the command reports success.
Retain the `.rotation.json` and sidecar decision files for interrupted-commit
recovery; distributed commit is not atomic. The ordinary mode without a share
plan requires an already provisioned replacement share.
