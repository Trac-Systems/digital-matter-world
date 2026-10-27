import { createServer } from 'node:http';
import { bitcoin, ordJson, PORTS } from './common.mjs';
import { Orders, serialQueue } from './inscriber.mjs';

const sats = amount => Math.round(amount * 100000000);
const fail = (status, message) => Object.assign(new Error(message), { status });
const ok = data => ({ code: 0, msg: 'ok', data });
const orderOk = data => ({ ok: true, data });
const enc = encodeURIComponent;
function page(url) {
  const cursor = Number(url.searchParams.get('cursor') || 0), size = Number(url.searchParams.get('size') || 100);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(size) || size < 1 || size > 500) throw fail(400, 'Invalid pagination');
  return { cursor, size };
}
async function body(req, json = true) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2000000) throw fail(413, 'Request too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!json) return text;
  try { return JSON.parse(text || '{}'); } catch { throw fail(400, 'Invalid JSON'); }
}

export class BitcoinReader {
  constructor(manifest) { this.manifest = manifest; this.scan = serialQueue(); }
  rpc(method, params) { return bitcoin(this.manifest, method, params); }
  async validate(address) { if (!(await this.rpc('validateaddress', [address])).isvalid) throw fail(400, 'Invalid regtest address'); }
  async utxos(address) {
    await this.validate(address);
    return this.scan(async () => {
      const scan = await this.rpc('scantxoutset', ['start', [`addr(${address})`]]);
      const result = [];
      for (const u of scan.unspents) {
        if (!await this.rpc('gettxout', [u.txid, u.vout, true])) continue;
        result.push({ txid: u.txid, vout: u.vout, value: sats(u.amount), status: { confirmed: true, block_height: u.height, block_hash: await this.rpc('getblockhash', [u.height]) } });
      }
      const mempool = await this.rpc('getrawmempool');
      for (const txid of mempool) {
        const tx = await this.rpc('getrawtransaction', [txid, true]);
        for (const v of tx.vout) if (v.scriptPubKey.address === address && await this.rpc('gettxout', [txid, v.n, true])) result.push({ txid, vout: v.n, value: sats(v.value), status: { confirmed: false } });
      }
      return result;
    });
  }
  async richUtxos(address) {
    const result = [];
    for (const u of await this.utxos(address)) {
      const raw = await this.rpc('getrawtransaction', [u.txid, true]);
      const output = u.status.confirmed ? await ordJson(this.manifest, `/output/${u.txid}:${u.vout}`) : null;
      const inscriptions = [];
      for (const id of output?.inscriptions || []) {
        const i = await ordJson(this.manifest, `/inscription/${id}`);
        inscriptions.push({ inscriptionId: id, inscriptionNumber: i.number, offset: Number(i.satpoint.split(':')[2]), contentType: i.content_type, contentLength: i.content_length });
      }
      result.push({ txid: u.txid, vout: u.vout, satoshi: u.value, scriptPk: raw.vout[u.vout].scriptPubKey.hex, address, height: u.status.block_height || 0, inscriptions, isSpent: false, isOpInRBF: false, status: u.status });
    }
    return result;
  }
  async history(address, after) {
    await this.validate(address);
    const height = await this.rpc('getblockcount');
    const transactions = [], prev = new Map();
    for (let n = 1; n <= height; n++) {
      const hash = await this.rpc('getblockhash', [n]);
      const block = await this.rpc('getblock', [hash, 2]);
      for (const tx of block.tx) { transactions.push({ ...tx, status: { confirmed: true, block_height: n, block_hash: hash, block_time: block.time } }); prev.set(tx.txid, tx); }
    }
    for (const id of await this.rpc('getrawmempool')) { const tx = await this.rpc('getrawtransaction', [id, true]); transactions.push({ ...tx, status: { confirmed: false } }); prev.set(id, tx); }
    const mapped = [];
    const output = v => ({ scriptpubkey: v.scriptPubKey.hex, scriptpubkey_address: v.scriptPubKey.address, scriptpubkey_type: v.scriptPubKey.type, value: sats(v.value) });
    for (const tx of transactions.reverse()) {
      const vin = [];
      for (const i of tx.vin) vin.push({ txid: i.txid, vout: i.vout, is_coinbase: Boolean(i.coinbase), sequence: i.sequence, prevout: i.txid && prev.get(i.txid) ? output(prev.get(i.txid).vout[i.vout]) : null });
      const vout = tx.vout.map(output);
      if (!vout.some(v => v.scriptpubkey_address === address) && !vin.some(v => v.prevout?.scriptpubkey_address === address)) continue;
      mapped.push({ txid: tx.txid, version: tx.version, locktime: tx.locktime, size: tx.size, weight: tx.weight, fee: vin.every(v => v.prevout) ? vin.reduce((s, v) => s + v.prevout.value, 0) - vout.reduce((s, v) => s + v.value, 0) : 0, vin, vout, status: tx.status });
    }
    const offset = after ? mapped.findIndex(t => t.txid === after) + 1 : 0;
    return mapped.slice(offset, offset + 25);
  }
}

export async function startGateway(manifest, { port = PORTS.gateway, orders = new Orders(manifest) } = {}) {
  const reader = new BitcoinReader(manifest);
  async function orderView(order) {
    let tappingStatus = 0;
    if (order.status === 'inscribed') {
      const tx = await bitcoin(manifest, 'getrawtransaction', [order.reveal, true]);
      tappingStatus = tx.confirmations > 0 ? 2 : 1;
      if (order.tapped) tappingStatus = 3;
    }
    const { entries, ...view } = order;
    return { ...view, state: order.status, status: order.status === 'inscribed' ? 1 : 0, type: order.orderType, rebar: false, tappingStatus, tapStatus: tappingStatus, serviceFee: 0, discountServiceFee: 0, networkFee: order.totalFee - order.postage * order.files.length, paidAmount: order.status === 'pending' ? 0 : order.totalFee, files: order.files.map(f => ({ filename: 'text.txt', ...f })) };
  }
  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'Content-Type, Authorization, X-Client, X-Api-Key');
    res.setHeader('cache-control', 'no-store');
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      if (!['GET', 'POST'].includes(req.method)) throw fail(405, 'Method not allowed');
      const url = new URL(req.url, manifest.gateway.url), path = url.pathname;
      let match, data;
      if (req.method === 'GET' && path === '/health') data = { ok: true, network: 'regtest', trac: 'stub', prices: 'stub' };
      else if (req.method === 'GET' && path === '/api/v1/fees/recommended') data = { fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 };
      else if (req.method === 'POST' && path === '/tx') {
        const hex = (await body(req, false)).trim();
        if (!/^(?:[a-f0-9]{2})+$/i.test(hex)) throw fail(400, 'Invalid transaction hex');
        data = await bitcoin(manifest, 'sendrawtransaction', [hex]);
      } else if (req.method === 'GET' && (match = path.match(/^\/tx\/([a-f0-9]{64})\/hex$/))) {
        res.setHeader('content-type', 'text/plain'); res.end(await bitcoin(manifest, 'getrawtransaction', [match[1]])); return;
      } else if (req.method === 'GET' && (match = path.match(/^\/address\/([^/]+)\/utxo$/))) data = await reader.utxos(decodeURIComponent(match[1]));
      else if (req.method === 'GET' && (match = path.match(/^\/api\/address\/([^/]+)\/txs$/))) data = await reader.history(decodeURIComponent(match[1]), url.searchParams.get('after_txid'));
      else if (req.method === 'GET' && (match = path.match(/^\/v1\/indexer\/address\/([^/]+)\/(balance|utxo-data|inscription-utxo-data)$/))) {
        const address = decodeURIComponent(match[1]), all = await reader.richUtxos(address);
        if (match[2] === 'balance') {
          const amount = group => group.reduce((s, u) => s + u.satoshi, 0);
          const confirmed = all.filter(u => u.status.confirmed), pending = all.filter(u => !u.status.confirmed), btc = confirmed.filter(u => !u.inscriptions.length), inscriptions = confirmed.filter(u => u.inscriptions.length);
          data = ok({ address, satoshi: amount(confirmed), pendingSatoshi: amount(pending), utxoCount: all.length, btcSatoshi: amount(btc), btcPendingSatoshi: amount(pending.filter(u => !u.inscriptions.length)), btcUtxoCount: btc.length, inscriptionSatoshi: amount(inscriptions), inscriptionPendingSatoshi: amount(pending.filter(u => u.inscriptions.length)), inscriptionUtxoCount: inscriptions.length });
        } else {
          const { cursor, size } = page(url), utxos = all.filter(u => match[2] === 'inscription-utxo-data' ? u.inscriptions.length : !u.inscriptions.length);
          data = ok({ total: utxos.length, cursor, utxo: utxos.slice(cursor, cursor + size) });
        }
      } else if (req.method === 'GET' && (match = path.match(/^\/v1\/indexer\/inscription\/info\/([^/]+)$/))) {
        const i = await ordJson(manifest, `/inscription/${enc(decodeURIComponent(match[1]))}`);
        data = ok({ ...i, inscriptionId: i.id, inscriptionNumber: i.number, contentType: i.content_type, contentLength: i.content_length, output: i.satpoint.split(':').slice(0, 2).join(':'), offset: Number(i.satpoint.split(':')[2]) });
      } else if (req.method === 'GET' && /^\/v1\/indexer\/address\/[^/]+\/runes\/(balance-list|[^/]+\/utxo)$/.test(path)) data = ok(path.endsWith('/balance-list') ? { total: 0, detail: [] } : { total: 0, utxo: [] });
      else if (req.method === 'GET' && /^\/(inscription|content|preview)\/[a-f0-9]{64}i[0-9]+$/.test(path)) {
        const response = await fetch(manifest.ord.url + path, { headers: { accept: path.startsWith('/inscription/') ? 'application/json' : (req.headers.accept || '*/*') }, signal: AbortSignal.timeout(15000) });
        res.statusCode = response.status; res.setHeader('content-type', response.headers.get('content-type') || 'application/octet-stream');
        res.end(Buffer.from(await response.arrayBuffer())); return;
      } else if (req.method === 'GET' && /^\/(?:r\/tap\/)?get[A-Z][A-Za-z]*(?:\/[^/]*)*$/.test(path)) {
        const tapPath = path.startsWith('/r/tap/') ? path : '/r/tap' + path;
        data = await ordJson(manifest, tapPath + url.search);
        if (tapPath.startsWith('/r/tap/getAccountTokensBalance/')) {
          for (const token of data.data.list) {
            token.overallBalance ||= '0'; token.transferableBalance ||= '0';
            token.tokenInfo = (await ordJson(manifest, `/r/tap/getDeployment/${enc(token.ticker)}`)).result;
          }
        }
      } else if (req.method === 'POST' && ['/v1/inscribe/order/texts', '/v1/inscribe/order/tapTransfer'].includes(path)) data = orderOk(await orderView(await orders.create(await body(req), path.endsWith('tapTransfer'))));
      else if (req.method === 'GET' && (match = path.match(/^\/v1\/inscribe\/order\/(readyToTap|authority)\/([^/]+)$/))) {
        const list = orders.list(decodeURIComponent(match[2]), match[1] === 'authority' ? 'AUTHORITY' : url.searchParams.get('orderType'));
        data = orderOk(await Promise.all(list.map(orderView)));
      } else if (req.method === 'POST' && (match = path.match(/^\/v1\/inscribe\/order\/(paid|tapping|cancel)\/([a-f0-9-]+)$/))) {
        await body(req);
        let order;
        if (match[1] === 'paid') order = await orders.paid(match[2]);
        else if (match[1] === 'cancel') order = await orders.cancel(match[2]);
        else { order = orders.get(match[2]); if (order.status !== 'inscribed') throw fail(409, 'Inscription not ready'); order.tapped = true; await orders.persist(order); }
        data = orderOk(await orderView(order));
      } else if (req.method === 'GET' && (match = path.match(/^\/v1\/inscribe\/order\/cancelAuthority\/([^/]+)$/))) {
        const found = [...orders.orders.values()].find(o => o.orderType === 'CANCEL_AUTHORITY' && o.inscriptionAuthority === match[1]);
        data = orderOk(found ? await orderView(found) : null);
      } else if (req.method === 'GET' && /^\/v1\/inscribe\/order\/unats\/[^/]+$/.test(path)) data = orderOk({ scriptInscription: null });
      else if (req.method === 'POST' && path === '/v2/inscribe/order/create') {
        const b = await body(req);
        const dataEntries = b.files?.map(f => ({ text: Buffer.from(f.dataURL.split(',')[1], 'base64').toString('utf8'), receiver: b.receiveAddress }));
        data = ok(await orderView(await orders.create({ connectedAddress: b.receiveAddress, postage: b.outputValue, feeRate: b.feeRate, data: dataEntries })));
      } else if (req.method === 'GET' && (match = path.match(/^\/v2\/inscribe\/order\/([a-f0-9-]+)$/))) data = ok(await orderView(orders.get(match[1])));
      else if (req.method === 'GET' && path === '/fee') data = { fee: '0', stub: true };
      else if (req.method === 'GET' && path === '/txv') data = { txv: '0', stub: true };
      else if (req.method === 'GET' && /^\/balance\/[^/]+$/.test(path)) data = { balance: '0', stub: true };
      else if (req.method === 'GET' && path === '/api/transactions') data = { transactions: [], total: 0, stub: true };
      else if (req.method === 'POST' && path === '/broadcast-transaction') { await body(req); throw fail(501, 'Local TRAC is stubbed; no transaction was broadcast'); }
      else if (req.method === 'GET' && ['/', '/v2/prices/BTC-USD/spot'].includes(path)) data = { data: { amount: '0', base: 'BTC', currency: 'USD' }, stub: true };
      else if (req.method === 'GET' && /^\/v1\/token-prices\/(TAP|DMT-NAT|TRAC)$/.test(path)) data = { statusCode: 200, data: { price_usd: '0' }, stub: true };
      else throw fail(404, 'Route not found');
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(error.status || (error.rpcCode ? 400 : 500), { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  let polling = false, closing = false;
  const timer = setInterval(async () => {
    if (polling || closing) return; polling = true;
    try { for (const order of orders.orders.values()) if (!closing && order.status === 'pending') await orders.paid(order.id).catch(() => {}); }
    finally { polling = false; }
  }, 1000);
  server.on('close', () => clearInterval(timer));
  server.stop = async () => {
    closing = true; clearInterval(timer);
    await new Promise(resolve => server.close(resolve));
    await orders.queue(async () => {});
  };
  return server;
}
