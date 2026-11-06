#!/usr/bin/env node
// Reviewable settings amendments using the accepted notary state.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StateTransition } from '../../contract/state.js';
import * as rules from '../../rules/src/index.js';

export const DEFAULT_MARGIN = '6';
export const DEFAULT_PROPOSAL_MARGIN = '2';
export const CLAIM_CAPACITY_VALUES = Object.freeze({ closureWorkBudget: 12288, closureReadBudget: 262144,
  closureByteBudget: 536870912, settlementPagesPerObservation: 64 });
// Operator limits a claim-profile amendment may retune alongside its work and page allowances.
export const CLAIM_TUNABLE_KEYS = Object.freeze(['closureWorkBudget', 'settlementPagesPerObservation', 'closureBacklogPairs',
  'closureBacklogBytes', 'closureBacklogWindows', 'batchDeadlineTips', 'requestMinBlocks']);
const TUNING_ARGUMENTS = Object.freeze({ closureWork: 'closureWorkBudget', settlementPages: 'settlementPagesPerObservation',
  backlogPairs: 'closureBacklogPairs', backlogBytes: 'closureBacklogBytes', backlogWindows: 'closureBacklogWindows',
  batchDeadline: 'batchDeadlineTips', requestMin: 'requestMinBlocks' });
export function need(value, code, details = {}) {
  if (!value) throw Object.assign(Error(code), { details });
}
const maximum = (...values) => values.reduce((a, b) => rules.compareUint(a, b) >= 0 ? a : b);
const positive = value => { rules.uintV2(value); need(value !== '0', 'successor_positive_margin'); return value; };
const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
export function valueDiff(previous, next) {
  return Object.keys(next).sort().filter(key => !same(previous[key] ?? null, next[key])).map(key =>
    ({ key, before: previous[key] ?? null, after: next[key] }));
}

// Resources are a separate, locally pinned document, never consensus values.
// Preserve the parser version as well as every unrelated resource setting.
export function sourceRateSuccessor(previous, sourceRps) {
  rules.validateResourceDocument(previous);
  sourceRps ??= previous.values.sourceRps;
  need(previous.version >= 3, 'successor_resource_version');
  need(Number.isSafeInteger(sourceRps) && sourceRps >= previous.values.sourceRps, 'successor_source_rate');
  if (sourceRps === previous.values.sourceRps) return structuredClone(previous);
  return rules.validateResourceDocument({ ...structuredClone(previous), revision: rules.nextUint(previous.revision),
    previousHash: rules.hashObject(previous), values: { ...structuredClone(previous.values), sourceRps } });
}

// Each successor adds exactly one reviewed rule group: first the public mint
// bundle, then permanent claims, open minting on linked land, and opaque payments.
const successorKind = current => current.values.publicMintActivationHeight === undefined ? 'publicMint' :
  current.values.claimsNeverCloseHeight === undefined ? 'claimsNeverClose' :
  current.values.bitmapMintOpenHeight === undefined ? 'bitmapMintOpen' : 'publicPaymentV2';
function successorValues(current, activationHeight) {
  if (successorKind(current) === 'publicMint') return { ...structuredClone(current.values), publicMintActivationHeight: activationHeight,
    publicMintLegacyFinderWindow: current.values.finderWindow, publicMintScanBlocks: 2, publicMintPageSize: 50 };
  if (successorKind(current) === 'claimsNeverClose') return { ...structuredClone(current.values), claimsNeverCloseHeight: activationHeight };
  if (successorKind(current) === 'bitmapMintOpen') return { ...structuredClone(current.values), bitmapMintOpenHeight: activationHeight };
  need(current.values.publicPaymentV2Height === undefined, 'successor_public_payment_v2_already_configured');
  return { ...structuredClone(current.values), publicPaymentV2Height: activationHeight };
}
const successorActivation = (current, document) => document.values[successorKind(current) === 'publicMint'
  ? 'publicMintActivationHeight' : successorKind(current) + 'Height'];

function feeValues(current, feePolicyRevision, linkMultiplier, executionHeight = '0') {
  need(typeof feePolicyRevision === 'string' && /^[0-9a-f]{64}$/.test(feePolicyRevision)
    && feePolicyRevision !== current.values.feePolicyRevision, 'successor_fee_revision');
  need(Number.isSafeInteger(linkMultiplier) && linkMultiplier >= (rules.freeLinkActive(executionHeight) ? 0 : 1) && linkMultiplier <= 10000, 'successor_link_multiplier');
  return { ...structuredClone(current.values), feePolicyRevision, linkMultiplier };
}

function legacyDeployValues(current, legacyDeployShareBps, legacyDeployPayoutMinAtoms, deployerShareBps = current.values.deployerShareBps) {
  need(Number.isSafeInteger(legacyDeployShareBps) && legacyDeployShareBps >= 0 && legacyDeployShareBps <= current.values.findBurnBps,
    'successor_legacy_deploy_share');
  rules.tapAtoms(legacyDeployPayoutMinAtoms);
  need(!legacyDeployShareBps || legacyDeployPayoutMinAtoms !== '0', 'successor_legacy_deploy_threshold');
  const values = { ...structuredClone(current.values), legacyDeployShareBps, legacyDeployPayoutMinAtoms, ...(deployerShareBps === undefined ? {} : { deployerShareBps }) };
  rules.validateSettings(values, undefined, current.effectiveBitcoinWindow); return values;
}
const legacyDeployChanged = (current, document) => ['legacyDeployShareBps', 'legacyDeployPayoutMinAtoms', 'deployerShareBps']
  .some(key => current.values[key] !== document.values[key]);

const tickerFeeKeys = ['tickerDeployMultiplier', 'tickerDeployBurnBps', 'linkBurnBps'];
const tickerFeesChanged = (current, document) => tickerFeeKeys.some(key => current.values[key] !== document.values[key]);
function tickerFeeValues(current, changes) {
  const ticker = changes.tickerDeployMultiplier !== undefined || changes.tickerDeployBurnBps !== undefined;
  need(!ticker || changes.tickerDeployMultiplier !== undefined && changes.tickerDeployBurnBps !== undefined, 'successor_ticker_arguments');
  const values = { ...structuredClone(current.values), ...Object.fromEntries(tickerFeeKeys.filter(key => changes[key] !== undefined).map(key => [key, changes[key]])) };
  rules.validateSettings(values, undefined, current.effectiveBitcoinWindow);
  return values;
}

export function buildSuccessor(snapshot, {
  activationHeight, publicPaymentV2Height, bitmapMintOpenHeight, margin = DEFAULT_MARGIN, proposalMargin = DEFAULT_PROPOSAL_MARGIN, effectiveBatch, sourceRps,
  feePolicyRevision, linkMultiplier, legacyDeployShareBps, legacyDeployPayoutMinAtoms, deployerShareBps, tickerDeployMultiplier, tickerDeployBurnBps, linkBurnBps,
  bulkCapacity = false, claimCapacity = false, pendingBlocks, ...tuning
} = {}) {
  const { current, last, head, resources } = snapshot;
  rules.validateSettingsDocument(current);
  if (pendingBlocks !== undefined) {
    need(pendingBlocks === 6 && !bulkCapacity && !claimCapacity && [activationHeight, publicPaymentV2Height, bitmapMintOpenHeight, feePolicyRevision,
      linkMultiplier, legacyDeployShareBps, legacyDeployPayoutMinAtoms, deployerShareBps, tickerDeployMultiplier,
      tickerDeployBurnBps, linkBurnBps, sourceRps].every(value => value === undefined), 'successor_pending_arguments');
    positive(proposalMargin);
    const minimumBatch = maximum(rules.nextUint(rules.decimalV2(last.n)), rules.nextUint(current.effectiveBatch));
    effectiveBatch ??= minimumBatch; rules.uintV2(effectiveBatch);
    need(rules.compareUint(effectiveBatch, minimumBatch) >= 0, 'successor_batch_boundary', { minimumBatch });
    const effectiveBitcoinWindow = maximum(current.effectiveBitcoinWindow, rules.addUint(rules.decimalV2(head.counted), proposalMargin));
    return describeSuccessor(snapshot, rules.settingsRevision({ network: current.network, previous: current,
      effectiveBatch, effectiveBitcoinWindow, values: { ...current.values, pendingBlocks } }), resources, margin);
  }
  if (bulkCapacity || claimCapacity) {
    // Capacity amendments use the same next-batch / counted-plus-margin boundaries.
    need(!(bulkCapacity && claimCapacity), 'successor_capacity_arguments');
    need([activationHeight, publicPaymentV2Height, bitmapMintOpenHeight, feePolicyRevision, linkMultiplier, legacyDeployShareBps, deployerShareBps,
      legacyDeployPayoutMinAtoms, tickerDeployMultiplier, tickerDeployBurnBps, linkBurnBps, sourceRps].every(value => value === undefined), 'successor_capacity_arguments');
    positive(proposalMargin);
    const effectiveBitcoinWindow = maximum(current.effectiveBitcoinWindow, rules.addUint(rules.decimalV2(head.counted), proposalMargin));
    const minimumBatch = maximum(rules.nextUint(rules.decimalV2(last.n)), rules.nextUint(current.effectiveBatch));
    effectiveBatch ??= minimumBatch; rules.uintV2(effectiveBatch);
    need(rules.compareUint(effectiveBatch, minimumBatch) >= 0, 'successor_batch_boundary', { minimumBatch });
    const document = claimCapacity ? rules.settingsRevision({ network: current.network, previous: current,
      effectiveBatch, effectiveBitcoinWindow, values: { ...current.values, ...CLAIM_CAPACITY_VALUES,
        ...Object.fromEntries(Object.entries(TUNING_ARGUMENTS).filter(([name]) => tuning[name] !== undefined).map(([name, key]) => [key, tuning[name]])) } }) :
      rules.bulkCapacitySuccessor(current, { effectiveBatch, effectiveBitcoinWindow });
    return describeSuccessor(snapshot, document, resources, margin);
  }
  const explicit = Object.entries({ publicPaymentV2Height, bitmapMintOpenHeight }).filter(([, value]) => value !== undefined);
  const fees = feePolicyRevision !== undefined, legacyDeploy = legacyDeployShareBps !== undefined || deployerShareBps !== undefined;
  if (deployerShareBps !== undefined) { legacyDeployShareBps ??= current.values.legacyDeployShareBps ?? 0; legacyDeployPayoutMinAtoms ??= current.values.legacyDeployPayoutMinAtoms; }
  const tickerChanges = { tickerDeployMultiplier, tickerDeployBurnBps, linkBurnBps }, tickerFees = tickerFeeKeys.some(key => tickerChanges[key] !== undefined);
  need(!tickerFees || !fees && !explicit.length && sourceRps === undefined, 'successor_ticker_arguments');
  need(legacyDeploy ? !fees && !explicit.length && sourceRps === undefined && legacyDeployPayoutMinAtoms !== undefined : legacyDeployPayoutMinAtoms === undefined, 'successor_legacy_deploy_arguments');
  need(fees ? !explicit.length && sourceRps === undefined : linkMultiplier === undefined, 'successor_fee_arguments');
  need(explicit.length <= 1 && (!explicit.length || activationHeight === undefined), 'successor_activation_arguments');
  if (explicit.length) {
    need(explicit[0][0] === successorKind(current) + 'Height', 'successor_activation_kind');
    activationHeight = explicit[0][1];
  }
  rules.uintV2(activationHeight); positive(margin); positive(proposalMargin);
  const earliestApplyHeight = rules.decimalV2(head.counted);
  if (fees && linkMultiplier === 0) need(rules.freeLinkActive(earliestApplyHeight), 'successor_link_multiplier');
  const effectiveBitcoinWindow = maximum(current.effectiveBitcoinWindow, rules.addUint(earliestApplyHeight, proposalMargin));
  const minimumBatch = maximum(rules.nextUint(rules.decimalV2(last.n)), rules.nextUint(current.effectiveBatch));
  effectiveBatch ??= minimumBatch; rules.uintV2(effectiveBatch);
  need(rules.compareUint(effectiveBatch, minimumBatch) >= 0, 'successor_batch_boundary', { minimumBatch });
  const minimumActivationHeight = rules.addUint(effectiveBitcoinWindow, margin);
  need(rules.compareUint(activationHeight, minimumActivationHeight) >= 0, 'successor_activation_margin', {
    minimumActivationHeight, effectiveBitcoinWindow, earliestApplyHeight, minimumBatch,
    lastBatch: rules.decimalV2(last.n), counted: rules.decimalV2(head.counted) });
  // Fee arithmetic already follows the signed policy. Its settings successor
  // takes effect at the existing two boundaries; no new consensus gate exists.
  const holderValues = legacyDeploy ? legacyDeployValues(current, legacyDeployShareBps, legacyDeployPayoutMinAtoms, deployerShareBps) : current.values;
  const document = rules.settingsRevision({ network: current.network, previous: current, effectiveBatch,
    effectiveBitcoinWindow: fees || legacyDeploy || tickerFees ? activationHeight : effectiveBitcoinWindow,
    values: tickerFees ? tickerFeeValues({ values: holderValues, effectiveBitcoinWindow: activationHeight }, tickerChanges) : legacyDeploy ? holderValues :
      fees ? feeValues(current, feePolicyRevision, linkMultiplier, activationHeight) : successorValues(current, activationHeight) });
  return describeSuccessor(snapshot, document, sourceRateSuccessor(resources, sourceRps), margin);
}

export function describeSuccessor(snapshot, document, resourceDocument, margin = DEFAULT_MARGIN) {
  const { current, resources, last, head } = snapshot;
  rules.validateSettingsDocument(document); rules.settingsSuccessor(current, document); positive(margin);
  if (document.values.linkMultiplier === 0) need(rules.freeLinkActive(head.counted), 'successor_link_multiplier');
  const fees = document.values.feePolicyRevision !== current.values.feePolicyRevision, legacyDeploy = legacyDeployChanged(current, document), tickerFees = tickerFeesChanged(current, document);
  need(!fees || !legacyDeploy && !tickerFees, 'successor_unexpected_settings_change');
  const pending = document.values.pendingBlocks !== current.values.pendingBlocks;
  const claims = [...Object.keys(CLAIM_CAPACITY_VALUES), ...CLAIM_TUNABLE_KEYS].some(key => document.values[key] !== current.values[key]);
  if (pending || claims || Object.keys(rules.BULK_CAPACITY_VALUES).some(key => document.values[key] !== current.values[key])) {
    // Once the claim profile is active, its work and page allowances may be retuned;
    // read and byte ceilings and every other value stay unchanged.
    const profile = values => ['closureReadBudget', 'closureByteBudget'].every(key => values[key] === CLAIM_CAPACITY_VALUES[key]);
    const tuned = claims && !pending && profile(current.values) && same(document.values,
      { ...current.values, ...Object.fromEntries(CLAIM_TUNABLE_KEYS.map(key => [key, document.values[key]])) });
    need(tuned || same(document.values, pending ? { ...current.values, pendingBlocks: 6 } :
      { ...current.values, ...(claims ? CLAIM_CAPACITY_VALUES : rules.BULK_CAPACITY_VALUES) }), 'successor_unexpected_settings_change');
    need(same(resources, resourceDocument), 'successor_resource_changed');
    const activationHeight = document.effectiveBitcoinWindow;
    return { version: 1, operation: 'ad_settings', document, hash: rules.hashObject(document),
      previousRevisionHash: document.previousRevisionHash, effectiveBatch: document.effectiveBatch,
      effectiveBitcoinWindow: document.effectiveBitcoinWindow, activationHeight, margin, minimumActivationHeight: activationHeight,
      earliestApplyHeight: rules.decimalV2(head.counted),
      snapshot: { notary: snapshot.notary ?? null, viewVersion: snapshot.viewVersion ?? null, currentHash: rules.hashObject(current), last, head },
      resourceDocument, resourceHash: rules.hashObject(resourceDocument), resourceInstallRequired: false,
      diff: { settings: valueDiff(current.values, document.values), resources: [] } };
  }
  const activationHeight = fees || legacyDeploy || tickerFees ? document.effectiveBitcoinWindow : successorActivation(current, document);
  const holderValues = legacyDeploy ? legacyDeployValues(current, document.values.legacyDeployShareBps, document.values.legacyDeployPayoutMinAtoms, document.values.deployerShareBps) : current.values;
  need(same(document.values, tickerFees ? tickerFeeValues({ values: holderValues, effectiveBitcoinWindow: document.effectiveBitcoinWindow }, document.values) : legacyDeploy ? holderValues : fees ? feeValues(current, document.values.feePolicyRevision, document.values.linkMultiplier, document.effectiveBitcoinWindow)
    : successorValues(current, activationHeight)), 'successor_unexpected_settings_change');
  if (fees || legacyDeploy || tickerFees) need(same(resources, resourceDocument), 'successor_resource_changed');
  need(same(resourceDocument, sourceRateSuccessor(resources, resourceDocument?.values?.sourceRps)), 'successor_resource_changed');
  const minimumActivationHeight = fees || legacyDeploy || tickerFees ? document.effectiveBitcoinWindow : rules.addUint(document.effectiveBitcoinWindow, margin);
  need(rules.compareUint(activationHeight, minimumActivationHeight) >= 0, 'successor_activation_margin', { minimumActivationHeight });
  return { version: 1, operation: 'ad_settings', document, hash: rules.hashObject(document),
    previousRevisionHash: document.previousRevisionHash, effectiveBatch: document.effectiveBatch,
    effectiveBitcoinWindow: document.effectiveBitcoinWindow, activationHeight, margin, minimumActivationHeight,
    earliestApplyHeight: rules.decimalV2(head.counted),
    snapshot: { notary: snapshot.notary ?? null, viewVersion: snapshot.viewVersion ?? null,
      currentHash: rules.hashObject(current), last, head },
    resourceDocument, resourceHash: rules.hashObject(resourceDocument), resourceInstallRequired: !same(resources, resourceDocument),
    diff: { settings: valueDiff(current.values, document.values), resources: valueDiff(resources.values, resourceDocument.values) } };
}

// The actual contract executes against cloned records. Its write set is never
// installed in the live view, including for failed or premature applications.
export async function simulateAdministration(snapshot, operation, value) {
  const records = new Map([...snapshot.records].map(([key, entry]) => [key, structuredClone(entry)]));
  const state = new StateTransition(async key => records.get(key) ?? null, snapshot.deployment);
  const error = await state.transaction(operation, value, snapshot.admin);
  need(!error, 'successor_contract_refused', { reason: error });
  return state.writes;
}

// A proposal whose effective batch has already been created can never be
// applied; the contract lets a new proposal replace it.
export const stalePending = snapshot => !!snapshot.pending && !!snapshot.last &&
  rules.compareUint(snapshot.pending.value.effectiveBatch, rules.decimalV2(snapshot.last.n)) <= 0;
export async function prepareSuccessor(snapshot, options, saved = null) {
  need((!snapshot.pending || stalePending(snapshot)) && !snapshot.scheduled, 'successor_amendment_pending');
  const plan = saved
    ? describeSuccessor(snapshot, saved.document, saved.resourceDocument, saved.margin)
    : buildSuccessor(snapshot, options);
  if (saved) need(saved.version === 1 && saved.hash === plan.hash && saved.resourceHash === plan.resourceHash
    && saved.snapshot?.notary === plan.snapshot.notary, 'successor_saved_plan_changed');
  await simulateAdministration(snapshot, 'ad_settings', { document: plan.document });
  return { ...plan, contractValidation: 'accepted' };
}

export async function prepareApplication(snapshot, confirmHash) {
  need(/^[0-9a-f]{64}$/.test(confirmHash ?? ''), 'successor_confirmation_required');
  const action = snapshot.pending;
  need(action && rules.hashObject(action.value) === confirmHash, 'successor_pending_hash_mismatch');
  rules.validateSettingsDocument(action.value);
  const earliestApplyHeight = rules.decimalV2(action.at), counted = rules.decimalV2(snapshot.head.counted);
  need(rules.compareUint(counted, earliestApplyHeight) >= 0, 'successor_apply_too_early', { earliestApplyHeight, counted });
  await simulateAdministration(snapshot, 'ad_apply', { id: 'settings' });
  return { operation: 'ad_apply', hash: confirmHash, earliestApplyHeight, counted,
    effectiveBatch: action.value.effectiveBatch, effectiveBitcoinWindow: action.value.effectiveBitcoinWindow,
    activationHeight: Object.keys(CLAIM_CAPACITY_VALUES).some(key => action.value.values[key] !== snapshot.current.values[key]) ||
      action.value.values.feePolicyRevision !== snapshot.current.values.feePolicyRevision || legacyDeployChanged(snapshot.current, action.value) || tickerFeesChanged(snapshot.current, action.value) ? action.value.effectiveBitcoinWindow :
      action.value.values.publicPaymentV2Height ?? action.value.values.bitmapMintOpenHeight ?? action.value.values.claimsNeverCloseHeight ?? action.value.values.publicMintActivationHeight, contractValidation: 'accepted' };
}

export function parseArguments(args) {
  const result = { mode: 'dry-run', margin: DEFAULT_MARGIN, proposalMargin: DEFAULT_PROPOSAL_MARGIN };
  const names = { config: 'config', 'activation-height': 'activationHeight',
    'public-payment-v2-height': 'publicPaymentV2Height', 'bitmap-mint-open-height': 'bitmapMintOpenHeight', margin: 'margin', 'proposal-margin': 'proposalMargin',
    'effective-batch': 'effectiveBatch', 'source-rps': 'sourceRps', 'confirm-hash': 'confirmHash', proposal: 'proposal',
    'pending-blocks': 'pendingBlocks', 'fee-policy-revision': 'feePolicyRevision', 'link-multiplier': 'linkMultiplier',
    'deployer-share-bps': 'deployerShareBps', 'legacy-deploy-share-bps': 'legacyDeployShareBps', 'legacy-deploy-payout-min-atoms': 'legacyDeployPayoutMinAtoms',
    'ticker-deploy-multiplier': 'tickerDeployMultiplier', 'ticker-deploy-burn-bps': 'tickerDeployBurnBps', 'link-burn-bps': 'linkBurnBps',
    'admin-key': 'adminKey', journal: 'journal', 'closure-work': 'closureWork', 'settlement-pages': 'settlementPages',
    'backlog-pairs': 'backlogPairs', 'backlog-bytes': 'backlogBytes', 'backlog-windows': 'backlogWindows',
    'batch-deadline': 'batchDeadline', 'request-min': 'requestMin' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const match = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(args[i]);
    need(match, 'successor_usage'); const [, name, inline] = match;
    need(!seen.has(name), 'successor_duplicate_argument'); seen.add(name);
    if (name === 'bulk-capacity' || name === 'claim-capacity') {
      need(inline === undefined, 'successor_usage'); result[name === 'bulk-capacity' ? 'bulkCapacity' : 'claimCapacity'] = true; continue;
    }
    if (['dry-run', 'send', 'apply', 'help'].includes(name)) {
      need(inline === undefined, 'successor_usage');
      if (name === 'help') result.help = true;
      else { need(!result.explicitMode, 'successor_mode_conflict'); result.mode = name; result.explicitMode = true; }
    } else {
      need(Object.hasOwn(names, name), 'successor_unknown_argument');
      const value = inline ?? args[++i]; need(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'successor_usage');
      result[names[name]] = value;
    }
  }
  if (result.help) return result;
  need(result.config, 'successor_config_required');
  const heights = ['activationHeight', 'publicPaymentV2Height', 'bitmapMintOpenHeight'].filter(key => result[key] !== undefined);
  const fees = result.feePolicyRevision !== undefined, legacyDeploy = result.legacyDeployShareBps !== undefined || result.deployerShareBps !== undefined;
  const tickerFees = tickerFeeKeys.some(key => result[key] !== undefined);
  need(!tickerFees || !fees && result.activationHeight !== undefined && !seen.has('source-rps') && !result.proposal && result.mode !== 'apply', 'successor_ticker_arguments');
  need((result.tickerDeployMultiplier === undefined) === (result.tickerDeployBurnBps === undefined), 'successor_ticker_arguments');
  for (const key of tickerFeeKeys) if (result[key] !== undefined) {
    need(/^(0|[1-9][0-9]*)$/.test(result[key]) && Number.isSafeInteger(Number(result[key])) && (key === 'tickerDeployMultiplier' || Number(result[key]) <= 10000), 'successor_ticker_value');
    result[key] = Number(result[key]);
  }
  need(legacyDeploy ? !fees && (result.legacyDeployPayoutMinAtoms !== undefined || result.deployerShareBps !== undefined) && result.activationHeight !== undefined && !seen.has('source-rps')
    && !result.proposal && result.mode !== 'apply' : result.legacyDeployPayoutMinAtoms === undefined, 'successor_legacy_deploy_arguments');
  need(fees ? result.activationHeight !== undefined && result.linkMultiplier !== undefined && !seen.has('source-rps')
    && !result.proposal && result.mode !== 'apply' : result.linkMultiplier === undefined, 'successor_fee_arguments');
  need(heights.length <= 1, 'successor_activation_arguments');
  if (result.mode === 'apply') need(!heights.length && !result.proposal && !seen.has('source-rps')
    && !seen.has('effective-batch') && !seen.has('margin') && !seen.has('proposal-margin'), 'successor_apply_arguments');
  else need(heights.length || result.proposal || result.bulkCapacity || result.claimCapacity || result.pendingBlocks !== undefined, 'successor_activation_required');
  if (result.pendingBlocks !== undefined) {
    need(result.pendingBlocks === '6' && result.mode === 'dry-run' && !heights.length && !result.proposal && !result.bulkCapacity && !result.claimCapacity && !fees && !legacyDeploy && !tickerFees && !seen.has('source-rps'), 'successor_pending_arguments');
    result.pendingBlocks = Number(result.pendingBlocks);
  }
  if (result.bulkCapacity || result.claimCapacity) need(!(result.bulkCapacity && result.claimCapacity) && result.mode === 'dry-run' &&
    !heights.length && !result.proposal && !fees && !legacyDeploy && !tickerFees && !seen.has('source-rps'), 'successor_capacity_arguments');
  for (const key of Object.keys(TUNING_ARGUMENTS)) if (result[key] !== undefined) {
    need(result.claimCapacity && /^[1-9][0-9]*$/.test(result[key]) && Number.isSafeInteger(Number(result[key])), 'successor_capacity_arguments');
    result[key] = Number(result[key]);
  }
  if (result.proposal) need(!heights.length && !seen.has('source-rps') && !seen.has('effective-batch')
    && !seen.has('margin') && !seen.has('proposal-margin'), 'successor_proposal_arguments');
  if (result.mode !== 'dry-run') need(/^[0-9a-f]{64}$/.test(result.confirmHash ?? '') && result.adminKey && result.journal, 'successor_confirmation_required');
  else need(!result.confirmHash && !result.adminKey && !result.journal, 'successor_dry_run_arguments');
  for (const key of heights) rules.uintV2(result[key]);
  if (result.effectiveBatch) rules.uintV2(result.effectiveBatch);
  positive(result.margin); positive(result.proposalMargin);
  if (result.sourceRps !== undefined) {
    need(/^[1-9][0-9]*$/.test(result.sourceRps) && Number.isSafeInteger(Number(result.sourceRps)), 'successor_source_rate');
    result.sourceRps = Number(result.sourceRps);
  }
  if (result.deployerShareBps !== undefined) {
    need(/^(0|[1-9][0-9]*)$/.test(result.deployerShareBps) && Number(result.deployerShareBps) <= 10000, 'successor_deployer_share');
    result.deployerShareBps = Number(result.deployerShareBps);
  }
  if (result.legacyDeployShareBps !== undefined) {
    need(/^(0|[1-9][0-9]*)$/.test(result.legacyDeployShareBps) && Number(result.legacyDeployShareBps) <= 10000, 'successor_legacy_deploy_share');
    result.legacyDeployShareBps = Number(result.legacyDeployShareBps);
    rules.tapAtoms(result.legacyDeployPayoutMinAtoms);
    need(!result.legacyDeployShareBps || result.legacyDeployPayoutMinAtoms !== '0', 'successor_legacy_deploy_threshold');
  }
  if (fees) {
    need(/^[0-9a-f]{64}$/.test(result.feePolicyRevision), 'successor_fee_revision');
    need((/^[1-9][0-9]*$/.test(result.linkMultiplier) || result.linkMultiplier === '0' && rules.freeLinkActive(result.activationHeight)) && Number(result.linkMultiplier) <= 10000, 'successor_link_multiplier');
    result.linkMultiplier = Number(result.linkMultiplier);
  }
  return result;
}

export const USAGE = `Usage: settings-successor.mjs --config FILE --activation-height HEIGHT [--dry-run]
  --config FILE --public-payment-v2-height HEIGHT [--dry-run]
  --config FILE --deployer-share-bps BPS [--legacy-deploy-payout-min-atoms ATOMS] --activation-height HEIGHT [--dry-run]
  --config FILE --legacy-deploy-share-bps BPS --legacy-deploy-payout-min-atoms ATOMS --activation-height HEIGHT [--dry-run]
  --config FILE --fee-policy-revision HASH --link-multiplier N --activation-height HEIGHT [--dry-run]
  --config FILE --ticker-deploy-multiplier N --ticker-deploy-burn-bps BPS [--link-burn-bps BPS] --activation-height HEIGHT [--dry-run]
  --config FILE --link-burn-bps BPS --activation-height HEIGHT [--dry-run]
  --config FILE --bulk-capacity [--effective-batch BATCH] [--dry-run]
  --config FILE --claim-capacity [--effective-batch BATCH] [--dry-run]
  --config FILE --pending-blocks 6 [--effective-batch BATCH] [--dry-run]
  [--margin 6] [--proposal-margin 2] [--effective-batch BATCH] [--source-rps RATE]
  --config FILE --proposal REVIEWED_JSON --send --confirm-hash HASH --admin-key FILE --journal DIRECTORY
  --config FILE --apply --confirm-hash HASH --admin-key FILE --journal DIRECTORY

The claim-capacity mode prepares 12,288 closure work units, 262,144 authenticated
reads, 536,870,912 charged bytes and 64 settlement pages. All other settings and
resources are preserved. Send the reviewed JSON with --proposal.
The pending-blocks mode prepares only a six-block successor; it cannot send or apply.
Both single and bulk mint payment windows use this setting. No new activation gate.
Dry-run is the default. It reads a fresh accepted Trac view and prints JSON.
The source rate is preserved unless --source-rps is passed explicitly.
Historical Bitmap successors also accept --bitmap-mint-open-height HEIGHT.
Fee, legacy-deploy and ticker/link split amendments preserve every other setting and the resource document.
Holder-share and ticker/link split amendments may be combined in one reviewed proposal.
Their activation height is the settings document's effective Bitcoin boundary.
The saved JSON pins both documents while the live head advances. Send/apply
require exclusive use of the gateway Trac writer; stop the gateway first.
Apply uses the accepted proposal, never a rebuilt one.
Resource output requires a separate configuration installation and restart.
`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log = console.error = console.warn = console.info = console.debug = () => {};
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) process.stdout.write(USAGE);
    // No top-level await: the runtime imports this module back, and awaiting
    // it here would leave both module evaluations waiting on each other.
    else import('./settings-successor-runtime.mjs').then(runtime => runtime.runSuccessor(options)).catch(fail);
  } catch (error) { fail(error); }
}
function fail(error) {
  // Dependency errors may contain private configuration. Emit only the
  // script's fixed error codes and explicitly selected public diagnostics.
  const code = /^successor_[a-z_]+$/.test(error.message ?? '') ? error.message : 'successor_failed';
  process.stderr.write(JSON.stringify({ error: code, ...(code === error.message ? error.details : {}) }) + '\n');
  process.exitCode = 1;
}
