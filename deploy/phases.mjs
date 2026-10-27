import { createGroup, loadGroup, ceremony } from '../committee/tss.mjs';
import { committeeAddress, abiWord, calldata } from '../committee/signer/escrow.mjs';
import { rules } from '../service/src/rules.mjs';
import { hash, check } from '../service/src/util.mjs';
import { randomBytes } from 'node:crypto';
import { verifyRuntime } from './safety.mjs';

// Chain-specific signing, confirmation waiting and local clock acceleration are
// injected by the caller. These are the deployment phases for every caller.
export async function committeePhase({ directory, network, epoch, port, prefix, existing, start }) {
  const group = existing ? (await loadGroup(directory)).group : await createGroup(directory, { prefix, port, network, epoch });
  for (const [i, member] of group.entries()) await start(member, i);
  const decision = existing ? null : await ceremony(group, 'keygen', { network, epoch });
  return { group, publicKey: existing ?? decision.publicKey, decision };
}
export async function activationPhase({ label, payload, receiver, write, transfer, confirm }) {
  const inscription = await write(label, payload, receiver);
  await transfer(label, inscription, receiver);
  await confirm(inscription);
  return inscription;
}
export async function authorityPhase({ group, network, epoch, name, receiver, activate, prepare = fn => fn(), sign = digest => ceremony(group.slice(0, 3), 'sign', { network, epoch, digest }) }) {
  const payload = await prepare(async () => {
    const auth = { name }, salt = randomBytes(32).toString('hex'), digest = hash(JSON.stringify(auth) + salt);
    const sig = await sign(digest);
    return { p: 'tap', op: 'privilege-auth', auth, hash: digest, salt, sig: { r: sig.r, s: sig.s, v: String(sig.v) } };
  });
  return activate('privilege-authority', payload, receiver);
}
export async function escrowPhase({ artifact, token, publicKey, admin, chainId, authorityEpoch = 0, send, rpc }) {
  check(String(BigInt(await rpc('eth_chainId'))) === String(chainId), 'deployment_chain');
  const constructor = [token, committeeAddress(publicKey), admin].map(a => abiWord('address', a).toString('hex')).join('');
  const receipt = await send('escrow-deploy', admin, null, artifact.bytecode.object + constructor);
  check(receipt.status === '0x1', 'escrow_deployment');
  const escrow = { address: receipt.contractAddress, token, chainId: String(chainId) };
  const runtime = await rpc('eth_getCode', [escrow.address, 'latest']);
  verifyRuntime(artifact.deployedBytecode.object, runtime, artifact.deployedBytecode.immutableReferences);
  for (const [name, expected] of [['token', token], ['committee', committeeAddress(publicKey)], ['admin', admin]]) {
    check('0x' + (await rpc('eth_call', [{ to: escrow.address, data: calldata(name + '()', []) }, 'latest'])).slice(-40) === expected.toLowerCase(), 'escrow_authority');
  }
  check(BigInt(await rpc('eth_call', [{ to: escrow.address, data: calldata('committeeEpoch()', []) }, 'latest'])) === BigInt(authorityEpoch), 'escrow_epoch');
  check(BigInt(await rpc('eth_call', [{ to: token, data: calldata('decimals()', []) }, 'latest'])) === 18n, 'token_decimals');
  return { escrow, constructor, receipt, runtime };
}
export async function checkpointPhase({ height, primary, witness, confirmations = 1 }) {
  check(Number.isSafeInteger(height) && height >= 0 && height % 2016 === 0, 'checkpoint_boundary');
  const read = async rpc => {
    const tip = await rpc('getblockcount'); check(tip - height + 1 >= confirmations && tip - height < 2016, 'checkpoint_freshness');
    const blockHash = await rpc('getblockhash', [height]), raw = await rpc('getblockheader', [blockHash, false]);
    const info = await rpc('getblockheader', [blockHash, true]), parsed = rules.parseHeader(raw, height), times = [];
    check(parsed.hash === blockHash && BigInt('0x' + blockHash) <= rules.targetFromBits(parsed.bits), 'checkpoint_header');
    for (let h = Math.max(0, height - 10); h <= height; h++) times.push((await rpc('getblockheader', [await rpc('getblockhash', [h]), true])).time);
    return { raw, checkpoint: { height, hash: blockHash, bits: parsed.bits, time: parsed.time, chainwork: BigInt('0x' + info.chainwork).toString(), times } };
  };
  const a = await read(primary);
  if (!witness) return a;
  const b = await read(witness);
  check(rules.stableJSON(a) === rules.stableJSON(b), 'checkpoint_disagreement'); return a;
}
