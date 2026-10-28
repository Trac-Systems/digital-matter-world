# Frozen v1 verifier

These files are copied byte-for-byte from commit `113b269`. `manifest.json`
pins their SHA-256 hashes, including the contract's canonical JSON/signing
dependency. They replay accepted v1 envelopes and v4 observations under their
historical rules. Policy changes belong in a new ruleset, never in this copy.

The legacy limits are intentional historical semantics. This directory is not
an admission policy for the new named-discovery engine.
