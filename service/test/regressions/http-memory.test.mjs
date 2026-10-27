import test from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { createServer } from 'node:http';
import { setImmediate as turn } from 'node:timers/promises';
import { installLocalFetch, jsonRequest } from '../../src/http-client.mjs';

test('completed JSON requests release deadlines instead of retaining a timeout per RPC', async () => {
  const upstream = globalThis.fetch, timers = new Set();
  const hook = createHook({ init(id, type, trigger, resource) { if (type === 'Timeout' && [30000, 45000].includes(resource._idleTimeout)) timers.add(id); }, destroy(id) { timers.delete(id); } }).enable();
  const server = createServer((req, res) => { res.end('{"ok":true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    installLocalFetch(); const url = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 200; i++) {
      assert.equal((await jsonRequest(url)).value.ok, true);
      assert.equal((await (await fetch(url)).json()).ok, true);
    }
    await turn(); await turn();
    assert.ok(timers.size < 5, `completed requests retained ${timers.size} deadline timers`);
  } finally { hook.disable(); globalThis.fetch = upstream; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('JSON limits, parse failures, upstream aborts and stalled bodies all clean up', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/stall') { res.writeHead(200); res.write('{'); }
    else res.end(req.url === '/bad' ? '{bad' : '{"message":"too large"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(jsonRequest(url, { maxBytes: 4 }), /response_limit/);
    await assert.rejects(jsonRequest(url + '/bad'), SyntaxError);
    await assert.rejects(jsonRequest(url + '/stall', { timeout: 25 }), /timed out/);
    const controller = new AbortController(); controller.abort(Error('caller_cancelled'));
    await assert.rejects(jsonRequest(url, { signal: controller.signal }), /caller_cancelled/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('the global fetch guard bounds streamed bodies and releases cancelled and empty responses', async () => {
  const upstream = globalThis.fetch;
  const server = createServer((req, res) => {
    if (req.url === '/empty') { res.writeHead(204); res.end(); }
    else if (req.url === '/large') res.end('x'.repeat(4_000_001));
    else { res.writeHead(200); res.write('partial'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    installLocalFetch();
    assert.equal((await fetch(url + '/empty')).body, null);
    await assert.rejects((await fetch(url + '/large')).arrayBuffer(), /response_limit/);
    const controller = new AbortController(), response = await fetch(url, { signal: controller.signal });
    const body = response.text(); controller.abort(Error('caller_cancelled'));
    await assert.rejects(body, /caller_cancelled/);
    await (await fetch(url)).body.cancel();
  } finally { globalThis.fetch = upstream; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
