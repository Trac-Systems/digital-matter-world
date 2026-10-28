import { loadRegtestHistory } from '../../lib/headers.mjs';
import { fakeTrac } from '../helpers.mjs';

export async function create({ network, config }) {
  const history = await loadRegtestHistory(config.testHistory);
  // Deliberately omit adapter.history: exercise the CLI's own cache/download path.
  const view = { get: h => history.get(h), hashAt: h => history.get(h)?.hash ?? null };
  return { trac: fakeTrac(view, { network, tip: history.length - 1 }).trac, close: async () => {} };
}
