import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { Journal } from '../signer/journal.mjs';
import { hex, sha256, seal, unseal } from '../signer/crypto.mjs';
import { buildRoot } from '../tss.mjs';
await mkdir(buildRoot, { recursive: true, mode: 0o700 });

test('journal survives restart, rejects conflicting slots and refuses to re-sign identical permits', async () => {
  const dir = await mkdtemp(resolve(buildRoot, 'journal-')), path = resolve(dir, 'signed.log');
  const key = randomBytes(32), journal = await new Journal(path, key, 'local', 'one').load();
  await journal.reserve(['mint/request/1', 'mint/block/p0/1'], sha256('one'), sha256('session'));
  await assert.rejects(journal.reserve(['mint/request/1'], sha256('other'), sha256('other')), /slot_conflict/);
  await assert.rejects(journal.reserve(['mint/request/1'], sha256('one'), sha256('retry')), /slot_already_reserved/);
  await journal.close();
  const resumed = await new Journal(path, key, 'local', 'one').load(); assert.equal(resumed.slots.size, 2); await resumed.close();
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const body = await readFile(path, 'utf8'); await writeFile(path, body.replace(sha256('one'), sha256('forged')));
  await assert.rejects(new Journal(path, key, 'local', 'one').load(), /journal_integrity/);
});
test('journal rejects a torn final write, wrong network and wrong authentication key', async () => {
  const dir = await mkdtemp(resolve(buildRoot, 'journal-')), path = resolve(dir, 'signed.log'), key = randomBytes(32);
  const journal = await new Journal(path, key, 'local', 'one').load(); await journal.append('test', { value: 'one' }); await journal.close();
  await assert.rejects(new Journal(path, key, 'other', 'one').load(), /journal_integrity/);
  await assert.rejects(new Journal(path, randomBytes(32), 'local', 'one').load(), /journal_integrity/);
  const body = await readFile(path, 'utf8'); await writeFile(path, body.slice(0, -1));
  await assert.rejects(new Journal(path, key, 'local', 'one').load(), /journal_truncated/);
});
test('encrypted storage binds passphrase, signer, network and ciphertext integrity', () => {
  const secret = randomBytes(32), passphrase = hex(randomBytes(32)), context = 'dmw-share-v1|local|one';
  const box = seal(passphrase, secret, context); assert.deepEqual(unseal(passphrase, box, context), secret);
  assert.throws(() => unseal('wrong', box, context)); assert.throws(() => unseal(passphrase, box, context + 'other'));
  const tampered = { ...box, data: (box.data.startsWith('00') ? '01' : '00') + box.data.slice(2) }; assert.throws(() => unseal(passphrase, tampered, context));
});
