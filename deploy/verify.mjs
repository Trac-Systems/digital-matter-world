import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { BUILD, validate } from './safety.mjs';
import { DEFAULT_TARGET, loadTarget, validateTarget } from './target.mjs';
import { verifyBinding } from '../rules/src/payout-bindings.mjs';
import { rules } from '../service/src/rules.mjs';
import { committeeAddress, calldata } from '../committee/signer/escrow.mjs';
const { secp256k1 } = createRequire(new URL('../committee/package.json', import.meta.url))('@noble/curves/secp256k1');
const argv = process.argv.slice(2);
assert(argv[0] && argv[1] === '--dry-run' && ['--regtest','--mainnet'].includes(argv[2]) && (argv.length===3 || argv.length===5 && argv[3]==='--target' && argv[4]), 'Usage: node deploy/verify.mjs ABSOLUTE_RUN --dry-run --regtest|--mainnet [--target FILE]');
const directory=resolve(argv[0]);assert.equal(await realpath(directory),directory);
const read=async name=>JSON.parse(await readFile(join(directory,name),'utf8'));
const sha=value=>createHash('sha256').update(value).digest('hex');
const selected=await loadTarget(argv[4]??DEFAULT_TARGET),archived=validateTarget(await read('launch-target.json'));
assert.deepEqual(selected,archived);assert.equal(selected.mode,argv[2].slice(2));
const target=selected.mode==='regtest'?validate(await read('target.json')):selected;
const r=await read('result.json'),outputs=await read('deployment-outputs.json'),checks=[];
assert.equal(r.mode,selected.mode);assert.equal(outputs.network,selected.network);assert.equal(outputs.mode,selected.mode);
assert.equal(outputs.targetSHA256,sha(JSON.stringify(archived)));
assert(r.complete && r.phases.every(p=>p.status==='passed'));
const required=selected.mode==='regtest'?['preflight','committee','bitcoin','trac','ethereum','smoke','kit']:['preflight','committee','bitcoin','trac','ethereum','config','kit'];
assert.deepEqual(r.phases.map(p=>p.name),required);
if(selected.mode==='regtest'){assert(r.processesStopped && r.cleanup.errors.length===0 && r.cleanup.processes.length>0 && r.cleanup.processes.every(p=>!p.alive));}
else {assert.equal(outputs.ethereum.chainId,selected.ethereum.chainId);assert.equal(outputs.roles.ethereumAdmin,selected.ethereum.adminAddress);assert.equal(outputs.roles.ethereumTreasury,selected.ethereum.treasuryAddress);assert.equal(outputs.roles.tapTreasury,selected.bitcoin.treasuryAddress);}
checks.push('Exact archived target, network-specific phases and deployed outputs agree');
const authority = await read('authority.json'), committee = await read('committee-public.json');
assert.equal(outputs.committee,committee.publicKey);
assert.equal(committee.ethereumAddress,committeeAddress(committee.publicKey));
assert.equal(sha(JSON.stringify(authority.auth) + authority.slt), authority.hash);
const compact = [authority.sig.r, authority.sig.s].map(n => BigInt(n).toString(16).padStart(64, '0')).join('');
assert.equal(secp256k1.Signature.fromCompact(compact).addRecoveryBit(Number(authority.sig.v)).recoverPublicKey(authority.hash).toHex(true), committee.publicKey);
checks.push('Activated TAP authority signature recovers the DKG public key');
const registry = await read('bitcoin-registry.json');
assert.equal(registry.length, outputs.assets.length);
assert.equal(new Set(registry.map(p => p.name)).size, registry.length); assert.equal(new Set(registry.map(p => p.deployment)).size, registry.length);
assert(registry.every(p => p.name.startsWith('dmw') && /^[0-9a-f]{64}i[0-9]+$/.test(p.element) && /^[0-9a-f]{64}i[0-9]+$/.test(p.deployment)));
assert.deepEqual(registry.map(p=>({asset:'p'+p.number.toString(36),element:p.element,deployment:p.deployment})),outputs.assets);
checks.push('Every declared asset has a unique deployment and an identified element');
const verification = await read('source-verification.json'), code = await readFile(join(directory, 'verification/artifact.json'));
assert.equal(sha(code), verification.artifactSHA256);
const artifact=JSON.parse(code);const {verifyRuntime}=await import('./safety.mjs');verifyRuntime(artifact.deployedBytecode.object,verification.runtime,artifact.deployedBytecode.immutableReferences);
assert.equal(sha(verification.runtime),verification.runtimeSHA256);assert.deepEqual(verification.escrow,outputs.ethereum);
assert.equal(verification.constructorArguments,[outputs.ethereum.token,committee.ethereumAddress,outputs.roles.ethereumAdmin].map(a=>a.slice(2).padStart(64,'0')).join(''));
const input = await read('verification/standard-input.json'); assert.equal(sha(input.sources['src/DmwEscrow.sol'].content), verification.source);
checks.push('Archived compiler artifact and source match deployed verification hashes');
if(selected.mode==='regtest'){
const smoke = await read('smoke-ethereum.json'), tapSmoke = await read('smoke-tap.json'), terms = await read('registry.json');
assert.equal(smoke.state, 'complete'); assert.equal(tapSmoke.state, 'complete');
const payoutBindings = await read('smoke-payout-bindings.json');
for (const [rail, mint] of [['tap', tapSmoke], ['ethereum', smoke]]) {
  const binding = verifyBinding(payoutBindings[rail], { network: target.network, bitcoinNetwork: 'regtest', members: committee.members });
  assert.equal(binding.request.rail, rail); assert.equal(mint.kind, rail);
  assert.equal(mint.feeQuote.payouts.finder, binding.id);
  assert(binding.acceptedAt <= mint.feeQuote.issuedAt);
}
assert.equal(payoutBindings.tap.request.agent, payoutBindings.ethereum.request.agent);
checks.push('Both smoke payout wallets have valid committee-accepted bindings pinned in their mint quotes');
const receipt = label => { const tx = r.ethereum.find(tx => tx.label === label); assert(tx && tx.receipt.status === '0x1'); return tx.receipt; };
const transfers = receipt => receipt.logs.filter(l => l.address.toLowerCase() === verification.escrow.token.toLowerCase() && l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef').map(l => ({ from: '0x' + l.topics[1].slice(-40), to: '0x' + l.topics[2].slice(-40), amount: BigInt(l.data).toString() }));
const deposited = transfers(receipt('smoke-deposit')), released = transfers(receipt('smoke-release'));
assert.equal(deposited.length, 1); assert.equal(deposited[0].to, verification.escrow.address); assert.equal(deposited[0].amount, smoke.price);
const treasury = Object.values(terms.assets).find(a=>a.id===smoke.deploymentId).ethereum.treasury.toLowerCase(), finder = payoutBindings.ethereum.request.address;
assert.equal(released.length, 3);
for (const [to, amount] of [[treasury, smoke.split.treasury], [finder, smoke.split.finder], ['0x' + '00'.repeat(20), smoke.split.burn]]) {
  assert(released.some(t => t.from === verification.escrow.address && t.to === to && t.amount === amount));
}
assert.equal(released.reduce((sum, t) => sum + BigInt(t.amount), 0n).toString(), smoke.price);
checks.push('Ethereum receipt logs prove exact payer deposit, treasury/finder transfers and native burn');
}
const kit = await read('agent-kit.json');
if(selected.mode==='mainnet') {
  assert.equal(committee.publicKey,selected.committee.publicKey);
  const {validatePublicTarget}=await import('./public-target.mjs');validatePublicTarget(kit);
  assert.equal(kit.gatewayKey,selected.public.gatewayKey);
  const checkpoint=await read('checkpoint.json');assert(checkpoint.independentValidation && checkpoint.checkpoint.height>0 && checkpoint.checkpoint.height%2016===0);
  const header=rules.parseHeader(checkpoint.raw,checkpoint.checkpoint.height);
  assert.equal(header.hash,checkpoint.checkpoint.hash);assert.equal(header.bits,checkpoint.checkpoint.bits);assert.equal(header.time,checkpoint.checkpoint.time);
  assert(BigInt('0x'+header.hash)<=rules.targetFromBits(header.bits) && rules.targetFromBits(header.bits)<=rules.targetFromBits(0x1d00ffff));
  assert(Array.isArray(checkpoint.checkpoint.times) && checkpoint.checkpoint.times.length===11 && checkpoint.checkpoint.times.at(-1)===header.time);
  assert.equal(new Set(checkpoint.validators).size,2);
  assert(checkpoint.observedTip-checkpoint.checkpoint.height+1>=selected.policy.confirmations && checkpoint.observedTip-checkpoint.checkpoint.height<2016);
  assert.equal(checkpoint.checkpoint.height,selected.bitcoin.checkpointHeight);
  assert.deepEqual(checkpoint.checkpoint,outputs.checkpoint);
  assert.deepEqual(kit.receiptSigners.map(({id,identity})=>({id,identity})),committee.members.map(({id,identity})=>({id,identity})));
  assert.deepEqual(kit.receiptSigners.map(({id,identity})=>({id,identity})),selected.committee.members.map(({id,identity})=>({id,identity})));
  const chain=await read('onchain-verification.json');assert.equal(chain.chainId,selected.ethereum.chainId);assert.equal(chain.escrow,outputs.ethereum.address);assert.equal(chain.runtime,verification.runtime);
  for(const [fn,address] of [['token()',outputs.ethereum.token],['admin()',outputs.roles.ethereumAdmin],['committee()',committee.ethereumAddress]])assert.equal('0x'+chain.calls[calldata(fn,[])].slice(-40),address.toLowerCase());
  assert.equal(BigInt(chain.calls[calldata('committeeEpoch()',[])]),BigInt(selected.policy.authorityEpoch));
  for(const [file,address] of [['source-public-verification.json',outputs.ethereum.address],['token-public-verification.json',outputs.ethereum.token]]){const record=await read(file);assert(record.verified && record.chainId===selected.ethereum.chainId && record.address===address && /^https:\/\//.test(record.publicURL));if(file.startsWith('source'))assert.equal(record.runtimeSHA256,verification.runtimeSHA256);}
  const admission=await read('admission.json');assert(admission.ok && admission.admitted && admission.stage==='admission' && admission.checks.length>0 && admission.checks.every(c=>c.ok));
} else {
  assert.deepEqual(Object.keys(kit).sort(),['localOnly','network','gateway','gatewayKey','receiptSigners','adapter','trac','headerSource','puzzleBits','powLimitBits','paymentOrigin'].sort());
  assert.deepEqual(kit.receiptSigners,committee.members.map(({id,identity})=>({id,identity})));
}
assert.equal(kit.network,target.network);checks.push('Public client allowlist and pinned gateway/witness identities');
await writeFile(join(directory, 'verification/checks.json'), JSON.stringify({ complete: true, checks }, null, 2) + '\n', { mode: 0o600 });
console.log(`${checks.length} offline evidence checks passed.`);
