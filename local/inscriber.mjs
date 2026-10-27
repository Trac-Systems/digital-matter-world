import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bitcoin, diskCheck, ordWallet, save, waitIndexed } from './common.mjs';

export function serialQueue() {
  let tail = Promise.resolve();
  return fn => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
}

export async function inscribe(manifest, entries, { feeRate = 1, postage = 10000 } = {}) {
  await diskCheck();
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 100) throw new Error('Expected 1..100 inscriptions');
  if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > 1000) throw new Error('Invalid fee rate');
  if (!Number.isSafeInteger(postage) || postage < 330 || postage > 1000000) throw new Error('Invalid postage');
  const folder = join(manifest.root, 'inscriptions', randomUUID());
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const inscriptions = [];
  for (const [index, entry] of entries.entries()) {
    const text = typeof entry.text === 'string' ? entry.text : JSON.stringify(entry.text);
    if (typeof text !== 'string' || Buffer.byteLength(text) > 100000) throw new Error('Invalid inscription content');
    const valid = await bitcoin(manifest, 'validateaddress', [entry.receiver]);
    if (!valid.isvalid) throw new Error('Invalid regtest receiver');
    const file = join(folder, `${index}.txt`);
    await writeFile(file, text, { mode: 0o600 });
    inscriptions.push({ file, destination: entry.receiver });
  }
  const batch = join(folder, 'batch.json');
  await save(batch, { mode: 'separate-outputs', postage, inscriptions });
  await waitIndexed(manifest);
  const result = await ordWallet(manifest, ['batch', '--no-backup', '--fee-rate', String(feeRate), '--batch', batch]);
  await save(join(folder, 'result.json'), result);
  return result;
}

export async function sendInscription(manifest, id, receiver) {
  await waitIndexed(manifest);
  return ordWallet(manifest, ['send', '--fee-rate', '1', '--postage', '10000sat', receiver, id]);
}

export class Orders {
  constructor(manifest) { this.manifest = manifest; this.orders = new Map(); this.queue = serialQueue(); }
  async persist(order) { await save(join(this.manifest.root, 'orders', `${order.id}.json`), order); }
  async create(body, transfer = false) {
    const entries = transfer ? [{ text: JSON.stringify({ p: 'tap', op: 'token-transfer', tick: body.ticker, amt: body.amount, ...(body.data ? { dta: JSON.parse(body.data) } : {}) }), receiver: body.connectedAddress }] : body.data;
    if (!Array.isArray(entries) || !entries.length || entries.length > 100 || entries.some(e => typeof e.text !== 'string' || Buffer.byteLength(e.text) > 100000)) throw Object.assign(new Error('Invalid inscription data'), { status: 400 });
    const postage = body.postage ?? 546, feeRate = body.feeRate ?? 1;
    if (!Number.isSafeInteger(postage) || postage < 330 || postage > 1000000 || !Number.isFinite(feeRate) || feeRate < 1 || feeRate > 1000) throw Object.assign(new Error('Invalid postage or fee rate'), { status: 400 });
    for (const address of [body.connectedAddress, ...entries.map(e => e.receiver)]) {
      if (!(await bitcoin(this.manifest, 'validateaddress', [address])).isvalid) throw Object.assign(new Error('Invalid regtest address'), { status: 400 });
    }
    await mkdir(join(this.manifest.root, 'orders'), { recursive: true, mode: 0o700 });
    // A conservative local quote covers separate outputs, commit and reveal fees.
    const totalFee = entries.length * postage + Math.ceil((500 + entries.reduce((n, e) => n + 150 + Buffer.byteLength(e.text) / 4, 0)) * feeRate);
    const order = { id: randomUUID(), payAddress: await bitcoin(this.manifest, 'getnewaddress', ['', 'bech32m'], 'faucet'), totalFee, amount: totalFee, postage, feeRate, connectedAddress: body.connectedAddress, orderType: body.orderType || (transfer ? 'TAP_TRANSFER' : 'TEXT'), inscriptionAuthority: body.inscriptionAuthority ?? null, status: 'pending', files: entries.map(e => ({ inscriptionId: '', txId: '', receiver: e.receiver })), entries, createdAt: new Date().toISOString() };
    this.orders.set(order.id, order); await this.persist(order); return order;
  }
  get(id) { const order = this.orders.get(id); if (!order) throw Object.assign(new Error('Order not found'), { status: 404 }); return order; }
  list(address, type) { return [...this.orders.values()].filter(o => o.connectedAddress === address && (!type || o.orderType === type) && o.status !== 'cancelled'); }
  async paid(id) {
    return this.queue(async () => {
      const order = this.get(id);
      if (order.status === 'inscribed') return order;
      if (order.status !== 'pending') throw Object.assign(new Error('Order cannot be paid in its current state'), { status: 409 });
      const paid = await bitcoin(this.manifest, 'getreceivedbyaddress', [order.payAddress, 1], 'faucet');
      if (Math.round(paid * 1e8) < order.totalFee) throw Object.assign(new Error('Awaiting confirmed payment'), { status: 409 });
      order.status = 'inscribing'; await this.persist(order);
      try {
        const result = await inscribe(this.manifest, order.entries, order);
        order.commit = result.commit; order.reveal = result.reveal;
        order.files = result.inscriptions.map(i => ({ inscriptionId: i.id, txId: result.reveal, receiver: i.destination }));
        order.status = 'inscribed'; await this.persist(order); return order;
      } catch (error) {
        // A failed broadcast may have sent the commit. Do not blindly repeat it.
        order.status = 'failed'; order.error = error.message; await this.persist(order); throw error;
      }
    });
  }
  async cancel(id) {
    return this.queue(async () => {
      const order = this.get(id);
      if (order.status !== 'pending') throw Object.assign(new Error('Only unpaid orders can be cancelled'), { status: 409 });
      if (await bitcoin(this.manifest, 'getreceivedbyaddress', [order.payAddress, 0], 'faucet') > 0) throw Object.assign(new Error('Paid orders cannot be cancelled'), { status: 409 });
      order.status = 'cancelled'; await this.persist(order); return order;
    });
  }
}
