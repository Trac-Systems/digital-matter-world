import { readFile } from 'node:fs/promises';
import { fixture, batchFixture } from './fixture.mjs';
import { ethereumFixture } from './ethereum-fixture.mjs';
import { ethereumPayments } from '../../service/src/ethereum.mjs';
import { createEscrowReader } from '../signer/escrow-reader.mjs';

// Local integration fixture. Operators never select this module implicitly.
export async function createReads({ file }) {
  return new Proxy({}, { get: (target, method) => {
    if (Object.hasOwn(target, method)) return target[method];
    if (method === 'mintPayoutSnapshot' || method === 'verifyPayoutSnapshot') return undefined;
    if (method === 'close' || method === 'then' || method === 'refreshEvidence' || method === 'bindings') return undefined;
    return async (...args) => {
      const options = JSON.parse(await readFile(file, 'utf8'));
      if (method === 'batchContext') return { ...batchFixture().context, ...(options.batchCounted === undefined ? {} : { counted: options.batchCounted }) };
      if (method === 'counted' && options.batchCounted !== undefined) return options.batchCounted;
      if (method === 'receiptCertificate' || method === 'batchRoot') return null;
      if (method === 'batchLast') return batchFixture().context.last;
      if (method === 'preflight') return fixture().reads.preflight(...args);
      if (method === 'mintCertificate') return options.certificate ?? null;
      if (options.ethereum) {
        const { endpoint, ...config } = options.ethereum, url = new URL(endpoint);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw Error('loopback_required');
        const rpc = async (method, params) => {
          const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
          const body = await response.json(); if (body.error) throw Error(body.error.message); return body.result;
        };
        const reader = createEscrowReader({ ...config.escrow, rpc });
        if (method === 'escrowDeposit') return reader.deposit(...args);
        if (method === 'escrowRotation') return reader.rotation(...args);
        if (method === 'committeeRotation') return options.rotation ?? null;
        if (method === 'mint') return options.observation ?? null;
        const f = ethereumFixture({ ...config, publicKey: options.publicKey });
        // A fixture models Trac acceptance; payment finality comes from Anvil.
        f.reprice({ consumed: options.consumed === true });
        if (method === 'mintPayment') {
          const snapshot = await reader.deposit(config.payer, f.id), settlement = snapshot.deposit.status === 2 ? await ethereumPayments({ rpc, escrow: config.escrow }).settled('ethereum', f.id, config.payer) : null;
          f.data.payment.depositFinal = snapshot.confirmations >= 1;
          f.data.payment.split = snapshot.deposit.split;
          f.data.payment.receipts = f.data.payment.receipts.map(r => ({ ...r, confirmations: settlement?.kind === 'claim' ? Math.min(snapshot.confirmations, settlement.confirmations) : 0 }));
        }
        if (method === 'assetContext') return { ...await f.reads.assetContext(...args), payouts: {} };
        if (method === 'mintFeeTerms') return { ...await f.reads.mintFeeTerms(...args), payoutSnapshot: { payouts: {} } };
        if (typeof f.reads[method] !== 'function') throw Error('unexpected_fixture_read_' + String(method));
        return f.reads[method](...args);
      }
      const f = fixture(options.kind, options.publicKey);
      if (method === 'assetContext') return { ...await f.reads.assetContext(...args), payouts: {} };
      if (method === 'mintFeeTerms') return { ...await f.reads.mintFeeTerms(...args), payoutSnapshot: { payouts: {} } };
      if (method === 'mint') return options.observation ?? null;
      return f.reads[method](...args);
    };
  } });
}
