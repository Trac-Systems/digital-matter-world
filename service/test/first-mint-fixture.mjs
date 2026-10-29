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

// Real settled catalog/find roots, account balances, financial batches and
// notary from v2-stack. Only the Bitcoin index and payment receipt are fixtures.
export async function firstMintStack(t, { store, contract, document, network, secret, committeeSecret,
  rulesContext, stamp, financial, sourceReady, clientOptions = {}, initialize = async () => {}, configureReads = () => {}, httpOptions = () => ({}) }) {
  const f = await provisioningFixture(t, { secret: committeeSecret });
  await writeFile(f.registryPath, JSON.stringify({ assets: {}, feePolicy: createFeePolicy('100') }));
  await initialize(f);
  const publicKey = f.policy.authorityKey, transfers = new Map();
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
      assetContext: async (requested, height) => {
        const source = await acceptedAssetProvenance({ store, reads: { rulesContext }, asset: patternCatalogId(requested) ?? requested, block: height });
        const entry = (await f.reads.registry()).assets[requested];
        const verified = await verifyDeployment(reads, entry);
        assert.equal(entry.pattern.pat, source.pattern.pat);
        return { deployment: { ...entry, active: true, privilegePublicKey: publicKey, decimals: 0, remaining: '1000000', limit: '0' },
          find: source.find, link: null, tier: source.tier, treasury: 'regtest-treasury', finderAddress: 'regtest-finder', discoverer: 'regtest-discoverer',
          beneficiaries: { finder: source.find.finder, discoverer: source.pattern.discoverer }, payouts: { finder: null, discoverer: null }, assetRevision: source.revision };
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
    return { session: r.hash('first-mint-session'), payload: attachPermit(approvals[0].permit, { r: String(signed.r), s: String(signed.s), v: signed.recovery }) };
  } };
  const provisioner = new Provisioner({ ...f, store, reads }), mints = new FinancialMints({ store, reads, financial, committee, document, network, bitcoinNetwork: 'regtest' });
  mints.provisioner = provisioner;
  const http = await serve({ intake: { store }, files: { serve: async () => false }, mints, operator: { provisioner },
    publicAPI: createPublicAPI({ views: { store, mints } }), ...httpOptions({ reads, mints, f }) }); t.after(() => http.close());
  const service = new ServiceClient({ origin: http.url, network, ...clientOptions });
  return { f, reads, independent, policies, mints, service, receiver, transfers, bitcoinSecret, bitcoinPublic, http, makeReads };
}

export async function firstMintFixture(t, options) {
  const { store, contract, rulesContext, drain, agent, catalogAsset, block = '1' } = options;
  const provenance = await acceptedAssetProvenance({ store, reads: { rulesContext }, asset: catalogAsset, block });
  const asset = provenance.find.asset, amount = String(provenance.find.count);
  assert.equal(provenance.find.finder, agent.owner);
  const { f, mints, service, receiver, transfers, bitcoinSecret, bitcoinPublic } = await firstMintStack(t, options);
  const originalService = agent.service; agent.service = service;
  t.after(() => { agent.service = originalService; });
  const intent = { asset: catalogAsset, amount, block, receiver, payer: receiver, kind: 'tap', compound: false };
  const tool = gameTools({ agent, candidates: async (asset, { block }) => (await service.mintRights(agent.address, { asset, block })).mintRights }).mint_on_chain;
  const args = tool.schema.parse({ ...intent, actionId: 'first-deploy-' + catalogAsset.replace(':', '-') });
  const make = () => tool.run(args);
  const first = await make(); assert.equal(first.state, 'deployment_needed'); assert.equal(first.signed, false);
  assert.equal(first.asset, asset); assert.equal(first.requestId, null); assert.equal(first.payable, false);
  assert.equal(first.next[0].tool, 'inscribe_deployment');
  let job = await service.deployment(catalogAsset);
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
  assert.equal((await make()).state, 'deployment_pending');
  await drain(); assert.ok(contract.db.get('fd/asset/' + asset));
  const quoted = await service.mintQuote({ asset: catalogAsset, amount, block }); assert.equal(quoted.asset, asset); assert.equal(quoted.jobState, 'registered');
  const requested = await make(), id = requested.request.requestId;
  assert.equal(requested.state, 'submitted'); assert.equal(store.get('mints', id).request.asset, asset);
  await drain(); await mints.tick();
  assert.equal((await service.mintStatus(id)).payable, true);
  const row = store.get('mints', id), payment = r.hash('first-mint-payment-' + asset) + 'i0';
  transfers.set(payment, row.quote.fees.map(fee => ({ ins: payment, fail: false, int: true, addr: row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
  await assert.rejects(service.reportMintPayment({ id, paymentId: payment }), /payment_unconfirmed/);
  f.canonical.set(payment, 100);
  await service.reportMintPayment({ id, paymentId: payment }); await drain();
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
  return { asset, requestId: id, deployment, permit: ready.mintContent };
}
