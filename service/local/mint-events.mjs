import { hash } from '../src/util.mjs';

export const holdKey = (asset, block) => hash(JSON.stringify([asset, block]));
export async function liveHold(events, api, asset, block) {
  const saved = events.get('liveHolds', holdKey(asset, block)); if (!saved) return null;
  const current = await api.dmwMint(saved.id), counted = (await api.dmwHead()).counted;
  if (!current || !current.h && (current.s !== 0 || counted > current.e) || current.asset !== asset || current.block !== block) return null;
  return { id: saved.id, expiry: current.h ? Number.MAX_SAFE_INTEGER : current.e };
}

// Index contract history without treating a paid hold as a new reservation.
// Remember admissions within this scan too, including compounds without blocks.
export async function mintEventChanges(events, history) {
  let counted = events.get('meta', 'counted') ?? 0;
  const changes = [], original = new Map();
  for await (const r of history) {
    if (r.key === 'b/cnt' && r.type !== 'del') counted = r.value;
    if (!/^m\/[0-9a-f]{64}$/.test(r.key)) continue;
    const id = r.key.slice(2), old = original.get(id) ?? events.get('originalPending', id);
    if (r.type !== 'del' && r.value.s === 0) {
      if (Object.hasOwn(r.value, 'block')) changes.push({ space: 'liveHolds', id: holdKey(r.value.asset, r.value.block), value: { id } });
      if (!old) {
        original.set(id, r.value);
        changes.push({ space: 'acceptances', id, value: { id, created: counted, expiry: r.value.e } },
          { space: 'originalPending', id, value: r.value });
      }
    }
    if (r.type === 'del') {
      if (old && Object.hasOwn(old, 'block')) changes.push({ space: 'liveHolds', id: holdKey(old.asset, old.block) });
      changes.push({ space: 'exits', id, value: { op: 'rx', height: counted } });
    } else if (r.value.s === 1) changes.push({ space: 'exits', id, value: { op: 'mc', height: counted, permitHash: r.value.permitHash } });
  }
  return { changes, counted };
}
