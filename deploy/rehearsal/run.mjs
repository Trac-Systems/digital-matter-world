#!/usr/bin/env node
// Same executable scenario: terminal import, activation, real signers, proofs,
// conservation and isolated old-state rollback. No independent mock success path.
if (!process.argv.includes('--smoke')) process.argv.push('--smoke');
await import('../../service/load/run.mjs');
