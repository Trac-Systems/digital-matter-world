import { createRequire } from 'node:module';
import { rules } from './rules.mjs';
import { check, hash } from './util.mjs';
import { escrowSplitForItems, ZERO_ADDRESS } from '../../committee/signer/escrow.mjs';
const require = createRequire(new URL('../../rules/package.json', import.meta.url));
const { Transaction, Script } = require('@scure/btc-signer');
const { secp256k1 } = require('@noble/curves/secp256k1');
const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
const inscription = value => typeof value === 'string' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(value);
const notFound = e => e.status === 404 || e.rpcCode === -5 || ['escrow_payer', 'payment_unconfirmed'].includes(e.message);

export function inscriptionContents(raw) {
  const tx = Transaction.fromRaw(Buffer.from(raw, 'hex'), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });
  const contents = [];
  for (let n = 0; n < tx.inputsLength; n++) {
    const witness = tx.getInput(n).finalScriptWitness;
    if (!witness || witness.length < 2) continue;
    const script = Script.decode(witness[witness.length - 2]);
    for (let i = 0; i < script.length - 3; i++) {
      if (script[i] !== 0 || script[i + 1] !== 'IF' || !(script[i + 2] instanceof Uint8Array) || Buffer.from(script[i + 2]).toString() !== 'ord') continue;
      let j = i + 3;
      // Header fields are tag/value pairs. An empty value (ord's zero pointer)
      // is not the body delimiter; that delimiter occurs in a tag position.
      while (j < script.length && script[j] !== 0 && script[j] !== 'ENDIF') {
        check(j + 1 < script.length && script[j + 1] !== 'ENDIF', 'payment_inscription'); j += 2;
      }
      if (script[j++] !== 0) continue;
      const body = [];
      while (j < script.length && script[j] instanceof Uint8Array) body.push(script[j++]);
      check(script[j] === 'ENDIF', 'payment_inscription');
      const bytes = Buffer.concat(body); check(bytes.length <= 65536, 'payment_inscription_size');
      try { contents.push(JSON.parse(bytes.toString('utf8'))); } catch { contents.push(null); }
      i = j;
    }
  }
  return { txid: tx.id, contents };
}
function recovered(payload, field) {
  const digest = hash(JSON.stringify(payload[field]) + payload.salt);
  check(digest === payload.hash, 'payment_signature');
  const compact = ['r', 's'].map(k => BigInt(payload.sig[k]).toString(16).padStart(64, '0')).join('');
  return secp256k1.Signature.fromCompact(compact).addRecoveryBit(Number(payload.sig.v)).recoverPublicKey(digest).toHex(true);
}
async function pages(reads, path, countPath, { recent = false, maxRows = 1000000 } = {}) {
  const count = Number(await reads.tap(countPath)); check(Number.isSafeInteger(count) && count >= 0 && count <= maxRows, 'payment_list_bound');
  const rows = [];
  for (let offset = recent ? Math.max(0, count - 1000) : 0; offset < count; offset += 500) {
    const page = await reads.tap(`${path}?offset=${offset}&max=500`);
    check(Array.isArray(page) && page.length === Math.min(500, count - offset), 'payment_list_incomplete'); rows.push(...page);
  }
  return rows;
}
async function tapReceipts(reads, row, paymentIds) {
  const receipts = [], prefix = `dmw-pay-v2|${row.id}|`;
  const recent = await pages(reads, 'getAccountRedeemList/' + encodeURIComponent(row.payer), 'getAccountRedeemListLength/' + encodeURIComponent(row.payer), { recent: true });
  const ids = new Set([...paymentIds, ...recent.filter(r => r.rdm?.items?.some(i => i.dta?.startsWith(prefix))).map(r => r.ins)]);
  check(ids.size <= 64, 'payment_item_limit');
  for (const id of ids) {
    check(inscription(id), 'payment_id');
    let inclusion;
    try { inclusion = await reads.included(id); } catch (e) { if (notFound(e)) continue; throw e; }
    if (!inclusion) {
      let tx;
      try { tx = await reads.bitcoinTransaction(id.slice(0, 64)); }
      catch (e) { if (notFound(e)) continue; throw e; }
      const parsed = inscriptionContents(tx.hex); check(parsed.txid === id.slice(0, 64), 'payment_tx_binding');
      const payload = parsed.contents[Number(id.split('i')[1])];
      check(payload?.p === 'tap' && payload.op === 'token-auth' && Array.isArray(payload.redeem?.items), 'payment_redeem');
      const authId = payload.redeem.auth; check(inscription(authId), 'payment_authority');
      const auth = await reads.content(authId);
      check(recovered(payload, 'redeem') === recovered(auth, 'auth'), 'payment_signature');
      const authorities = await pages(reads, 'getAccountAuthList/' + encodeURIComponent(row.payer), 'getAccountAuthListLength/' + encodeURIComponent(row.payer));
      check(authorities.some(a => a.ins === authId && a.addr === row.payer) && await reads.tap('getAuthCancelled/' + authId) === false, 'payment_authority');
      for (const [index, item] of payload.redeem.items.entries()) {
        const fee = row.quote.fees.find(f => f.tt === 'a' && f.dta === item.dta && f.to === item.address && f.ticker === item.tick);
        if (!fee) continue;
        receipts.push({ ...fee, key: rules.paymentItemKey('tap', id + '/mempool/' + index), amount: rules.parseTapAmount(item.amt), accepted: true, confirmations: 0, origin: row.id, reference: id });
      }
      continue;
    }
    const payload = await reads.content(id);
    check(payload?.p === 'tap' && payload.op === 'token-auth' && Array.isArray(payload.redeem?.items), 'payment_redeem');
    const transfers = await pages(reads, 'getTransferredList/' + id.slice(0, 64), 'getTransferredListLength/' + id.slice(0, 64), { maxRows: 1000 });
    for (const [index, transfer] of transfers.entries()) {
      if (transfer.ins !== id || transfer.fail !== false || transfer.int !== true || transfer.addr !== row.payer) continue;
      // The burn fee matches only the exact configured burn address, amount,
      // payer and request-bound data, just like every other direct TAP item.
      const fee = row.quote.fees.find(f => f.tt === 'a' && f.dta === transfer.dta && f.to === transfer.taddr && f.ticker === transfer.tick);
      if (!fee) continue;
      check(payload.redeem.items.some(i => i.dta === fee.dta && i.address === fee.to && i.tick === fee.ticker && rules.parseTapAmount(i.amt) === transfer.amt), 'payment_item_binding');
      receipts.push({ ...fee, key: rules.paymentItemKey('tap', id + '/' + index), amount: transfer.amt, accepted: true, confirmations: inclusion.confirmations, origin: row.id, reference: id });
    }
  }
  return receipts;
}

// Attach to each independent reader, including the committee's. Gateway rows
// supply lookup hints only; successful transfers, escrow state and used credit
// are always checked against the chain by the reader itself.
export function installMintPayments(reads, { request, escrow, network, confirmations = 1 }) {
  reads.mintRequest = async id => request(id);
  reads.mintPayment = async (id, candidate) => {
    const row = candidate ?? request(id);
    check(row.id === id && Array.isArray(row.quote.fees), 'payment_request');
    const current = await reads.pending(id), sources = [];
    check(Array.isArray(row.creditIds ?? []) && (row.creditIds ?? []).length <= 32, 'payment_credit_limit');
    for (const creditId of row.creditIds ?? []) {
      const source = request(creditId), pending = await reads.pending(creditId);
      check(rules.pendingId(network, source.request) === creditId && rules.verifyRequest('rq', network, source.request, source.signature, source.request.until) && await reads.agentAddress(pending?.o) === source.request.owner, 'payment_credit_owner');
      check(source.request.owner === row.request.owner && source.payer === row.payer && source.kind === row.kind && pending?.s === 2 && !pending.h, 'payment_credit_binding');
      sources.push(source);
    }
    sources.push(row); // Credits are independently accounted before the new deposit.
    const receipts = []; let depositFinal = false, split = null, depositFees = row.quote.fees;
    const available = async receipt => {
      const spent = await reads.paymentUsed(receipt.key);
      let used = BigInt(spent?.used ?? '0');
      if (current?.s === 1) {
        const own = current.payments?.find(p => p.key === receipt.key);
        if (!own) return null;
        check(used >= BigInt(own.amount) && own.total === receipt.amount, 'payment_accounting');
        used = BigInt(receipt.amount) - BigInt(own.amount);
      }
      return { ...receipt, used: used.toString() };
    };
    for (const source of sources) {
      const ids = source.paymentIds ?? (source.paymentId ? [source.paymentId] : []);
      check(ids.length <= 64 && new Set(ids).size === ids.length, 'payment_id_limit');
      if (source.kind === 'tap') receipts.push(...await tapReceipts(reads, source, ids));
      else {
        if (source.id === id) {
          const credits = (await Promise.all(receipts.map(available))).filter(Boolean).sort((a,b)=>a.key.localeCompare(b.key));
          depositFees = rules.paymentProgress(row.quote.fees, credits, { confirmations }).missing;
        }
        let snapshot;
        try { snapshot = await reads.escrowDeposit(source.payer, source.id); } catch (e) { if (notFound(e)) continue; throw e; }
        const d = snapshot.deposit;
        check(snapshot.chainId === escrow.chainId && snapshot.address === escrow.address.toLowerCase() && snapshot.token === escrow.token.toLowerCase() && snapshot.payer === source.payer.toLowerCase(), 'escrow_domain');
        const actualFees = source.quote.fees.flatMap(fee => {
          const role = fee.role === 'firstMaker' ? 'finder' : fee.role, amount = d.split[role + 'Amount'];
          check(typeof amount === 'string' && /^(0|[1-9][0-9]*)$/.test(amount) && BigInt(amount) <= BigInt(fee.amount), 'escrow_split');
          if (role !== 'burn') check(d.split[role] === (amount === '0' ? ZERO_ADDRESS : fee.to.toLowerCase()), 'escrow_split');
          return amount === '0' ? [] : [{ ...fee, amount }];
        });
        check(same(d.split, escrowSplitForItems(actualFees)) && d.amount === actualFees.reduce((n,f)=>n+BigInt(f.amount),0n).toString(), 'escrow_split');
        if (source.id === id) check(same(d.split, escrowSplitForItems(depositFees)), 'escrow_split');
        if (![1, 2].includes(d.status)) continue;
        if (source.id === id) { depositFinal = snapshot.confirmations >= confirmations; split = d.split; }
        const released = d.status === 2 ? await reads.escrowSettled(source.payer, source.id) : null;
        for (const fee of actualFees) receipts.push({ ...fee,
          key: rules.paymentItemKey('ethereum', [escrow.chainId, escrow.address.toLowerCase(), source.payer.toLowerCase(), source.id, fee.role].join('/')),
          accepted: true, confirmations: released?.kind === 'claim' ? Math.min(snapshot.confirmations, released.confirmations) : 0, origin: source.id, reference: source.id });
      }
    }
    const unique = new Map();
    for (const receipt of receipts) {
      const value = await available(receipt);
      if (!value) continue;
      check(!unique.has(receipt.key) || same(unique.get(receipt.key), value), 'payment_duplicate'); unique.set(receipt.key, value);
    }
    return { requestId: id, kind: row.kind, payer: row.payer, fees: row.quote.fees, receipts: [...unique.values()].sort((a, b) => a.key.localeCompare(b.key)),
      requiredConfirmations: confirmations, ...(row.kind === 'ethereum' ? { depositFinal, split, depositFees, depositAmount: depositFees.reduce((n,f)=>n+BigInt(f.amount),0n).toString() } : {}) };
  };
  return reads;
}
