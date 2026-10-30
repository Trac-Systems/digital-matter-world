#!/usr/bin/env node
// GET-only deployment preparation. Prints a reviewable JSON manifest; it never
// writes contract state or edits the release's height/manifest automatically.
import { pathToFileURL } from 'node:url';
import { compoundIdentityV4, compoundRecordCommitment } from '../src/compound-identity-v4.js';
import { hashObject, assert } from '../src/core.js';
import { decodeTracAddress, encodeTracAddress } from '../src/trac-address.js';

export async function buildCompoundMergeManifest({ read, network = 'dmw-mainnet', holders = [] }) {
  const snapshots = new Map();
  async function page(path, key) {
    const rows = [], seen = new Set(); let cursor = null;
    do {
      const url = new URL(path, 'https://public.invalid'); url.searchParams.set('limit', '50');
      if (cursor) url.searchParams.set('cursor', cursor);
      const route = url.pathname + url.search, value = await read(route);
      assert(Array.isArray(value[key]), 'compound_merge_api_shape'); snapshots.set(route, hashObject(value)); rows.push(...value[key]);
      cursor = value.nextCursor ?? value.next;
      assert(!cursor || typeof cursor === 'string' && !seen.has(cursor), 'compound_merge_cursor'); seen.add(cursor);
    } while (cursor);
    return rows;
  }
  const compounds = (await page('/compounds', 'compounds')).filter(c => !c.retired), records = new Map(compounds.map(c => [c.id, c]));
  const targets = new Map(), visiting = new Set();
  function canonical(id) {
    if (!id.startsWith('c2:')) return id;
    if (targets.has(id)) return targets.get(id);
    const c = records.get(id); assert(c && c.v === 3 && c.commitment === id.slice(3) && compoundRecordCommitment(c) === c.commitment && !visiting.has(id), 'compound_merge_record');
    visiting.add(id);
    const identity = compoundIdentityV4(c.recipe, c.inputs.map(p => [canonical(p.asset), p.amount]));
    // v3 amounts are already normalized per unit, never the original craft
    // batch size. Refuse an unexpected ratio conversion for manual review.
    assert(identity.amount === '1', 'compound_merge_ratio_scale');
    targets.set(id, identity.id); visiting.delete(id); return identity.id;
  }
  for (const c of compounds) canonical(c.id);
  const agents = await page('/agents', 'agents');
  const owners = new Set([...holders, ...agents.map(a => a.address), ...compounds.map(c => c.firstMaker)].filter(Boolean));
  const balances = new Map();
  for (const address of [...owners].sort()) {
    const holder = address.startsWith('trac1') ? decodeTracAddress(address) : address;
    const rows = await page(`/agents/${encodeTracAddress(holder)}/balances`, 'balances');
    for (const row of rows) if (targets.has(row.asset)) {
      assert(row.current === true && !row.blocked && row.held === '0', 'compound_merge_balance_unavailable');
      if (BigInt(row.amount) > 0n) balances.set(row.asset + '/' + holder, { oldId: row.asset, newId: targets.get(row.asset), holder, amount: row.amount });
    }
  }
  const rows = [...balances.values()];
  for (const c of compounds) {
    const supplies = await page('/results/supply?asset=' + encodeURIComponent(c.id), 'supply');
    const supply = supplies.find(s => s.asset === c.id);
    assert(supply?.current === true && !supply.blocked, 'compound_merge_supply_unavailable');
    const held = rows.filter(r => r.oldId === c.id).reduce((sum, r) => sum + BigInt(r.amount), 0n);
    assert(held === BigInt(supply.issued) - BigInt(supply.burned), 'compound_merge_missing_holder');
    if (held === 0n) rows.push({ oldId: c.id, newId: targets.get(c.id), holder: decodeTracAddress(c.firstMaker), amount: '0' });
  }
  // A public projection may advance between pages: do not generate a list from
  // mixed revisions. Contract supply/balance proofs also recheck it at cutover.
  for (const [route, expected] of snapshots) assert(hashObject(await read(route)) === expected, 'compound_merge_snapshot_changed');
  rows.sort((a, b) => a.oldId.localeCompare(b.oldId) || a.holder.localeCompare(b.holder));
  return { network, ready: true, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), holders = []; let base = 'https://dmtworld.tap-protocol.com', network = 'dmw-mainnet';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base') base = args[++i];
    else if (args[i] === '--network') network = args[++i];
    else if (args[i] === '--holder') holders.push(args[++i]);
    else throw Error('Usage: compound-merge-manifest.mjs [--base URL] [--network NAME] [--holder trac1…]');
  }
  const origin = new URL(base);
  const read = async path => {
    const url = new URL(path, origin); assert(url.origin === origin.origin, 'compound_merge_origin');
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000) });
    assert(response.ok, `compound_merge_http_${response.status}`); return response.json();
  };
  process.stdout.write(JSON.stringify(await buildCompoundMergeManifest({ read, network, holders }), null, 2) + '\n');
}
