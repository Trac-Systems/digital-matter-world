import { ed25519 } from '@noble/curves/ed25519';
import { assert, integer, exactKeys, hex, bytesToHex, hexToBytes, hash, digest, networkId, stableJSON, parseCanonical } from './core.js';
import { validateDefinition } from './patterns.js';
export const MOVE_DEFAULTS = Object.freeze({ puzzleBits: 12, freshness: 2, maxBytes: 16384 });
import { validateRequest } from './operations.js';
const nonce = n => typeof n === 'string' && /^[0-9a-f]{1,32}$/.test(n);
export function validatePayload(type, p) {
  if (type === 'header') assert(exactKeys(p, ['height', 'raw']) && integer(p.height) && hex(p.raw, 80), 'header_payload');
  else if (type === 'claim') {
    const keys = ['window', 'plots']; if (Object.hasOwn(p ?? {}, 'header')) keys.push('header');
    assert(exactKeys(p, keys) && integer(p.window) && Array.isArray(p.plots) && p.plots.length > 0 && p.plots.length <= 1000, 'claim_payload');
    assert(p.plots.every((q, i) => exactKeys(q, ['block', 'patterns']) && integer(q.block, 0xffffffff) &&
      (i === 0 || q.block > p.plots[i - 1].block) && Array.isArray(q.patterns) && q.patterns.length > 0 && q.patterns.length <= 64 &&
      q.patterns.every((n, j) => integer(n, 0xffffffff) && (j === 0 || n > q.patterns[j - 1]))), 'claim_plots');
    if (p.header) validatePayload('header', p.header);
  }
  else if (type === 'discovery-commit') {
    assert(exactKeys(p, ['commitment']) && hex(p.commitment, 32), 'discovery_commit_payload');
  } else if (type === 'discovery-reveal') {
    assert(exactKeys(p, ['proposal', 'salt']) && hex(p.salt, 32), 'discovery_reveal_payload');
    const proposal = p.proposal;
    assert(exactKeys(proposal, ['name', 'pat', 'fld', 'dt']) && /^dmw[a-z0-9]{2,29}$/.test(proposal.name), 'proposal_payload'); validateDefinition(proposal);
  } else if (type === 'craft') {
    assert(exactKeys(p, ['recipe', 'request', 'sig']) && ['fusion', 'resonance'].includes(p.recipe) && hex(p.sig, 64), 'craft_payload');
    validateRequest('xc', p.request);
  }
  else throw new Error('move_type');
}
export function validateMove(move) {
  assert(exactKeys(move, ['v', 'network', 'a', 't', 'b', 'h', 'p', 'w', 'sig']), 'move_shape');
  assert(move.v === 1 && hex(move.a, 32) && integer(move.b) && hex(move.h, 32) && nonce(move.w) && hex(move.sig, 64), 'move_fields');
  networkId(move.network); validatePayload(move.t, move.p); return move;
}
export function unsignedMove(move) { const { sig, ...body } = move; return body; }
export function puzzleHash(move) { return hash(`dmw-puzzle-v1|${stableJSON(unsignedMove(move))}`); }
export function leadingZeroBits(h) {
  let bits = 0;
  for (const c of h) { const n = parseInt(c, 16); if (!n) bits += 4; else return bits + Math.clz32(n) - 28; }
  return bits;
}
export function moveDigest(move) { return digest('dmw-move-v1', networkId(move.network), unsignedMove(move)); }
export function solveMove(body, secret, bits = 12, maxAttempts = 10000000) {
  assert(integer(bits, 32) && integer(maxAttempts) && bytesToHex(ed25519.getPublicKey(secret)) === body.a, 'puzzle_parameters');
  for (let i = 0; i < maxAttempts; i++) {
    const move = { ...body, w: i.toString(16), sig: '0'.repeat(128) };
    validateMove(move);
    if (leadingZeroBits(puzzleHash(move)) >= bits) { move.sig = bytesToHex(ed25519.sign(moveDigest(move), secret)); return move; }
  }
  throw new Error('puzzle_exhausted');
}
export function checkMove(move, { network, tip, hashAt, puzzleBits = 12, freshness = 2 }) {
  try {
    validateMove(move);
    if (move.network !== network) return 'network';
    if (move.b > tip || move.b < tip - freshness || hashAt(move.b) !== move.h) return 'stale';
    if (!integer(puzzleBits, 32) || leadingZeroBits(puzzleHash(move)) < puzzleBits) return 'puzzle';
    if (!ed25519.verify(hexToBytes(move.sig), moveDigest(move), hexToBytes(move.a), { zip215: false })) return 'signature';
    return null;
  } catch { return 'format'; }
}
export function parseMove(text, maxBytes = MOVE_DEFAULTS.maxBytes) { return validateMove(parseCanonical(text, maxBytes)); }
export const moveId = move => bytesToHex(moveDigest(move));
