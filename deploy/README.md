# Deployment and development tools

This directory contains deployment APIs, configuration examples and tests for
Digital Matter World. The examples describe supported layouts for a new
installation. Replace their paths, domains and budgets for your environment.
Keep completed inputs and credentials outside the checkout.

- [Production launch](PRODUCTION.md): inputs, phase ordering and recovery.
- [Input template](inputs/mainnet-inputs.template.json) and [target schema](targets/schema.json).
- [Payment protocol](PAYMENTS.md): player payments, mint permits and indexing.
- [Server examples](servers/README.md): service units, proxy routes and backups.
- [Validation](VALIDATION.md) and [local verification](REHEARSAL.md).
- [Launch inscriptions](LAUNCH-INSCRIPTIONS.md) and [launch inputs](LAUNCH.md).
- [Contract operation](../contract/docs/OPERATION.md): clock, custody and settlement.

Launch commands can submit transactions when executed with completed inputs.
Keep the original journal and transaction identities when resuming an interrupted
launch. Preparation does not grant admission; validate the configured services
before accepting new requests.
