import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readTapSourceURL } from '../../src/source-url.mjs';
import { readSecret, productionURL } from '../config.mjs';
import { createBitcoin } from '../bitcoin.mjs';
import { HttpSource } from '../http.mjs';
import { temporary } from './helpers.mjs';

test('source reader accepts owned 0600 files and exact service-owned read-only systemd copies', async t => {
  const root = await temporary(t), file = join(root, 'tap-source.url'), credentials = join(root, 'credentials');
  await writeFile(file, 'http://source.invalid:59751\n', { mode: 0o600 });
  assert.equal(await readTapSourceURL(file), 'http://source.invalid:59751');
  await mkdir(credentials, { mode: 0o700 }); const copy = join(credentials, 'tap-source.url');
  await writeFile(copy, 'http://source.invalid:59751', { mode: 0o400 });
  await chmod(credentials, 0o500);
  assert.equal(await readTapSourceURL('/etc/dmw/private/tap-source.url', { rootOwned: true, credentialsDirectory: credentials }), 'http://source.invalid:59751');
  await assert.rejects(readTapSourceURL(copy), /tap_source_file_required/);
  await assert.rejects(readSecret(copy), /private_permissions/);
  assert.throws(() => productionURL('http://source.invalid:59751'), /endpoint_transport/);
  await chmod(copy, 0o600);
  await assert.rejects(readTapSourceURL(file, { credentialsDirectory: credentials }), /tap_source_file_required/);
  await chmod(credentials, 0o700);
});
test('credential names, symlinks, directory permissions, file modes and URL syntax fail without exposing contents', async t => {
  const root = await temporary(t), file = join(root, 'source.url');
  const invalid = ['https://source.invalid/path', 'http://source.invalid?key=secret', 'https://name:secret@source.invalid', 'http://source.invalid/#x', 'ftp://source.invalid', 'http:source.invalid', 'http://source.invalid/\nheader'];
  for (const value of invalid) { await writeFile(file, value, { mode: 0o600 }); await assert.rejects(readTapSourceURL(file), e => e.message === 'tap_source_file_required' && !JSON.stringify(e).includes('source.invalid')); }
  await writeFile(file, 'http://source.invalid'); await chmod(file, 0o644); await assert.rejects(readTapSourceURL(file)); await chmod(file, 0o600);
  await symlink(file, join(root, 'alias')); await assert.rejects(readTapSourceURL(join(root, 'alias')));
  for (const credentialName of ['../source.url', '/source.url', '.', '..']) await assert.rejects(readTapSourceURL(file, { credentialsDirectory: root, credentialName }));
  await chmod(root, 0o777); await assert.rejects(readTapSourceURL(file, { credentialsDirectory: root })); await chmod(root, 0o700);
});
test('the explicit ord origin is pinned through the local fetch guard; transport rejects redirects and strips errors', async t => {
  const root = await temporary(t), file = join(root, 'source.url'); await writeFile(file, 'http://source.invalid:59751', { mode: 0o600 });
  const original = globalThis.fetch, paths = [];
  const unguarded = async (url, options) => { paths.push(new URL(url)); assert.equal(options.redirect, 'error'); throw Error('private upstream diagnostic'); };
  const guarded = () => { throw Error('must_not_use_general_loopback_guard'); }; guarded[Symbol.for('dmw.localFetch')] = unguarded;
  globalThis.fetch = guarded; t.after(() => { globalThis.fetch = original; });
  await assert.rejects(createBitcoin({ kind: 'ord' }, { retries: 0 }, { network: 'regtest' }), /bitcoin_source/);
  assert.equal(paths.length, 0, 'the client cannot silently fall back to a default source file');
  await assert.rejects(createBitcoin({ kind: 'ord', urlFile: file }, { retries: 0 }, { network: 'regtest' }), e => e.message === 'http_unavailable');
  assert.equal(paths.length, 1); assert.equal(paths[0].origin, 'http://source.invalid:59751'); assert.equal(paths[0].pathname, '/r/blockhash/0');
  const source = new HttpSource({ url: 'http://source.invalid:59751', fetchImpl: unguarded, retries: 0 });
  for (const path of ['//other.invalid', 'http://other.invalid', '/\\other.invalid']) assert.throws(() => source.request(path), /http_path/);
});
