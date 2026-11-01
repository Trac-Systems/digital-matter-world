import { appendFile, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeTrac, history } from '../helpers.mjs';
import { FakeService } from '../fake-service.mjs';

// A local stand-in for exclusive Trac stores. Opening a second adapter fails;
// every send records its process so the test proves where work actually ran.
export async function create({ network, config, service }) {
  const lock = join(config.directory, 'fixture-adapter.lock'), fd = await open(lock, 'wx', 0o600);
  const log = event => appendFile(join(config.directory, 'fixture-events.jsonl'), JSON.stringify({ ...event, pid: process.pid }) + '\n', { mode: 0o600 });
  await log({ type: 'open' });
  const hist = history(), { trac } = fakeTrac(hist, { network }), fake = new FakeService({ network, history: hist, tip: 20 });
  // All reads and sends are fixtures. No network contact, even for health.
  service.health = async () => { throw Error('The fixture has no automatic mining tip'); };
  service.patterns = async () => ({ patterns: [], total: 0, limit: 50, next: null });
  service.fetchImpl = async (url, options) => { await log({ type: 'service', route: new URL(url).pathname }); return fake.fetch(url, options); };
  service.deployTicker = async args => { await log({ type: 'deploy' }); return { state: 'prepared', ...args, pid: process.pid }; };
  service.tickerPayment = async args => { await log({ type: 'ticker-payment' }); return { state: 'reported', ...args, pid: process.pid }; };
  const submit = trac.submit.bind(trac);
  trac.submit = async packet => { await log({ type: 'send', tx: packet.tx }); return submit(packet); };
  return { trac, history: hist, source: { raw: async h => hist.raw(h), hash: async h => hist.hashAt(h) },
    close: async () => { await fd.close(); await unlink(lock); } };
}
