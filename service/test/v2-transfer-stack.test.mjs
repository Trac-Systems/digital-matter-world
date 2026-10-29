import test from 'node:test';
import assert from 'node:assert/strict';
import { v2StackFixture } from './v2-stack-fixture.mjs';
import { AccountExecution } from '../src/account-batch.mjs';
import { AccountAvailability } from '../src/account-availability.mjs';
import { accountKey, readAccountLeaf } from '../../contract/account-tree.js';
import { accountActionDigest } from '../../contract/root-accounts.js';
import { createPublicAPI } from '../src/public-api.mjs';
import { Feeds } from '../src/feeds.mjs';
import { signBytes } from '../../kit/lib/signing.mjs';
import * as r from '../../rules/src/index.js';

test('local v2 stack retains kit transfers while gateway and five signers reject unsupported admission', { timeout: 180000 }, t =>
  v2StackFixture(t, { scenario: async s => {
    const { players, history, legacyRecord, store, files, contract, document, drain } = s;
    const [A, B] = players.map(p => p.agent);
    const balance = (owner, asset) => {
      const record = contract.db.get('ar/' + owner); if (!record) return '0';
      const key = accountKey('balance', asset), proof = new AccountAvailability(store).prove(record.root, [key]);
      return readAccountLeaf(record.root, proof, key)?.available ?? '0';
    };
    A.trac.balance = async (owner, asset) => balance(owner, asset);
    await A.claim({ event: { window: s.tip, hash: history.hashAt(s.tip) }, plots: [{ block: 1, patterns: [0] }], history,
      patterns: [{ ...legacyRecord, number: 0 }] });
    await drain(); await s.advance(1012); await s.runtime.intake.seal(); await drain();
    assert.equal(balance(A.owner, 'p0'), '1'); assert.equal(balance(A.owner, 'p2:0'), '0');
    assert.equal(balance(B.owner, 'p0'), '0');
    const before = structuredClone([...contract.db]);
    const request = { actionId: 'send-one', op: 'tf', value: { to: B.address, assets: [['p0', '1']] } };
    await assert.rejects(A.transaction(request), { code: 'transfer_v2_unavailable', prepared: true, sent: false });
    const saved = A.journal.get('tx/send-one/v2-intent'); assert.equal(saved.state, 'prepared');
    await assert.rejects(A.transaction(request), { code: 'transfer_v2_unavailable' });
    assert.deepEqual(A.journal.get('tx/send-one/v2-intent'), saved);
    assert.deepEqual([...contract.db], before, 'preparation never changes accepted balances');

    // The existing account engine can build this exact packet, but it is not
    // an admitted batch. Keep its writes isolated from the accepted store.
    const execution = new AccountExecution({ store, document, height: String(s.tip) });
    await execution.accounts(saved.body.actions); const built = execution.result();
    assert.equal(built.writes.find(w => w.space === 'publicBalances' && w.id === A.owner + '/p0').value.amount, '0');
    assert.equal(built.writes.find(w => w.space === 'publicBalances' && w.id === B.owner + '/p0').value.amount, '1');
    assert.deepEqual([...contract.db], before);

    const move = { v: 2, ruleset: 'dmw-v2', settingsRevision: document.revision, settingsHash: r.hashObject(document), network: s.network,
      a: A.owner, t: 'craft-v2', b: String(s.tip), h: history.hashAt(s.tip),
      p: { recipe: 'fusion', snapshot: { height: String(s.tip), hash: history.hashAt(s.tip) }, action: saved.body.actions[0] }, w: '0' };
    move.sig = signBytes(A.wallet, r.moveDigestV2(move));
    await assert.rejects(A.service.submit(move, { hashAt: history.hashAt }), /craft_authorization/);
    assert.equal(store.count('namedDedupe'), 1, 'rejected transfer creates no receipt');

    let refusals = 0; const signature = s.committee.signature;
    s.committee.signature = async (...args) => {
      if (!refusals) refusals = (await s.rejectAccountOperations(args[1], built.operations)).length;
      return signature(...args);
    };
    await s.advance(1013);
    await A.claim({ event: { window: s.tip, hash: history.hashAt(s.tip) }, plots: [{ block: 11, patterns: [0] }], history,
      patterns: [{ ...legacyRecord, number: 0 }] });
    await drain();
    assert.equal(refusals, 5, 'each independent HTTP signer refuses the transfer account operation');
    assert.equal(balance(A.owner, 'p0'), '1'); assert.equal(balance(B.owner, 'p0'), '0');
    assert.deepEqual(A.journal.get('tx/send-one/v2-intent'), saved);

    const feeds = new Feeds({ store, files, history, reads: {} });
    for (let i = 0; store.count('feedEvents') && i < 100; i++) await feeds.events();
    assert.equal(store.count('feedEvents'), 0);
    const publicAPI = createPublicAPI({ views: { store }, files });
    const sender = await publicAPI.read(`/accounts/${A.owner}/balances/p0`);
    assert.equal(readAccountLeaf(sender.account.root, sender.proof, accountKey('balance', 'p0')).available, '1');
    assert.equal(store.get('publicBalances', B.owner + '/p0'), null);
    const events = await publicAPI.read('/events?type=transfer');
    assert.deepEqual(events.events, [], 'unaccepted transfer must never appear as a completed event');
    const historyPage = await publicAPI.read(`/agents/${A.address}/history?type=transfer`);
    assert.deepEqual(historyPage.history, []);
  } }));

test('activated p2 transfer is accepted by five signers, projects both histories and funds the recipient mint', { timeout: 180000 }, async t => {
  const { firstMintFixture } = await import('./first-mint-fixture.mjs');
  await v2StackFixture(t, { finderWindow: 2, scenario: async s => {
    const { players, history, store, files, contract, document, drain, network } = s;
    const [A, B] = players.map(p => p.agent);
    const leaf = (owner, asset) => {
      const record = contract.db.get('ar/' + owner); if (!record) return null;
      const key = accountKey('balance', asset);
      return readAccountLeaf(record.root, new AccountAvailability(store).prove(record.root, [key]), key);
    };
    for (const agent of [A, B]) agent.trac.balance = async (owner, asset) => leaf(owner, asset)?.available ?? '0';
    const witnesses = { anchor: { height: '1010', hash: history.hashAt(1010) }, matches: [1, 2, 3].map(h => ({ height: String(h), hash: history.hashAt(h), count: '1' })) };
    await A.propose({ actionId: 'transfer-pattern', proposal: players[0].proposal, history, witnesses }); await drain();
    await s.advance(1012); await A.reveal({ actionId: 'transfer-pattern', history }); await drain();
    const pattern = store.list('patternsByAsset', { limit: 20 }).map(x => x.value).find(p => p.name === players[0].proposal.name);
    const asset = 'p2:' + pattern.number;
    await A.claim({ event: { window: s.tip, hash: history.hashAt(s.tip) }, plots: [{ block: 2, patterns: [Number(pattern.number)] }],
      history, patterns: [{ ...pattern, number: Number(pattern.number) }] }); await drain();
    await s.advance(1014); await s.runtime.intake.seal(); await drain();
    assert.equal(leaf(A.owner, asset).available, '1'); assert.equal(leaf(B.owner, asset), null);
    const find = store.get('finds', r.findIdV2('2', pattern.number));
    assert.equal(r.mintRight({ find, owner: B.owner, counted: '1014' }).allowed, false);
    const request = { actionId: 'p2-send', op: 'tf', value: { to: B.address, assets: [[asset, '1']] } };
    await assert.rejects(A.transaction(request), { code: 'transfer_v2_unavailable' });
    const intent = A.journal.get('tx/p2-send/v2-intent');
    const historical = store.list('batches', { limit: 1000 }).filter(row => row.value.batch.v === 2).map(row => row.value.batch.n);
    const successor = r.settingsRevision({ network, previous: document,
      effectiveBatch: r.addUint((await contract.state().batchLast()).n, '2'), effectiveBitcoinWindow: '1016',
      values: { ...document.values, ...r.PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '1017', publicMintLegacyFinderWindow: document.values.finderWindow } });
    assert.equal(await contract.run('ad_settings', { document: successor }), null);
    await s.advance(1015); assert.equal(await contract.run('ad_apply', { id: 'settings' }), null);
    await s.advance(1016); assert.equal(contract.db.get('v2/settings').revision, successor.revision);
    await assert.rejects(A.transaction(request), { code: 'transfer_v2_unavailable' });
    const raw = { v: 2, ruleset: 'dmw-v2', settingsRevision: successor.revision, settingsHash: r.hashObject(successor), network,
      a: A.owner, t: 'transfer-v2', b: String(s.tip), h: history.hashAt(s.tip), p: { actions: intent.body.actions }, w: '0' };
    raw.sig = signBytes(A.wallet, r.moveDigestV2(raw));
    await assert.rejects(A.service.submit(raw, { hashAt: history.hashAt }), /transfer_v2_unavailable/);
    await s.advance(1017);
    for (const n of historical) {
      const replay = await s.replayAccepted(n);
      assert.ok(replay.files.every(file => !Object.hasOwn(file, 'transfers')));
    }
    assert.ok(historical.length >= 4, 'replay the pre-activation discovery and settlement batches byte for byte');
    const sendAction = async (action, resign = true) => {
      const signed = { ...action };
      if (resign) signed.sig = signBytes(A.wallet, accountActionDigest(network, signed));
      const move = { ...raw, b: String(s.tip), h: history.hashAt(s.tip), p: { actions: [signed] } };
      move.sig = signBytes(A.wallet, r.moveDigestV2(move));
      return A.service.submit(move, { hashAt: history.hashAt });
    };
    const acceptedBefore = store.count('namedDedupe'), a = intent.body.actions[0];
    for (const [change, resign, reason] of [
      [{ amount: '2', nonce: r.hash('overspend') }, true, /account_insufficient/],
      [{ amount: '2' }, false, /transfer_authorization/],
      [{ revision: '0', nonce: r.hash('stale-revision') }, true, /account_signature/],
      [{ until: '1016', nonce: r.hash('expired') }, true, /transfer_authorization/],
      [{ amount: '0' }, true, /transfer_assets/]
    ]) {
      await assert.rejects(sendAction({ ...a, ...change }, resign), reason);
      assert.equal(store.count('namedDedupe'), acceptedBefore, 'refused actions issue no receipt');
      assert.equal(leaf(A.owner, asset).available, '1');
    }
    const beforeSupply = structuredClone(contract.db.get('ar/supply'));
    const result = await A.transaction(request); assert.equal(result.state, 'received');
    assert.deepEqual(A.journal.get('tx/p2-send/v2-intent'), intent, 'activation reuses the exact pre-activation signed intent');
    assert.equal(leaf(A.owner, asset).available, '1', 'receipt alone does not spend');
    await assert.rejects(sendAction({ ...a, nonce: r.hash('pending-double-spend') }), /account_insufficient/);
    assert.equal(store.count('namedDedupe'), acceptedBefore + 1, 'pending debit is reserved before another receipt');
    let refusals = 0; const signature = s.committee.signature;
    s.committee.signature = async (...args) => {
      const op = args[1].batch.ops.find(o => o.actions?.some(a => a.type === 'transfer'));
      if (op && !refusals) refusals = (await s.rejectAccountOperations(args[1], [op])).length;
      return signature(...args);
    };
    await drain(); assert.equal(refusals, 5);
    assert.equal(leaf(A.owner, asset), null); assert.equal(leaf(B.owner, asset).available, '1');
    assert.deepEqual(contract.db.get('ar/supply'), beforeSupply);
    await assert.rejects(sendAction({ ...a, revision: contract.db.get('ar/' + A.owner).revision }), /account_replay/);
    assert.equal(store.get('publicBalances', A.owner + '/' + asset).amount, '0');
    assert.equal(store.get('publicBalances', B.owner + '/' + asset).amount, '1');
    assert.equal((await A.transaction(request)).replayed, true);
    assert.deepEqual(A.journal.get('tx/p2-send/v2-intent'), intent);
    assert.deepEqual(r.mintRight({ find, owner: B.owner, counted: String(s.tip) }), { allowed: true, role: 'public', until: null });
    const feeds = new Feeds({ store, files, history, reads: {} });
    const project = async () => { for (let i = 0; store.count('feedEvents') && i < 1000; i++) await feeds.events(); assert.equal(store.count('feedEvents'), 0); };
    const acceptedEvents = store.list('feedEvents', { limit: 1000 }).filter(row => row.value.transfers?.length);
    await project();
    const api = createPublicAPI({ views: { store }, files });
    const events = await api.read('/events?type=transfer'); assert.equal(events.events.length, 1);
    for (const agent of [A, B]) {
      const page = await api.read(`/agents/${agent.address}/history?type=transfer`);
      assert.equal(page.history.length, 1); assert.equal(page.history[0].id, events.events[0].id);
      const balance = await api.read(`/accounts/${agent.owner}/balances/${asset}`);
      assert.equal(readAccountLeaf(balance.account.root, balance.proof, accountKey('balance', asset))?.available ?? '0', agent === A ? '0' : '1');
    }
    for (const row of acceptedEvents) await store.put('feedEvents', row.id, row.value);
    const restartedFeeds = new Feeds({ store, files, history, reads: {} });
    await restartedFeeds.events();
    assert.equal((await api.read('/events?type=transfer')).events.length, 1, 'completed events remain deduplicated after restart');
    const expiring = { type: 'transfer', owner: B.owner, to: A.owner, asset, amount: '1',
      revision: contract.db.get('ar/' + B.owner).revision, nonce: r.hash('delayed-transfer-expiry'), until: String(s.tip) };
    expiring.sig = signBytes(B.wallet, accountActionDigest(network, expiring));
    const delayed = { ...raw, a: B.owner, b: String(s.tip), h: history.hashAt(s.tip), p: { actions: [expiring] } };
    delayed.sig = signBytes(B.wallet, r.moveDigestV2(delayed));
    await B.service.submit(delayed, { hashAt: history.hashAt });
    await s.advance(s.tip + 1);
    const delayedBatch = store.get('namedAccepted', r.moveIdV2(delayed)).batch;
    const rejected = await s.replayAccepted(delayedBatch);
    assert.equal(rejected.files.flatMap(file => file.moves).find(row => r.moveIdV2(row.move) === r.moveIdV2(delayed)).reason, 'transfer_authorization');
    assert.equal(leaf(B.owner, asset).available, '1', 'expired acknowledged transfer cannot spend or block later batches');
    assert.equal(leaf(A.owner, asset), null);
    await project(); assert.equal((await api.read('/events?type=transfer')).events.length, 1);
    let reserved = false;
    await firstMintFixture(t, { ...s, document: successor, agent: B, catalogAsset: asset, block: '2', finderExpected: false,
      afterReserve: ({ id }) => {
        assert.equal(contract.db.get('ao/' + id).owner, B.owner);
        assert.equal(contract.db.get('ao/' + id).state, 'reserved');
        assert.deepEqual(leaf(B.owner, asset), { available: '0', held: '1' }); reserved = true;
      } });
    assert.equal(reserved, true);
  } });
});
