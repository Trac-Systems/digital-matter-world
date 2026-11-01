import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { inscriptionContents, tapReceipts } from './mint-payments.mjs';
import { resolvePublicPaymentIntent, publicPaymentData } from './public-mint-sources.mjs';

// Scheduling hints only: the existing public-scan reader still rebuilds and
// verifies the complete Bitcoin prefix independently on every signer.
export async function publicPaymentReceipts(reads, row, ids, at) {
  const read = () => tapReceipts(reads, row, ids, reads.lookups?.settings, { at, confirmedOnly: true });
  const receipts = await (reads.withTapSnapshot ? reads.withTapSnapshot(at, read) : read());
  return receipts.filter(r => r.accepted && r.confirmations >= 1 && BigInt(r.amount) > 0n);
}

// One shared, durable Bitcoin walk discovers unreported payments. Its work is
// independent of the number of unpaid requests and it never submits a scan.
export async function discoverPublicMintPayments(mints, at) {
  const { reads, store, document } = mints;
  if (!reads.publicBitcoinBlock || !reads.publicBitcoinHash) return;
  const start = document.values.publicMintActivationHeight;
  let saved = store.get('meta', 'publicMintDiscovery');
  if (saved?.lastHeight && BigInt(saved.lastHeight) <= BigInt(at.counted) &&
      await reads.publicBitcoinHash(saved.lastHeight, at) !== saved.lastHash) saved = null;
  const from = saved ?? { height: start, transactionIndex: 0, inscriptionIndex: 0 };
  if (BigInt(from.height) > BigInt(at.counted)) return;
  const block = await reads.publicBitcoinBlock(from.height, at);
  check(rules.decimalV2(block.height) === from.height && Array.isArray(block.transactions) && block.transactions.length === block.tx.length, 'public_block_evidence');
  let ti = from.transactionIndex, ii = from.inscriptionIndex, work = 0;
  for (; ti < block.transactions.length && work < document.values.publicMintPageSize; ti++) {
    const parsed = inscriptionContents(block.transactions[ti], reads.lookups?.settings, { scan: true });
    check(parsed.txid === block.tx[ti], 'public_block_transaction');
    if (!parsed.contents.length) { work++; ii = 0; continue; }
    for (; ii < parsed.contents.length && work < document.values.publicMintPageSize; ii++, work++) {
      const payload = parsed.contents[ii];
      if (payload?.p !== 'tap' || payload.op !== 'token-auth' || !Array.isArray(payload.redeem?.items)) continue;
      const intents = new Map();
      for (const item of payload.redeem.items) {
        const intent = await resolvePublicPaymentIntent(reads, item, { document, height: from.height, reference: parsed.txid + 'i' + ii, at });
        if (!intent) continue;
        try {
          const signed = reads.feeQuotes.verify('dmw-public-mint-quote-v1', intent);
          if (signed.network !== mints.parent.network) continue;
          if (signed.paymentVersion !== 2 && document.values.publicPaymentV2Height !== undefined &&
              BigInt(signed.feeQuote.validFrom) >= BigInt(document.values.publicPaymentV2Height)) continue;
          intents.set(rules.publicRequestId(signed.network, intent), intent);
        } catch { /* An unsigned payload cannot add work to the paid queue. */ }
      }
      if (intents.size !== 1) continue;
      const [id, intent] = [...intents][0], reference = parsed.txid + 'i' + ii;
      const row = { id, payer: intent.tapAddress, quote: { fees: intent.fees.map(f => ({ ...f, dta: publicPaymentData(intent, f.role) })) } };
      try {
        const receipts = await publicPaymentReceipts(reads, row, [reference], at);
        if (receipts.length) await mints.queuePlot(intent.asset, intent.block, from.height, [], rules.perTickerSupplyActive(at.executionHeight ?? at.counted) ? intent.supplyScope : null);
      } catch (error) {
        if (!['payment_redeem', 'payment_item_binding'].includes(error.message)) throw error;
      }
    }
    if (ii < parsed.contents.length) break;
    ii = 0;
  }
  await store.put('meta', 'publicMintDiscovery', { height: ti === block.transactions.length ? rules.nextUint(from.height) : from.height,
    transactionIndex: ti === block.transactions.length ? 0 : ti, inscriptionIndex: ii, lastHeight: from.height, lastHash: block.hash });
}
