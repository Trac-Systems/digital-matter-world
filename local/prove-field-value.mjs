#!/usr/bin/env node
// Real regtest TAP transport, with deterministic local DMW execution. The local
// stack has no Trac devnet: accepted account records below are a local replay.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import * as r from '../rules/src/index.js';
import { current, bitcoin, receiveAddress, ordJson, mine, save, localUrl } from './common.mjs';
import { inscribe, sendInscription } from './inscriber.mjs';
import { authority, redeem, testKey } from './protocol.mjs';
import { loadRegtestHistory } from '../kit/lib/headers.mjs';
import { searchMatchPage } from '../kit/lib/search-matches.mjs';
import { Store } from '../service/src/store.mjs';
import { Provisioner } from '../service/src/provisioning.mjs';
import { FeeQuotes, createFeePolicy } from '../service/src/fees.mjs';
import { AccountExecution } from '../service/src/account-batch.mjs';
import { FinancialExecution } from '../service/src/financial-execution.mjs';
import { FinancialMints } from '../service/src/financial-mints.mjs';
import { installFinancialSources } from '../service/src/financial-sources.mjs';
import { verifyFinancialExecution } from '../committee/signer/financial-execution.mjs';
import { Policy } from '../committee/signer/policy.mjs';
import { attachPermit } from '../committee/signer/adapter.mjs';
import { verifyMintResult } from '../committee/signer/certificate.mjs';
import { financialMintDigest, financialMintId } from '../rules/src/financial-mint.js';
import { accountActionDigest } from '../contract/root-accounts.js';
import { payerDigest } from '../service/src/mints.mjs';
import { capacityKey, reserveFinancialCapacity } from '../contract/financial-capacity.js';
import { winningMint } from '../service/src/mint-evidence.mjs';

export async function proveFieldValue(manifest, log = () => {}) {
  for (const url of [manifest.bitcoin.rpc, manifest.ord.url]) localUrl(url);
  assert.equal((await bitcoin(manifest, 'getblockchaininfo')).chain, 'regtest');
  let counted = String(await bitcoin(manifest, 'getblockcount'));
  assert(r.fieldValueAmountActive(counted), 'Use a disposable local activation edit; production placeholder must stay unchanged');
  const network = 'dmw-regtest-field-value', suffix = randomBytes(4).toString('hex');
  const directory = `${manifest.root}/field-value-${suffix}`;
  const store = await Store.open(directory), registryPath = `${directory}/registry.json`;
  const proof = { network, activationHeight: r.FIELD_VALUE_AMOUNT_HEIGHT, run: manifest.root,
    limitation: 'Trac transport is unavailable in local/stack; claims and financial batches use the actual rules, contract and independent signer verifier in a local accepted-record replay.',
    transactions: [], moves: [], patterns: [], mints: [], refusals: {}, quotes: [] };
  const checkpoint = () => save(`${manifest.root}/field-value-proof.json`, proof);
  let operator;
  try {
    const tap = async path => (await ordJson(manifest, '/r/tap/' + path)).result;
    const refresh = async () => { counted = String(await bitcoin(manifest, 'getblockcount')); };
    const write = async (text, receiver, label) => {
      const result = await inscribe(manifest, [{ text, receiver }]); await mine(manifest); await refresh();
      proof.transactions.push({ label, commit: result.commit, reveal: result.reveal, inscription: result.inscriptions[0].id });
      await checkpoint(); return result.inscriptions[0].id;
    };
    const activate = async (text, receiver, label) => {
      const id = await write(text, receiver, label), sent = await sendInscription(manifest, id, receiver);
      await mine(manifest); await refresh(); proof.transactions.push({ label: label + ' activation', transaction: sent });
      return id;
    };
    const receiver = await receiveAddress(manifest), treasury = await receiveAddress(manifest);
    const signerSecret = testKey(), payerKey = testKey(), ownerSecret = randomBytes(32), gatewaySecret = randomBytes(32);
    const owner = r.bytesToHex(ed25519.getPublicKey(ownerSecret)), publicKey = r.bytesToHex(secp256k1.getPublicKey(signerSecret));
    proof.receiver = receiver;
    log('Activating a regtest privilege authority and funding local TAP fees');
    const privilege = await activate(authority(signerSecret, { privilege: true }), receiver, 'privilege authority');
    assert.equal(await tap('getDeployment/tap'), null, 'Run this proof on a fresh disposable stack');
    await write({ p: 'tap', op: 'token-deploy', tick: 'tap', max: '1000', dec: '18' }, receiver, 'fee token deployment');
    await write({ p: 'tap', op: 'token-mint', tick: 'tap', amt: '1000' }, receiver, 'fee token funding');
    const payerAuth = await activate(authority(payerKey, { auth: ['tap'] }), receiver, 'payer authority');
    const { changes } = JSON.parse(await readFile(new URL('../service/test/fixtures/flat-fees.json', import.meta.url)));
    const { baseFee, ...feeSettings } = changes, feePolicy = createFeePolicy(baseFee, Date.now(), feeSettings);
    const document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '0', values: {
      ...r.SETTINGS_PROFILE, feePolicyRevision: feePolicy.current, linkMultiplier: 1, puzzleBits: 0 } });
    await writeFile(registryPath, JSON.stringify({ assets: {}, feePolicy, link: { treasury } }), { mode: 0o600 });
    const registry = () => readFile(registryPath, 'utf8').then(JSON.parse);
    const content = async id => {
      const response = await fetch(manifest.ord.url + '/content/' + id); assert(response.ok);
      const text = await response.text(); try { return JSON.parse(text); } catch { return text; }
    };
    const included = async id => {
      const row = await ordJson(manifest, '/inscription/' + id);
      return { height: String(row.height), confirmations: Number(counted) - row.height + 1,
        blockHash: await bitcoin(manifest, 'getblockhash', [row.height]) };
    };
    const elements = () => tap('getDmtElementsList');
    const chain = { registry, tap, content, included, inscription: id => ordJson(manifest, '/inscription/' + id),
      counted: async () => counted, authority: async () => ({ network, committee: publicKey, epoch: 0 }),
      element: async id => (await elements()).find(e => e.ins === id) ?? null,
      elementByDefinition: async (pat, fld) => (await elements()).find(e => (e.pat ?? null) === pat && Number(e.fld) === fld) ?? null,
      elementByName: async name => (await elements()).find(e => e.tick.toLowerCase() === name.toLowerCase()) ?? null,
      mintedInscription: async id => (await tap('getMintedList/' + id.slice(0, 64))).find(m => m.ins === id) ?? null,
      privilegeAuthority: async id => (await tap('getPrivilegeAuthList')).find(a => a.ins === id) ?? null,
      bindings: { bitcoinNetwork: 'regtest', resolve: () => ({ request: { address: receiver } }) },
      rulesContext: async () => ({ settings: document }) };
    operator = new Provisioner({ store, reads: chain, network, registryPath, policy: {
      confirmations: 1, privilege, authorityKey: publicKey, tapTreasury: treasury, ethereumTreasury: 'unused-regtest' } });
    const headers = [];
    for (let h = 0; h <= Number(counted); h++) {
      const hash = await bitcoin(manifest, 'getblockhash', [h]);
      headers.push(Buffer.from(await bitcoin(manifest, 'getblockheader', [hash, false]), 'hex'));
    }
    const headerPath = `${directory}/headers.bin`; await writeFile(headerPath, Buffer.concat(headers));
    const history = await loadRegtestHistory(headerPath), tip = { height: history.length - 1, hash: history.get(history.length - 1).hash };
    const proposals = [
      { name: 'dmwvalue' + suffix, pat: '^[2-9]', fld: 10, dt: 'n', amountMode: 'field-value' },
      { name: 'dmwreuse' + suffix, pat: '^[1-9]', fld: 10, dt: 'n', amountMode: 'field-value' },
      { name: 'dmwbits' + suffix, pat: '^[0-9a-f]', fld: 11, dt: 'h', amountMode: 'field-value' },
      { name: 'dmwcount' + suffix, pat: '[0-9]', fld: 4, dt: 'n' }
    ];
    let named = r.emptyNamedDiscovery(), sequence = '0'; const claims = {}, records = new Map(), selected = [];
    const namedMove = async (type, payload) => {
      const tipHash = await bitcoin(manifest, 'getblockhash', [Number(counted)]);
      const move = { v: 2, ruleset: document.ruleset, network, settingsHash: r.hashObject(document), settingsRevision: document.revision,
        a: owner, t: type, b: counted, h: tipHash, p: payload, w: '0' };
      move.sig = r.bytesToHex(ed25519.sign(r.moveDigestV2(move), ownerSecret));
      const next = String(BigInt(sequence) + 1n);
      const receipt = r.signReceiptV2(move, { tip: counted, hash: tipHash, sequence: next, batch: '1' }, gatewaySecret);
      const result = r.replayNamedEntries(named, { entries: [{ move, receipt }], settings: document,
        settingsHistory: { get: hash => { assert.equal(hash, r.hashObject(document)); return document; } },
        batch: '1', gateway: r.bytesToHex(ed25519.getPublicKey(gatewaySecret)), history,
        hashAt: height => String(height) === counted ? tipHash : history.get(height).hash,
        counted, executionHeight: counted, lastSequence: sequence });
      assert.equal(result.outcomes[0].reason, 'accepted'); named = result.state; sequence = next;
      proof.moves.push({ type, id: r.moveIdV2(move), receiptHash: r.hashObject(receipt), executionHeight: counted, outcome: 'accepted' });
      return result.outcomes[0];
    };
    log('Searching verified regtest headers, revealing named patterns and settling claims');
    for (const [i, proposal] of proposals.entries()) {
      const search = await searchMatchPage({ history, tip, proposal, pageSize: 100, settings: document });
      assert(search.matches.length >= document.values.minMatchingBlocks);
      const matches = search.matches.slice(0, Math.max(3, document.values.minMatchingBlocks)), salt = r.hash('salt/' + suffix + i);
      const anchor = { height: String(tip.height), hash: tip.hash };
      const commitment = r.namedCommitment({ proposal, salt, agent: owner, anchor, matches, settings: document });
      await namedMove('discovery-commit-v2', { commitment });
      await mine(manifest, 2); await refresh();
      const result = await namedMove('discovery-reveal-v2', { proposal, salt, commitmentId: commitment, anchor, matches, witnessRoot: r.witnessRoot(matches) });
      const pattern = result.record, asset = 'p2:' + pattern.number;
      records.set(asset, pattern);
      const blocks = i === 0 ? matches.slice(0, 2).map(m => m.height) : [proposal.fld === 4 ? '100' :
        (i === 1 ? matches.find(m => m.count === '1') ?? matches[0] : matches[0]).height];
      const plots = blocks.map(block => ({ block, patterns: [pattern.number] }));
      await namedMove('claim-v2', { window: counted, plots });
      const event = r.claimRound(counted, await bitcoin(manifest, 'getblockhash', [Number(counted)]), counted, String(records.size));
      event.policy = { settingsHash: r.hashObject(document), claimsPerWindow: document.values.claimsPerWindow,
        claimWindowBlocks: document.values.claimWindowTips, finderWindow: document.values.finderWindow };
      const entered = r.enterClaims({ state: claims, event, agent: owner, plots,
        patterns: new Map([[pattern.number, pattern]]), history, settings: { document }, height: counted, executionHeight: counted });
      assert.equal(entered.slots.length, blocks.length);
      await mine(manifest, 2); await refresh();
      r.freezeClaimWindow({ state: claims, event, decidingHash: await bitcoin(manifest, 'getblockhash', [Number(counted)]), counted, settings: { document } });
      const budget = new r.CreditBudget({ document });
      while (r.takeSettlementPage({ state: claims, event, height: counted, budget })) {}
      const balance = r.recordGet(claims.balances, owner)[asset];
      const execution = new AccountExecution({ store, document, height: counted });
      await execution.accounts([{ type: 'credit', owner, asset, amount: balance }]); await store.transact(execution.result().writes);
      for (const block of blocks) selected.push({ asset, block, amount: String(r.recordGet(claims.finds, r.findIdV2(block, pattern.number)).count) });
      proof.patterns.push({ asset, proposal, commitment, witnesses: matches, knownMatchCount: pattern.knownMatchCount,
        knownOccurrenceTotal: pattern.knownOccurrenceTotal, claimBlocks: blocks, creditedUnits: balance });
      await checkpoint();
    }
    log('Provisioning TAP deployments, including reuse of a pattern-free nonce element');
    for (const [asset, pattern] of records) {
      let job;
      for (let attempt = 0; attempt < 8; attempt++) {
        job = await operator.advanceAsset(asset, pattern);
        if (job.state === 'registered') break;
        assert.equal(job.state, 'awaiting_player_deploy', JSON.stringify({ state: job.state, reason: job.reason }));
        const id = await write(job.content, receiver, `${asset} ${job.phase}`);
        job = await operator.submit(asset, { phase: job.phase, inscription: id });
        if (job.state === 'registered') break;
      }
      assert.equal(job.state, 'registered');
      Object.assign(proof.patterns.find(p => p.asset === asset), { element: job.elementId, reused: job.reused, deployment: job.entry.id, ticker: job.entry.indexTick });
    }
    assert.equal(proof.patterns[0].element, proof.patterns[1].element);
    assert.equal(proof.patterns[1].reused, true);
    assert.equal((await chain.element(proof.patterns[0].element)).pat, null);
    let revision = 0, signCount = 0, quoteTier;
    const accepted = new Map();
    const stamp = async () => ({ counted, last: { n: revision, to: counted }, revision, tip: counted,
      tipHash: await bitcoin(manifest, 'getblockhash', [Number(counted)]) });
    const assetContext = async (asset, block) => {
      const entry = (await registry()).assets[asset]; assert(entry);
      const pattern = records.get(asset), find = pattern && r.recordGet(claims.finds, r.findIdV2(String(block), pattern.number));
      return { pattern, find: find ?? null, link: null, tier: quoteTier ?? pattern?.tier ?? 1,
        treasury, finderAddress: receiver, discoverer: receiver, firstMakerAddress: receiver,
        beneficiaries: { finder: owner, discoverer: owner, firstMaker: owner }, payouts: {},
        deployment: { ...entry, active: true, privilegePublicKey: publicKey, decimals: 0,
          remaining: await tap('getMintTokensLeft/' + entry.indexTick), limit: '0' } };
    };
    const base = { ...chain, assetContext, batchStamp: stamp, link: async () => null,
      bitmap: async block => { const bm = await tap('getBitmap/' + block); assert.equal(bm.ownr, receiver); return { agent: owner, address: receiver }; },
      isMinted: async (dep, tick, block) => !!await tap(`getDmtMintHolderByBlock/dmt-${tick}/${block}`),
      paymentTransfers: async id => (await tap('getTransferredList/' + id.slice(0, 64))).map((value, index) => ({ index, value })),
      mint: async id => {
        const row = store.get('mints', id); if (!row?.mintInscription) return null;
        return winningMint(chain, row, { id: row.mintInscription }, (digest, sig) => {
          const compact = ['r', 's'].map(k => BigInt(sig[k]).toString(16).padStart(64, '0')).join('');
          return secp256k1.Signature.fromCompact(compact).addRecoveryBit(Number(sig.v)).recoverPublicKey(digest).toHex(true);
        });
      } };
    const makeReads = () => installFinancialSources({ ...base,
      feeQuotes: new FeeQuotes({ network, secret: gatewaySecret, registry, settings: () => document }) }, {
      network, document, bitcoinNetwork: 'regtest', recoveryVersion: 2,
      request: id => store.get('mints', id), reservation: async id => accepted.get(id), record: async key => store.get('accountRecords', key) });
    const reads = makeReads(), independent = makeReads(), financial = new FinancialExecution({ store, reads, document });
    const signer = new Policy({ network, publicKey, reads: independent, bitcoinNetwork: 'regtest' });
    const committee = { signature: async (_key, proposal) => {
      const approval = await signer.approve(proposal), sig = secp256k1.sign(approval.digest, signerSecret, { lowS: true });
      const signature = { compact: sig.toCompactHex(), r: String(sig.r), s: String(sig.s), v: sig.recovery };
      verifyMintResult(approval.details, signature, { network, publicKey, id: approval.details.id }); signCount++;
      return { session: r.hash('local/' + signCount), payload: attachPermit(approval.permit, signature) };
    } };
    const mints = new FinancialMints({ store, reads, financial, committee, network, document, bitcoinNetwork: 'regtest' });
    const execute = async () => {
      const at = await stamp(), result = await financial.build({ height: counted, at });
      assert.deepEqual(result.deferred, []);
      await verifyFinancialExecution({ files: [{ ops: result.operations, financialOperations: result.inputs }], reads: independent, document, network, height: counted, at });
      for (const input of result.inputs) if (input.transition.type === 'reserve') accepted.set(input.transition.id, input.evidence);
      const draft = { proposal: { batch: { n: ++revision } }, items: [{ output: { file: { financialOperations: result.inputs } } }] };
      await store.transact([...result.writes, ...financial.acceptedOperations(draft)]);
    };
    for (const asset of records.keys()) {
      const generation = await reads.financialDeployment(asset, await stamp());
      await financial.submit({ type: 'lifecycle', id: generation.id, action: generation.action }); await execute();
    }
    // Quotes use live indexed deployments and the local all-one policy.
    for (quoteTier = 1; quoteTier <= 5; quoteTier++) {
      const quote = await mints.quote({ ...selected[0], payer: receiver }); assert.equal(quote.price, baseFee);
      proof.quotes.push({ kind: 'find', tier: quoteTier, price: quote.price });
    }
    quoteTier = undefined;
    const compoundId = 'c2:' + r.hash('compound/' + suffix), tick = 'dmwcompound' + suffix;
    const compoundDeployment = await write({ p: 'tap', op: 'token-deploy', tick, max: '18446744073709551615', dec: '0', prv: privilege }, receiver, 'compound quote deployment');
    const reg = await registry(); reg.assets[compoundId] = { id: compoundDeployment, asset: compoundId, kind: 'compound', tick, indexTick: tick,
      privilege, authorityKey: publicKey, options: { max: '18446744073709551615', dec: '0' } }; await save(registryPath, reg);
    const generation = await reads.financialDeployment(compoundId, await stamp());
    await financial.submit({ type: 'lifecycle', id: generation.id, action: generation.action }); await execute();
    const compoundQuote = await mints.quote({ asset: compoundId, amount: '1', payer: receiver }); assert.equal(compoundQuote.price, baseFee);
    proof.quotes.push({ kind: 'compound', price: compoundQuote.price });
    await write('100.bitmap', receiver, 'Bitmap for link quote');
    const linkQuote = await reads.financialLinkQuote({ block: '100', payer: receiver }); assert.equal(linkQuote.price, baseFee);
    proof.quotes.push({ kind: 'link', price: linkQuote.price });
    log('Checking nonmatching blocks and capacity refusal before any mint signature');
    const nonmatch = Array.from({ length: history.length }, (_, h) => h).find(h => history.get(h).nonce > 0 && r.patternAmount(proposals[0], history.get(h)) === '0');
    assert.notEqual(nonmatch, undefined);
    const refusedClaim = r.enterClaims({ state: {}, event: r.claimRound(counted, r.hash('refused'), counted, '4'), agent: owner,
      plots: [{ block: String(nonmatch), patterns: ['0'] }], patterns: new Map([['0', records.get('p2:0')]]), history, settings: { document }, height: counted });
    assert.deepEqual(refusedClaim.slots, []);
    await assert.rejects(mints.quote({ asset: selected[0].asset, block: String(nonmatch), payer: receiver }), /mint_no_find/);
    const unsigned = await write({ p: 'tap', op: 'dmt-mint', tick: proposals[0].name, blk: String(nonmatch), dep: proof.patterns[0].deployment }, receiver, 'unsigned excluded block');
    assert.equal(await tap(`getDmtMintHolderByBlock/${proof.patterns[0].ticker}/${nonmatch}`), null);
    assert.equal(String(await tap(`getBalance/${receiver}/${proof.patterns[0].ticker}`) ?? '0'), '0');
    proof.refusals.nonmatch = { block: String(nonmatch), nonce: String(history.get(nonmatch).nonce), error: 'mint_no_find', signatures: signCount, unsignedInscription: unsigned };
    const capacity = { deployment: proof.patterns[0].deployment, ...selected[0], remaining: String(BigInt(selected[0].amount) - 1n), limit: '0' };
    await assert.rejects(reserveFinancialCapacity({ get: async () => null }, r.hash('local-capacity'), capacity), /financial_capacity_reserved/);
    const remaining = await tap('getMintTokensLeft/' + proof.patterns[0].ticker);
    await assert.rejects(reserveFinancialCapacity({ get: async () => null }, r.hash('real-capacity'), { ...capacity, amount: String(BigInt(remaining) + 1n), remaining }), /financial_capacity_reserved/);
    const occupied = String(BigInt(remaining) - BigInt(selected[0].amount) + 1n);
    await assert.rejects(reserveFinancialCapacity({ get: async key => key === capacityKey(capacity.deployment) ? occupied : null },
      r.hash('reserved-capacity'), { ...capacity, remaining }), /financial_capacity_reserved/);
    proof.refusals.capacity = { required: selected[0].amount, remaining: capacity.remaining, indexedRemaining: remaining,
      excessiveRequest: String(BigInt(remaining) + 1n), simulatedReserved: occupied, error: 'financial_capacity_reserved', signatures: signCount };
    assert.equal(signCount, 0); await checkpoint();
    log('Signing agent reservations, paying real TAP fees, approving permits and indexing mints');
    for (const selection of selected) {
      const quote = await mints.quote({ ...selection, payer: receiver, receiver });
      const request = { v: 2, owner, ...selection, receive: r.hash(receiver), nonce: r.hash('mint/' + suffix + selection.asset + selection.block),
        until: String(BigInt(counted) + 20n), expires: String(BigInt(counted) + 432n), settingsHash: quote.feeQuote.settingsHash };
      const body = { request, signature: r.bytesToHex(ed25519.sign(financialMintDigest(network, request), ownerSecret)), receiver, payer: receiver, kind: 'tap', feeQuote: quote.feeQuote };
      body.authorization = r.bytesToHex(ed25519.sign(payerDigest(network, body), ownerSecret));
      const pending = await mints.request(body), action = pending.reservationAction;
      const reserve = { ...action, sig: r.bytesToHex(ed25519.sign(accountActionDigest(network, action), ownerSecret)) };
      await mints.request({ ...body, reserve }); await execute();
      const id = financialMintId(network, request), row = store.get('mints', id);
      const payment = await write(redeem(payerAuth, [], payerKey, { items: r.walletFeeItems(row.quote.fees, 'regtest') }), receiver, `${selection.asset}/${selection.block} fee payment`);
      await mints.payment({ id, paymentId: payment }); await execute();
      await mints.tick(); await execute(); await mints.tick();
      const status = mints.public(id); assert.equal(status.state, 'permit_issued', JSON.stringify({ state: status.state, reason: status.reason, blocked: status.blocked }));
      const entry = (await registry()).assets[selection.asset], before = String(await tap(`getBalance/${receiver}/${entry.indexTick}`) ?? '0');
      const inscription = await write(status.permit, receiver, `${selection.asset}/${selection.block} permitted mint`);
      const after = String(await tap(`getBalance/${receiver}/${entry.indexTick}`));
      assert.equal(BigInt(after) - BigInt(before), BigInt(selection.amount));
      const holder = await tap(`getDmtMintHolderByBlock/${entry.indexTick}/${selection.block}`);
      assert.equal(holder.ins, inscription);
      const indexed = (await tap('getTickerMintList/' + entry.indexTick)).find(m => m.ins === inscription);
      assert.equal(indexed.fail, false); assert.equal(indexed.amt, selection.amount);
      await mints.payment({ id, inscription }); await mints.tick(); await execute(); await mints.tick();
      assert.equal(mints.public(id).state, 'minted');
      assert.equal(store.get('accountRecords', 'dc/' + id).state, 'minted');
      proof.mints.push({ ...selection, requestId: id, payment, inscription, permitHash: status.permit.prv.hash,
        ticker: entry.indexTick, before, after, indexedAmount: indexed.amt, holder, state: 'minted' }); await checkpoint();
    }
    assert.equal(proof.mints.at(-1).amount, '3', 'count control keeps the three digits of block 100');
    proof.signatures = signCount; proof.completed = true; proof.endHeight = counted; await checkpoint();
    return proof;
  } catch (error) { proof.error = error.stack; await checkpoint(); throw error; }
  finally { await operator?.close(); await store.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  proveFieldValue(await current(), console.log).then(p => console.log(JSON.stringify(p, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
