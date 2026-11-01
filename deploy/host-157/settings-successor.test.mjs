import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../../rules/src/index.js';
import { stalePending, buildSuccessor, describeSuccessor, sourceRateSuccessor, parseArguments, valueDiff } from './settings-successor.mjs';
import { runtimeResources } from '../../service/src/r3-settings.mjs';

const current = r.settingsRevision({ network: 'successor-test', effectiveBatch: '5', effectiveBitcoinWindow: '900',
  values: { ...r.SETTINGS_PROFILE, finderWindow: 864, adminDelayTips: 12 } });
const resources = r.resourceRevision({ operator: 'successor-test', values: { ...r.RESOURCE_PROFILE, sourceQueue: 128 } });
const snapshot = { current, resources, last: { n: '9', to: '1000' }, head: { counted: '1000' } };

test('fee-only successor changes only fee pins at the existing batch and Bitcoin boundaries', () => {
  const feePolicyRevision = 'b'.repeat(64);
  const plan = buildSuccessor(snapshot, { activationHeight: '1020', feePolicyRevision, linkMultiplier: 1 });
  assert.deepEqual(plan.document.values, { ...current.values, feePolicyRevision, linkMultiplier: 1 });
  assert.equal(plan.document.effectiveBitcoinWindow, '1020');
  assert.equal(plan.activationHeight, '1020');
  assert.deepEqual(plan.resourceDocument, resources);
  assert.equal(plan.resourceInstallRequired, false);
  assert.deepEqual(describeSuccessor(snapshot, plan.document, plan.resourceDocument), plan);
  for (const [batch, height, expected] of [['9', '1020', current], ['10', '1019', current], ['10', '1020', plan.document]])
    assert.deepEqual(r.effectiveSettings(current, plan.document, batch, height), expected);
  assert.throws(() => describeSuccessor(snapshot, { ...plan.document, values: { ...plan.document.values, finderWindow: 1 } }, resources), /unexpected_settings/);
  assert.throws(() => describeSuccessor(snapshot, plan.document, sourceRateSuccessor(resources, 100)), /resource_changed/);
  for (const options of [{ feePolicyRevision: '0', linkMultiplier: 1 }, { feePolicyRevision, linkMultiplier: 0 },
    { feePolicyRevision, linkMultiplier: '1' }, { feePolicyRevision, linkMultiplier: 1, sourceRps: 100 }, { linkMultiplier: 1 }])
    assert.throws(() => buildSuccessor(snapshot, { activationHeight: '1020', ...options }));
  const next = { ...snapshot, current: plan.document, last: { n: '10', to: '1020' }, head: { counted: '1020' } };
  assert.throws(() => buildSuccessor(next, { activationHeight: '1040', feePolicyRevision, linkMultiplier: 1 }), /fee_revision/);
});

test('fee amendment CLI requires a complete explicit fee pin and preserves send confirmation', () => {
  const args = ['--config', '/config', '--activation-height', '1020', '--fee-policy-revision', 'b'.repeat(64), '--link-multiplier', '1'];
  const options = parseArguments(args);
  assert.equal(options.mode, 'dry-run'); assert.equal(options.linkMultiplier, 1);
  assert.equal(buildSuccessor(snapshot, options).document.values.feePolicyRevision, 'b'.repeat(64));
  for (const extra of [['--source-rps', '100'], ['--proposal', '/proposal'], ['--apply'], ['--send']])
    assert.throws(() => parseArguments([...args, ...extra]));
  assert.throws(() => parseArguments(args.slice(0, -2)), /fee_arguments/);
  assert.throws(() => parseArguments(['--config', '/config', '--activation-height', '1020', '--link-multiplier', '1']), /fee_arguments/);
});

test('successor copies current values, preserves finder rights and amends resources independently', () => {
  const plan = buildSuccessor(snapshot, { activationHeight: '1020', sourceRps: 100 });
  assert.equal(plan.document.revision, '1');
  assert.equal(plan.previousRevisionHash, r.hashObject(current));
  assert.equal(plan.hash, r.hashObject(plan.document));
  assert.equal(plan.effectiveBatch, '10');
  assert.equal(plan.earliestApplyHeight, '1000', 'settings amendments apply without an admin delay');
  assert.equal(plan.effectiveBitcoinWindow, '1002');
  assert.equal(plan.minimumActivationHeight, '1008');
  assert.deepEqual(plan.document.values, { ...current.values, publicMintActivationHeight: '1020',
    publicMintLegacyFinderWindow: 864, publicMintScanBlocks: 2, publicMintPageSize: 50 });
  assert.deepEqual(plan.resourceDocument.values, { ...resources.values, sourceRps: 100 });
  assert.equal(runtimeResources(plan.resourceDocument, plan.document).source.requestsPerSecond, 100);
  assert.equal(plan.resourceDocument.previousHash, r.hashObject(resources));
  assert.equal(plan.resourceDocument.revision, '1');
  assert.deepEqual(plan.diff.resources, [{ key: 'sourceRps', before: 2, after: 100 }]);
  assert.equal(plan.diff.settings.length, 4);
  assert.equal(current.values.publicMintActivationHeight, undefined);
  assert.equal(resources.values.sourceRps, 2);
  assert.equal(r.validateSettingsDocument(plan.document), plan.document);
});

test('activation, proposal runway and batch boundaries use exact unbounded decimal clocks', () => {
  assert.throws(() => buildSuccessor(snapshot, { activationHeight: '1007' }), e => e.message === 'successor_activation_margin' && e.details.minimumActivationHeight === '1008');
  assert.throws(() => buildSuccessor(snapshot, { activationHeight: '1020', effectiveBatch: '9' }), /successor_batch_boundary/);
  assert.throws(() => buildSuccessor(snapshot, { activationHeight: '1020', margin: '0' }), /successor_positive_margin/);
  assert.throws(() => buildSuccessor(snapshot, { activationHeight: '1020', proposalMargin: '0' }), /successor_positive_margin/);
  const big = '9007199254740993123456789';
  const plan = buildSuccessor({ ...snapshot, last: { n: big, to: big }, head: { counted: big } },
    { activationHeight: r.addUint(big, '20') });
  assert.equal(plan.effectiveBatch, r.nextUint(big));
  assert.equal(plan.effectiveBitcoinWindow, r.addUint(big, '2'));
  assert.equal(plan.activationHeight, r.addUint(big, '20'));
  const firstBatch = buildSuccessor({ ...snapshot, last: { n: '4', to: '900' } }, { activationHeight: '1020' });
  assert.equal(firstBatch.effectiveBatch, '6', 'successor must be later than the current revision even before its first batch');
});

test('existing public activation cannot be silently rescheduled; source rate cannot decrease', () => {
  const plan = buildSuccessor(snapshot, { activationHeight: '1020' });
  // The next successor may only add the permanent-claims height; the public activation stays unchanged.
  const claims = buildSuccessor({ ...snapshot, current: plan.document, resources: plan.resourceDocument }, { activationHeight: '2000' });
  assert.deepEqual(claims.document.values, { ...plan.document.values, claimsNeverCloseHeight: '2000' });
  assert.deepEqual(claims.diff.settings, [{ key: 'claimsNeverCloseHeight', before: null, after: '2000' }]);
  assert.equal(claims.activationHeight, '2000');
  assert.equal(claims.resourceInstallRequired, false);
  assert.equal(r.validateSettingsDocument(claims.document), claims.document);
  const bitmap = buildSuccessor({ ...snapshot, current: claims.document, resources: plan.resourceDocument }, { activationHeight: '3000' });
  assert.equal(bitmap.document.revision, '3');
  assert.deepEqual(bitmap.document.values, { ...claims.document.values, bitmapMintOpenHeight: '3000' });
  assert.deepEqual(bitmap.diff.settings, [{ key: 'bitmapMintOpenHeight', before: null, after: '3000' }]);
  assert.equal(bitmap.activationHeight, '3000');
  assert.equal(bitmap.resourceInstallRequired, false);
  assert.deepEqual(bitmap.resourceDocument, plan.resourceDocument);
  assert.equal(r.settingsSuccessor(claims.document, bitmap.document), bitmap.document);
  const opaque = buildSuccessor({ ...snapshot, current: bitmap.document, resources: plan.resourceDocument }, { publicPaymentV2Height: '4000' });
  assert.equal(opaque.document.revision, '4');
  assert.deepEqual(opaque.diff.settings, [{ key: 'publicPaymentV2Height', before: null, after: '4000' }]);
  assert.throws(() => buildSuccessor({ ...snapshot, current: opaque.document, resources: plan.resourceDocument }, { activationHeight: '5000' }), /already_configured/);
  for (const rate of [1, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => sourceRateSuccessor(resources, rate), /successor_source_rate/);
  assert.equal(sourceRateSuccessor(resources, 50).values.sourceRps, 50);
  assert.deepEqual(sourceRateSuccessor(resources, 2), resources);
  const v3 = structuredClone(resources); v3.version = 3;
  for (const key of ['assetPublicMintsPerPayer', 'assetPublicMintsPerIP', 'assetPublicMintStartsPerMinute']) delete v3.values[key];
  for (const key of ['relayObservationPage', 'committeeHealthMs', 'committeeReadyMs', 'committeeRequestMs', 'committeeResponseBytes', 'committeePollMs', 'committeeHistoryPage',
    'closureWorkPerSecond', 'closureReadsPerSecond', 'closureBytesPerSecond', 'closureTimeoutPaddingMs']) delete v3.values[key];
  r.validateResourceDocument(v3);
  assert.equal(sourceRateSuccessor(v3).version, 3);
  assert.deepEqual(valueDiff(v3.values, sourceRateSuccessor(v3).values), []);
  assert.deepEqual(valueDiff(v3.values, sourceRateSuccessor(v3, 100).values), [{ key: 'sourceRps', before: 2, after: 100 }]);
});

test('CLI defaults to dry-run and rejects ambiguous modes or incomplete send authorization', () => {
  assert.equal(parseArguments(['--config', '/config', '--activation-height=1020']).mode, 'dry-run');
  const hash = 'a'.repeat(64), send = ['--config', '/config', '--proposal', '/proposal', '--send', '--admin-key', '/key', '--journal', '/journal'];
  assert.equal(parseArguments([...send, '--confirm-hash=' + hash]).mode, 'send');
  assert.throws(() => parseArguments(send), /confirmation_required/);
  for (const extra of [['--dry-run'], ['--apply'], ['--send'], ['--activation-height', '1020'], ['--source-rps', '100'], ['--unknown']]) {
    assert.throws(() => parseArguments([...send, '--confirm-hash=' + hash, ...extra]));
  }
  assert.equal(parseArguments(['--config', '/config', '--apply', '--confirm-hash', hash, '--admin-key', '/key', '--journal', '/journal']).mode, 'apply');
  assert.throws(() => parseArguments(['--config', '/config', '--activation-height=1020', '--admin-key', '/key']), /dry_run_arguments/);
});

function revisionThree(rate = 100) {
  const pub = buildSuccessor(snapshot, { activationHeight: '1020' });
  const claims = buildSuccessor({ ...snapshot, current: pub.document }, { activationHeight: '2000' });
  const bitmap = buildSuccessor({ ...snapshot, current: claims.document }, { bitmapMintOpenHeight: '973724' });
  return { ...snapshot, current: bitmap.document, head: { counted: '973730' },
    resources: r.resourceRevision({ operator: 'successor-test', values: { ...resources.values, sourceRps: rate } }) };
}
for (const rate of [2, 100, 250]) test(`revision 3 to 4 adds only opaque payment activation and preserves sourceRps=${rate}`, () => {
  const live = revisionThree(rate), options = parseArguments(['--config', '/config', '--public-payment-v2-height', '973740']);
  assert.equal(options.sourceRps, undefined);
  const plan = buildSuccessor(live, options);
  assert.equal(plan.document.revision, '4');
  assert.deepEqual(plan.diff.settings, [{ key: 'publicPaymentV2Height', before: null, after: '973740' }]);
  assert.deepEqual(plan.document.values, { ...live.current.values, publicPaymentV2Height: '973740' });
  assert.deepEqual(plan.diff.resources, []); assert.equal(plan.resourceInstallRequired, false);
  assert.deepEqual(plan.resourceDocument, live.resources); assert.equal(plan.activationHeight, '973740');
  assert.deepEqual(describeSuccessor(live, plan.document, plan.resourceDocument), plan, 'saved-plan validation preserves the exact review');
  const changed = structuredClone(plan.document); changed.values.finderWindow++;
  assert.throws(() => describeSuccessor(live, changed, plan.resourceDocument), /unexpected_settings_change/);
  for (const key of ['bitmapMintOpenHeight', 'publicPaymentV2Height']) {
    for (const remove of [false, true]) {
      const values = { ...plan.document.values, [key]: '973750' }; if (remove) delete values[key];
      const amended = r.settingsRevision({ network: plan.document.network, previous: plan.document, effectiveBatch: '20', effectiveBitcoinWindow: '973735', values });
      assert.throws(() => r.settingsSuccessor(plan.document, amended), /boundary/);
    }
  }
  assert.throws(() => buildSuccessor(live, { publicPaymentV2Height: '973737' }), /activation_margin/);
  assert.throws(() => buildSuccessor(live, { bitmapMintOpenHeight: '973740' }), /activation_kind/);
  assert.throws(() => buildSuccessor(live, { publicPaymentV2Height: '973740', bitmapMintOpenHeight: '973740' }), /activation_arguments/);
  const bumped = buildSuccessor(live, { publicPaymentV2Height: '973740', sourceRps: rate + 1 });
  assert.deepEqual(bumped.diff.resources, [{ key: 'sourceRps', before: rate, after: rate + 1 }]);
});

test('opaque payment CLI rejects mixed heights, saved-plan overrides and apply-time edits', () => {
  const cli = ['--config', '/config', '--public-payment-v2-height', '973740'];
  for (const extra of [['--activation-height', '973740'], ['--bitmap-mint-open-height', '973740']]) {
    assert.throws(() => parseArguments([...cli, ...extra]), /activation_arguments/);
  }
  assert.throws(() => parseArguments([...cli, '--proposal', '/proposal']), /proposal_arguments/);
  assert.throws(() => parseArguments([...cli, '--apply']), /apply_arguments/);
  assert.equal(parseArguments([...cli, '--source-rps', '101']).sourceRps, 101);
  assert.throws(() => parseArguments(['--config', '/config', '--public-payment-v2-height', '0973740']));
});

test('a proposal whose effective batch already exists may be replaced; a live one may not', () => {
  const pending = { value: { effectiveBatch: '360' }, at: '973725' };
  assert.equal(stalePending({ pending, last: { n: '360' } }), true);
  assert.equal(stalePending({ pending, last: { n: '361' } }), true);
  assert.equal(stalePending({ pending, last: { n: '359' } }), false);
  assert.equal(stalePending({ pending: null, last: { n: '360' } }), false);
});

test('legacy deploy successor changes only share and payout threshold, with existing settings boundaries', () => {
  const plan = buildSuccessor(snapshot, { activationHeight: '1020', legacyDeployShareBps: 1000, legacyDeployPayoutMinAtoms: '1000000000000000000' });
  assert.deepEqual(plan.document.values, { ...current.values, legacyDeployShareBps: 1000, legacyDeployPayoutMinAtoms: '1000000000000000000' });
  assert.equal(plan.effectiveBitcoinWindow, '1020'); assert.equal(plan.activationHeight, '1020');
  assert.deepEqual(plan.resourceDocument, resources);
  assert.deepEqual(describeSuccessor(snapshot, plan.document, resources), plan);
  assert.deepEqual(r.effectiveSettings(current, plan.document, '10', '1019'), current);
  assert.deepEqual(r.effectiveSettings(current, plan.document, '10', '1020'), plan.document);
  for (const options of [{ legacyDeployShareBps: 1000 }, { legacyDeployPayoutMinAtoms: '1' },
    { legacyDeployShareBps: 2001, legacyDeployPayoutMinAtoms: '1' }, { legacyDeployShareBps: 1000, legacyDeployPayoutMinAtoms: '0' },
    { legacyDeployShareBps: 1000, legacyDeployPayoutMinAtoms: '1', feePolicyRevision: 'a'.repeat(64), linkMultiplier: 1 },
    { legacyDeployShareBps: 1000, legacyDeployPayoutMinAtoms: '1', sourceRps: 100 }])
    assert.throws(() => buildSuccessor(snapshot, { activationHeight: '1020', ...options }));
  assert.throws(() => describeSuccessor(snapshot, { ...plan.document, values: { ...plan.document.values, finderWindow: 1 } }, resources), /unexpected_settings/);
  const next = { ...snapshot, current: plan.document, last: { n: '10' }, head: { counted: '1020' } };
  const disabled = buildSuccessor(next, { activationHeight: '1040', legacyDeployShareBps: 0, legacyDeployPayoutMinAtoms: '1000000000000000000' });
  assert.equal(disabled.document.values.legacyDeployShareBps, 0);
  assert.deepEqual(describeSuccessor(next, disabled.document, resources), disabled);
});
test('legacy deploy CLI requires explicit share and threshold and retains reviewed-plan controls', () => {
  const args = ['--config', '/config', '--activation-height', '1020', '--legacy-deploy-share-bps', '1000', '--legacy-deploy-payout-min-atoms', '1000000000000000000'];
  const options = parseArguments(args);
  assert.equal(options.mode, 'dry-run'); assert.equal(options.legacyDeployShareBps, 1000);
  assert.equal(buildSuccessor(snapshot, options).document.values.legacyDeployPayoutMinAtoms, '1000000000000000000');
  for (const extra of [['--source-rps', '100'], ['--proposal', '/proposal'], ['--apply'], ['--send'], ['--link-multiplier', '1']])
    assert.throws(() => parseArguments([...args, ...extra]));
  assert.throws(() => parseArguments(args.slice(0, -2)), /legacy_deploy_arguments/);
  assert.throws(() => parseArguments([...args.slice(0, -1), '0']), /legacy_deploy_threshold/);
});

test('ticker deploy and link burn amendments preserve all other settings and settings boundaries', () => {
  const options = parseArguments(['--config', '/config', '--activation-height', '1020', '--ticker-deploy-multiplier', '7', '--ticker-deploy-burn-bps', '2500', '--link-burn-bps', '1234']);
  const plan = buildSuccessor(snapshot, options);
  assert.deepEqual(plan.document.values, { ...current.values, tickerDeployMultiplier: 7, tickerDeployBurnBps: 2500, linkBurnBps: 1234 });
  assert.equal(plan.effectiveBitcoinWindow, '1020'); assert.equal(plan.activationHeight, '1020');
  assert.deepEqual(plan.resourceDocument, resources);
  assert.deepEqual(describeSuccessor(snapshot, plan.document, resources), plan);
  assert.deepEqual(r.effectiveSettings(current, plan.document, '10', '1019'), current);
  assert.deepEqual(r.effectiveSettings(current, plan.document, '9', '1020'), current);
  assert.deepEqual(r.effectiveSettings(current, plan.document, '10', '1020'), plan.document);
  const linkOnly = buildSuccessor(snapshot, { activationHeight: '1020', linkBurnBps: 10000 });
  assert.deepEqual(linkOnly.document.values, { ...current.values, linkBurnBps: 10000 });
  assert.deepEqual(describeSuccessor(snapshot, linkOnly.document, resources), linkOnly);
  for (const extra of [{ finderWindow: 1 }, { findBurnBps: 1900 }]) {
    assert.throws(() => describeSuccessor(snapshot, { ...plan.document, values: { ...plan.document.values, ...extra } }, resources), /unexpected_settings_change/);
  }
  for (const bad of [{ tickerDeployMultiplier: 1 }, { tickerDeployBurnBps: 0 },
    { tickerDeployMultiplier: -1, tickerDeployBurnBps: 0 }, { linkBurnBps: 10001 },
    { linkBurnBps: 1, sourceRps: 100 }, { linkBurnBps: 1, feePolicyRevision: 'a'.repeat(64), linkMultiplier: 1 },
    { linkBurnBps: 1, legacyDeployShareBps: 2001, legacyDeployPayoutMinAtoms: '1' }]) {
    assert.throws(() => buildSuccessor(snapshot, { activationHeight: '1020', ...bad }));
  }
});

test('ticker amendment CLI rejects incomplete groups and ambiguous amendments', () => {
  const base = ['--config', '/config', '--activation-height', '1020'];
  for (const args of [['--ticker-deploy-multiplier', '1'], ['--ticker-deploy-burn-bps', '0'], ['--link-burn-bps', '10001'],
    ['--link-burn-bps', '1.5'], ['--link-burn-bps', '01'], ['--link-burn-bps', '-1'],
    ['--link-burn-bps', '5', '--source-rps', '100'], ['--link-burn-bps', '5', '--proposal', '/proposal'],
    ['--link-burn-bps', '5', '--apply'], ['--link-burn-bps', '5', '--fee-policy-revision', 'a'.repeat(64), '--link-multiplier', '1']]) {
    assert.throws(() => parseArguments([...base, ...args]));
  }
  const zero = parseArguments([...base, '--ticker-deploy-multiplier', '0', '--ticker-deploy-burn-bps', '0']);
  assert.equal(zero.tickerDeployMultiplier, 0); assert.equal(zero.tickerDeployBurnBps, 0);
});

test('deployer share amendments preserve unrelated values and use the shared payout threshold', () => {
  const options = parseArguments(['--config', '/config', '--activation-height', '1020', '--deployer-share-bps', '500', '--legacy-deploy-payout-min-atoms', '100']);
  const plan = buildSuccessor(snapshot, options);
  assert.equal(plan.document.values.deployerShareBps, 500); assert.equal(plan.document.values.legacyDeployShareBps, 0);
  assert.equal(plan.document.values.legacyDeployPayoutMinAtoms, '100');
  assert.deepEqual(describeSuccessor(snapshot, plan.document, resources), plan);
  const next = { ...snapshot, current: plan.document, last: { n: '10', to: '1020' }, head: { counted: '1020' } };
  const disabled = buildSuccessor(next, { activationHeight: '1040', deployerShareBps: 0 });
  assert.deepEqual(disabled.document.values, { ...plan.document.values, deployerShareBps: 0 });
  for (const values of [{ deployerShareBps: 2001 }, { deployerShareBps: 500, legacyDeployShareBps: 1600 }, { legacyDeployPayoutMinAtoms: '0' }])
    assert.throws(() => buildSuccessor(snapshot, { activationHeight: '1020', deployerShareBps: 500, legacyDeployPayoutMinAtoms: '100', ...values }));
});

test('combined holder and ticker amendments preserve live legacy settings and both settings boundaries', () => {
  const live = { ...snapshot, current: r.settingsRevision({ network: current.network, effectiveBatch: '5', effectiveBitcoinWindow: '900',
    values: { ...current.values, legacyDeployShareBps: 1000, legacyDeployPayoutMinAtoms: '1000000000000000000' } }) };
  // Seven is a test multiplier, not an operator fee recommendation.
  const options = parseArguments(['--config', '/config', '--activation-height', r.MULTI_TICKER_HEIGHT,
    '--deployer-share-bps', '500', '--ticker-deploy-multiplier', '7', '--ticker-deploy-burn-bps', '2500', '--link-burn-bps', '1234']);
  assert.equal(options.mode, 'dry-run');
  const plan = buildSuccessor(live, options);
  assert.deepEqual(plan.document.values, { ...live.current.values, deployerShareBps: 500,
    tickerDeployMultiplier: 7, tickerDeployBurnBps: 2500, linkBurnBps: 1234 });
  assert.deepEqual(describeSuccessor(live, plan.document, resources), plan);
  assert.deepEqual(plan.resourceDocument, resources); assert.equal(plan.resourceInstallRequired, false);
  assert.deepEqual(plan.diff.settings.map(row => row.key), ['deployerShareBps', 'linkBurnBps', 'tickerDeployBurnBps', 'tickerDeployMultiplier']);
  for (const [batch, height, expected] of [['9', r.MULTI_TICKER_HEIGHT, live.current],
    ['10', String(BigInt(r.MULTI_TICKER_HEIGHT) - 1n), live.current], ['10', r.MULTI_TICKER_HEIGHT, plan.document]])
    assert.deepEqual(r.effectiveSettings(live.current, plan.document, batch, height), expected);
  for (const change of [{ finderWindow: 1 }, { findBurnBps: 1900 }, { feePolicyRevision: 'a'.repeat(64) }])
    assert.throws(() => describeSuccessor(live, { ...plan.document, values: { ...plan.document.values, ...change } }, resources), /unexpected_settings_change/);
  assert.throws(() => describeSuccessor(live, plan.document, sourceRateSuccessor(resources, 100)), /resource_changed/);
  for (const change of [{ deployerShareBps: 1001 }, { legacyDeployShareBps: 1600 }, { legacyDeployPayoutMinAtoms: '0' },
    { sourceRps: 100 }, { feePolicyRevision: 'a'.repeat(64), linkMultiplier: 1 }])
    assert.throws(() => buildSuccessor(live, { ...options, ...change }));
  const initial = buildSuccessor(snapshot, { ...options, legacyDeployShareBps: 1000, legacyDeployPayoutMinAtoms: '1000000000000000000' });
  assert.deepEqual(initial.document.values, plan.document.values);
});

test('zero link successor is refused before activation and can switch free linking back to charged', () => {
  const height = r.FREE_LINK_HEIGHT, before = String(BigInt(height) - 1n), feePolicyRevision = 'c'.repeat(64);
  const options = { activationHeight: before, feePolicyRevision, linkMultiplier: 0 };
  assert.throws(() => buildSuccessor(snapshot, options), /^Error: successor_link_multiplier$/);
  const cli = h => ['--config', '/config', '--activation-height', h, '--fee-policy-revision', feePolicyRevision, '--link-multiplier', '0'];
  assert.throws(() => parseArguments(cli(before)), /^Error: successor_link_multiplier$/);
  assert.throws(() => buildSuccessor(snapshot, parseArguments(cli(height))), /successor_link_multiplier/);
  const active = { ...snapshot, head: { counted: height }, last: { n: '9', to: height } };
  const effective = String(BigInt(height) + 20n);
  const plan = buildSuccessor(active, parseArguments(cli(effective)));
  assert.equal(plan.document.values.linkMultiplier, 0);
  assert.deepEqual(describeSuccessor(active, plan.document, plan.resourceDocument), plan);
  assert.equal(r.effectiveSettings(current, plan.document, '10', before), current);
  assert.equal(r.effectiveSettings(current, plan.document, '10', effective), plan.document);
  const next = { ...snapshot, current: plan.document, last: { n: '10', to: effective }, head: { counted: effective } };
  const paid = buildSuccessor(next, { activationHeight: String(BigInt(height) + 40n), feePolicyRevision: 'd'.repeat(64), linkMultiplier: 1 });
  assert.equal(paid.document.values.linkMultiplier, 1);
  assert.deepEqual(describeSuccessor(next, paid.document, paid.resourceDocument), paid);
  const burns = buildSuccessor(next, { activationHeight: String(BigInt(height) + 40n), linkBurnBps: 1234 });
  assert.equal(burns.document.values.linkMultiplier, 0);
});

test('bulk capacity successor changes only the batch budget and bytes at the next batch and current window', () => {
  const plan = buildSuccessor(snapshot, { bulkCapacity: true });
  assert.deepEqual(plan.diff.settings, [{ key: 'batchBytes', before: current.values.batchBytes, after: 120000 },
    { key: 'mintOperationBudget', before: current.values.mintOperationBudget, after: 128 }]);
  assert.deepEqual(plan.diff.resources, []); assert.equal(plan.resourceInstallRequired, false);
  assert.equal(plan.effectiveBatch, '10'); assert.equal(plan.effectiveBitcoinWindow, '1002'); assert.equal(plan.activationHeight, '1002');
  assert.equal(describeSuccessor(snapshot, plan.document, plan.resourceDocument).hash, plan.hash);
  assert.throws(() => describeSuccessor(snapshot, { ...plan.document, values: { ...plan.document.values, linkMultiplier: 7 } }, resources));
  assert.throws(() => buildSuccessor(snapshot, { bulkCapacity: true, activationHeight: '1020' }), /successor_capacity_arguments/);
  assert.equal(parseArguments(['--config', 'c.json', '--bulk-capacity']).bulkCapacity, true);
  assert.throws(() => parseArguments(['--config', 'c.json', '--bulk-capacity', '--send', '--confirm-hash', 'a'.repeat(64), '--admin-key', 'k', '--journal', 'j']), /successor_capacity_arguments/);
});

test('six-block payment successor is dry-run only and changes only the existing pendingBlocks setting', () => {
  const options = parseArguments(['--config', '/config', '--pending-blocks', '6']);
  const plan = buildSuccessor(snapshot, options);
  assert.equal(options.mode, 'dry-run');
  assert.deepEqual(plan.document.values, { ...current.values, pendingBlocks: 6 });
  assert.deepEqual(plan.diff.settings, [{ key: 'pendingBlocks', before: 432, after: 6 }]);
  assert.deepEqual(plan.resourceDocument, resources);
  assert.equal(plan.resourceInstallRequired, false);
  assert.deepEqual(describeSuccessor(snapshot, plan.document, resources), plan);
  for (const extra of [['--send'], ['--apply'], ['--bulk-capacity'], ['--activation-height', '1020'], ['--source-rps', '100']])
    assert.throws(() => parseArguments(['--config', '/config', '--pending-blocks', '6', ...extra]));
  for (const value of ['0', '5', '7', '432', '6.0']) assert.throws(() => parseArguments(['--config', '/config', '--pending-blocks', value]));
  const changed = structuredClone(plan.document); changed.values.finderWindow++;
  assert.throws(() => describeSuccessor(snapshot, changed, resources), /unexpected_settings_change/);
});
