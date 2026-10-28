import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import { sealReceiptSegment, attestReceiptSegment, verifySegmentAttestations } from '../src/receipt-segments.js';

const gw = randomBytes(32), members = [1, 2, 3, 4, 5].map(n => { const secret = randomBytes(32); return { id: 'operator' + n, identity: bytesToHex(ed25519.getPublicKey(secret)), secret }; });
const context = { network: 'dmw-mainnet', tip: '100', hash: 'ab'.repeat(32), segment: '0', previous: null, ruleset: 'dmw-v2', settingsRevision: '0', settingsHash: 'cd'.repeat(32) };

test('an empty receipt segment can be witnessed after downtime; a non-empty one cannot', () => {
  const empty = sealReceiptSegment([], context, gw);
  const late = members.slice(0, 3).map(m => attestReceiptSegment(empty, '113', m.id, m.secret));
  assert.equal(verifySegmentAttestations(empty, late, members.map(({ id, identity }) => ({ id, identity }))), true);
  assert.throws(() => attestReceiptSegment(empty, '99', members[0].id, members[0].secret), /receipt_attestation_late/);
  const full = { ...empty, count: 1 };
  assert.throws(() => attestReceiptSegment(full, '113', members[0].id, members[0].secret), /receipt_attestation_late/);
  assert.equal(attestReceiptSegment(full, '101', members[0].id, members[0].secret).observedTip, '101');
});
