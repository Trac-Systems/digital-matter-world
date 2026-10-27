import { fanOutValidatorSends } from '../../contract/runtime/fanout.js';
import { check } from './util.mjs';
// Called with the already configured local peer. The runtime fanout patches only
// this client's transport, never the installed MSB package.
export function runtimeTransport(peer, bus, { installFanout = true } = {}) {
  if (installFanout) fanOutValidatorSends(bus.network, 3);
  const protocol = peer.protocol.instance, api = protocol.api;
  return {
    async prepareMessage(op, value) {
      const prepared = api.prepareMessage(JSON.stringify({ network: peer.config.dmw.network, op, value }), peer.wallet.publicKey), nonce = api.generateNonce();
      return { prepared, nonce, signature: peer.wallet.sign(JSON.stringify(prepared) + nonce) };
    },
    async sendMessage(m) { return api.post(m.prepared, m.signature, m.nonce); },
    async prepareTransaction(op, value) {
      const dispatch = { type: op, value }, nonce = protocol.generateNonce();
      const ch = await protocol.resolveTxContentHash(dispatch), txv = await peer.msbClient.getTxvHex();
      const tx = await protocol.generateTx(peer.msbClient.networkId, txv, peer.writerLocalKey, ch, peer.base.key.toString('hex'), peer.msbClient.bootstrapHex, nonce);
      return { dispatch, txv, tx, nonce, ch, address: peer.wallet.publicKey, signature: peer.wallet.sign(Buffer.from(tx, 'hex')) };
    },
    async sendTransaction(prepared) {
      check(await peer.msbClient.getTxvHex() === prepared.txv, 'tx_version_changed', 503);
      const result = await protocol.broadcastTransaction(prepared.dispatch, false, prepared);
      check(result?.txo?.tx === prepared.tx, 'tx_identity_changed', 503); return result;
    },
    async status(job) {
      if (job.op === 'bt') {
        const root = await api.dmwBatchRoot(job.value.n);
        if (root === job.value.root) return { state: 'accepted' };
        if (root !== null) return { state: 'rejected', reason: 'batch_conflict' };
      } else if (job.op === 'hd') {
        if (await api.dmwHashAt(job.height) === job.hash) return { state: 'accepted' };
        // Stored fork headers are accepted before they become canonical.
        if ((await peer.base.view.get('b/r/' + job.hash))?.value?.[0] === job.height) return { state: 'accepted' };
      }
      if (job.transaction && job.op !== 'hd') {
        const marker = await peer.base.view.get(`tx/${job.transaction.tx}`);
        if (marker) {
          const row = await peer.base.view.get(`txi/${marker.value}`);
          if (row?.value?.err) return { state: 'rejected', reason: 'contract_rejected' };
        }
      }
      return { state: 'pending' };
    }
  };
}
export class Outbox {
  constructor({ store, transport, fallbackMs = 5000, retryMs = 1000, maxJobs = 128 }) { Object.assign(this, { store, transport, fallbackMs, retryMs, maxJobs }); }
  async enqueue(id, op, value, extra = {}) {
    if (this.store.get('outbox', id) || this.store.get('sent', id)) return;
    check(this.store.count('outbox') < this.maxJobs, 'outbox_capacity', 503);
    const message = await this.transport.prepareMessage(op, value);
    await this.store.put('outbox', id, { id, op, value, message, created: Date.now(), next: 0, attempts: 0, ...extra });
  }
  async tick(now = Date.now()) {
    if (this.running) return; this.running = true;
    try {
      for (const { id, value: job } of this.store.list('outbox', { limit: this.maxJobs })) {
        const header = job.op === 'hd';
        if (job.blocked || !header && job.next > now) continue;
        if (header && job.after && !this.store.get('sent', job.after)) continue;
        try {
          const status = await this.transport.status(job);
          if (status.state === 'accepted') {
            await this.store.transact([{ space: 'sent', id, value: { id, tx: header ? null : job.transaction?.tx ?? null, accepted: now } }, { space: 'outbox', id }]); continue;
          }
          if (status.state === 'rejected') { await this.store.put('outbox', id, { ...job, blocked: status.reason }); continue; }
          // Acceptance is polled every tick; only retransmission backs off.
          if (job.next > now) continue;
          if (!header && now - job.created >= this.fallbackMs && !job.transaction) {
            job.transaction = await this.transport.prepareTransaction(job.op, job.value);
            await this.store.put('outbox', id, job);
          }
          // Save the attempt before the side effect. Every retry uses the exact
          // persisted nonce, content hash and signature, including after a crash.
          job.attempts++; job.next = now + Math.min(30000, this.retryMs * 2 ** Math.min(job.attempts - 1, 5));
          await this.store.put('outbox', id, job);
          if (!header && job.transaction) await this.transport.sendTransaction(job.transaction);
          else await this.transport.sendMessage(job.message);
        } catch { await this.store.put('outbox', id, { ...job, next: now + this.retryMs, error: 'transport_unavailable' }); }
      }
    } finally { this.running = false; }
  }
}
