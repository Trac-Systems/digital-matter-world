import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { secp256k1 } from '../../kit/node_modules/@noble/curves/secp256k1.js';
import { p2tr } from '../../kit/node_modules/@scure/btc-signer/index.js';
import { buildInscription, signCommit } from '../../kit/lib/inscription-core.mjs';
import * as r from '../../rules/src/index.js';
import { publicScanKey, publicRefundKey } from '../../contract/public-mint.js';
import { Feeds } from '../src/feeds.mjs';
import { v2StackFixture } from './v2-stack-fixture.mjs';
import { firstMintFixture } from './first-mint-fixture.mjs';

test('settings activate permanent claims and ordered public takes through gateway and five HTTP signers', { timeout: 180000 }, t =>
  v2StackFixture(t, { finderWindow: 2, settingsValues: { ...r.PUBLIC_MINT_SETTINGS,
    publicMintActivationHeight: '1010', publicMintLegacyFinderWindow: 2 }, scenario: async s => {
    const { store, files, contract, history, players, document, drain, legacyRecord } = s;
    const agent = players[7].agent, pattern = { ...legacyRecord, number: 0 }, asset = 'p0', catalogAsset = 'p2:0';
    const claim = (who, block) => who.claim({ event: { window: s.tip, hash: history.hashAt(s.tip) },
      plots: [{ block: Number(block), patterns: [0] }], history, patterns: [pattern] });
    const claims = () => new r.ClaimStorage({ get: id => store.get('claimNodes', id), cacheSize: 64 }).load(store.get('meta', 'ruleState'));
    const reservation = block => r.recordGet(claims().claimReservations, r.findIdV2(String(block), '0')) ?? null;
    const find = block => store.get('finds', r.findIdV2(String(block), '0'));
    const feeds = new Feeds({ store, files, history, reads: {} });
    const project = async () => { while (store.count('feedEvents')) await feeds.events(); };
    await claim(agent, '1'); await drain(); await s.advance(1012); await s.runtime.intake.seal(); await drain();
    assert.equal(find('1').finder, agent.owner);
    const agentService = agent.service;
    const mint = await firstMintFixture(t, { ...s, agent, catalogAsset, block: '1', sourceReady: s.sourceReady });
    agent.service = agentService;
    let mined = 100;
    const checkout = async block => {
      await project();
      return mint.service.request('/public-mints/start', { value: { asset: catalogAsset, block: String(block), tapAddress: mint.receiver } });
    };
    const pay = status => {
      const height = String(s.tip), payload = { p: 'tap', op: 'token-auth', redeem: { items: r.walletFeeItems(status.fees, 'regtest') } };
      const plan = buildInscription({ text: JSON.stringify(payload), receiver: mint.receiver, publicKey: mint.bitcoinPublic,
        network: 'regtest', feeRate: 1, maxFeeSats: '1000000', utxos: [{ txid: r.hash('public-cardinal/' + status.id), vout: 0,
          value: '10000000', script: Buffer.from(p2tr(secp256k1.getPublicKey(mint.bitcoinSecret).slice(1)).script).toString('hex'), confirmed: true, cardinal: true }] });
      const signed = signCommit(plan, mint.bitcoinSecret);
      mint.f.mine(s.tip - mined); mined = s.tip;
      mint.f.canonical.set(plan.inscriptionId, s.tip); mint.f.contents.set(plan.inscriptionId, payload);
      mint.transfers.set(plan.inscriptionId, status.fees.map(fee => ({ ins: plan.inscriptionId, fail: false, int: true,
        addr: mint.receiver, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
      mint.publicBlocks.set(height, [...(mint.publicBlocks.get(height) ?? []), { ...plan, revealHex: signed.revealHex }]);
      return plan.inscriptionId;
    };
    const scan = async block => {
      const id = r.publicPlotId(asset, String(block)), previous = contract.db.get(publicScanKey(id)) ?? null;
      const transition = { type: 'public-scan', id, asset, block: String(block), previous: r.hashObject(previous) };
      await s.financial.submit(transition); await drain();
      assert.equal(store.count('financialQueue'), 0, JSON.stringify(store.list('financialDeferred', { limit: 10 })));
      return contract.db.get(publicScanKey(id));
    };
    const scanThrough = async block => {
      let row;
      for (let i = 0; i < 30; i++) {
        row = contract.db.get(publicScanKey(r.publicPlotId(asset, String(block))));
        if (row && BigInt(row.next.height) > BigInt(s.tip)) return row;
        await scan(block);
      }
      assert.fail('public scan did not reach the payment');
    };
    const refund = (status, reference) => contract.db.get(publicRefundKey({ id: status.id, reference }));
    const latest = async () => s.replayAccepted((await contract.state().batchLast()).n);

    // Historical public payments have no claim-tree marker. Activation must
    // still find their accepted dc/plot + fp records without a lifetime scan.
    await agent.submitOccurrences({ actionId: 'historical-public', patternKey: legacyRecord.key,
      anchor: { height: String(s.tip), hash: history.hashAt(s.tip) }, matches: [{ height: '11', hash: history.hashAt(11), count: '2' }] });
    await drain(); await s.advance(1014);
    const historicalPublic = await checkout('11'); pay(historicalPublic);
    assert.equal((await scanThrough('11')).winner.id, historicalPublic.id);
    assert.equal(reservation('11'), null);
    const historical = store.list('batches', { limit: 1000 }).filter(row => row.value.batch.v === 2).map(row => row.value.batch.n);
    const activeHeight = String(s.tip + 1);
    const successor = r.settingsRevision({ network: s.network, previous: document,
      effectiveBatch: r.addUint((await contract.state().batchLast()).n, '1'), effectiveBitcoinWindow: activeHeight,
      values: { ...document.values, claimsNeverCloseHeight: activeHeight } });
    assert.equal(await contract.run('ad_settings', { document: successor }), null);
    assert.equal(await contract.run('ad_apply', { id: 'settings' }), null, 'settings have no admin delay');
    await s.advance(Number(activeHeight)); mint.mints.document = successor;
    assert.equal(contract.db.get('v2/settings').revision, successor.revision);
    const baseline = process.env.DMW_BASELINE_ROOT && await import(pathToFileURL(join(process.env.DMW_BASELINE_ROOT, 'committee/signer/adapter.mjs')).href);
    for (const n of historical) {
      const replay = await s.replayAccepted(n);
      if (baseline) await s.replayAccepted(n, baseline.rebuildBatch);
      assert.ok(replay.files.every(file => !Object.hasOwn(file, 'publicMintEvidence')));
      assert.ok(replay.files.flatMap(file => file.financialOperations ?? []).every(input => !Object.hasOwn(input.evidence, 'claim')));
    }

    await t.test('unavailable public scans stay queued without sealing empty batches', async () => {
      const transition = { type: 'public-scan', id: r.publicPlotId(asset, '61'), asset, block: '61', previous: r.hashObject(null) };
      const evidence = s.reads.financialEvidence;
      s.reads.financialEvidence = async (t, at) => { if (t.id === transition.id) throw Error('public_scan_pending'); return evidence(t, at); };
      await s.financial.submit(transition);
      const last = await contract.state().batchLast();
      assert.equal(await s.financial.ready({ height: String(s.tip), at: { counted: String(s.tip), last } }), false);
      await s.pipeline.tick(); assert.deepEqual(await contract.state().batchLast(), last);
      assert.equal(store.count('financialQueue'), 1);
      s.reads.financialEvidence = evidence; await drain();
      assert.equal(store.count('financialQueue'), 0);
    });

    let evidenceRefusals = 0;
    const signature = s.committee.signature;
    s.committee.signature = async (...args) => {
      const op = args[1].batch.ops.find(op => op.type === 'public-scan');
      if (op && !evidenceRefusals) {
        evidenceRefusals += (await s.rejectPublicClaimEvidence(args[1], context => {
          const input = context.inputs.find(i => i.financialOperations?.some(f => f.transition.type === 'public-scan'));
          input.financialOperations.find(f => f.transition.type === 'public-scan').operations.find(op => op.type === 'public-scan').claim.claimed = true;
        }, /public_claim_binding/)).length;
        evidenceRefusals += (await s.rejectPublicClaimEvidence(args[1], context => {
          const input = context.inputs.find(i => i.publicMintEvidence?.length);
          input.publicMintEvidence[0].id = r.hash('forged-public-winner');
        }, /public_claim_binding|batch_mismatch|public_mint_evidence_read/)).length;
      }
      return signature(...args);
    };

    await t.test('old-block claims survive the former deadline and legacy public winners refuse new claims', async () => {
      assert.ok(BigInt(s.tip) > BigInt(r.claimDeadline(pattern, '21', document)));
      await claim(agent, '21'); await claim(players[0].agent, '11');
      const record = s.reads.financialRecord, last = await contract.state().batchLast();
      s.reads.financialRecord = async (key, at) => { if (key === 'dc/plot/p0/11') throw Error('source_unavailable'); return record(key, at); };
      await assert.rejects(s.pipeline.build(), /public_mint_evidence_missing/);
      assert.deepEqual(await contract.state().batchLast(), last, 'missing winner evidence cannot become an ordinary move rejection');
      s.reads.financialRecord = record; await drain();
      const replay = await latest();
      assert.ok(replay.files.flatMap(f => f.moves).some(move => move.reason === 'public_minted'));
      assert.ok(replay.files.flatMap(f => f.publicMintEvidence).some(row => row.asset === asset && row.block === '11' && row.id === historicalPublic.id));
      await s.advance(s.tip + 2); await s.runtime.intake.seal(); await drain();
      assert.equal(find('21').finder, agent.owner);
      assert.equal(find('21').finderUntil, r.addUint(find('21').findHeight, '2'));
      assert.equal(find('11'), null);
    });

    await t.test('an activated public winner takes the slot and a later direct claim is public_minted', async () => {
      const status = await checkout('31'); assert.equal(Object.hasOwn(status, 'claimDeadline'), false);
      pay(status); assert.equal((await scanThrough('31')).winner.id, status.id);
      assert.equal(reservation('31').publicMint, true);
      await claim(players[1].agent, '31'); await drain();
      assert.ok((await latest()).files.flatMap(f => f.moves).some(move => move.reason === 'public_minted'));
      assert.equal(find('31'), null);
      assert.equal(contract.db.get('fp/' + status.id).owner, null);
    });

    await t.test('a settled agent claim makes a previously quoted public payment refundable as claimed_first', async () => {
      const status = await checkout('41');
      await claim(players[2].agent, '41'); await drain(); await s.advance(s.tip + 2); await s.runtime.intake.seal(); await drain();
      assert.equal(find('41').finder, players[2].agent.owner);
      const reference = pay(status); const scan = await scanThrough('41');
      assert.equal(scan.winner, null); assert.equal(refund(status, reference).reason, 'claimed_first');
      assert.equal(mint.mints.public(status.id).reason, 'claimed_first');
      assert.equal(store.get('financialCustodyPending', status.id), null);
      assert.equal(contract.db.get('fp/' + status.id), undefined);
    });

    await t.test('a claim drawn in the payment batch wins before its public scan', async () => {
      const status = await checkout('51'), window = s.tip;
      await claim(players[3].agent, '51'); await drain();
      await s.advance(window + 1);
      // Advance the scan through the empty prefix, then hold the deciding
      // observation until the confirmed payment is queued in the same batch.
      await scanThrough('51');
      await s.observeNext(); const reference = pay(status);
      await scan('51');
      const replay = await latest(), operations = replay.files.flatMap(f => f.financialOperations ?? []);
      const paid = operations.find(input => input.transition.type === 'public-scan' && input.transition.block === '51');
      assert.equal(paid.evidence.claim.claimed, true);
      assert.ok(replay.files.some(f => f.closures.some(c => c.window === String(window)) || f.settlements.some(c => c.window === String(window))));
      assert.equal(find('51').finder, players[3].agent.owner);
      assert.equal(refund(status, reference).reason, 'claimed_first');
      assert.equal(contract.db.get('dc/plot/' + asset + '/51'), undefined);
    });

    await t.test('a header award skips a public plot accepted before its draw', async () => {
      const block = String(s.tip), status = await checkout(block); pay(status); await scanThrough(block);
      assert.equal(reservation(block).winner, status.id);
      await players[4].agent.headers({ height: s.tip, raw: Buffer.from(history.raw(s.tip)).toString('hex'), history }); await drain();
      await s.advance(s.tip + 2); await s.runtime.intake.seal(); await drain();
      const state = claims(), draw = r.recordGet(state.headerAwards, block);
      assert.equal(draw.senderCount, '1');
      assert.equal(r.implicitHeaderFind({ state, slot: { id: r.findIdV2(block, '0'), block, asset, pattern: '0', count: 2 },
        pattern: { number: '0' }, materializedAt: String(s.tip), settings: successor }), null);
      assert.equal(find(block), null); assert.equal(reservation(block).winner, status.id);
    });
    assert.equal(store.get('meta', 'ruleState').claimRoot, contract.db.get('v2/claims'));
    assert.equal(evidenceRefusals, 10, 'all five signers reject both forged scan decisions and public winner evidence');
    t.diagnostic(JSON.stringify({ historicalBatchesReplayed: historical.length, acceptedBatches: (await contract.state().batchLast()).n,
      activationRevision: successor.revision, claimsNeverCloseHeight: successor.values.claimsNeverCloseHeight,
      signing: 'five independent HTTP signer policies approved every batch; Bitcoin and TAP index fixtures, no broadcast' }));
  } }));
