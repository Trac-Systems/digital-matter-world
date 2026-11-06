import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { inscriptionContents, tapReceipts } from './mint-payments.mjs';
import { resolvePublicPaymentIntent, publicPaymentData, publicScanBlock, dmwCandidate } from './public-mint-sources.mjs';

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
  const budget = document.values.publicMintPageSize * 20;
  let cursor = null, lastHeight = null, lastHash = null, work = 0, unrevealed = null, at_ = null;
  // Same work units as the plot scan: only DMW payment candidates count.
  // A failed read (a batch changed the snapshot, a source hiccup) keeps the
  // progress made so far: the next pass resumes at the failing candidate
  // instead of re-walking the whole backlog from the first block.
  try {
  walk: for (let h = BigInt(from.height); h <= BigInt(at.counted); h++) {
    const first = h === BigInt(from.height), height = String(h), block = await publicScanBlock(reads, height, at, reads.lookups?.settings);
    lastHeight = height; lastHash = block.hash;
    for (const c of block.candidates) {
      if (first && (c.ti < Number(from.transactionIndex) || c.ti === Number(from.transactionIndex) && c.ii < Number(from.inscriptionIndex))) continue;
      if (work >= budget) { cursor = { height, transactionIndex: c.ti, inscriptionIndex: c.ii }; break walk; }
      if (dmwCandidate(c)) work++;
      at_ = { height, transactionIndex: c.ti, inscriptionIndex: c.ii, hash: block.hash };
      const payload = c.payload, ii = c.ii, parsed = { txid: c.txid };
      const intents = new Map();
      for (const item of payload.redeem.items) {
        let intent;
        try { intent = await resolvePublicPaymentIntent(reads, item, { document, height, reference: parsed.txid + 'i' + ii, at }); }
        catch (error) {
          if (error.message !== 'public_payment_unrevealed' || !mints.revealPayment) throw error;
          // Reveal every waiting payment in this walk, not only the first,
          // and queue its plot so the scan rides in the reveal's batch. The
          // walk resumes here so the revealed payment is read normally later.
          const queued = await mints.revealPayment(error), row = store.get('mints', store.get('publicMintCommitments', error.commitment) ?? '');
          if (queued.revealQueued && row?.request) await mints.queuePlot(row.request.asset, row.request.block, height, [], row.intent?.supplyScope ?? row.request.supplyScope ?? null);
          else unrevealed ??= { height, transactionIndex: c.ti, inscriptionIndex: c.ii };
          continue;
        }
        if (!intent) continue;
        try {
          const signed = reads.feeQuotes.verify('dmw-public-mint-quote-v1', intent);
          if (signed.network !== mints.parent.network) continue;
          if (signed.paymentVersion !== 2 && document.values.publicPaymentV2Height !== undefined &&
              BigInt(signed.feeQuote.validFrom) >= BigInt(document.values.publicPaymentV2Height)) continue;
          intents.set(rules.publicRequestId(signed.network, intent), intent);
        } catch { /* An unsigned payload cannot add work to the paid queue. */ }
      }
      // Distinct plots share one wallet payment. Keep the scanner's existing
      // rule of exactly one intent per plot at a given inscription position.
      const plots = new Map();
      for (const [id, intent] of intents) {
        const scope = rules.perTickerSupplyActive(at.executionHeight ?? at.counted) ? intent.supplyScope : null;
        const plot = rules.publicPlotId(intent.asset, intent.block, scope);
        plots.set(plot, plots.has(plot) ? null : { id, intent, scope });
      }
      for (const entry of plots.values()) {
        if (!entry) continue;
        const { id, intent, scope } = entry, reference = parsed.txid + 'i' + ii;
        const row = { id, payer: intent.tapAddress, quote: { fees: intent.fees.map(f => ({ ...f, dta: publicPaymentData(intent, f.role) })) } };
        try {
          const receipts = await publicPaymentReceipts(reads, row, [reference], at);
          if (receipts.length) await mints.queuePlot(intent.asset, intent.block, height, [], scope);
        } catch (error) {
          if (!['payment_redeem', 'payment_item_binding'].includes(error.message)) throw error;
        }
      }
    }
    cursor = { height: String(h + 1n), transactionIndex: 0, inscriptionIndex: 0 };
  }
  } catch (error) {
    const resume = unrevealed ?? (at_ && { height: at_.height, transactionIndex: at_.transactionIndex, inscriptionIndex: at_.inscriptionIndex });
    if (resume) await store.put('meta', 'publicMintDiscovery', { ...resume, lastHeight: at_?.height ?? lastHeight, lastHash: at_?.hash ?? lastHash });
    throw error;
  }
  await store.put('meta', 'publicMintDiscovery', { ...(unrevealed ?? cursor), lastHeight, lastHash });
  // Reveals are already queued above; report the wait without queuing again.
  if (unrevealed) throw Object.assign(Error('public_payment_unrevealed'), { revealHandled: true });
}
