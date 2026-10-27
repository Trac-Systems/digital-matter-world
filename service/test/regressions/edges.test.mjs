import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rpc, installLocalFetch } from '../../src/http-client.mjs';
import { rpc as dependencyRPC } from '../../../local/common.mjs';
import { Replay } from '../../src/replay.mjs';
import { initialState } from '../../src/rules.mjs';

test('local Bitcoin helper rejects redirects before contacting their destination', async () => {
  const servers = [], originalFetch = globalThis.fetch; let reached = false;
  const listen = async handler => { const s = createServer(handler); servers.push(s); await new Promise(r => s.listen(0, '127.0.0.1', r)); return 'http://127.0.0.1:' + s.address().port; };
  try {
    const destination = await listen(async (req, res) => { for await (const chunk of req) void chunk; reached = true; res.end('{"result":123}'); });
    const source = await listen((req, res) => { req.resume(); res.writeHead(307, { location: destination }).end(); });
    await assert.rejects(rpc(source, 'local_test')); assert.equal(reached, false);
    installLocalFetch(); await assert.rejects(dependencyRPC(source, 'dependency_test')); assert.equal(reached, false);
  } finally { globalThis.fetch = originalFetch; for (const s of servers) { s.closeAllConnections(); await new Promise(r => s.close(r)); } }
});

