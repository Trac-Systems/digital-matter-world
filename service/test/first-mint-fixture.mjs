import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { secp256k1 } from '../../contract/node_modules/@noble/curves/secp256k1.js';
import { p2tr } from '../../kit/node_modules/@scure/btc-signer/index.js';
import { rules as r } from '../src/rules.mjs';
import { Provisioner } from '../src/provisioning.mjs';
import { FinancialMints } from '../src/financial-mints.mjs';
import { installFinancialSources, acceptedFinancialReservation } from '../src/financial-sources.mjs';
import { patternCatalogId } from '../src/mint-assets.mjs';
import { acceptedAssetProvenance } from '../src/asset-provenance.mjs';
import { FeeQuotes, createFeePolicy } from '../src/fees.mjs';
import { verifyDeployment } from '../src/deployments.mjs';
import { heightKey } from '../src/util.mjs';
import { Policy } from '../../committee/signer/policy.mjs';
import { attachPermit } from '../../committee/signer/adapter.mjs';
import { serve } from '../src/http.mjs';
import { ServiceClient } from '../../kit/lib/service-client.mjs';
import { gameTools } from '../../kit/lib/tools.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { mintContent, buildInscription, signCommit, fundingAddress } from '../../kit/lib/inscription-core.mjs';
import { provisioningFixture } from './provisioning-fixture.mjs';
import { verifyMintResult } from '../../committee/signer/certificate.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// Real settled catalog/find roots, account balances, financial batches and
// notary from v2-stack. Only the Bitcoin index and payment receipt are fixtures.
export async function firstMintStack(t, { store, contract, document, network, secret, committeeSecret,
  rulesContext, stamp, financial, sourceReady, history, runtime, clientOptions = {}, initialize = async () => {}, configureReads = () => {}, httpOptions = () => ({}) }) {
  const f = await provisioningFixture(t, { secret: committeeSecret });
  await writeFile(f.registryPath, JSON.stringify({ assets: {}, feePolicy: createFeePolicy('100') }));
  await initialize(f);
  const publicKey = f.policy.authorityKey, transfers = new Map(), publicBlocks = new Map(), mintedObservations = new Map();
  const bitcoinSecret = new Uint8Array(32).fill(44), bitcoinPublic = Buffer.from(secp256k1.getPublicKey(bitcoinSecret)).toString('hex');
  const receiver = fundingAddress(bitcoinPublic, 'regtest');
  f.reads.inscription = async () => ({ address: receiver });
  const audits = async n => {
    const row = store.get('batches', heightKey(n)); assert.equal(row.batch.root, contract.db.get('bt/' + n));
    const bytes = await Promise.all(row.publications.map(p => readFile(join(store.directory, 'static', p.audit.path.slice(1)))));
    assert.equal(r.merkleRoot(bytes), row.batch.root); return bytes.map(b => r.decodeBinary(b));
  };
  const makeReads = () => {
    const reads = { ...f.reads, counted: async () => (await stamp()).counted, batchStamp: stamp, rulesContext,
      authority: async () => ({ network, committee: publicKey, epoch: 0 }),
      feeQuotes: new FeeQuotes({ network, secret, registry: f.reads.registry, settings: () => document }),
      tap: async key => key.startsWith('getMintTokensLeft/') ? '1000000' : f.reads.tap(key),
      content: async id => transfers.has(id) ? { p: 'tap', op: 'token-auth', redeem: { items: transfers.get(id).map(x => ({ dta: x.dta, address: x.taddr, tick: x.tick, amt: r.formatTapAmount(x.amt) })) } } : f.reads.content(id),
      paymentTransfers: async id => transfers.get(id).map((value, index) => ({ index, value })),
      isMinted: async () => false,
      mint: async id => mintedObservations.get(id) ?? null,
      publicMintHeader: async height => history.get(height),
      publicBitcoinHash: async height => r.hash('public-block/' + height),
      publicBitcoinBlock: async height => ({ height: Number(height), hash: r.hash('public-block/' + height),
        tx: (publicBlocks.get(height) ?? []).map(p => p.inscriptionId.slice(0, 64)), transactions: (publicBlocks.get(height) ?? []).map(p => p.revealHex) }),
      assetContext: async (requested, height) => {
        const source = await acceptedAssetProvenance({ store, reads: { rulesContext }, asset: patternCatalogId(requested) ?? requested, block: height });
        const entry = (await f.reads.registry()).assets[requested];
        const verified = await verifyDeployment(reads, entry);
        assert.equal(entry.pattern.pat, source.pattern.pat);
        return { deployment: { ...entry, active: true, privilegePublicKey: publicKey, decimals: 0, remaining: '1000000', limit: '0' },
          find: source.find, pattern: source.pattern, publicClaims: source.publicClaims, link: null, tier: source.tier, treasury: 'regtest-treasury', finderAddress: 'regtest-finder', discoverer: 'regtest-discoverer',
          beneficiaries: { finder: source.find?.finder ?? null, discoverer: source.pattern.discoverer }, payouts: { finder: null, discoverer: null }, assetRevision: source.revision };
      } };
    configureReads(reads, f);
    return installFinancialSources(reads, { network, document, bitcoinNetwork: 'regtest', recoveryVersion: 2,
      request: id => store.get('mints', id) ?? store.get('financialLinks', id), reservation: id => acceptedFinancialReservation({ store, audits, id }), record: key => contract.db.get(key) });
  };
  const reads = makeReads(), independent = makeReads(); sourceReady(reads, independent);
  const policies = Array.from({ length: 5 }, () => new Policy({ network, publicKey, reads: makeReads() }));
  const committee = { signature: async (_, proposal) => {
    const approvals = await Promise.all(policies.map(p => p.approve(proposal)));
    assert.equal(new Set(approvals.map(a => a.digest)).size, 1);
    const signed = secp256k1.sign(approvals[0].digest, committeeSecret, { lowS: true, prehash: false });
    verifyMintResult(approvals[0].details, { compact: signed.toCompactHex(), r: String(signed.r), s: String(signed.s), v: signed.recovery },
      { network, publicKey, id: approvals[0].details.id });
    return { session: r.hash('first-mint-session'), payload: attachPermit(approvals[0].permit, { r: String(signed.r), s: String(signed.s), v: signed.recovery }) };
  } };
  const provisioner = new Provisioner({ ...f, store, reads }), mints = runtime?.mints ?? new FinancialMints({ store, reads, financial, committee, document, network, bitcoinNetwork: 'regtest' });
  Object.assign(mints, { reads, committee, provisioner });
  reads.feeQuotes.settings = () => mints.document;
  const http = await serve({ intake: { store }, files: { serve: async () => false }, mints, operator: { provisioner },
    publicAPI: createPublicAPI({ views: { store, mints } }), ...httpOptions({ reads, mints, f }) }); t.after(() => http.close());
  const service = new ServiceClient({ origin: http.url, network, ...clientOptions });
  return { f, reads, independent, policies, provisioner, mints, service, receiver, transfers, bitcoinSecret, bitcoinPublic, http, makeReads, publicBlocks, mintedObservations, committee, publicKey };
}

export async function firstMintFixture(t, options) {
  const { store, contract, rulesContext, drain, agent, catalogAsset, block = '1', publicChecks = false, project, stamp, finderExpected = true, document, network, secret, financial } = options;
  const provenance = await acceptedAssetProvenance({ store, reads: { rulesContext }, asset: catalogAsset, block });
  const asset = provenance.find.asset, amount = String(provenance.find.count);
  assert.equal(provenance.find.finder === agent.owner, finderExpected);
  if (!finderExpected) assert.ok(BigInt((await stamp()).counted) >= BigInt(provenance.find.finderUntil));
  const { f, reads, provisioner, mints, service, receiver, transfers, bitcoinSecret, bitcoinPublic, publicBlocks, mintedObservations, independent, policies, committee, publicKey } = await firstMintStack(t, options);
  const originalService = agent.service; agent.service = service;
  t.after(() => { agent.service = originalService; });
  const intent = { asset: catalogAsset, amount, block, receiver, payer: receiver, kind: 'tap', compound: false };
  const tool = gameTools({ agent, candidates: async (asset, { block }) => (await service.mintRights(agent.address, { asset, block })).mintRights }).mint_on_chain;
  const args = tool.schema.parse({ ...intent, actionId: 'first-deploy-' + catalogAsset.replace(':', '-') });
  const make = () => tool.run(args);
  if (publicChecks) {
    await drain(); await project();
    assert.equal(mints.publicMints.state(catalogAsset, '201').state, 'public', JSON.stringify({
      occurrence: !!store.get('claimed2/' + catalogAsset, r.uintKeyV2('201')),
      rounds: store.get('meta', 'ruleState').rounds.map(row => ({ window: row.window, closed: row.closed })) }));
    const setup = await service.request('/public-mints/start', { value: { asset: catalogAsset, block: '201', tapAddress: receiver } });
    assert.equal(setup.state, 'deployment_needed'); assert.equal(setup.payable, false); assert.equal(setup.reservation, 'none');
    assert.equal(setup.requestId, null); assert.ok(setup.deploymentPath);
  }
  let first;
  if (!publicChecks && finderExpected) {
  const lookup = reads.elementByDefinition;
  const catalog = store.list('patternsByAsset', { limit: 4096 }), position = catalog.findIndex(r => r.id === catalogAsset);
  assert.ok(position >= 0);
  await store.put('meta', 'provisioningCursor', { pattern: 0, type: '', named: position ? catalog[position - 1].id : '' });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  reads.elementByDefinition = async (...args) => {
    if (args[0] === provenance.pattern.pat) { entered(); await delay(2000); }
    return lookup(...args);
  };
  const provisioning = provisioner.tick();
  await Promise.race([started, provisioning.then(() => { throw Error('slow_lookup_not_entered'); })]);
  const quoteStart = performance.now(); first = await make(); const quoteMs = performance.now() - quoteStart;
  assert.ok(quoteMs < 1500, `quote waited for provisioning: ${quoteMs} ms`);
  assert.equal(first.state, 'deployment_needed'); assert.equal(first.signed, false);
  await provisioning; reads.elementByDefinition = lookup;
  t.diagnostic(JSON.stringify({ firstMintAsset: asset, indexerDelayMs: 2000, quoteDuringProvisioningMs: quoteMs }));
  } else {
    first = await make(); await provisioner.work.drain();
    assert.equal(first.state, 'deployment_needed'); assert.equal(first.signed, false);
  }
  assert.equal(first.asset, asset); assert.equal(first.requestId, null); assert.equal(first.payable, false);
  assert.equal(first.next[0].tool, 'inscribe_deployment');
  await service.deployment(catalogAsset); await provisioner.work.drain();
  let job = await provisioner.state(catalogAsset);
  assert.equal(job.phase, 'element');
  const element = f.index(job.content, r.hash('first-element-' + asset) + 'i0');
  f.canonical.delete(element);
  await assert.rejects(service.submitDeployment({ asset: catalogAsset, phase: 'element', inscription: element }), /deployment_confirmations/);
  f.canonical.set(element, 100); // Included in a fixture Bitcoin block.
  job = await service.submitDeployment({ asset: catalogAsset, phase: 'element', inscription: element });
  assert.equal(job.phase, 'deployment'); assert.equal(job.content.elem, element);
  const deployment = f.index(job.content, r.hash('first-deployment-' + asset) + 'i0');
  f.deployments.get('dmt-' + job.content.tick).max = '1000000';
  f.canonical.delete(deployment);
  await assert.rejects(service.submitDeployment({ asset: catalogAsset, phase: 'deployment', inscription: deployment }), /deployment_confirmations/);
  f.canonical.set(deployment, 100);
  assert.equal((await service.submitDeployment({ asset: catalogAsset, phase: 'deployment', inscription: deployment })).state, 'registered');
  if (publicChecks) {
    const registered = await service.request('/public-mints/start', { value: { asset: catalogAsset, block: '201', tapAddress: receiver } });
    assert.equal(registered.state, 'deployment_pending'); assert.equal(registered.payable, false); assert.equal(registered.requestId, null);
    assert.equal(store.count('publicMintRequests'), 0, 'deployment preparation creates no checkout or reservation');
  }
  assert.equal((await make()).state, 'deployment_pending');
  await mints.deploymentTick();
  await drain(); assert.ok(contract.db.get('fd/asset/' + asset));
  const quoted = await service.mintQuote({ asset: catalogAsset, amount, block }); assert.equal(quoted.asset, asset); assert.equal(quoted.jobState, 'registered');
  const requested = await make(), id = requested.request.requestId;
  assert.equal(requested.state, 'submitted'); assert.equal(store.get('mints', id).request.asset, asset);
  await drain(); await mints.tick();
  assert.equal((await service.mintStatus(id)).payable, true);
  await options.afterReserve?.({ id, asset, amount, mints, reads, f, service });
  const row = store.get('mints', id), payment = r.hash('first-mint-payment-' + asset) + 'i0';
  transfers.set(payment, row.quote.fees.map(fee => ({ ins: payment, fail: false, int: true, addr: row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
  await assert.rejects(service.reportMintPayment({ id, paymentId: payment }), /payment_unconfirmed/);
  f.canonical.set(payment, 100);
  await service.reportMintPayment({ id, paymentId: payment });
  await options.beforePaymentBatch?.({ id, mints, reads, service }); await drain();
  await mints.tick(); await drain(); await mints.tick();
  const ready = await service.mintStatus(id);
  assert.equal(ready.state, 'permit_issued'); assert.equal(ready.mintContent.dep, deployment);
  assert.equal(contract.db.get('ao/' + id).state, 'consumed'); assert.equal(contract.db.get('fp/' + id).state, 'consumed');
  assert.equal(ready.mintContent.op, 'dmt-mint'); assert.equal(ready.mintContent.tick, provenance.pattern.name);
  const text = mintContent(ready, receiver), script = Buffer.from(p2tr(secp256k1.getPublicKey(bitcoinSecret).slice(1)).script).toString('hex');
  // The kit can build the final permit inscription, with no Bitcoin broadcast.
  const plan = buildInscription({ text, receiver, publicKey: bitcoinPublic, network: 'regtest', feeRate: 2, maxFeeSats: '10000',
    utxos: [{ txid: r.hash('cardinal'), vout: 0, value: '100000', script, confirmed: true, cardinal: true }] });
  assert.ok(signCommit(plan, bitcoinSecret).revealHex);
  await service.reportMintPayment({ id, inscription: plan.inscriptionId });
  assert.equal(store.get('mints', id).mintInscription, plan.inscriptionId);
  if (options.confirmMint) {
    const source = await reads.assetContext(asset, block);
    mintedObservations.set(id, { accepted: true, fail: false, confirmations: 1, inscription: plan.inscriptionId,
      deployment, tick: source.deployment.tick, receiver, amount, block, dta: ready.mintContent.dta, permitHash: ready.mintContent.prv.hash, committee: publicKey });
    await mints.tick(); await drain(); await mints.tick();
    assert.equal((await service.mintStatus(id)).state, 'minted');
    assert.equal(contract.db.get('dc/' + id).state, 'minted');
  }
  if (publicChecks) {
    await project();
    const publicBlock = '201', otherSecret = new Uint8Array(32).fill(45), otherPublic = Buffer.from(secp256k1.getPublicKey(otherSecret)).toString('hex');
    const other = fundingAddress(otherPublic, 'regtest'), height = r.decimalV2((await stamp()).counted);
    const beforeAccount = contract.db.get('ar/' + agent.owner);
    const post = (route, value) => service.request(route, { value });
    const list = await service.request('/public-mints', { query: { asset: catalogAsset } });
    assert.ok(list.rows.some(row => row.block === publicBlock));
    assert.ok(list.rows.every(row => row.state === 'public'));
    const a = await post('/public-mints/start', { asset: catalogAsset, block: publicBlock, tapAddress: receiver });
    const b = await post('/public-mints/start', { asset: catalogAsset, block: publicBlock, tapAddress: other });
    assert.equal(a.reservation, 'none'); assert.equal(b.reservation, 'none');
    assert.equal(a.payer, receiver); assert.equal(b.payer, other);
    assert.equal(store.get('holds', asset + '/' + publicBlock), null);
    const makePayment = (status, key, publicKey) => {
      const payload = { p: 'tap', op: 'token-auth', redeem: { items: r.walletFeeItems(status.fees, 'regtest') } };
      const p = buildInscription({ text: JSON.stringify(payload), receiver: status.receiver, publicKey, network: 'regtest', feeRate: 1, maxFeeSats: '1000000',
        utxos: [{ txid: r.hash('public-cardinal-' + status.id), vout: 0, value: '10000000', script: Buffer.from(p2tr(secp256k1.getPublicKey(key).slice(1)).script).toString('hex'), confirmed: true, cardinal: true }] });
      const signed = signCommit(p, key);
      transfers.set(p.inscriptionId, status.fees.map(fee => ({ ins: p.inscriptionId, fail: false, int: true, addr: status.receiver, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
      f.contents.set(p.inscriptionId, payload); f.canonical.set(p.inscriptionId, Number(height));
      return { ...p, revealHex: signed.revealHex };
    };
    f.mine(Number(height) - 100);
    const first = makePayment(a, bitcoinSecret, bitcoinPublic), second = makePayment(b, otherSecret, otherPublic);
    publicBlocks.set(height, [first, second]);
    const transition = { type: 'public-scan', id: r.publicPlotId(asset, publicBlock), asset, block: publicBlock, previous: r.hashObject(null) };
    assert.deepEqual(await reads.publicMintScan(transition, await stamp()), await independent.publicMintScan(transition, await stamp()), 'independent readers reconstruct the same complete Bitcoin prefix');
    // Report the losing payment first, and never report the winning one.
    await service.reportMintPayment({ id: b.id, paymentId: second.inscriptionId });
    for (let i = 0; i < 20 && mints.public(a.id).state !== 'permit_issued'; i++) { await mints.tick(); await drain(); }
    await mints.tick();
    const winner = await service.mintStatus(a.id), loser = await service.mintStatus(b.id);
    assert.equal(winner.state, 'permit_issued'); assert.equal(loser.state, 'refundable');
    assert.equal(loser.reason, 'someone_paid_first'); assert.equal(loser.refunds.length, 1);
    assert.equal(loser.refunds[0].reference, second.inscriptionId);
    assert.equal(loser.refunds[0].requestId, b.id); assert.equal(loser.refunds[0].paymentId, second.inscriptionId);
    assert.equal(contract.db.get('ao/' + a.id), undefined, 'no Trac obligation');
    assert.deepEqual(contract.db.get('ar/' + agent.owner), beforeAccount, 'public mint spends no units');
    assert.equal(contract.db.get('fp/' + b.id), undefined, 'loser receives no permit funding');
    await assert.rejects(policies[0].approve({ network, kind: 'mint', version: 'public-v1', id: b.id, receiver: other }), /public_payment_unsettled/);
    const owed = await service.request('/public-mints/refunds', { query: { tapAddress: other } });
    assert.equal(owed.rows.length, 1); assert.equal(owed.rows[0].state, 'owed');
    assert.equal((await service.request('/public-mints', { query: { asset: catalogAsset } })).rows.some(row => row.block === publicBlock), false);
    await assert.rejects(post('/public-mints/start', { asset: catalogAsset, block: publicBlock, tapAddress: other }), /someone_paid_first/);
    await mints.tick(); assert.equal((await service.mintStatus(a.id)).mintContent.prv.hash, winner.mintContent.prv.hash);
    const publicPlan = buildInscription({ text: mintContent(winner, receiver), receiver, publicKey: bitcoinPublic, network: 'regtest', feeRate: 1, maxFeeSats: '1000000',
      utxos: [{ txid: r.hash('public-mint-inscription'), vout: 0, value: '10000000', script, confirmed: true, cardinal: true }] });
    assert.ok(signCommit(publicPlan, bitcoinSecret).revealHex);
    await service.reportMintPayment({ id: a.id, inscription: publicPlan.inscriptionId });
    const source = contract.db.get('fi/source/' + a.id);
    mintedObservations.set(a.id, { accepted: true, fail: false, confirmations: 1, inscription: publicPlan.inscriptionId,
      deployment, tick: source.deployment.tick, receiver, amount: winner.amount, block: publicBlock,
      dta: winner.mintContent.dta, permitHash: winner.mintContent.prv.hash, committee: publicKey });
    await mints.tick(); await drain(); await mints.tick();
    assert.equal((await service.mintStatus(a.id)).state, 'minted');
    assert.equal(contract.db.get('dc/' + a.id).state, 'minted');
    const finalBlock = await service.request('/public-mints/' + catalogAsset + '/' + publicBlock);
    assert.equal(finalBlock.state, 'already_minted');
    assert.deepEqual(contract.db.get('ar/' + agent.owner), beforeAccount, 'confirmed public mint still consumes no units');
    const restarted = new FinancialMints({ store, reads: independent, financial, committee, document, network, bitcoinNetwork: 'regtest' });
    await restarted.tick();
    assert.equal(restarted.public(a.id).mintContent.prv.hash, winner.mintContent.prv.hash);
    assert.equal(restarted.public(b.id).refunds[0].paymentId, second.inscriptionId);
  }
  return { asset, requestId: id, deployment, permit: ready.mintContent, mints, service,
    f, reads, receiver, transfers, bitcoinSecret, bitcoinPublic, publicBlocks, independent };
}
