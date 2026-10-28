import { readFile } from 'node:fs/promises';
import { ed25519 } from '@noble/curves/ed25519';
import { canonicalJSON, check, sha256 } from './signer/crypto.mjs';
import { atomicWrite } from '../service/src/util.mjs';
import { post } from '../service/src/committee.mjs';
import { compareOrdinal } from '../rules/src/integers-v2.js';

export const rosterId = members => sha256(canonicalJSON(members));
export function validateRoster(members) {
  check(Array.isArray(members) && members.length === 5 && new Set(members.map(m => m.id)).size === 5 && new Set(members.map(m => m.identity)).size === 5 &&
    members.every(m => /^[0-9a-f]{64}$/.test(m.identity)), 'committee_roster'); return members;
}
export function rotationBody(network, before, after, publicKey) {
  validateRoster(before); validateRoster(after);
  check(before.filter(a => after.some(b => canonicalJSON(a) === canonicalJSON(b))).length === 4, 'rotation_replace_one');
  return { domain: 'dmw-roster-rotation-v1', network, before: rosterId(before), after: rosterId(after), publicKey, members: after };
}
export function attestRotation(body, signer, secret) {
  return { signer, sig: Buffer.from(ed25519.sign(Buffer.from(canonicalJSON(body)), Buffer.from(secret, 'hex'))).toString('hex') };
}
export function verifyRotation(body, votes, members) {
  check(Array.isArray(votes) && votes.length >= 3 && new Set(votes.map(v => v.signer)).size === votes.length, 'rotation_quorum');
  for (const v of votes) { const m = members.find(m => m.id === v.signer); check(m && ed25519.verify(v.sig, Buffer.from(canonicalJSON(body)), m.identity, { zip215: false }), 'rotation_attestation'); }
}
// A replacement must already hold a working threshold share for the same key.
// This changes service membership, not the contract's threshold key/epoch.
export async function rotateRoster(filename, { replace, replacement, dryRun = true }) {
  const config = JSON.parse(await readFile(filename, 'utf8')), before = config.committee.map(s => s.peer);
  check(config.committee.some(s => s.id === replace) && replacement?.id === replacement?.peer?.id, 'rotation_member');
  const clients = config.committee.map(s => s.id === replace ? replacement : s), after = clients.map(s => s.peer);
  const resources = config.v2?.resources?.values ?? config.resources?.values;
  const request = (s, path, value, timeout) => post(s, path, value, timeout ?? resources?.committeeRequestMs, resources?.committeeResponseBytes);
  const statuses = await Promise.all(clients.map(s => request(s, '/health', {}, resources?.committeeHealthMs)));
  const publicKey = statuses[0].publicKey;
  check(statuses.every((s, i) => s.id === clients[i].id && s.network === config.network && s.publicKey === publicKey && compareOrdinal(s.epoch, config.epoch ?? 1) === 0), 'rotation_share_continuity');
  const body = rotationBody(config.network, before, after, publicKey);
  if (dryRun) return { dryRun, body, healthy: statuses.length };
  const replies = await Promise.allSettled(config.committee.map(s => request(s, '/attest-roster', body)));
  const votes = replies.filter(r => r.status === 'fulfilled').map(r => r.value); verifyRotation(body, votes, before);
  const history = config.rosterHistory ?? [];
  for (const members of [before, after]) if (!history.some(r => rosterId(r.members) === rosterId(members))) history.push({ id: rosterId(members), members });
  const transition = { body, votes, at: Date.now() };
  // Persist the complete public trust history before changing the active list.
  const next = { ...config, committee: clients, rosterHistory: history, rosterTransitions: [...(config.rosterTransitions ?? []), transition] };
  await atomicWrite(filename, JSON.stringify(next));
  return { dryRun: false, ...transition, restartRequired: true };
}
