import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { v2StackFixture } from './v2-stack-fixture.mjs';
import { firstMintStack } from './first-mint-fixture.mjs';
import { bindingFixture } from './bindings-fixture.mjs';
import { testPayoutAddress } from './payout-wallets.mjs';
import { rules as r } from '../src/rules.mjs';
import { FinancialLinks } from '../src/financial-links.mjs';
import { FinancialLinkReconciler } from '../src/financial-lifecycle.mjs';
import { SubmittedBitmaps } from '../src/submitted-bitmaps.mjs';
import { bitmapOwner } from '../prod/public-reads.mjs';
import { History } from '../src/history.mjs';
import { Feeds } from '../src/feeds.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { PublicRegistry } from '../src/public-registry.mjs';
import { migrateRegistry, readRegistry } from '../src/registry.mjs';
import { createFeePolicy } from '../src/fees.mjs';
import { gameTools } from '../../kit/lib/tools.mjs';
import { wireIdentities } from '../../rules/src/trac-address.js';
import { financialLinkDigest } from '../../rules/src/financial-link.js';
import { financialMintDigest } from '../../rules/src/financial-mint.js';
import { signBytes, signPaymentIntent } from '../../kit/lib/signing.mjs';

// No live services, Bitcoin broadcasts or TAP payments. Bitcoin ownership,
// indexing and payment receipts are fixtures; discovery, balances, HTTP actions,
// binding certificates, five signer policies, financial batches and projections
// all run their real v2 paths against the imported local notary.
test('local v2 Bitmap linking, mint rights and holder payouts end to end', { timeout: 600000 }, async t => {
  // Batch catch-up observations to keep the test bounded; every Bitcoin height
  // is replayed and the default 1,008-block finder deadline remains unchanged.
  await v2StackFixture(t, { historyLength: 2100, observationsPerBatch: 16, scenario: async s => {
    const { store, files, history, document, network, contract, players, drain } = s;
    const [A, B, C, D] = players.map(p => p.agent), H = '1';
    const wallets = players.map((_, i) => r.hash('bitmap-wallet-' + i));
    const addresses = wallets.map(key => testPayoutAddress(key, 'tap'));
    const bf = bindingFixture(store, { network });
    const bitmapInscription = r.hash('1.bitmap') + 'i0', otherBitmapInscription = r.hash('2.bitmap') + 'i0';
    let holderAddress = addresses[0];
    const indexedBitmap = block => block === H ? { bm: Number(H), ins: bitmapInscription, ownr: holderAddress } :
      block === '2' ? { bm: 2, ins: otherBitmapInscription, ownr: addresses[0] } : null;
    const indexedInscription = async id => {
      assert.ok([bitmapInscription, otherBitmapInscription].includes(id));
      return { id, address: id === bitmapInscription ? holderAddress : addresses[0], content: id === bitmapInscription ? '1.bitmap' : '2.bitmap' };
    };
    const submittedBitmaps = new SubmittedBitmaps({ store, verify: async (block, inscription) => {
      const bitmap = indexedBitmap(block); assert.ok(bitmap && (!inscription || inscription === bitmap.ins));
      const holder = await bitmapOwner({ tap: async () => bitmap, indexer: { inscription: indexedInscription }, bindings: bf.bindings }, block);
      return { block, inscription: bitmap.ins, ...holder, snapshot: { height: String(s.tip), hash: history.hashAt(s.tip) } };
    } });
    let links, reconciler;
    const mint = await firstMintStack(t, { ...s,
      clientOptions: { gateway: A.service.gateway, receiptSigners: A.service.receiptSigners },
      initialize: async f => {
        await writeFile(f.registryPath, JSON.stringify({ assets: {}, feePolicy: createFeePolicy('100'), link: { treasury: 'regtest-treasury' } }));
        await migrateRegistry(f.registryPath); f.reads.registry = () => readRegistry(f.registryPath);
      },
      configureReads: (reads, f) => {
        reads.included = async id => f.canonical.has(id) ? { confirmations: s.tip - f.canonical.get(id) + 1,
          height: f.canonical.get(id), blockHash: history.hashAt(f.canonical.get(id)) } : null;
        reads.bindings = bf.bindings;
        const tap = reads.tap;
        reads.tap = key => key.startsWith('getBitmap/') ? Promise.resolve(indexedBitmap(key.slice(10))) : tap(key);
        reads.bitmap = block => bitmapOwner({ tap: reads.tap, indexer: { inscription: indexedInscription }, bindings: bf.bindings }, block);
        reads.link = async block => { const row = contract.db.get('k/link/' + BigInt(block).toString(36)); return row ? JSON.parse(row) : null; };
        const assetContext = reads.assetContext;
        reads.assetContext = async (...args) => {
          const context = await assetContext(...args), link = await reads.link(args[1]), holder = link ? await reads.bitmap(args[1]) : null;
          const finder = bf.bindings.resolve(context.find.finder, 'tap', undefined, 'finder');
          const discoverer = bf.bindings.resolve(context.beneficiaries.discoverer, 'tap', undefined, 'discoverer');
          return { ...context, link, bitmapHolder: holder, landownerAddress: holder?.address ?? null,
            finderAddress: finder.request.address, discoverer: discoverer.request.address,
            beneficiaries: { ...context.beneficiaries, landowner: holder?.agent ?? null },
            payouts: { finder: finder.id, discoverer: discoverer.id, landowner: null } };
        };
      },
      httpOptions: ({ reads, mints }) => {
        links = new FinancialLinks({ store, reads, financial: s.financial, document, network });
        reconciler = new FinancialLinkReconciler({ store, reads, financial: s.financial });
        return { intake: s.runtime.intake, files, publicAPI: createPublicAPI({ views: { store, mints }, files }), links, bindings: bf.bindings, submittedBitmaps, rateBurst: 1000, ratePerSecond: 1000 };
      } });
    const { service, f, mints, provisioner, transfers } = mint;
    for (const { agent } of players) { agent.service = service; agent.bitcoinNetwork = 'regtest'; }
    const bind = async i => {
      const who = { address: players[i].agent.owner, secret: Buffer.from(r.hashBytes('isolated-kit-player-' + i)) };
      const { walletSignature, ...packet } = bf.packet(who, 'tap', wallets[i]);
      const pending = await service.requestPayoutBinding(packet);
      const proof = await service.request('/payout-bindings/complete', { value: { id: pending.id, walletSignature } });
      assert.equal(wireIdentities(proof).request.agent, who.address);
    };
    // D has units, but has not registered its payout wallet yet.
    for (const i of [0, 1, 2, 4, 5, 7]) await bind(i);
    const feeds = new Feeds({ store, files, history, reads: {}, settings: { feedEventRows: 100 } });
    const registry = new PublicRegistry({ store, registry: f.reads.registry });
    const localHistory = new History(store);
    const project = async () => {
      const start = Number(localHistory.length);
      await localHistory.appendMany(String(start), Array.from({ length: s.tip - start + 1 }, (_, i) => Buffer.from(history.raw(start + i)).toString('hex')));
      for (let i = 0; i < 20000 && (store.count('feedEvents') || store.count('feedBlockChanges') || store.count('feedLinkedBlocks2')); i++) await feeds.events();
      assert.equal(store.count('feedEvents'), 0);
      for (let i = 0; i < 1000 && store.count('feedPages'); i++) await feeds.tick();
      assert.equal(store.count('feedPages'), 0);
      await registry.tick(); await registry.tick();
    };
    const read = async path => wireIdentities(await service.readPage(path));
    const rights = async (agent, asset) => {
      const result = await service.mintRights(agent.address, { asset, block: H });
      assert.equal(result.mintRights.length, 1); return wireIdentities(result.mintRights[0]);
    };
    const tool = agent => gameTools({ agent, candidates: async (asset, { block }) => (await service.mintRights(agent.address, { asset, block })).mintRights }).mint_on_chain;
    const request = (agent, asset, actionId) => {
      const entry = tool(agent); return entry.run(entry.schema.parse({ asset, amount: '1', block: H, kind: 'tap', compound: false,
        receiver: mint.receiver, payer: mint.receiver, actionId }));
    };
    const pay = async (row, report) => {
      const payment = r.hash('bitmap-payment-' + row.id) + 'i0';
      transfers.set(payment, row.quote.fees.map(fee => ({ ins: payment, fail: false, int: true, addr: row.payer, taddr: fee.to,
        tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
      await assert.rejects(report({ id: row.id, paymentId: payment }), /payment_unconfirmed/);
      f.canonical.set(payment, s.tip); await report({ id: row.id, paymentId: payment }); await drain();
    };
    const holderFee = (quote, address) => {
      assert.equal(document.values.landownerShareBps, 1500);
      assert.equal(quote.split.landowner, String(BigInt(quote.price) * 15n / 100n));
      assert.equal(quote.split.burn, String(BigInt(quote.price) * BigInt(document.values.findBurnBps) / 10000n), 'no extra unlinked burn');
      const fee = quote.fees.find(f => f.role === 'landowner');
      assert.equal(fee.to, address); assert.equal(fee.amount, quote.split.landowner);
    };
    const finishMint = async (agent, asset, actionId, address) => {
      const result = await request(agent, asset, actionId); assert.equal(result.state, 'submitted');
      const id = result.request.requestId, row = store.get('mints', id); holderFee(row.quote, address);
      await drain(); await mints.tick(); assert.equal((await service.mintStatus(id)).payable, true);
      await pay(row, value => service.reportMintPayment(value));
      await mints.tick(); await drain(); await mints.tick();
      const ready = await service.mintStatus(id); assert.equal(ready.state, 'permit_issued');
      assert.equal(contract.db.get('ao/' + id).state, 'consumed'); assert.equal(contract.db.get('fp/' + id).state, 'consumed');
      assert.equal(ready.mintContent.op, 'dmt-mint'); holderFee(ready, address);
      await project();
      const payments = (await read('/results/payments')).payments.filter(p => p.requestId === id && p.role === 'landowner');
      assert.equal(payments.length, 1); assert.equal(payments[0].to, address); assert.equal(payments[0].amount, row.quote.split.landowner);
      return row;
    };
    // A hostile client bypasses the kit's early refusal; the HTTP admission
    // and independent financial source policies must refuse the signed intent.
    const refuseHTTP = async (agent, asset, reason) => {
      const quote = await service.mintQuote({ asset, amount: '1', block: H, payer: mint.receiver, receiver: mint.receiver });
      const request = { v: 2, owner: agent.owner, asset, amount: '1', receive: r.hash(mint.receiver), block: H,
        nonce: r.hash('refuse-' + asset + '-' + agent.owner + '-' + s.tip), until: String(s.tip + document.values.moveFreshnessTips),
        expires: String(s.tip + document.values.pendingBlocks), settingsHash: r.hashObject(document) };
      const body = { version: 2, request, payer: mint.receiver, receiver: mint.receiver, kind: 'tap', feeQuote: quote.feeQuote,
        signature: signBytes(agent.wallet, financialMintDigest(network, request)) };
      body.authorization = signPaymentIntent(agent.wallet, network, body);
      await assert.rejects(service.requestMint(body), reason);
    };
    const proposers = [players[1], players[2], players[4], players[5]];
    const witnesses = { anchor: { height: '1010', hash: history.hashAt(1010) }, matches: [1, 2, 3].map(h => ({ height: String(h), hash: history.hashAt(h), count: '1' })) };
    for (const p of proposers) { await p.agent.propose({ actionId: 'bitmap-pattern', proposal: p.proposal, history, witnesses }); await drain(); }
    await s.advance(1012);
    for (const p of proposers) { await p.agent.reveal({ actionId: 'bitmap-pattern', history }); await drain(); }
    const patterns = store.list('patternsByAsset', { limit: 20 }).map(x => ({ ...x.value, number: Number(x.value.number) }));
    if (!patterns.some(p => p.number === 0)) patterns.push({ ...s.legacyRecord, number: 0 });
    const [before, after, transfer, publicBefore] = proposers.map(p => patterns.find(q => q.name === p.proposal.name));
    const asset = p => 'p2:' + p.number;
    const claim = async (agent, plots) => { await agent.claim({ event: { window: s.tip, hash: history.hashAt(s.tip) }, plots, history, patterns }); await drain(); };
    for (const [i, agent] of [A, B, C, D].entries()) await claim(agent, [
      { block: (i + 1) * 10, patterns: [before.number, after.number, transfer.number, publicBefore.number] },
      ...(agent === B ? [{ block: 1, patterns: [before.number, publicBefore.number] }] : [])]);
    await s.advance(1014); await s.runtime.intake.seal(); await drain(); await project();
    const deploy = async p => {
      const a = asset(p), first = await service.mintQuote({ asset: a, amount: '1', block: H }); assert.equal(first.state, 'deployment_needed');
      // Deployment content is prepared in the background; read the job once its worker is done.
      const ready = async () => { await provisioner.work.drain(); return provisioner.state(a); };
      await service.deployment(a); let job = await ready();
      for (let i = 0; i < 3 && job.state !== 'registered'; i++) {
        const inscription = f.index(job.content, r.hash('bitmap-deploy-' + a + '-' + job.phase) + 'i0');
        if (job.phase === 'deployment') f.deployments.get('dmt-' + job.content.tick).max = '1000000';
        job = await service.submitDeployment({ asset: a, phase: job.phase, inscription });
        if (job.state !== 'registered' && !job.content) job = await ready();
      }
      assert.equal(job.state, 'registered');
      assert.equal((await service.mintQuote({ asset: a, amount: '1', block: H })).state, 'deployment_pending');
      await mints.deploymentTick(); await drain(); await project();
    };
    await deploy(before); await deploy(publicBefore);
    await s.advance(1015); await project();
    let linkHeight;
    await t.test('1: held Bitmap links through quote, signed request, fixture payment and accepted public projections', async () => {
      const submitted = wireIdentities(await service.submitBitmap({ block: H, inscription: bitmapInscription })); assert.equal(submitted.agent, A.owner);
      const result = await A.linkBitmap({ actionId: 'bitmap-link', height: H, payer: addresses[0] }); assert.equal(result.state, 'submitted');
      const id = result.request.id; await drain();
      assert.equal((await service.linkStatus(id)).payable, true);
      await pay(store.get('financialLinks', id), value => service.reportLinkPayment(value));
      await reconciler.tick(String(s.tip), await s.stamp()); await drain(); await links.tick(); await project();
      assert.equal((await service.linkStatus(id)).state, 'accepted');
      assert.equal(contract.db.get('fl/' + id).state, 'complete');
      const accepted = JSON.parse(contract.db.get('k/link/1')); linkHeight = accepted.linkHeight;
      assert.equal(linkHeight, String(s.tip));
      const listed = (await read('/results/links')).links; assert.equal(listed.length, 1);
      assert.equal(listed[0].block, H); assert.equal(listed[0].linkHeight, linkHeight); assert.equal(listed[0].owner, A.owner);
      assert.deepEqual((await read('/links')).links, listed);
      const block = await read('/blocks/1'); assert.equal(block.linked, true);
      assert.equal(block.link.linkHeight, linkHeight); assert.equal(block.link.owner, A.owner);
      for (const path of ['/block/1', '/plot/1']) {
        const response = await fetch(mint.http.url + path, { headers: { accept: 'text/html' } });
        assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/html/); await response.text();
      }
      assert.equal((await rights(B, asset(before))).link.linkHeight, linkHeight);
    });
    await s.advance(1016);
    await claim(C, [{ block: 1, patterns: [after.number, transfer.number] }]);
    await claim(B, [{ block: 1, patterns: [0] }]);
    await s.advance(1018); await s.runtime.intake.seal(); await drain(); await project();
    await service.submitBitmap({ block: H });
    await deploy(after); await deploy(transfer); await deploy(patterns.find(p => p.number === 0));
    await t.test('2: pre-link find retains finder week, pays A, then becomes public', async () => {
      const b = await rights(B, asset(before)); assert.ok(BigInt(b.findHeight) < BigInt(linkHeight));
      assert.equal(b.whoMayMint, 'finder'); assert.equal(b.allowed, true);
      for (const other of [A, C, D]) { const row = await rights(other, asset(before)); assert.equal(row.whoMayMint, 'finder'); assert.equal(row.allowed, false); }
      await assert.rejects(request(A, asset(before), 'not-finder'), /Mint right unavailable|No mint candidate/);
      await refuseHTTP(A, asset(before), /financial_mint_right/);
      await finishMint(B, asset(before), 'finder-mint', addresses[0]);
    });
    await t.test('6: imported catalog p2:0 spends ledger p0 and pays the linked holder', async () => {
      const row = await finishMint(B, 'p2:0', 'imported-mint', addresses[0]); assert.equal(row.request.asset, 'p0');
      assert.equal(store.get('provisioning', 'p2:0'), null);
    });
    assert.equal(document.values.finderWindow, 1008, 'exercise the full default finder week');
    const end = Number((await rights(C, asset(after))).finderUntil);
    await s.advance(end, { batchTips: 16 }); await project(); await service.submitBitmap({ block: H });
    await t.test('2 continued: a pre-link find is public after its finder week, including a non-holder mint', async () => {
      for (const agent of [A, B, C, D]) {
        const original = await rights(agent, asset(before)); assert.equal(original.whoMayMint, 'public'); assert.equal(original.rightAllowed, true);
        const row = await rights(agent, asset(publicBefore)); assert.equal(row.whoMayMint, 'public'); assert.equal(row.allowed, true);
      }
      // The first slot already issued a permit; a second pre-link find proves
      // actual public admission without attempting to mint a spent slot twice.
      await finishMint(D, asset(publicBefore), 'public-mint', addresses[0]);
    });
    await t.test('3: post-link find becomes bitmap-only after the finder week', async () => {
      const a = await rights(A, asset(after)); assert.ok(BigInt(a.findHeight) > BigInt(linkHeight));
      assert.equal(a.whoMayMint, 'bitmap'); assert.equal(a.allowed, true);
      for (const other of [B, C, D]) { const row = await rights(other, asset(after)); assert.equal(row.whoMayMint, 'bitmap'); assert.equal(row.allowed, false); }
      await assert.rejects(request(C, asset(after), 'not-holder'), /Mint right unavailable|No mint candidate/);
      await refuseHTTP(C, asset(after), /financial_mint_right/);
      await finishMint(A, asset(after), 'holder-mint', addresses[0]);
    });
    await t.test('4: transfer to an unregistered wallet waits, then D registers and receives the right and share', async () => {
      const staleQuote = await service.mintQuote({ asset: asset(transfer), amount: '1', block: H });
      holderAddress = addresses[3]; await s.advance(s.tip + 1); await project();
      for (const agent of [A, D]) { const row = await rights(agent, asset(transfer)); assert.equal(row.allowed, false); assert.equal(row.reason, 'holder_unavailable'); }
      await assert.rejects(service.mintQuote({ asset: asset(transfer), amount: '1', block: H }), /bitmap_agent_binding/);
      await assert.rejects(service.submitBitmap({ block: H }), /bitmap_agent_binding/);
      await bind(3);
      assert.equal((await rights(D, asset(transfer))).reason, 'holder_unavailable');
      const requestsBefore = store.count('mints');
      await assert.rejects(request(D, asset(transfer), 'holder-needs-submission'), /Mint right unavailable|No mint candidate/);
      assert.equal(store.count('mints'), requestsBefore, 'stale ownership creates no payable reservation');
      await service.submitBitmap({ block: H });
      await assert.rejects(service.quote({ asset: asset(transfer), amount: '1', block: H, feeQuote: staleQuote.feeQuote }), /quote_recipient_changed/);
      const d = await rights(D, asset(transfer)); assert.equal(d.whoMayMint, 'bitmap'); assert.equal(d.allowed, true);
      assert.equal((await rights(A, asset(transfer))).allowed, false);
      await refuseHTTP(A, asset(transfer), /financial_mint_right/);
      const row = await finishMint(D, asset(transfer), 'new-holder-mint', addresses[3]);
      assert.ok(row.quote.fees.every(fee => fee.to !== addresses[0]), 'no fee goes to the former holder');
      assert.equal((await read('/results/links')).links[0].owner, D.owner);
      assert.equal((await read('/blocks/1')).link.owner, D.owner);
    });
    await t.test('5: duplicate links and non-holder link requests are refused', async () => {
      await assert.rejects(D.linkBitmap({ actionId: 'duplicate-link', height: H, payer: addresses[3] }), /link_exists/);
      const saved = A.journal.get('link/bitmap-link').body, request = { ...saved.request, owner: D.owner,
        nonce: r.hash('second-link'), until: String(s.tip + document.values.pendingBlocks) };
      await assert.rejects(service.requestLink({ ...saved, request, signature: signBytes(D.wallet, financialLinkDigest(network, request)) }), /link_exists/);
      await assert.rejects(B.linkBitmap({ actionId: 'not-my-bitmap', height: '2', payer: addresses[1] }), /financial_link_owner/);
      assert.equal(contract.db.get('k/link/2'), undefined); assert.equal(store.count('financialLinks'), 1);
    });
    t.diagnostic('Bitcoin/TAP indexing and receipts are fixtures; all actions are loopback HTTP. Five policy approvals per accepted batch and permit; no threshold ceremony or live broadcast.');
  } });
});
