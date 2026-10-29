import { check, hash } from './util.mjs';
import { atomicAmount, inscriptionId } from './mint-refund-protocol.mjs';

// All financial reads are bounded and pinned to a canonical TAP snapshot.
export class MintRefundTap {
  constructor({ http, bitcoin, settings }) { Object.assign(this, { http, bitcoin, settings }); }
  async read(path) {
    const response = await this.http.request('/r/tap/' + path);
    check(response && Object.hasOwn(response, 'result'), 'mint_refund_tap_response');
    return response.result;
  }
  async snapshot() {
    const height = String(await this.read('getCurrentBlock'));
    check(/^(0|[1-9][0-9]{0,9})$/.test(height), 'mint_refund_tap_height');
    const blockHash = await this.http.request('/r/blockhash/' + height);
    check(typeof blockHash === 'string' && /^[0-9a-f]{64}$/.test(blockHash) &&
      blockHash === await this.bitcoin.http.request('/block-height/' + height, { text: true }), 'mint_refund_tap_canonical');
    return { height, blockHash };
  }
  async at(read) {
    const snapshot = await this.snapshot(), value = await read(snapshot);
    check(JSON.stringify(snapshot) === JSON.stringify(await this.snapshot()), 'mint_refund_tap_changed');
    return { value, snapshot };
  }
  async page(path, limit = this.settings.pageSize, offset = 0) {
    const rows = await this.read(path + '?offset=' + offset + '&max=' + limit);
    check(Array.isArray(rows) && rows.length <= limit, 'mint_refund_tap_page'); return rows;
  }
  async float(address, authority) {
    return this.at(async snapshot => {
      const balances = {};
      for (const ticker of this.settings.refundTickers) {
        const amount = await this.read('getBalance/' + encodeURIComponent(address) + '/' + encodeURIComponent(ticker));
        check(amount === null || atomicAmount(amount), 'mint_refund_tap_balance'); balances[ticker] = amount ?? '0';
      }
      let authorityStatus = authority ? 'pending' : 'not_created';
      if (authority) {
        const id = authority.plan.inscriptionId;
        check(inscriptionId(id), 'mint_refund_authority');
        const rows = await this.page('getAccountAuthList/' + encodeURIComponent(address));
        const indexed = rows.find(r => r.ins === id);
        if (indexed) {
          check(indexed.addr === address && JSON.stringify(indexed.auth) === JSON.stringify(authority.payload.auth), 'mint_refund_authority_binding');
          const content = await this.http.request('/content/' + id, { text: true });
          check(content !== null && hash(content) === authority.plan.textHash, 'mint_refund_authority_content');
          const cancelled = await this.read('getAuthCancelled/' + id);
          check(typeof cancelled === 'boolean', 'mint_refund_authority_cancelled');
          const tx = await this.bitcoin.transaction(authority.tapPlan?.txid ?? authority.plan.revealTxid);
          authorityStatus = cancelled ? 'cancelled' : tx?.confirmed && Number.isSafeInteger(tx.height) && BigInt(tx.height) <= BigInt(snapshot.height) ? 'active' : 'pending';
        }
      }
      return { address, balances, authority: { state: authorityStatus, ...(authority ? { inscriptionId: authority.plan.inscriptionId, tickers: authority.payload.auth } : {}) } };
    });
  }
  async confirmed(row, floatAddress) {
    let rejected;
    try { const evidence = await this.confirmInscription(row, floatAddress, row.plan.inscriptionId); if (evidence) return evidence; }
    catch (error) {
      if (!['mint_refund_transfer_count', 'mint_refund_transfer_binding'].includes(error.message)) throw error;
      rejected = error;
    }
    // Anyone may inscribe an authority-signed redeem. If its exact signature
    // was relayed first, recognize that successful payment instead of creating
    // another debit or leaving the serial refund queue blocked indefinitely.
    // This dedicated account signs only one unsettled redeem, so its latest
    // bounded page contains any accepted relay of the outstanding signature.
    const found = await this.at(async () => {
      const count = Number(await this.read('getAccountRedeemListLength/' + encodeURIComponent(floatAddress)));
      check(Number.isSafeInteger(count) && count >= 0, 'mint_refund_tap_page');
      if (!count) return null;
      const rows = await this.page('getAccountRedeemList/' + encodeURIComponent(floatAddress), this.settings.pageSize, Math.max(0, count - this.settings.pageSize));
      return rows.find(r => r.addr === floatAddress && r.hash === row.payload.hash && r.slt === row.payload.salt &&
        ['v', 'r', 's'].every(k => String(r.sig?.[k]) === row.payload.sig[k]) && inscriptionId(r.ins))?.ins ?? null;
    });
    if (found.value && found.value !== row.plan.inscriptionId) return this.confirmInscription(row, floatAddress, found.value);
    if (rejected) throw rejected;
    return null;
  }
  async confirmInscription(row, floatAddress, id) {
    const { plan, payload, amounts } = row, txid = id.slice(0, 64);
    const tx = await this.bitcoin.transaction(txid);
    if (!tx?.confirmed || !Number.isSafeInteger(tx.height)) return null;
    const evidence = await this.at(async snapshot => {
      if (BigInt(tx.height) > BigInt(snapshot.height)) return null;
      // A Bitcoin confirmation alone is insufficient: every exact token
      // transfer must have succeeded in TAP's index for this redeem.
      const content = await this.http.request('/content/' + id, { text: true });
      if (id === plan.inscriptionId) check(content !== null && hash(content) === plan.textHash, 'mint_refund_redeem_content');
      else {
        let copied; try { copied = JSON.parse(content); } catch {}
        check(copied?.p === 'tap' && copied.op === 'token-auth' && copied.hash === payload.hash && copied.salt === payload.salt &&
          JSON.stringify(copied.redeem) === JSON.stringify(payload.redeem) && ['v', 'r', 's'].every(k => copied.sig?.[k] === payload.sig[k]), 'mint_refund_redeem_content');
      }
      const rows = await this.page('getTransferredList/' + txid);
      const transfers = rows.filter(r => r.ins === id);
      if (!transfers.length) return null;
      check(transfers.length === payload.redeem.items.length, 'mint_refund_transfer_count');
      for (const item of payload.redeem.items) {
        const matches = transfers.filter(r => r.tick === item.tick && r.addr === floatAddress && r.taddr === item.address && r.dta === item.dta &&
          r.amt === amounts[item.tick] && r.fail === false && r.int === true && String(r.blck) === String(tx.height));
        check(matches.length === 1, 'mint_refund_transfer_binding');
      }
      return { inscriptionId: id, txid, height: tx.height };
    });
    return evidence.value ? { ...evidence.value, snapshot: evidence.snapshot } : null;
  }
  async cardinal(coins) {
    const result = [];
    for (const coin of coins) {
      if (!coin.confirmed) continue;
      const output = await this.http.request('/output/' + coin.txid + ':' + coin.vout);
      check(output && Array.isArray(output.inscriptions) && output.runes && typeof output.runes === 'object', 'mint_refund_float_coin_unknown');
      if (output.indexed === true && output.spent === false && String(output.value) === coin.value && !output.inscriptions.length && !Object.keys(output.runes).length) result.push(coin);
    }
    return result;
  }
}
