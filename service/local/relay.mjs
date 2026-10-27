import { rules } from '../src/rules.mjs';
import { check } from '../src/util.mjs';

// A valid fork header is accepted before it has enough work to become the tip.
// Acknowledge its stored identity, independently of canonical chain selection.
export async function relayHeaders(headers, { connect, admin, row, api, until }) {
  check(Array.isArray(headers) && headers.length > 0 && headers.length <= 20, 'headers');
  const accepted = rules.parseHeader(headers.at(-1)).hash;
  if (!await row('b/r/' + accepted)) {
    await connect(); await admin.post({ op: 'hd', value: { headers } });
    await until(() => row('b/r/' + accepted), 'header replication', 30000);
  }
  return { ...await api.dmwHead(), accepted };
}
