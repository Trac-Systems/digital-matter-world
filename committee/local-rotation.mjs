import { readFile } from 'node:fs/promises';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ceremony, descriptor, rpc, loadGroup } from './tss.mjs';
import { rotationBody, rosterId, verifyRotation } from './rosters.mjs';
import { post } from '../service/src/committee.mjs';
import { atomicWrite, check, hash } from '../service/src/util.mjs';

// Receipt/custody membership changes by one. TSS uses its existing disjoint
// five-to-five resharing protocol to refresh all shares under the same key.
// This avoids overlapping-party resharing, which the pinned library cannot do.
export async function rotateLocalSigner(filename, { replace, replacement, dryRun = true }) {
  const config = JSON.parse(await readFile(filename, 'utf8')), plan = replacement.sharePlan;
  check(config.mode === 'regtest' && plan?.oldGroup && plan?.newGroup && plan?.signerConfigs, 'rotation_local_share_plan');
  const old = (await loadGroup(plan.oldGroup)).group, next = (await loadGroup(plan.newGroup)).group;
  const client = Object.fromEntries(Object.entries(replacement).filter(([key]) => key !== 'sharePlan'));
  const clients = config.committee.map(s => String(s.id) === String(replace) ? client : s), before = config.committee.map(s => s.peer), after = clients.map(s => s.peer);
  const states = await Promise.all(old.map(s => rpc(s.url, s.token, '/status'))), publicKey = states[0].public;
  check(publicKey && states.every(s => s.public === publicKey && !s.retired && s.epoch === states[0].epoch), 'rotation_old_shares');
  check(next.length === 5 && next.every(n => !old.some(o => o.id === n.id)), 'rotation_new_shares');
  const body = rotationBody(config.network, before, after, publicKey), targets = [];
  for (let i = 0; i < clients.length; i++) {
    const path = plan.signerConfigs[String(clients[i].id)]; check(typeof path === 'string', 'rotation_signer_config');
    const signer = JSON.parse(await readFile(path, 'utf8')); check(signer.id === clients[i].id && signer.network === config.network, 'rotation_signer_identity');
    targets.push({ path, signer, secret: JSON.parse(await readFile(signer.secrets, 'utf8')), sidecar: next[i] });
  }
  if (dryRun) return { dryRun, body, healthy: states.length, refreshedShares: 5, contractEpoch: config.epoch, shareEpoch: states[0].epoch + 1 };
  const responses = await Promise.allSettled(config.committee.map(s => post(s, '/attest-roster', body)));
  const votes = responses.filter(r => r.status === 'fulfilled').map(r => r.value); verifyRotation(body, votes, before);
  const record = { body, votes, at: Date.now(), shareEpoch: states[0].epoch + 1, state: 'resharing' };
  await atomicWrite(filename + '.rotation.json', JSON.stringify(record));
  const reshared = await ceremony(old, 'reshare', { network: config.network, epoch: record.shareEpoch, newGroup: next });
  check(reshared.publicKey === publicKey, 'rotation_key_changed');
  const replacedIndex = config.committee.findIndex(s => String(s.id) === String(replace));
  const quorum = [next[replacedIndex], ...next.filter((_, i) => i !== replacedIndex).slice(0, 2)];
  const digest = hash(JSON.stringify(body)), proof = await ceremony(quorum, 'sign', { network: config.network, epoch: record.shareEpoch, digest });
  check(secp256k1.verify(proof.compact, digest, publicKey, { prehash: false }), 'rotation_continuity');
  const history = [...(config.rosterHistory ?? [])];
  for (const members of [before, after]) if (!history.some(r => r.id === rosterId(members))) history.push({ id: rosterId(members), members });
  const thresholdMembers = clients.map((s, i) => ({ signer: s.id, peer: descriptor(next[i]) }));
  for (const t of targets) {
    await atomicWrite(t.signer.secrets, JSON.stringify({ ...t.secret, sidecarToken: t.sidecar.token }));
    await atomicWrite(t.path, JSON.stringify({ ...t.signer, sidecar: t.sidecar.url, tssEpoch: record.shareEpoch, thresholdMembers, members: after, rosterHistory: history }));
  }
  const transition = { ...record, state: 'configured', continuity: { digest, signature: proof }, shareDecision: reshared.certificate };
  await atomicWrite(filename, JSON.stringify({ ...config, committee: clients, rosterHistory: history, rosterTransitions: [...(config.rosterTransitions ?? []), transition] }));
  await atomicWrite(filename + '.rotation.json', JSON.stringify(transition));
  return { dryRun: false, body, votes, refreshedShares: 5, shareEpoch: record.shareEpoch, restartRequired: true };
}
