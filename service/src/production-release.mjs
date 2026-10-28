// Production activation is a conjunction of installed release, immutable
// capture-derived plan and a current independent notary read. No force flag.
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rules as r } from './rules.mjs';
import { check, hash } from './util.mjs';
import { configuredResources } from './r3-settings.mjs';
const execute = promisify(execFile);
const same = (a, b) => r.stableJSON(a) === r.stableJSON(b);
export function productionRuntimeBinding(config) {
  // The root installer reads the saved config; startup expands its pinned
  // resource document. Bind the same effective settings on both paths.
  config = configuredResources(config);
  const { releaseFile, ...v2 } = config.v2 ?? {};
  return r.hashObject({ network: config.network, data: config.data, prod: config.prod, v2,
    committee: config.committee.map(({ id, peer }) => ({ id, peer })), assetRecoveryVersion: config.assetRecoveryVersion });
}
export function validateProductionRelease({ proof, config, activation, current, deployment, revision }) {
  const plan = proof?.plan, terminal = plan?.terminal, v = deployment?.v2;
  check(proof?.version === 1 && /^[0-9a-f]{40}$/.test(revision) && plan?.revision === revision
    && proof.planHash === r.hashObject(plan) && proof.runtimeHash === productionRuntimeBinding(config), 'v2_release_plan');
  check(proof.release?.revision === revision && proof.release.oldRevision === plan.oldRevision
    && proof.release.nodeVersion === 'v24.22.1' && proof.release.platform === 'linux' && proof.release.arch === 'x64'
    && hash(proof.releaseBytes) === plan.releaseManifestSHA256 && same(JSON.parse(proof.releaseBytes), proof.release)
    && same(proof.installedAccounts, ['dmw', 'dmw-operator1', 'dmw-operator2', 'dmw-operator3', 'dmw-operator4', 'dmw-operator5']), 'v2_release_installation');
  check(plan.capture?.reconciled === true && /^[0-9a-f]{64}$/.test(plan.capture.inventoryHash)
    && /^[0-9a-f]{64}$/.test(plan.capture.sourceInventoryHash)
    && /^[0-9a-f]{64}$/.test(plan.capture.reconciliationHash) && proof.captureHash === r.hashObject(plan.capture)
    && /^[0-9a-f]{64}$/.test(plan.activation?.sha256) && proof.activationSHA256 === plan.activation.sha256, 'v2_release_capture');
  check(terminal?.notary === config.prod?.trac?.bootstrap && terminal.notary !== terminal.legacyNotary
    && terminal.manifestHash === config.v2.manifestHash && activation === terminal.manifestHash
    && terminal.effectiveBatch === config.v2.manifest.effectiveBatch
    && terminal.previousBatchRoot === config.v2.manifest.previousBatchRoot, 'v2_release_terminal');
  const observed = proof.terminalObservation;
  check(observed?.source === 'independent-notary' && observed.notary === terminal.notary && observed.manifestHash === terminal.manifestHash
    && observed.ready === true && observed.synchronized === true && observed.sendIntentsResolved === true
    && Number.isSafeInteger(observed.observedAt) && observed.observedAt > 0 && observed.observedAt <= Date.now()
    && observed.last?.n === String(BigInt(terminal.effectiveBatch) - 1n) && observed.last.root === terminal.previousBatchRoot
    && Array.isArray(observed.pendingTransactions) && !observed.pendingTransactions.length
    && observed.deploymentHash === r.hashObject(deployment), 'v2_release_terminal_observation');
  check(current?.ready === true && current.manifestHash === terminal.manifestHash
    && r.hashObject(current.manifest) === terminal.manifestHash && v?.manifestHash === terminal.manifestHash
    && same(v.manifest, config.v2.manifest) && same(v.document, config.v2.document)
    && v.receiptProtocol === 1 && config.v2.receiptProtocol === 1
    && v.gateway === config.v2.gateway && same(v.receiptSigners, config.v2.receiptSigners), 'v2_release_observation');
  check(current.last && /^(0|[1-9][0-9]*)$/.test(String(current.last.n))
    && BigInt(current.last.n) >= BigInt(terminal.effectiveBatch) - 1n, 'v2_release_notary_behind');
  return { revision, planHash: proof.planHash, manifestHash: terminal.manifestHash, notary: terminal.notary };
}
export async function requireProductionRelease({ config, store, reads }) {
  if (config.mode !== 'prod') return;
  check(config.v2?.releaseFile && typeof reads?.rulesContext === 'function' && typeof reads?.trac === 'function', 'v2_release_incomplete');
  const repo = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
  const match = /^\/opt\/dmw\/releases\/([0-9a-f]{40})\/dmw$/.exec(repo);
  check(match && config.v2.releaseFile === repo + '/cutover-binding.json', 'v2_release_location');
  let fd;
  try {
    check(await realpath(config.v2.releaseFile) === config.v2.releaseFile, 'v2_release_file');
    fd = await open(config.v2.releaseFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const s = await fd.stat();
    check(s.isFile() && s.uid === 0 && !(s.mode & 0o022) && s.size <= 4_000_000, 'v2_release_file');
    const proof = JSON.parse(await fd.readFile('utf8'));
    const git = async (...args) => (await execute('git', ['-c', 'safe.directory=' + repo, '-C', repo, ...args], { maxBuffer: 2_000_000 })).stdout.trim();
    check(await git('rev-parse', 'HEAD') === match[1] && await git('status', '--porcelain', '--untracked-files=no') === '', 'v2_release_code_changed');
    // A fresh independently configured reader is mandatory on every start.
    // The normal production Trac adapter authenticates the peer/bootstrap and
    // deployment before exposing these reads; gateway state cannot supply it.
    check(!config.prod.trac.runtimeModule, 'v2_release_production_transport');
    await reads.trac('terminalWatermark');
    await reads.trac('stamp');
    const current = await reads.rulesContext(), deployment = await reads.trac('deployment');
    const result = validateProductionRelease({ proof, config, activation: store.get('meta', 'v2Activation'), current, deployment, revision: match[1] });
    check(await reads.trac('root', [String(BigInt(config.v2.manifest.effectiveBatch) - 1n)]) === config.v2.manifest.previousBatchRoot, 'v2_release_predecessor');
    return result;
  } finally { await fd?.close(); }
}
