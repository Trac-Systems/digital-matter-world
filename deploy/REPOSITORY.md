# Public source exports

The public tree contains the rules, contracts, service, committee, player kit,
local development tools, playground, deployment tools, tests and documentation.
The Playbay game is maintained separately.

Keep credentials, endpoint files, wallet stores, signer shares, registries,
generated configuration, logs and runtime data outside the public tree. Ignore
rules do not remove files already tracked by Git. Inspect the tracked inventory
and the exported bytes before release.

The checked-in regtest target is an empty template. `refresh-regtest.mjs` writes
an ignored local target and private endpoint snapshots; publish the template
only. Mainnet connection files and completed deployment worksheets remain
private. Public player profiles contain only reviewed deployment identities and
chain pins.

## Inspect an export

Run `node deploy/squash-release.mjs --dry-run --output /absolute/private/new-tree`
from the repository root. The destination must be new and outside checkouts.
The script copies the public allowlist, rejects private/runtime files, machine
paths, provider hostnames and symlinks, and runs the repository's secret scanner.
It includes working-tree changes and writes a file/hash inventory beside the
review tree. It does not initialize a repository or publish anything.

For a release tied to a committed revision, use `git archive REVISION` into a new
directory. Inspect that exact tree and run `gitleaks detect --no-git --redact
--source DIRECTORY`. Check file names, local paths, endpoint hosts and generated
data as well as scanner results. Never suppress a credential finding to pass a
release check.

Create a new repository in the clean directory with one initial commit. Check
the author and committer, committed inventory and secret scan of that history.
Record the source revision and exported commit with the deployment records.
Only publish the reviewed commit to the intended public repository.
