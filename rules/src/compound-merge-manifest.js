import { freezeDocument } from './settings-v2.js';

// Replace this entire manifest with the reviewed output of
// rules/scripts/compound-merge-manifest.mjs immediately before deployment.
// Rows contain { oldId, newId, holder (hex public key), amount (ledger units) }.
// Existing v3 records already describe ONE reduced-ratio unit: their original
// craft amount is in the holder balance and MUST NOT be multiplied again.
export const COMPOUND_IDENTITY_V4_MERGES = freezeDocument({
  network: "dmw-mainnet",
  ready: true,
  rows: [
    {"oldId": "c2:1bafd6097265662a5da3cd6aecd4c1df945f866038ceb85151ee96ed6227e5d5", "newId": "c2:e9f0843ea3da981ce457b38b35170e16e2448c9f93581c48c50c366013d34729", "holder": "752ecf794c3c2a044efb632624e42a259a21eba2f1b0bdbadd7bccc1b6a84939", "amount": "1"},
    {"oldId": "c2:2b91a38746504080d048ec76ed4234f22ab8555bcda7daffa925869a6d62552f", "newId": "c2:e9f0843ea3da981ce457b38b35170e16e2448c9f93581c48c50c366013d34729", "holder": "752ecf794c3c2a044efb632624e42a259a21eba2f1b0bdbadd7bccc1b6a84939", "amount": "10"}
  ]
});
