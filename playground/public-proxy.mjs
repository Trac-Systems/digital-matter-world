import { ownerAddress } from './owner-address.mjs';
// Public responses, cursor signatures and continuation routes pass through
// unchanged. Only the current player's address is supplied by the local app.
export function publicPath(input, owner) {
  return publicPathForOwner(input, ownerAddress(owner));
}

function publicPathForOwner(input, owner) {
  const url = new URL(input, 'http://127.0.0.1'), path = url.pathname.slice(5);
  if (path.startsWith('gateway/')) {
    const target = '/' + path.slice(8);
    if (!/^\/[a-zA-Z0-9/_.-]+$/.test(target) || target.includes('..') || target.includes('//')) throw Object.assign(Error('gateway_read_path'), { status: 400 });
    return target + url.search;
  }
  if (/^(?:web-api\/)?mint\/bulk\/[0-9a-f]{64}(?:\/(?:terms|members|permit))?$/.test(path)) return '/' + path + url.search;
  if (path === 'operator/status') return '/operator/status';
  if (path === 'list') {
    const source = url.searchParams.get('source');
    if (source?.startsWith('/') && !source.startsWith('/api/')) return '/list' + url.search;
    if (source?.startsWith('/api/')) {
      const mapped = publicPathForOwner(new URL(source, url.origin), owner);
      if (mapped) { url.searchParams.set('source', mapped); return '/list' + url.search; }
    }
    return null;
  }
  if (/^player\/(?:balances|mintRights|bitmaps|finds)$/.test(path)) return `/agents/${owner}/${path.slice(7)}` + url.search;
  if (/^(?:status|world|blocks|patterns|table|compounds|finds|receipts|feed|agents|mint-rights|payout-bindings|results|records\/batches)(?:\/|$)/.test(path) && path !== 'status/components') {
    if (/^blocks\/\d+(?:\/[^/]+)?$/.test(path) && !url.searchParams.has('owner')) url.searchParams.set('owner', owner);
    return '/' + path + url.search;
  }
  return null;
}

export function sharedReads({ engine, local }) {
  return async (input, context) => {
    const url = new URL(input), owner = ownerAddress(engine.state.player.address), path = url.pathname.slice(5);
    const target = publicPathForOwner(url, owner);
    if (target) return engine.get(target, /^\/(?:web-api\/)?mint\/[0-9a-f]{64}$/.test(target) ? context : undefined);
    if (path === 'player') {
      const profile = await engine.get('/agents/' + owner + url.search), own = await local(url);
      return { ...profile, ...own, counts: { ...profile.counts, ...own.counts }, pages: { ...profile.pages, ...own.pages } };
    }
    if (/^lab\/(?:status|bots|jobs|feed)(?:\/|$)/.test(path)) return local(url);
    if (path.startsWith('player/') || path.startsWith('payment-plan/')) {
      const result = await local(url);
      return { ...result, localData: { label: "your agent's local data" } };
    }
    // Jobs, bot scheduling and process monitoring are Lab controls.
    if (/^(?:jobs|bots|status\/components)(?:\/|$)/.test(path)) return local(url);
    if (path === 'list') return local(url);
    throw Object.assign(Error('not_found'), { status: 404 });
  };
}
