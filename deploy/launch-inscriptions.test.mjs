import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launchInscriptionTexts } from './launch-inscriptions.mjs';
import { authority as signAuthority } from '../local/protocol.mjs';

test('launch bundle has only the privilege authority and explicit self-send activation', async () => {
  const authority = signAuthority(Buffer.alloc(32, 42), { privilege: true, auth: { name: 'dmw' }, salt: 'ab'.repeat(32) });
  const rows = await launchInscriptionTexts({ authority, receiver: 'bcrt1pfixtureowneraddress' });
  assert.equal(rows.length, 1); assert.equal(rows[0].label, 'privilege-authority');
  assert.deepEqual(JSON.parse(rows[0].inscriptionText), authority);
  assert.match(rows[0].activation, /same address/);
  const doc = await readFile(new URL('./LAUNCH-INSCRIPTIONS.md', import.meta.url), 'utf8');
  assert.match(doc, /periodic table starts empty/); assert.match(doc, /same address/);
  await assert.rejects(launchInscriptionTexts({ authority: 'PLACEHOLDER' }), /authority_content/);
});
