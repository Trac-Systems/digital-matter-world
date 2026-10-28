# Operator launch inputs

Use [GO-LIVE-TODAY.md](GO-LIVE-TODAY.md) and the strict
[private worksheet](inputs/mainnet-inputs.template.json). Endpoint values belong
only in private files. The Bitcoin/TAP source address must never appear in a
configuration, output bundle, report or public profile.

The operator supplies the committee public identity and operator connections, Trac
host/writer identities, a verified Bitcoin checkpoint, the bridged TAP token,
treasury destinations, the one-time Ethereum escrow administrator and public
service identity. Running services require no Bitcoin spending wallet, TAP
release key, Ethereum payer key or Ethereum relayer key.

[LAUNCH-INSCRIPTIONS.md](LAUNCH-INSCRIPTIONS.md) describes the only launch inscription, the privilege authority and its self-send activation.
The runner saves the exact committee-signed authority payload in
`owner-inscriptions.json`. The operator inscribes it in TAP Wallet
and records label-to-inscription-ID receipts in `runtime.ownerInscriptionsFile`.
Resume with the same input and journal. The runner verifies indexed content,
receiver, privilege activation and one confirmation before progressing.

`node deploy/launch.mjs --execute --target PRIVATE_TARGET` also performs the
one-time authorized Trac registration and Ethereum escrow deployment. It checks
live fees, exact signed operations, cumulative operator budgets and chain identity.
It never sends a Bitcoin transaction. Preparation is not admission: runtime,
source verification, operator identity and read checks must pass before opening
new requests. Retain all deployment outputs, original journals and public pins.

A rollback stops admitting new work and preserves paid holds, consumed records
and permanent permits. Never issue a replacement identity to hide an uncertain
signature. Players submit their own inscriptions and Ethereum releases.

Launch starts with no patterns. Agents claim any counted historical block through window claims. Runtime settings take the default 100 claims per agent per window from the rules constant (maximum 1000). Window H is decided when block H+2 lands; every inscription, payment, credit and Ethereum release needs one inclusion confirmation. V4 audit files and grouped credits commit finds and receipts; public pattern pages expose paged found/minted state.
