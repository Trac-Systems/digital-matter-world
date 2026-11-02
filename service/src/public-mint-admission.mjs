import { isIP } from 'node:net';
import { check, hash, serial } from './util.mjs';
import { assetResources } from './asset-resources.mjs';
import { rules } from './rules.mjs';
import { publicScanKey } from '../../contract/public-mint.js';

// The HTTP listener is loopback-only. Caddy supplies the last forwarded hop;
// never use the first address, which can have been supplied by the caller.
export function publicMintClientIP(req) {
  const peer = req.socket.remoteAddress ?? '';
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
  const forwarded = local && typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',').at(-1).trim() : '';
  const address = isIP(forwarded) ? forwarded : peer;
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) return address.slice(7);
  // URL serialization normalizes equivalent IPv6 spellings to one quota key.
  return isIP(address) === 6 ? new URL('http://[' + address + ']').hostname.slice(1, -1) : address;
}

export function openPublicMint(store, row, height) {
  if (!row?.publicMint) return false;
  const bulk = row.publicBulkOrderId && store.get('publicBulkOrders', row.publicBulkOrderId);
  const expired = BigInt(height) > BigInt(row.expiry) || bulk && Date.now() > bulk.expiresAt;
  if (row.permit || expired && !(row.publicBulkOrderId && (row.paymentIds?.length || bulk?.paymentPending)) ||
      ['expired', 'minted', 'refundable', 'cancelled', 'rejected'].includes(row.state)) return false;
  const scan = store.get('accountRecords', publicScanKey(rules.publicPlotId(row.request.asset, row.request.block, row.intent?.supplyScope ?? row.request.supplyScope)));
  return !scan?.winner && store.count('publicMintRefundsByRequest/' + row.id) === 0;
}

export class PublicMintAdmission {
  constructor(parent, { now = Date.now } = {}) {
    this.parent = parent; this.now = now; this.gate = serial();
  }
  get resources() { return assetResources(this.parent.resources); }
  // Persist the minute window so a gateway restart does not reset the quota.
  // Bounded by the same local input capacity as the other asset queues.
  async start(ip) {
    const ipHash = hash(ip ?? 'local');
    await this.gate(async () => {
      const store = this.parent.store, now = this.now(), resources = this.resources;
      const prior = store.get('publicMintStartRates', ipHash), writes = [];
      let after = '';
      do {
        const page = store.list('publicMintStartRates', { after, limit: resources.workPage });
        for (const row of page) if (now >= row.value.until) writes.push({ space: 'publicMintStartRates', id: row.id });
        after = page.length === resources.workPage ? page.at(-1).id : '';
      } while (after);
      const live = prior && now < prior.until;
      check(live || store.count('publicMintStartRates') - writes.length < resources.mintInputCapacity, 'public_mint_start_rate', 429);
      check(!live || prior.count < resources.publicMintStartsPerMinute, 'public_mint_start_rate', 429);
      writes.push({ space: 'publicMintStartRates', id: ipHash, value: { until: live ? prior.until : now + 60_000, count: live ? prior.count + 1 : 1 } });
      await store.transact(writes);
    });
    return ipHash;
  }
  admit(row, ipHash, write) {
    return this.admitMany([row], ipHash, rows => write(rows[0])).then(result => ({ row: result.rows[0], created: result.created }));
  }
  admitMany(rows, ipHash, write) {
    return this.gate(async () => {
      const store = this.parent.store, resources = this.resources;
      check(rows.length > 0 && rows.length <= resources.publicBulkMintBlocks && new Set(rows.map(r => r.id)).size === rows.length &&
        rows.every(r => r.payer === rows[0].payer && (rows.length === 1 || r.publicBulkOrderId && r.publicBulkOrderId === rows[0].publicBulkOrderId)), 'public_bulk_members');
      const existing = rows.map(row => store.get('mints', row.id));
      if (existing.some(Boolean)) { check(existing.every(Boolean), 'public_bulk_conflict', 409); return { rows: existing, created: false }; }
      const height = store.get('meta', 'ruleState')?.counted ?? rows[0].created;
      let total = 0, after = ''; const payers = new Set(), ips = new Set();
      do {
        const page = store.list('publicMintRequests', { after, limit: resources.workPage });
        for (const { id } of page) {
          const prior = store.get('mints', id);
          if (!openPublicMint(store, prior, height)) continue;
          total++; const order = prior.publicBulkOrderId ?? prior.id;
          if (prior.payer === rows[0].payer) payers.add(order); if (prior.clientIPHash === ipHash) ips.add(order);
        }
        after = page.length === resources.workPage ? page.at(-1).id : '';
      } while (after);
      check(payers.size < resources.publicMintsPerPayer, 'public_mint_payer_capacity', 429);
      check(ips.size < resources.publicMintsPerIP, 'public_mint_ip_capacity', 429);
      check(total + rows.length <= resources.activeMints, 'mint_capacity', 503);
      rows = rows.map(row => ({ ...row, clientIPHash: ipHash }));
      await write(rows);
      return { rows, created: true };
    });
  }
}
