import assert from 'node:assert/strict';
import { bitcoin, mine, waitIndexed } from '../../local/common.mjs';
import { inscribe } from '../../local/inscriber.mjs';
import { redeem } from '../../local/protocol.mjs';
import { rules as r } from '../src/rules.mjs';
import { quoteBulkMint, makeBulkMint } from '../../kit/lib/bulk-mint.mjs';
import { applyMatchingCredit, listFeeCredits } from '../../kit/lib/financial-credit.mjs';
import { TapWalletMint } from '../../kit/lib/tap-wallet-mint.mjs';
import { TapWalletBulkMint } from '../../kit/lib/tap-wallet-bulk-mint.mjs';
import { bulkWalletItems, bulkReceiptKey } from '../../rules/src/bulk-mint.js';
import { accountKey, readAccountLeaf } from '../../contract/account-tree.js';
import { AccountAvailability } from '../src/account-availability.mjs';

export async function runLatePaymentRehearsal({ stack, runtime, store, contract, agent, service, document, progress, sync,
  payer, receiver, payerKey, authId, bulkEntry, bulkTransport, inscription, candidateFor, pass }) {
  assert.equal(document.values.pendingBlocks, 6);
  const head = () => contract.state().head(), results = [];
  const balance = asset => {
    const account = store.get('accountRecords', 'ar/' + agent.owner), key = accountKey('balance', asset);
    return readAccountLeaf(account.root, new AccountAvailability(store).prove(account.root, [key]), key);
  };
  const empty = async n => {
    for (let i = 0; i < n; i++) await bitcoin(stack, 'generateblock', [stack.bitcoin.miningAddress, []]);
    await waitIndexed(stack); await sync();
  };
  const create = async (actionId, asset = 'c1', block) => {
    const result = await agent.makeReal({ actionId, asset, amount: '3', receiver, payer, kind: 'tap', compound: block === undefined,
      ...(block === undefined ? {} : { block, candidate: await candidateFor(asset, block) }) });
    const id = result.request.requestId;
    await progress(() => runtime.mints.public(id).payable);
    assert.equal(BigInt(store.get('mints', id).expiry) - BigInt((await head()).counted), 6n);
    return id;
  };
  const spend = async (credit, request, actionId) => {
    const page = await listFeeCredits(agent, { request, limit: 50 });
    assert.ok(page.credits.some(row => row.id === credit && row.usable), 'public HTTP page discovers an independently verified matching credit');
    await applyMatchingCredit(agent, { actionId, credit, request });
    await progress(() => runtime.mints.public(request).state === 'permit_issued');
    const minted = await inscription(runtime.mints.public(request).permit, receiver); await sync();
    await service.reportMintPayment({ id: request, inscription: minted });
    await progress(() => runtime.mints.public(request).state === 'minted');
    assert.equal(contract.db.get('dc/' + request).state, 'minted');
  };
  for (const delay of [6, 7]) {
    const before = balance('c1'), id = await create('late-single-' + delay), expiry = store.get('mints', id).expiry;
    const fees = store.get('mints', id).quote.fees;
    const sent = await inscribe(stack, [{ text: redeem(authId, [], payerKey, { items: r.walletFeeItems(fees, 'regtest') }), receiver: payer }]);
    const paymentId = sent.inscriptions[0].id;
    await assert.rejects(service.reportMintPayment({ id, paymentId }));
    assert.ok(store.get('mints', id).paymentReferences.includes(paymentId));
    await empty(delay);
    if (delay === 7) {
      await progress(() => runtime.mints.public(id).state === 'expired' && store.get('accountRecords', 'ao/' + id)?.state === 'refunded');
      assert.equal(contract.db.get('ao/' + id).state, 'refunded'); assert.deepEqual(balance('c1'), before);
      assert.equal(store.get('financialActiveMints', id), null);
    }
    await mine(stack); await sync();
    assert.equal(BigInt((await head()).counted), BigInt(expiry) + BigInt(delay - 5));
    // No further payment report. The server alone discovers confirmation.
    await progress(() => runtime.mints.public(id).state === 'expired' && runtime.mints.public(id).creditedAmount !== undefined);
    const status = await service.mintStatus(id), amount = fees.reduce((n, f) => n + BigInt(f.amount), 0n).toString();
    assert.equal(status.reason, 'credited'); assert.equal(status.creditedAmount, amount);
    assert.deepEqual(balance('c1'), before); assert.equal(contract.db.get('dc/' + id).state, 'released');
    const request = await create('credit-single-' + delay);
    await spend(status.creditId, request, 'spend-single-' + delay);
    assert.equal((await service.mintStatus(id)).creditedAmount, amount);
    assert.ok(contract.db.get('fc/' + status.creditId).fees.every(f => f.amount === '0'));
    results.push({ kind: 'single', delay, request: id, paymentId, creditId: status.creditId, amount, newMint: request });
    pass(`six-block single: broadcast before expiry, confirm expiry+${delay - 5}, automatic credit, released units, credit-funded mint`);
  }
  await progress(() => !!store.get('accountRecords', 'fd/asset/' + bulkEntry.asset));
  const timelyQuote = await quoteBulkMint(agent, { actionId: 'timely-bulk', asset: bulkEntry.asset, deployment: bulkEntry.id,
    blocks: ['102', '103'], payer, receiver });
  const timely = await makeBulkMint(agent, { actionId: 'timely-bulk', quoteId: timelyQuote.quoteId,
    maxPayableFeeAtoms: timelyQuote.terms.payableFeeAtoms, maxSetAsideSats: 100000 });
  await progress(async () => (await runtime.bulkMints.status(timely.orderId)).payable);
  const timelyPayment = await inscription(redeem(authId, [], payerKey, { items: bulkWalletItems(timelyQuote.terms) }), payer);
  await sync(); await service.reportBulkPayment({ orderId: timely.orderId, paymentId: timelyPayment, commitTxid: null, revealTxid: null });
  await progress(async () => (await runtime.bulkMints.status(timely.orderId)).permit.complete);
  const timelyPermits = await service.bulkMintPermit(timely.orderId), timelyMembers = [];
  for (const member of timelyPermits.members) timelyMembers.push({ index: member.index, inscription: await inscription(member.mintContent, receiver) });
  await sync(); await runtime.bulkMints.finish({ orderId: timely.orderId, members: timelyMembers });
  await progress(async () => (await runtime.bulkMints.status(timely.orderId)).state === 'minted');
  assert.equal((await runtime.bulkMints.status(timely.orderId)).progress.minted, 2);
  results.push({ kind: 'bulk-timely', request: timely.orderId, paymentId: timelyPayment, members: timelyMembers });
  pass('six-block bulk: timely payment issues both permits and both real inscriptions finish');
  const actionId = 'late-bulk', before = balance(bulkEntry.asset);
  const quote = await quoteBulkMint(agent, { actionId, asset: bulkEntry.asset, deployment: bulkEntry.id, blocks: ['100', '101'], payer, receiver });
  const accepted = await makeBulkMint(agent, { actionId, quoteId: quote.quoteId, maxPayableFeeAtoms: quote.terms.payableFeeAtoms, maxSetAsideSats: 100000 });
  const id = accepted.orderId;
  await progress(async () => (await runtime.bulkMints.status(id)).payable);
  const sent = await inscribe(stack, [{ text: redeem(authId, [], payerKey, { items: bulkWalletItems(quote.terms) }), receiver: payer }]);
  const paymentId = sent.inscriptions[0].id;
  await service.reportBulkPayment({ orderId: id, paymentId, commitTxid: null, revealTxid: null }).catch(error => {
    assert.ok(['bulk_payment_unknown', 'bulk_source_unavailable'].includes(error.code ?? error.message), error.message);
  });
  await empty(7); await progress(async () => (await runtime.bulkMints.status(id)).state === 'expired');
  assert.deepEqual(balance(bulkEntry.asset), before); assert.equal(store.get('activeBulkOrders', id), null);
  await mine(stack); await sync();
  const creditId = bulkReceiptKey('regtest', paymentId);
  await progress(() => !!store.get('publicResults/credits', creditId));
  const status = await service.bulkMintStatus(id);
  assert.equal(status.state, 'credited'); assert.equal(status.creditId, creditId);
  assert.equal(status.creditedAmount, quote.terms.payableFeeAtoms);
  const request = await create('bulk-credit-single', bulkEntry.asset, '100');
  await spend(creditId, request, 'spend-bulk-credit');
  results.push({ kind: 'bulk', request: id, paymentId, creditId, amount: quote.terms.payableFeeAtoms, newMint: request });
  pass('six-block bulk: unconfirmed report survives expiry, slot and units release, automatic reusable credit pays a new mint');
  const guardedSingle = await agent.makeReal({ actionId: 'guard-single', asset: 'c1', amount: '3', compound: true,
    payer: bulkTransport.payer, receiver: bulkTransport.payer });
  const guardedQuote = await quoteBulkMint(agent, { actionId: 'guard-bulk', asset: bulkEntry.asset, deployment: bulkEntry.id,
    blocks: ['104', '105'], payer: bulkTransport.payer, receiver: bulkTransport.payer });
  const guardedBulk = await makeBulkMint(agent, { actionId: 'guard-bulk', quoteId: guardedQuote.quoteId,
    maxPayableFeeAtoms: guardedQuote.terms.payableFeeAtoms, maxSetAsideSats: 100000 });
  await progress(async () => runtime.mints.public(guardedSingle.request.requestId).state === 'awaiting_payment' && (await runtime.bulkMints.status(guardedBulk.orderId)).payable);
  await empty(5);
  const currentTip = BigInt(await bitcoin(stack, 'getblockcount'));
  assert.equal(BigInt((await service.mintStatus(guardedSingle.request.requestId)).payBy.untilBlock) - currentTip, 1n);
  assert.equal(BigInt((await service.bulkMintStatus(guardedBulk.orderId)).payBy.untilBlock) - currentTip, 1n);
  const records = new Map(), provider = { ...bulkTransport.provider };
  for (const method of ['getBitcoinUtxos', 'signPsbt', 'pushPsbt', 'pushTx']) provider[method] = () => assert.fail('deadline guard called ' + method);
  const options = { provider, network: 'regtest',
    readTip: () => bitcoin(stack, 'getblockcount'), journal: { get: async k => records.get(k), put: async (k, v) => records.set(k, v), lock: async (_k, fn) => fn() } };
  const singleWallet = new TapWalletMint({ ...options, readStatus: id => service.mintStatus(id),
    readPaymentPlan: async id => ({ requestId: id, payer: store.get('mints', id).payer }) });
  const bulkWallet = new TapWalletBulkMint({ ...options, readStatus: id => service.bulkMintStatus(id), readTerms: id => service.bulkMintTerms(id) });
  for (const [wallet, id] of [[singleWallet, guardedSingle.request.requestId], [bulkWallet, guardedBulk.orderId]]) {
    await wallet.connect(); await assert.rejects(wallet.pay(id), e => e.code === 'payment_window_short' && /fresh mint request/.test(e.message));
  }
  assert.equal(records.size, 0); assert.equal(bulkTransport.payments(), 0);
  await empty(2);
  await progress(async () => runtime.mints.public(guardedSingle.request.requestId).state === 'expired' && (await runtime.bulkMints.status(guardedBulk.orderId)).state === 'expired');
  pass('single and bulk wallets refuse one remaining block against the actual regtest tip without payment or journal writes');
  return results;
}
