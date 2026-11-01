import { MintRefundTap } from './mint-refund-source.mjs';
import { readTapSourceURL } from './source-url.mjs';
import { check } from './util.mjs';
import { btc } from './mint-sender-keys.mjs';
import { hex, unhex, networkFor } from '../../kit/lib/inscription-core.mjs';

// Bounded Esplora calls. Endpoint contents and provider bodies never enter logs.
export class SenderHTTP {
  constructor({ origin, settings, fetchImpl = fetch, signal }) { Object.assign(this, { origin, settings, fetchImpl, signal }); }
  async request(path, { method = 'GET', body, text = false, authorization } = {}) {
    const signal = AbortSignal.any([AbortSignal.timeout(this.settings.timeoutMs), ...(this.signal ? [this.signal] : [])]);
    let reader;
    try {
      const response = await this.fetchImpl(this.origin + path, { method, redirect: 'error', signal,
        headers: { accept: 'application/json', ...(authorization ? { authorization } : {}), ...(body === undefined ? {} : { 'content-type': text ? 'text/plain' : 'application/json' }) },
        ...(body === undefined ? {} : { body: text ? body : JSON.stringify(body) }) });
      if (response.status === 404 && method === 'GET') { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(Error('mint_sender_http_status'), { code: 'mint_sender_http_status', status: response.status }); }
      check(!response.headers.get('content-length') || Number(response.headers.get('content-length')) <= this.settings.maxResponseBytes, 'mint_sender_response_limit');
      reader = response.body.getReader(); const chunks = []; let size = 0;
      for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; check(size <= this.settings.maxResponseBytes, 'mint_sender_response_limit'); chunks.push(Buffer.from(r.value)); }
      const value = Buffer.concat(chunks).toString('utf8').trim();
      return text ? value : JSON.parse(value);
    } catch (e) {
      if (e.code === 'mint_sender_http_status') throw e;
      throw Error(signal.aborted ? 'mint_sender_timeout' : 'mint_sender_source_unavailable');
    } finally { await reader?.cancel().catch(() => {}); }
  }
}
export class MintSenderBitcoin {
  constructor({ http, network, settings }) { Object.assign(this, { http, network, settings }); }
  async verifyNetwork() {
    this.networkVerified = false;
    const hash = await this.http.request('/block-height/0', { text: true });
    check(hash === (this.network === 'mainnet' ? '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f' : '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'), 'mint_sender_bitcoin_network');
    this.networkVerified = true;
  }
  async utxos(address) {
    const script = hex(btc.OutScript.encode(btc.Address(networkFor(this.network)).decode(address)));
    const coins = await this.http.request('/address/' + encodeURIComponent(address) + '/utxo');
    check(Array.isArray(coins) && coins.length <= this.settings.maxUtxos, 'mint_sender_utxos');
    const result = [];
    for (const coin of coins) {
      check(/^[0-9a-f]{64}$/.test(coin.txid) && Number.isSafeInteger(coin.vout) && coin.vout >= 0 && coin.vout <= 0xffffffff && Number.isSafeInteger(coin.value) && coin.value > 0, 'mint_sender_coin');
      const raw = await this.http.request('/tx/' + coin.txid + '/hex', { text: true });
      check(typeof raw === 'string', 'mint_sender_transaction_missing');
      const tx = btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true, allowUnknownOutputs: true }), output = tx.getOutput(coin.vout);
      check(tx.id === coin.txid && hex(output.script) === script && output.amount === BigInt(coin.value), 'mint_sender_coin_binding');
      result.push({ txid: coin.txid, vout: coin.vout, value: String(coin.value), script, confirmed: coin.status?.confirmed === true, cardinal: true });
    }
    return result;
  }
  async paymentFunding(address, reference) {
    check(/^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(reference), 'mint_refund_reference');
    const raw = await this.http.request('/tx/' + reference.slice(0, 64) + '/hex', { text: true });
    check(typeof raw === 'string', 'mint_sender_transaction_missing');
    const payment = btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true, allowUnknownOutputs: true });
    check(payment.id === reference.slice(0, 64), 'mint_sender_transaction_binding');
    const parents = new Set(Array.from({ length: payment.inputsLength }, (_, i) => hex(payment.getInput(i).txid)));
    // TAP Wallet extraOutputs are siblings of the payment's commit output.
    // Never charge another payment's set-aside, even for the same request id.
    return (await this.utxos(address)).filter(coin => parents.has(coin.txid));
  }
  // Transactions spending the other outputs of `txid` (a payment's reveal spends its commit output).
  async spenders(txid, except) {
    check(/^[0-9a-f]{64}$/.test(txid), 'mint_sender_txid');
    const outs = await this.http.request('/tx/' + txid + '/outspends');
    check(Array.isArray(outs) && outs.length <= 64, 'mint_sender_outspends');
    return [...new Set(outs.map((o, vout) => vout !== except && o?.spent === true && /^[0-9a-f]{64}$/.test(o.txid ?? '') ? o.txid : null).filter(Boolean))];
  }
  async feeRate() {
    const rates = await this.http.request('/fee-estimates'), rate = rates?.[String(this.settings.feeTargetBlocks)];
    check(Number.isFinite(rate) && rate > 0, 'mint_sender_fee_unavailable'); return Math.max(1, rate);
  }
  async transaction(txid) {
    check(/^[0-9a-f]{64}$/.test(txid), 'mint_sender_txid');
    const tx = await this.http.request('/tx/' + txid);
    check(!tx || tx.txid === txid, 'mint_sender_transaction_binding');
    return tx ? { confirmed: tx.status?.confirmed === true, ...(tx.status?.confirmed === true ? { height: tx.status.block_height, blockHash: tx.status.block_hash } : {}) } : null;
  }
  async broadcast(raw, txid) {
    if (await this.transaction(txid)) return txid;
    const answer = await this.http.request('/tx', { method: 'POST', body: raw, text: true });
    check(answer === txid, 'mint_sender_broadcast_binding'); return txid;
  }
}
export async function createMintSenderBitcoin({ config, settings, network, signal }) {
  // Read the same TAP source configuration for network evidence. ord currently
  // has no send API; an explicit operator-selected Esplora endpoint is required.
  const tapOrigin = await readTapSourceURL(config.prod?.bitcoin?.urlFile ?? config.local?.tapSourceFile, { rootOwned: process.platform === 'linux' });
  const origin = await readTapSourceURL(settings.bitcoinApiUrlFile, { rootOwned: process.platform === 'linux', credentialName: 'mint-bitcoin.url' });
  const tap = new SenderHTTP({ origin: tapOrigin, settings, signal });
  const http = new SenderHTTP({ origin: origin + settings.bitcoinApiPath, settings, signal });
  const source = new MintSenderBitcoin({ http, network, settings });
  const verify = source.verifyNetwork.bind(source);
  source.verifyNetwork = async () => {
    await verify();
    check(await tap.request('/r/blockhash/0') === await http.request('/block-height/0', { text: true }), 'mint_sender_source_network');
  };
  source.tap = new MintRefundTap({ http: tap, bitcoin: source, settings });
  return source;
}
export class MintSenderGateway {
  constructor({ http, token }) { this.http = http; this.authorization = 'Bearer ' + token; }
  payouts(after, limit) {
    return this.http.request('/internal/mint-sender/payouts?' + new URLSearchParams({ after, limit }), { authorization: this.authorization });
  }
  preparePayout(record) {
    return this.http.request('/internal/mint-sender/payouts/prepare', { method: 'POST', body: record, authorization: this.authorization });
  }
  recordPayout(record) {
    return this.http.request('/internal/mint-sender/payouts/record', { method: 'POST', body: record, authorization: this.authorization });
  }
  async list(after, limit) {
    const page = await this.http.request('/internal/mint-sender/requests?' + new URLSearchParams({ after, limit }), { authorization: this.authorization });
    check(page && Array.isArray(page.rows), 'mint_sender_gateway_unavailable'); return page;
  }
  async refunds(after, limit) {
    const page = await this.http.request('/internal/mint-sender/refunds?' + new URLSearchParams({ after, limit }), { authorization: this.authorization });
    check(page && Array.isArray(page.rows), 'mint_sender_gateway_unavailable'); return page;
  }
  async tickerReturns(after, limit) {
    const page = await this.http.request('/internal/mint-sender/ticker-returns?' + new URLSearchParams({ after, limit }), { authorization: this.authorization });
    check(page && Array.isArray(page.rows), 'mint_sender_gateway_unavailable'); return page;
  }
  async tickerDeploys(after, limit) {
    const page = await this.http.request('/internal/mint-sender/ticker-deploys?' + new URLSearchParams({ after, limit }), { authorization: this.authorization });
    check(page && Array.isArray(page.rows), 'mint_sender_gateway_unavailable'); return page;
  }
  tickerDeployStatus(id) { return this.http.request('/internal/mint-sender/ticker-deploys/' + id, { authorization: this.authorization }); }
  // The same public reports the deploy page makes: the in-flight deploy, then its registration once confirmed.
  reportTickerDeploy(id, plan) {
    return this.http.request('/mint/inflight', { method: 'POST', body: { kind: 'ticker', ref: id, phase: 'deployment', attempt: 0,
      commitTxid: plan.commitTxid, revealTxid: plan.revealTxid, inscriptionId: plan.inscriptionId } });
  }
  registerTickerDeploy(asset, id, inscription) {
    return this.http.request('/mint/deploy-ticker', { method: 'POST', body: { asset, requestId: id, inscription, phase: 'deployment' } });
  }
  tickerReturnStatus(id) { return this.http.request('/internal/mint-sender/ticker-returns/' + id, { authorization: this.authorization }); }
  async refund(id) {
    const result = await this.http.request('/internal/mint-sender/refunds/' + id, { authorization: this.authorization });
    check(result?.record?.refundId === id, 'mint_sender_gateway_unavailable'); return result;
  }
  async status(id) {
    const status = await this.http.request('/mint/' + id);
    check(status?.requestId === id, 'mint_sender_gateway_unavailable'); return status;
  }
  async report(id, inscription) {
    return this.http.request('/mint/payment', { method: 'POST', body: { id, inscription } });
  }
  // The same in-flight report the request page makes after TAP Wallet sends the fee payment.
  reportPayment(id, { commitTxid, revealTxid }) {
    return this.http.request('/mint/inflight', { method: 'POST', body: { kind: 'mint', ref: id, phase: 'payment', attempt: 0,
      commitTxid, revealTxid, inscriptionId: revealTxid + 'i0' } });
  }
}
