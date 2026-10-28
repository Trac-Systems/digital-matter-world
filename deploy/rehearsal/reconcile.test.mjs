import test from 'node:test';
import assert from 'node:assert/strict';
import { operatorExportBytes, reconcileOperatorExports } from './reconcile.mjs';
import { terminalRecordsRoot } from '../../service/src/pending-financial.mjs';
import { rules as r, initialState } from '../../service/src/rules.mjs';
import { network, gateway, agent, signEd, fixtureHistory } from '../../service/test/helpers.mjs';
import { harness, deployment } from '../../contract/tests/helpers/harness.mjs';

async function fixture() {
  const old = harness({ ...deployment, network }); await old.advance(9); assert.equal(await old.batch([]), null); await old.advance(8);
  const history = fixtureHistory(20), anchor = { height: '17', hash: history.hashAt(17) };
  const document = r.settingsRevision({ network, effectiveBatch: '2', effectiveBitcoinWindow: '17', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
  const batch = { v: 1, epoch: 0, n: 2, from: 10, to: 10, deadline: 16, root: r.hash('unsigned-draft-root'), ops: [] };
  const gatewayRows = [['meta', 'draft', { proposal: { batch } }], ['meta', 'ruleState', initialState(10, history.hashAt(9), 9)]];
  const members = Array.from({ length: 5 }, (_, i) => ({ id: 'operator' + (i + 1), ...agent(2400 + i) }));
  const body = { version: 1, network, gateway, anchor, document, legacySettings: {}, gatewayRows,
    headersHash: r.hash('independently captured public headers'), notary: { options: old.options, records: [...old.db] }, reservations: [] };
  const exports = members.map((m, i) => {
    const own = structuredClone({ ...body, signer: m.id, reservations: i < 3 ? [{ slots: ['batch/0/2'], digest: r.bytesToHex(r.batchDigest(network, batch)), details: { n: 2, deadline: 16 } }] : [] });
    return { ...own, signature: signEd(operatorExportBytes(own), m.secret) };
  });
  const expected = { network, gateway, anchor, settingsHash: r.hashObject(document), legacySettings: {}, headersHash: body.headersHash,
    notaryRoot: terminalRecordsRoot(old.db), gatewayRoot: r.hashObject(['dmw-legacy-gateway-v1', gatewayRows]) };
  return { exports, roster: members.map(({ id, address }) => ({ id, identity: address })), expected, historyFor: () => fixtureHistory(20), members };
}
test('five signed operator exports derive their own pending/import roots; three reservations and two absences agree', async () => {
  const f = await fixture(), result = reconcileOperatorExports(f);
  assert.equal(result.reconciled, true); assert.equal(result.operators.length, 5);
  assert.equal(new Set(result.operators.map(o => o.exportHash)).size, 5);
  assert.equal(new Set(result.operators.map(o => o.roots.importRoot)).size, 1);
  assert(result.roots.pendingRoot);
});
test('one stale/tampered/operator-substituted export prevents a reconciled snapshot', async () => {
  const f = await fixture();
  const altered = structuredClone(f.exports); altered[4].gatewayRows[1][2].discoveryCommits = [{ agent: agent(9).address, commitment: r.hash('omitted'), tip: 8 }];
  assert.throws(() => reconcileOperatorExports({ ...f, exports: altered }), /reconcile_operator_signature/);
  const { signature, ...body } = altered[4]; altered[4].signature = signEd(operatorExportBytes(body), f.members[4].secret);
  assert.throws(() => reconcileOperatorExports({ ...f, exports: altered }), /reconcile_source_disagreement/);
  assert.throws(() => reconcileOperatorExports({ ...f, exports: [...f.exports.slice(0, 4), f.exports[0]] }), /reconcile_five_operators/);
  assert.throws(() => reconcileOperatorExports({ ...f, roster: f.roster.map(m => ({ ...m, identity: f.roster[0].identity })) }), /reconcile_five_operators/);
});
