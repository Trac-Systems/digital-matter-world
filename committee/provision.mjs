import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { canonicalJSON, sha256, check } from './signer/crypto.mjs';
import { encodeTracAddress } from '../rules/src/trac-address.js';
const hex = b => Buffer.from(b).toString('hex');
const privateJSON = async (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
async function saveOnce(path, value) {
  try { await privateJSON(path,value); }
  catch(error) {
    if(error.code!=='EEXIST')throw error;
    const existing=await (await import('../deploy/target.mjs')).privateJSON(path);
    check(canonicalJSON(existing)===canonicalJSON(value),'operator_existing_config_mismatch');
  }
}

// Run once as each operator's Unix user (the host may be shared). Only its public descriptor leaves this
// directory; the coordinator does not generate or distribute operator secrets.
export async function provisionOperator({ directory, id, url, network }) {
  check(/^[a-zA-Z0-9._:-]{1,96}$/.test(id) && /^[a-zA-Z0-9._:-]{1,96}$/.test(network), 'operator_domain');
  const u=new URL(url);check(!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&(u.protocol==='http:'&&u.hostname==='127.0.0.1'||u.protocol==='https:'&&/^[a-zA-Z0-9.-]+\.[a-zA-Z]+$/.test(u.hostname)&&!/(^|\.)localhost$|\.local$/.test(u.hostname)), 'operator_transport');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await (await import('../service/prod/config.mjs')).privatePath(directory,{directory:true});
  const identity = randomBytes(32), encryption = randomBytes(32);
  try {
    const member = { id, url, identity: hex(ed25519.getPublicKey(identity)), encryption: hex(x25519.getPublicKey(encryption)) };
    await privateJSON(join(directory, 'credentials.json'), { identity: hex(identity), encryption: hex(encryption), token: hex(randomBytes(32)), passphrase: hex(randomBytes(32)) });
    await privateJSON(join(directory, 'operator-public.json'), { network, ...member, address: encodeTracAddress(member.identity) });
    return member;
  } finally { identity.fill(0); encryption.fill(0); }
}
export const rosterHash = members => sha256(canonicalJSON(members.map(({ id, identity, encryption }) => ({ id, identity, encryption }))));
export function verifyBootstrapAttestation(answer, {target,member,challenge}) {
  const {signature,...body}=answer;
  check(body.domain==='dmw-bootstrap-attestation-v1' && body.challenge===challenge && body.network===target.network && body.epoch===target.committee.epoch && body.id===member.id && body.publicKey===target.committee.publicKey && body.roster===rosterHash(target.committee.members),'bootstrap_attestation_binding');
  check(ed25519.verify(Buffer.from(signature,'hex'),Buffer.from(canonicalJSON(body)),Buffer.from(member.identity,'hex')),'bootstrap_attestation_signature');
}
export function operatorAttestation(config, secret, publicKey, challenge) {
  check(/^[0-9a-f]{64}$/.test(challenge), 'attestation_challenge');
  const body = { domain: 'dmw-operator-attestation-v1', challenge, network: config.network, epoch: config.epoch,
    id: config.id, publicKey, roster: rosterHash(config.members), address: encodeTracAddress(hex(ed25519.getPublicKey(Buffer.from(secret, 'hex')))) };
  return { ...body, signature: hex(ed25519.sign(Buffer.from(canonicalJSON(body)), Buffer.from(secret, 'hex'))) };
}
export function verifyOperatorAttestation(answer, { target, member, challenge }) {
  const { signature, ...body } = answer;
  check(body.domain === 'dmw-operator-attestation-v1' && body.challenge === challenge && body.network === target.network && body.epoch === target.committee.epoch && body.id === member.id && body.publicKey === target.committee.publicKey && body.roster === rosterHash(target.committee.members) && body.address === encodeTracAddress(member.identity), 'operator_attestation_binding');
  check(ed25519.verify(signature, Buffer.from(canonicalJSON(body)), member.identity), 'operator_attestation_signature');
  return body;
}

// This stage needs only the roster and the operator's own files. It can run
// before DKG, Trac registration, registry provisioning or escrow deployment.
export async function configureOperator(target, id, directory) {
  const { endpoint, privateJSON: readPrivate } = await import('../deploy/target.mjs');
  const { endpoint: remoteEndpoint } = await import('../service/prod/config.mjs');
  await (await import('../service/prod/config.mjs')).privatePath(directory,{directory:true});
  const member = target.committee.members.find(m => m.id === id); check(member, 'operator_not_in_target');
  const own = await readPrivate(join(directory, 'credentials.json'));
  check(hex(ed25519.getPublicKey(Buffer.from(own.identity, 'hex'))) === member.identity && hex(x25519.getPublicKey(Buffer.from(own.encryption, 'hex'))) === member.encryption, 'operator_key_pin');
  const ep = target.mode === 'mainnet' ? remoteEndpoint : endpoint;
  const peers = await Promise.all(target.committee.members.map(async m => ({ id: m.id, identity: m.identity, encryption: m.encryption, url: (await ep({...m.sidecar,authFile:'',tokenFile:''})).url })));
  const ownRead = await readPrivate(target.runtime.signerReads[target.committee.members.indexOf(member)]);
  check(ownRead.readerId === id && ownRead.listen && /^127\.0\.0\.1:[0-9]+$/.test(ownRead.listen) && /^127\.0\.0\.1:[0-9]+$/.test(ownRead.sidecarListen), 'operator_listener');
  await saveOnce(join(directory, 'sidecar.json'), { id, network: target.network, epoch: target.committee.epoch, listen: ownRead.sidecarListen, directory,
    secrets: join(directory, 'credentials.json'), peers });
  return {member,ownRead,peers};
}

export async function bindOperator(target, id, directory) {
  const { secret, privateJSON: readPrivate } = await import('../deploy/target.mjs');
  const { renderTargetRuntime } = await import('../deploy/runtime.mjs');
  const {member,ownRead,peers}=await configureOperator(target,id,directory),own=await readPrivate(join(directory,'credentials.json'));
  let signerSecrets;
  try { await lstat(join(directory,'signer-credentials.json')); signerSecrets=await readPrivate(join(directory,'signer-credentials.json')); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  signerSecrets ??= { identity: own.identity, encryption: own.encryption, sidecarToken: own.token,
    apiToken: await secret(member.signer.tokenFile), passphrase: hex(randomBytes(32)), journalKey: hex(randomBytes(32)) };
  check(signerSecrets.identity===own.identity && signerSecrets.encryption===own.encryption && signerSecrets.sidecarToken===own.token && signerSecrets.apiToken===await secret(member.signer.tokenFile),'operator_signer_credentials');
  const readConfig = join(directory, 'reads.json');
  const rendered=await renderTargetRuntime(target, { signer: target.committee.members.indexOf(member), filename: readConfig,persist:false });
  const gateway = target.public.gatewayKey;
  const config = { id, network: target.network, epoch: target.committee.epoch, publicKey: target.committee.publicKey, gateway,
    directory, listen: ownRead.listen, sidecar: 'http://' + ownRead.sidecarListen, secrets: join(directory, 'signer-credentials.json'), members: peers,
    escrow: { address: target.ethereum.escrowAddress, token: target.ethereum.tokenAddress, chainId: target.ethereum.chainId },
    readModule: resolve(new URL('../service/prod/reads.mjs', import.meta.url).pathname), readOptions: { config: readConfig, readerId: id } };
  await saveOnce(join(directory,'signer-credentials.json'),signerSecrets);
  await (await import('../deploy/runtime.mjs')).saveRuntime(readConfig,rendered);
  await saveOnce(join(directory, 'signer.json'), config); return { id, address: encodeTracAddress(member.identity), roster: rosterHash(peers) };
}
