import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { secp256k1 } from '../../contract/node_modules/@noble/curves/secp256k1.js';
import { harness, deployment, committeeSecret, alice } from '../../contract/tests/helpers/harness.mjs';
import { checkpoint, chain, parseHeader } from '../../contract/tests/helpers/chain.mjs';
import { accountKey, accountTree } from '../../contract/account-tree.js';
import { rules as r, initialState } from '../src/rules.mjs';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Outbox } from '../src/transport.mjs';
import { prepareTerminalImport } from '../src/terminal-import.mjs';
import { installGatewayActivation } from '../src/v2-runtime.mjs';
import { FinancialExecution, buildFinancialExecution } from '../src/financial-execution.mjs';
import { recoveryBatch } from '../../rules/src/recovery-batch.js';
import { RecoveryCoordinator } from '../src/recovery-coordinator.mjs';
import { financialInventoryPage } from '../src/financial-inventory.mjs';
import { installRecoverySources } from '../src/financial-recovery-sources.mjs';
import { installFinancialChain } from '../src/financial-chain.mjs';
import { Policy } from '../../committee/signer/policy.mjs';
import { preflightBatch } from '../../committee/signer/preflight.mjs';
import { temp, network, fixtureHistory } from './helpers.mjs';

for (const scenario of ['complete', 'abort', 'refork']) test(`native coordinator ${scenario} through five policies after restart`, async t => {
  const abandon = scenario === 'abort';
  const directory = await temp('mg3-recovery-'), history = fixtureHistory(30), legacy = harness({ ...deployment, network });
  await legacy.advance(9); assert.equal(await legacy.batch([{ op: 'mk', to: alice.address, asset: 'p0', amount: '100' }]), null); await legacy.advance(1);
  const imported = prepareTerminalImport({ records: legacy.db, height: 10 });
  const document = r.settingsRevision({ network, effectiveBatch: '2', effectiveBitcoinWindow: '10', values: { ...r.SETTINGS_PROFILE, recoveryHeaders: 3, paymentPage: 2 } });
  const manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '2', previousBatchRoot: legacy.db.get('bt/1'),
    bitcoinAnchor: { height: '10', hash: history.hashAt(10) }, settingsHash: r.hashObject(document), catalogRoot: r.namedStateRoot(r.emptyNamedDiscovery()),
    accountsRoot: imported.financialRoot, receiptSegmentStart: '0', schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const manifestHash = r.hashObject(manifest), contract = harness({ ...deployment, network, v2: { manifest, manifestHash, document, importRoot: imported.importRoot, importRows: imported.importRows } });
  for (const page of imported.pages) assert.equal(await contract.run('ad_import', page), null);
  const archiveKey = accountKey('bitcoin-checkpoint', '0'), archive = accountTree(new Map([[archiveKey, checkpoint]]));
  contract.db.set('s/beaconRecovery', { version: 2, archiveRoot: archive.root });
  const oldAnchor = { bitcoin: { height: '10', hash: history.hashAt(10) }, ethereum: null }; contract.db.set('fp/chain', oldAnchor);
  const retained = new Map([
    ['fc/' + r.hash('credit'), { owner: alice.address, revision: '0', fees: [{ key: r.hash('fee'), amount: '7' }] }],
    ['bc/' + r.hash('custody'), { owner: alice.address, amount: '9', state: 'claimable' }],
    ['fd/' + r.hash('generation'), { maximum: '100', reserved: '3', minted: '2' }],
    ['fm/capacity/' + r.hash('deployment'), '3'], ['fi/deployment/legacy', '4'],
    ['fi/request/' + r.hash('imported-permit'), { permitHash: r.hash('unchanged-permit') }], ['fl/slot/42', null],
  ]);
  for (const [key, value] of retained) contract.db.set(key, value);
  let alternative = chain(12, checkpoint, 601, 77);
  const canonical = new Map([['0', checkpoint.hash], ...alternative.map((raw, i) => [String(i + 1), parseHeader(raw).hash])]);
  const target = { height: '12', hash: canonical.get('12') };
  let store = await Store.open(directory); t.after(() => store.close());
  await store.put('meta', 'ruleState', initialState(10, history.hashAt(10), 9));
  await installGatewayActivation({ store, manifest, manifestHash, document, imported, named: r.emptyNamedDiscovery() });
  await store.put('accountRecords', 'fp/chain', oldAnchor);
  await store.put('observations', 'saved-receipt-segment', { preserve: true });
  const original = store.get('meta', 'ruleState').claimSnapshot, account = contract.db.get('ar/' + alice.address);
  const stamp = async () => { const head = await contract.state().head(); return { counted: head.counted, tip: head.tip.height, tipHash: head.tip.hash,
    revision: contract.metrics.puts, last: await contract.state().batchLast() }; };
  const makeReads = () => {
    const reads = { batchStamp: stamp, authority: async () => ({ network, committee: deployment.committee, epoch: 0 }),
      batchRoot: async n => contract.db.get('bt/' + n) ?? null, financialRecord: async key => contract.db.get(key) ?? null,
      financialBeaconConfig: async () => contract.options, financialCanonicalBitcoinHash: async height => canonical.get(String(height)), financialCanonicalTip: async () => target,
      financialRecordProvenance: async () => ({ anchor: oldAnchor }),
      rulesContext: async () => ({ ready: true, ruleset: 'dmw-v2', manifest, manifestHash, settings: document, settingsHash: r.hashObject(document),
        last: await contract.state().batchLast(), catalogRoot: contract.db.get('v2/catalog'), claimsRoot: contract.db.get('v2/claims') }),
      preflight: (batch, at) => preflightBatch(batch, at, { read: key => contract.db.get(key), deployment: contract.options }),
      financialInventoryPage: range => financialInventoryPage({ async *createReadStream({ gte, gt, lt, limit }) {
        let count = 0; for (const [key, value] of [...contract.db].sort(([a], [b]) => a < b ? -1 : 1)) if (key >= gte && (!gt || key > gt) && key < lt && count++ < limit) yield { key, value };
      } }, range, { paymentPage: 2 }),
      financialRecoveryHeaders: async (from, _target, limit) => {
        assert.equal(limit, document.values.recoveryHeaders); return alternative.slice(Number(from), Number(from) + limit);
      } };
    installRecoverySources(reads); installFinancialChain(reads, { bitcoinHash: async height => canonical.get(String(height)), canonicalBitcoinHash: async height => canonical.get(String(height)) });
    reads.financialEvidence = (transition, at) => transition.type === 'beacon-recovery' ? reads.financialBeaconEvidence(transition.operation, at) : reads.financialRecoveryEvidence(transition.action, at);
    return reads;
  };
  const reads = makeReads(), policies = Array.from({ length: 5 }, () => new Policy({ network, publicKey: deployment.committee, reads: makeReads() }));
  const approvals = new Map(), proposals = [];
  const committee = { signature: async (_key, proposal) => {
    proposals.push(structuredClone(proposal));
    for (const policy of policies) await policy.approve(proposal);
    approvals.set(proposal.batch.n, (approvals.get(proposal.batch.n) ?? 0) + 1);
    return { signature: { compact: secp256k1.sign(r.batchDigest(network, proposal.batch), committeeSecret, { lowS: true, prehash: false }).toCompactHex() } };
  } };
  const create = () => {
    // Normal runtime refresh pauses during recovery. A cached older document
    // must not override the independently read effective recovery limits.
    const cached = r.settingsRevision({ network, effectiveBatch: '2', effectiveBitcoinWindow: '10',
      values: { ...document.values, recoveryHeaders: 4, paymentPage: 3 } });
    const financial = new FinancialExecution({ store, reads, document: cached }), files = new Files(join(directory, 'static'));
    const outbox = new Outbox({ store, fallbackMs: 100000, retryMs: 0, transport: { prepareMessage: async (op, value) => ({ op, value }),
      sendMessage: async message => {
        assert.equal(await contract.run(message.op, message.value), null);
        for (const write of store.get('meta', 'financialRecoveryDraft').writes) if (write.space === 'accountRecords')
          assert.deepEqual(contract.db.get(write.id) ?? null, write.value ?? null, write.id);
      },
      status: async job => ({ state: contract.db.get('bt/' + job.value.n) === job.value.root ? 'accepted' : 'pending' }) } });
    return new RecoveryCoordinator({ store, reads, financial, committee, files, outbox, network });
  };
  let coordinator = create();
  await assert.rejects(coordinator.begin({ anchor: checkpoint, proof: { empty: true }, target }), /account_(proof|key)|recovery_anchor_proof/);
  assert.equal(coordinator.active(), null);
  const begun = await coordinator.begin({ anchor: checkpoint, proof: archive.prove([archiveKey]), target });
  const transact = store.transact.bind(store); let lose = true;
  store.transact = async changes => {
    if (lose && changes.some(c => c.space === 'meta' && c.id === 'financialRecoveryDraft' && c.value === undefined)) { lose = false; throw Error('simulated_gateway_loss'); }
    return transact(changes);
  };
  await assert.rejects(coordinator.tick(), /simulated_gateway_loss/);
  await store.close(); store = await Store.open(directory); coordinator = create();
  let intervened = false, reforked = false;
  for (let n = 0; coordinator.active() && n < 100; n++) {
    const row = contract.db.get('fr/' + begun.id);
    if (!intervened && row?.state === 'approved') {
      intervened = true;
      if (abandon) canonical.set('12', r.hash('replacement-canonical-tip'));
      else {
        // An independently accepted batch may advance the notary between
        // approval and adoption. Reconcile its real effects/checkpoint first.
        const at = await stamp(), other = r.hash('intervening-stage'), state = store.get('meta', 'ruleState');
        const result = await buildFinancialExecution({ store, reads, document, height: at.counted, at, transitions: [{ type: 'beacon-recovery', id: other,
          operation: { op: 'br', v: 2, type: 'begin', id: other, anchor: checkpoint, proof: archive.prove([archiveKey]), previous: at.tipHash } }] });
        const built = recoveryBatch({ network, epoch: '0', at, previous: await reads.batchRoot(at.last.n), context: await reads.rulesContext(), document,
          snapshot: state.claimSnapshot, inputs: result.inputs, executionHash: await reads.financialNotaryHashAt(at.counted, at) });
        const signed = await committee.signature('intervening', { network, kind: 'batch', recovery: true, batch: built.batch, files: [built.encoded] });
        assert.equal(await contract.run('bt', { ...built.batch, sig: signed.signature.compact }), null);
        await store.transact([...result.writes, { space: 'meta', id: 'ruleState', value: { ...state, ...built.snapshot.hot,
          claimSnapshot: built.snapshot, claimRoot: built.batch.claims, accountRoot: built.batch.accounts } }]);
      }
    }
    if (scenario === 'refork' && !reforked && contract.db.get('br/' + begun.id + '/meta')?.state === 'adopted') {
      reforked = true; alternative = chain(14, checkpoint, 602, 99);
      alternative.forEach((raw, i) => canonical.set(String(i + 1), parseHeader(raw).hash));
    }
    await coordinator.tick();
  }
  assert.equal(intervened, true);
  assert.equal(coordinator.active(), null);
  assert.equal(store.get('financialRecoveries', begun.id).state, abandon ? 'aborted' : 'complete');
  assert.equal((await contract.state().head()).tip.hash, abandon ? oldAnchor.bitcoin.hash : target.hash);
  assert.deepEqual(contract.db.get('ar/' + alice.address), account);
  assert.deepEqual(store.get('observations', 'saved-receipt-segment'), { preserve: true });
  const saved = store.get('meta', 'ruleState').claimSnapshot;
  assert.deepEqual({ ...saved.hot, observation: original.hot.observation }, original.hot);
  assert.deepEqual(saved.maps, original.maps);
  assert.equal((await contract.state().batchLast()).to, '9');
  assert.equal(contract.db.get('fr/active'), null);
  assert.deepEqual(contract.db.get('fp/chain'), abandon ? oldAnchor : { bitcoin: target, ethereum: null });
  assert.ok(proposals.some(p => p.batch.ops.some(op => op.action?.type === (abandon ? 'recovery-abort' : 'recovery-refresh'))));
  for (const [key, value] of retained) {
    assert.deepEqual(contract.db.get(key), value);
    assert.equal(!!contract.db.get('fq/' + key), value !== null && !key.startsWith('fi/'));
  }
  assert.ok([...approvals.values()].every(n => n === 1));
  const altered = structuredClone(proposals.at(-1)); altered.batch.catalog = r.hash('substituted-catalog');
  await assert.rejects(policies[0].approve(altered));
  if (scenario === 'refork') {
    assert.equal(reforked, true);
    await assert.rejects(reads.financialChainAnchor({ at: await stamp(), prior: contract.db.get('fp/chain') }), /financial_chain_recovery_required/);
    const next = { height: '14', hash: canonical.get('14') };
    const resumed = await coordinator.begin({ anchor: checkpoint, proof: archive.prove([archiveKey]), target: next });
    assert.notEqual(resumed.id, begun.id);
    for (let n = 0; coordinator.active() && n < 100; n++) await coordinator.tick();
    assert.equal(coordinator.active(), null);
    assert.deepEqual(contract.db.get('fp/chain'), { bitcoin: next, ethereum: null });
    for (const [key, value] of retained) assert.deepEqual(contract.db.get(key), value);
  }
});

test('recovery draft retirement preserves ambiguity, acceptance and every archived packet', async t => {
  const store = await Store.open(await temp('mg3b-recovery-draft-')); t.after(() => store.close());
  const old = { counted: '10', last: { n: '1', to: '9' }, revision: '1', tip: '10', tipHash: r.hash('tip') };
  let at = { ...old }, root = null;
  const reads = { batchStamp: async () => at, batchRoot: async () => root, authority: async () => ({ epoch: '0' }) };
  const coordinator = new RecoveryCoordinator({ store, reads, committee: {}, financial: {}, network });
  const draft = { at: old, proposal: { batch: { n: '2', epoch: '0', deadline: '20', root: r.hash('batch') } } }, key = 'batch/0/2';
  const put = value => store.put('meta', 'financialRecoveryDraft', value);
  await put(draft); at = { ...old, revision: '2' };
  assert.equal(await coordinator.reconcile(draft), null);
  assert.deepEqual(store.get('financialRecoveryRetired', r.hashObject(draft.proposal.batch)).draft, draft);
  const signed = { ...draft, signature: '1'.repeat(128) };
  await put(signed); await store.put('ceremonies', key, { stage: 'running', id: 'original' });
  assert.deepEqual(await coordinator.reconcile(signed), signed);
  assert.deepEqual(store.get('ceremonies', key), { stage: 'running', id: 'original' });
  at = { ...at, counted: '21' }; root = signed.proposal.batch.root;
  assert.deepEqual(await coordinator.reconcile(signed), signed);
  root = r.hash('conflicting-accepted-batch');
  await assert.rejects(coordinator.reconcile(signed), /financial_recovery_batch_conflict/);
  assert.deepEqual(store.get('meta', 'financialRecoveryDraft'), signed);
  root = null;
  assert.equal(await coordinator.reconcile(signed), null);
  const retired = store.get('financialRecoveryRetired', r.hashObject(draft.proposal.batch));
  assert.equal(retired.proof.reason, 'deadline_expired');
  assert.deepEqual(retired.draft, signed); assert.deepEqual(retired.ceremony, { stage: 'running', id: 'original' });
  assert.equal(store.get('ceremonies', key), null);
});
