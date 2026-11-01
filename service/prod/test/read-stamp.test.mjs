import test from 'node:test';
import assert from 'node:assert/strict';
import { batchReadStamp, gatewayFinancialReadStamp, checkBatchReceiptRoster } from '../reads.mjs';
import { rules } from '../../src/rules.mjs';

const hash = 'ab'.repeat(32);
for (const [source, notary] of [[973507, '973507'], ['973507', 973507], [973507, 973507],
  ['9007199254740993', '9007199254740993']]) {
  test(`batch stamp agrees across source ${typeof source} and notary ${typeof notary}: ${source}`, async () => {
    const stamp = { counted: notary, tip: notary, tipHash: hash, revision: '9', last: { n: '102' } };
    let calls = 0;
    const result = await batchReadStamp(async method => { assert.equal(method, 'stamp'); calls++; return structuredClone(stamp); },
      { stamp: async () => ({ height: source, hash }) });
    assert.equal(calls, 2);
    assert.deepEqual(result, { ...stamp, tap: { height: source, hash } });
  });
}
test('batch stamp refuses changed height, branch or notary revision', async () => {
  const stamp = { tip: '973507', tipHash: hash, revision: '9' };
  for (const tap of [{ height: 973508, hash }, { height: 973507, hash: 'cd'.repeat(32) }]) {
    await assert.rejects(batchReadStamp(async () => stamp, { stamp: async () => tap }), /read_snapshot_changed/);
  }
  let calls = 0;
  await assert.rejects(batchReadStamp(async () => ({ ...stamp, revision: ++calls === 1 ? '9' : '10' }),
    { stamp: async () => ({ height: 973507, hash }) }), /read_snapshot_changed/);
  await assert.rejects(batchReadStamp(async () => ({ ...stamp, tip: '9007199254740993' }),
    { stamp: async () => ({ height: 9007199254740992, hash }) }), /integer_v2/);
});

test('gateway financial stamp omits only the raw transport revision and retains authority', async () => {
  let revision = 9007199254740993n;
  const stamp = { counted: '973507', tip: '973507', tipHash: hash, last: { n: '102', to: '973506' } };
  const authority = { committee: 'key', epoch: '9', paused: false, pauseUntil: null };
  const preview = { ...stamp, batchRoot: hash, authority,
    admissionPolicy: { ready: true, settingsHash: hash, scheduledSettingsHash: rules.hashObject(null) } };
  const trac = async method => {
    if (method === 'financialPreviewStamp') return structuredClone(preview);
    assert.equal(method, 'stamp'); return { ...stamp, revision: String(revision++) };
  };
  const indexer = { stamp: async () => ({ height: 973507, hash }) };
  assert.deepEqual(await gatewayFinancialReadStamp(trac, indexer), { ...stamp, batchRoot: hash, authority, tap: await indexer.stamp(),
    admissionPolicy: { ready: true, settingsHash: hash, scheduledSettingsHash: rules.hashObject(null) } });
  await assert.rejects(batchReadStamp(trac, indexer), /read_snapshot_changed/, 'ordinary and signer stamps remain strict');
});

for (const field of ['counted', 'tip', 'tipHash', 'last', 'batchRoot', 'authority', 'scheduledSettings', 'extension']) {
  test(`gateway financial stamp refuses a changing ${field}`, async () => {
    const stamp = { counted: '973507', tip: '973507', tipHash: hash, last: { n: '102' }, batchRoot: hash,
      authority: { epoch: '9' }, admissionPolicy: { scheduledSettingsHash: hash }, extension: 'old' };
    let changed = false;
    const changes = { counted: { counted: '973508' }, tip: { tip: '973508' }, tipHash: { tipHash: 'cd'.repeat(32) },
      last: { last: { n: '103' } }, batchRoot: { batchRoot: 'cd'.repeat(32) }, authority: { authority: { epoch: '10' } },
      scheduledSettings: { admissionPolicy: { scheduledSettingsHash: 'cd'.repeat(32) } }, extension: { extension: 'new' } };
    const trac = async method => {
      assert.equal(method, 'financialPreviewStamp'); return { ...stamp, ...(changed ? changes[field] : {}) };
    };
    await assert.rejects(gatewayFinancialReadStamp(trac, { stamp: async () => {
      changed = true; return { height: 973507, hash };
    } }), /read_snapshot_changed/);
  });
}

test('gateway financial stamp still requires canonical TAP height and hash', async () => {
  const trac = async method => {
    assert.equal(method, 'financialPreviewStamp'); return { counted: '973507', tip: '973507', tipHash: hash, last: { n: '102' } };
  };
  for (const tap of [{ height: 973508, hash }, { height: 973507, hash: 'cd'.repeat(32) }]) {
    await assert.rejects(gatewayFinancialReadStamp(trac, { stamp: async () => tap }), /read_snapshot_changed/);
  }
});

test('activated receipt pins match only signer identities while legacy rosters remain exact', () => {
  const members = Array.from({ length: 5 }, (_, i) => ({ id: 'operator' + (i + 1), identity: String(i + 1).repeat(64),
    encryption: 'ab'.repeat(32), url: 'http://127.0.0.1:' + (58330 + i) }));
  const config = { committee: members.map(peer => ({ peer })) };
  const receiptSigners = members.map(({ id, identity }) => ({ id, identity }));
  checkBatchReceiptRoster(config, { document: {}, receiptSigners });
  checkBatchReceiptRoster(config, { receiptSigners: members });
  assert.throws(() => checkBatchReceiptRoster(config, { receiptSigners }), /receipt_roster_changed/);
  for (const changed of [receiptSigners.slice(1), receiptSigners.toReversed(),
    receiptSigners.map((m, i) => i ? m : { ...m, identity: 'ff'.repeat(32) }),
    receiptSigners.map((m, i) => i ? m : { ...m, id: 'other' }), members]) {
    assert.throws(() => checkBatchReceiptRoster(config, { document: {}, receiptSigners: changed }), /receipt_roster_changed/);
  }
  const old = members.map(m => ({ ...m, identity: 'cd'.repeat(32) }));
  checkBatchReceiptRoster({ ...config, rosterHistory: [{ members: old }] },
    { document: {}, receiptSigners: old.map(({ id, identity }) => ({ id, identity })) });
});
