import test from 'node:test';
import assert from 'node:assert/strict';
import { Files } from '../src/files.mjs';
import { serve } from '../src/http.mjs';
import { temp } from './helpers.mjs';
test('static files have deliberate cache headers, conditional hits, immutable conflict detection, and feed limits', async () => {
  const files = new Files(await temp()); await files.immutable('blocks/1.bin', Buffer.from('audit')); await files.json('latest.json', { real: [] });
  const http = await serve({ files, intake: {} });
  try {
    const response = await fetch(http.url + '/blocks/1.bin'); assert.equal(await response.text(), 'audit'); assert.match(response.headers.get('cache-control'), /immutable/);
    assert.equal((await fetch(http.url + '/blocks/1.bin', { headers: { 'if-none-match': response.headers.get('etag') } })).status, 304);
    assert.match((await fetch(http.url + '/latest.json')).headers.get('cache-control'), /max-age=1/);
    await assert.rejects(files.immutable('blocks/1.bin', Buffer.from('changed')), /immutable_conflict/);
    await assert.rejects(files.json('latest.json', { huge: 'a'.repeat(60000) }), /feed_budget/);
    assert.throws(() => files.path('../private'), /file_name/);
  } finally { await http.close(); }
});
