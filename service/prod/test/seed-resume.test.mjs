import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BitcoinViews } from '../bitcoin.mjs';
import { parseHeader, REGTEST_PARAMS } from '../../../contract/beacon/bitcoin.js';
import { mine, chain } from '../../../contract/tests/helpers/chain.mjs';
import { temporary } from './helpers.mjs';

const mainnet = Buffer.from((await readFile(new URL('../../../kit/test/fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex');
const heights = spy => spy.mock.calls.map(call => call.arguments[1]);
const range = (start, end) => Array.from({ length: end - start }, (_, i) => start + i);
async function setup(t, bytes = mainnet, client = {}) {
  let views;
  const root = await temporary(t, () => views?.close()), file = join(root, 'headers.bin');
  await writeFile(file, bytes, { mode: 0o600 });
  const reopen = () => {
    views?.close(); views = new BitcoinViews(client, join(root, 'headers.sqlite'));
    return { views, spy: t.mock.method(views, 'insert') };
  };
  return { file, reopen, ...reopen() };
}

test('empty seed validates every real mainnet header; reopening an unchanged file validates none', async t => {
  assert.equal(mainnet.length, 64 * 80);
  const f = await setup(t);
  await f.views.seed(f.file); assert.deepEqual(heights(f.spy), range(0, 64));
  const { views, spy } = f.reopen(); await views.seed(f.file);
  assert.deepEqual(heights(spy), []);
  assert.deepEqual(views.seedWork, { bytes: 0, headers: 0, reused: true });
  const tip = parseHeader(mainnet.subarray(63 * 80).toString('hex')).hash;
  assert.equal((await views.view(63, tip)).hashAt(63), tip);
});

test('seed validates only appended records after reopening the private store', async t => {
  const f = await setup(t, mainnet.subarray(0, 32 * 80)); await f.views.seed(f.file);
  await appendFile(f.file, mainnet.subarray(32 * 80));
  const { views, spy } = f.reopen(); await views.seed(f.file);
  assert.deepEqual(heights(spy), range(32, 64));
  assert.equal(views.db.prepare('SELECT COUNT(*) AS n FROM headers').get().n, 64);
});

test('a shorter matching file reuses its entire prefix and leaves validated descendants available', async t => {
  const f = await setup(t); await f.views.seed(f.file);
  await writeFile(f.file, mainnet.subarray(0, 20 * 80));
  const { views, spy } = f.reopen(); await views.seed(f.file);
  assert.deepEqual(heights(spy), []);
  await writeFile(f.file, mainnet); await views.seed(f.file);
  assert.deepEqual(heights(spy), []);
  assert.equal(views.db.prepare('SELECT COUNT(*) AS n FROM headers').get().n, 64);
});

test('a replaced interior record is validated even when the final file header still matches the store', async t => {
  const f = await setup(t); await f.views.seed(f.file);
  const changed = Buffer.from(mainnet);
  mainnet.copy(changed, 20 * 80, 21 * 80, 22 * 80);
  await writeFile(f.file, changed);
  const { views, spy } = f.reopen();
  await assert.rejects(views.seed(f.file), /bitcoin_link/);
  assert.deepEqual(heights(spy), [20]);
});

test('corruption beyond the resume point is rejected and rolled-back records are validated on retry', async t => {
  const f = await setup(t, mainnet.subarray(0, 32 * 80)); await f.views.seed(f.file);
  const changed = Buffer.from(mainnet); changed[40 * 80 + 76] ^= 1;
  await writeFile(f.file, changed);
  const { views, spy } = f.reopen();
  await assert.rejects(views.seed(f.file), /bitcoin_pow/);
  assert.deepEqual(heights(spy), range(32, 41));
  assert.equal(views.db.prepare('SELECT COUNT(*) AS n FROM headers').get().n, 32);
  spy.mock.resetCalls(); await writeFile(f.file, mainnet); await views.seed(f.file);
  assert.deepEqual(heights(spy), range(32, 64));
});

test('a valid replacement branch resumes at its first difference and preserves the old branch', async t => {
  const genesis = mine('00'.repeat(32), 1000), first = parseHeader(genesis);
  const prefix = [genesis, ...chain(20, first)], fork = parseHeader(prefix.at(-1));
  const old = chain(10, fork), replacement = chain(12, fork, 600, 1);
  const f = await setup(t, Buffer.from([...prefix, ...old].join(''), 'hex'), { params: REGTEST_PARAMS, genesis: first.hash });
  await f.views.seed(f.file);
  await writeFile(f.file, Buffer.from([...prefix, ...replacement].join(''), 'hex'));
  const { views, spy } = f.reopen(); await views.seed(f.file);
  assert.deepEqual(heights(spy), range(21, 33));
  assert.equal((await views.view(30, parseHeader(old.at(-1)).hash)).raw(30), old.at(-1));
  assert.equal((await views.view(32, parseHeader(replacement.at(-1)).hash)).raw(32), replacement.at(-1));
});

test('resume rejects a splice between two already validated branches at the same height', async t => {
  const genesis = mine('00'.repeat(32), 1000), first = parseHeader(genesis);
  const original = [genesis, ...chain(10, first)], replacement = [genesis, ...chain(10, first, 600, 1)];
  const f = await setup(t, Buffer.from(original.join(''), 'hex'), { params: REGTEST_PARAMS, genesis: first.hash });
  await f.views.seed(f.file);
  await writeFile(f.file, Buffer.from(replacement.join(''), 'hex')); await f.views.seed(f.file);
  await writeFile(f.file, Buffer.from([...original.slice(0, 5), ...replacement.slice(5)].join(''), 'hex'));
  const { views, spy } = f.reopen(); await assert.rejects(views.seed(f.file), /bitcoin_link/);
  assert.deepEqual(heights(spy), [5]);
});

test('empty and partial seed files retain their rejection semantics after resume', async t => {
  const f = await setup(t, Buffer.alloc(0));
  await assert.rejects(f.views.seed(f.file), /bitcoin_seed/); assert.equal(f.spy.mock.callCount(), 0);
  await writeFile(f.file, mainnet); await f.views.seed(f.file);
  const { views, spy } = f.reopen(); await appendFile(f.file, Buffer.from([0]));
  await assert.rejects(views.seed(f.file), /bitcoin_seed/); assert.deepEqual(heights(spy), []);
});
