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
  if (!row?.publicMint || row.permit || BigInt(height) > BigInt(row.expiry) ||
      ['expired', 'minted', 'refundable', 'cancelled', 'rejected'].includes(row.state)) return false;
  const scan = store.get('accountRecords', publicScanKey(rules.publicPlotId(row.request.asset, row.request.block)));
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
    return this.gate(async () => {
      const store = this.parent.store, resources = this.resources;
      const existing = store.get('mints', row.id);
      if (existing) return { row: existing, created: false };
      const height = store.get('meta', 'ruleState')?.counted ?? row.created;
      let total = 0, payer = 0, ip = 0, after = '';
      do {
        const page = store.list('publicMintRequests', { after, limit: resources.workPage });
        for (const { id } of page) {
          const prior = store.get('mints', id);
          if (!openPublicMint(store, prior, height)) continue;
          total++; if (prior.payer === row.payer) payer++; if (prior.clientIPHash === ipHash) ip++;
        }
        after = page.length === resources.workPage ? page.at(-1).id : '';
      } while (after);
      check(payer < resources.publicMintsPerPayer, 'public_mint_payer_capacity', 429);
      check(ip < resources.publicMintsPerIP, 'public_mint_ip_capacity', 429);
      check(total < resources.activeMints, 'mint_capacity', 503);
      row = { ...row, clientIPHash: ipHash };
      await write(row);
      return { row, created: true };
    });
  }
}
