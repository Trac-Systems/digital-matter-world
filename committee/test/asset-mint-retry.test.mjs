import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../signer/journal.mjs';
import { sha256 } from '../signer/crypto.mjs';

test('fresh mint attempts retain the exact commitment, all slots and original evidence across restart', async t => {
  const path = join(await mkdtemp(join(tmpdir(), 'r4-mint-')), 'journal');
  let journal = await new Journal(path, 'disposable-test', 'local', 's1').load(); t.after(() => journal.close());
  const slots = ['mint/request/1', 'mint/block/p0/1'], digest = sha256('permit'), details = { id: '1', permit: { digest }, request: { amount: '3' } };
  await journal.reserve(slots, digest, sha256('first'), details);
  await assert.rejects(journal.reserve(slots, digest, sha256('second'), details), /slot_already_reserved/);
  await assert.rejects(journal.retryMint(slots, sha256('different'), sha256('second')), /mint_retry_binding/);
  await assert.rejects(journal.retryMint(slots.slice(0, 1), digest, sha256('second')), /mint_retry_binding/);
  await journal.retryMint(slots, digest, sha256('second'));
  assert.deepEqual(journal.slots.get(slots[0]).details, details);
  await journal.close(); journal = await new Journal(path, 'disposable-test', 'local', 's1').load();
  assert.equal(journal.slots.get(slots[0]).session, sha256('second'));
  assert.equal(journal.records.filter(r => r.type === 'reserve').length, 2);
  await assert.rejects(journal.retryMint(slots, digest, sha256('first')), /ceremony_reused/);
  await journal.append('signed', { session: sha256('second'), digest, signature: 'durable-result' });
  await assert.rejects(journal.retryMint(slots, digest, sha256('third')), /permit_result_available/);
});
