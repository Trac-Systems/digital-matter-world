import { fakeTrac, history } from '../helpers.mjs';
import { installLocalFetch } from '../../../service/src/http-client.mjs';
export async function create({ network }) {
  // Match the real playground integration: its local RPC reader installs this
  // query-rejecting hook during adapter creation, after the kit pins transport.
  installLocalFetch();
  return { trac: fakeTrac(history(), { network }).trac, close: async () => {} };
}
