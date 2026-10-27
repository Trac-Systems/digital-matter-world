# Production committee reads

Configure `reads.mjs` as the signer reader module and pass the absolute private
production configuration path. `createReads({config,readerId,gateway})` verifies
production settings, uses the configured single ord + ord-tap source and opens a
separate durable observer/index directory for each signer. It does not import or
load the gateway's transaction-signing secrets.

See [the production adapter configuration and limitations](../../service/prod/README.md).
Tests run with `node --test committee/prod/test/*.test.mjs`; the combined offline
suite is documented in that guide. Local HTTP stand-ins are used only in tests;
production source credentials and header verification remain mandatory. Bitcoin
headers, blocks, raw transactions and inclusion all come from ord HTTP; no
committee process connects to Bitcoin Core.
