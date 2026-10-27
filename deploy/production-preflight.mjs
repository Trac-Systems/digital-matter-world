import { publicVerification } from './public-verification.mjs';
import { randomBytes } from 'node:crypto';
import { need, privateJSON, privateBytes, secret, sha256 } from './target.mjs';
import { targetReads } from './reads.mjs';
import { checkpointPhase } from './phases.mjs';
import { validateRuntimePolicy, renderTargetRuntime } from './runtime.mjs';
import { fundingRequirements } from './costs.mjs';
import { payoutAddress } from '../rules/src/payout-bindings.mjs';
import { committeeAddress, calldata } from '../committee/signer/escrow.mjs';
import { edPublic } from '../service/src/util.mjs';
import { verifyOperatorAttestation, verifyBootstrapAttestation } from '../committee/provision.mjs';
import { createRequire } from 'node:module';
import { decodeTracAddress } from '../rules/src/trac-address.js';
import { rules } from '../service/src/rules.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ownerInputReport } from './owner-inputs.mjs';
const { secp256k1 } = createRequire(new URL('../committee/package.json', import.meta.url))('@noble/curves/secp256k1');

export async function productionPreflight(t, { stage = 'preparation', online = false, reads: suppliedReads } = {}) {
  need(['preparation', 'admission'].includes(stage), 'preflight_stage');
  const checks = [], check = async (name, fn, fix) => { try { await fn(); checks.push({ name, ok: true, detail: '' }); return true; } catch { checks.push({ name, ok: false, detail: fix }); return false; } };
  await check('Production policy and roster', () => {
    validateRuntimePolicy(t); need(t.bitcoin.chain === 'main' && t.ethereum.chainId === '1' && t.ethereum.signing === 'files', 'chain');
    for (const role of ['treasury', 'authorityHolder']) payoutAddress('tap', t.bitcoin[role + 'Address'], 'mainnet');
    for (const role of ['admin', 'treasury']) payoutAddress('ethereum', t.ethereum[role + 'Address'], 'mainnet');
  }, 'Fill the operator role addresses, distinct roster and production fee/confirmation limits.');
  await check('Gateway key pin', async () => need(edPublic(Buffer.from(await secret(t.gateway.keyFile), 'hex')) === t.public.gatewayKey, 'gateway_pin'), 'Supply the private gateway key and its independently distributed public pin.');
  await check('Sender key and Trac address proofs', async () => {
    for (const role of ['admin']) {
      const key=Buffer.from(await secret(t.ethereum[role+'KeyFile']),'hex');
      try { need(key.length===32 && committeeAddress(Buffer.from(secp256k1.getPublicKey(key)).toString('hex'))===t.ethereum[role+'Address'].toLowerCase(),'sender_key'); } finally { key.fill(0); }
    }
    for (const [role,pin] of [['host','hostAdminPublicKey'],['writer','writerPublicKey']]) need(decodeTracAddress(t.trac.balance[role+'Address'])===t.trac[pin],'trac_address_pin');
    need(t.trac.writerPublicKey!==t.trac.hostAdminPublicKey && t.trac.writerPublicKey!==t.trac.adminPublicKey,'separate_trac_writer');
  }, 'Supply matching sender keys and checksummed Trac funding accounts; the indexer may also be the admin.');
  await check('Measured cost provenance', async () => { const bytes = await privateBytes(t.paths.costsFile); need(await sha256(bytes) === t.paths.costsSHA256, 'cost_hash'); const required=fundingRequirements(JSON.parse(bytes), t); for(const [name,amount] of Object.entries(required))need(BigInt(t.funding[name])>=amount,'budget'); }, 'Pin the measured local baseline and fund each role above that floor; a live production estimate is still required before execution.');
  if (!online && !suppliedReads) {
    checks.push({ ok: false, name: 'Production read checks pending', detail: 'Operator inputs and reachable TLS services are required. Use --online for read-only production checks; no launch writes are enabled.' });
    return { ok: false, stage, admitted: false, checks };
  }
  let reads;
  await check('Local services and HTTPS providers', async () => { reads = suppliedReads ?? await targetReads(t); }, 'Check owned connection files, local service ports and provider TLS.');
  if (reads) {
    await check('Bitcoin and TAP source agree', () => reads.chainAgreement(), 'Wait for indexing and resolve chain/genesis or source disagreement.');
    await check('Fresh confirmed checkpoint', async () => {
      need(t.bitcoin.checkpointHeight > 0 && (!t.bitcoin.witnessRpc.urlFile || reads.witness), 'checkpoint_source');
      const observed = await checkpointPhase({ height: t.bitcoin.checkpointHeight, primary: reads.core, witness: reads.witness, confirmations: t.policy.confirmations });
      const saved = await privateJSON(t.bitcoin.checkpointFile); need(rules.stableJSON(saved.checkpoint) === rules.stableJSON(observed.checkpoint), 'checkpoint_pin');
    }, 'Pin a recent confirmed retarget boundary validated against the Bitcoin source.');
    await check('Live MSB funds and fee schedule', async () => {
      const f = await reads.funding(); need(f.source === 'pinned-msb-runtime' && Date.now() - f.observedAt < 60000 && f.observedAt <= Date.now() && BigInt(f.feeAtoms) > 0n && new Set(f.validators).size >= 3, 'msb_source');
      for (const role of ['host', 'writer']) need(BigInt(f.balances[t.trac.balance[role + 'Address']]) >= BigInt(t.funding['tnk' + role[0].toUpperCase() + role.slice(1) + 'Atoms']), 'msb_funds');
    }, 'Check both funded Trac accounts and current fees through three discovered mainnet validators.');
    await check('Gas senders funded', async () => { for (const role of ['admin']) need(BigInt(await reads.ethereum('eth_getBalance', [t.ethereum[role + 'Address'], 'latest'])) >= BigInt(t.funding['ethereum' + role[0].toUpperCase() + role.slice(1) + 'Wei']), 'gas_funds'); }, 'Fund each configured Ethereum sender.');
    for (const m of t.committee.members) await check('Operator ' + m.id + ' attestation', async () => {
      const challenge = randomBytes(32).toString('hex');
      if (stage === 'preparation') verifyBootstrapAttestation(await reads.sidecar(m, '/attest-bootstrap', {challenge}), {target:t,member:m,challenge});
      else verifyOperatorAttestation(await reads.signer(m, '/attest-deployment', { challenge }), { target: t, member: m, challenge });
    }, 'Provision each local signer and bind its reader, identity, network, epoch and roster.');
    if (stage === 'admission') {
      await check('Rendered runtime and registry', async () => { await renderTargetRuntime(t, { persist: false }); await reads.registry(await privateJSON(t.gateway.registryFile)); }, 'Match deployment outputs, confirmed registry entries and private runtime references.');
      await check('Escrow code and authorities', async () => {
        for (const address of [t.ethereum.tokenAddress, t.ethereum.escrowAddress]) need((await reads.ethereum('eth_getCode', [address, 'latest'])).length > 2, 'deployed_code');
        for (const [fn, expected] of [['token()', t.ethereum.tokenAddress], ['admin()', t.ethereum.adminAddress], ['committee()', committeeAddress(t.committee.publicKey)]]) need('0x' + (await reads.ethereum('eth_call', [{ to: t.ethereum.escrowAddress, data: calldata(fn, []) }, 'latest'])).slice(-40) === expected.toLowerCase(), 'authority');
        need(BigInt(await reads.ethereum('eth_call', [{ to: t.ethereum.escrowAddress, data: calldata('committeeEpoch()', []) }, 'latest'])) === BigInt(t.policy.authorityEpoch), 'authority_epoch');
      }, 'Verify the deployed escrow, token and authority epoch.');
      await check('Public source and token verification', async () => {
        await publicVerification(t, reads);
      }, 'Retrieve the pinned published artifacts and compiler inputs, and match escrow/token implementation bytecode.');
      await check('Gateway post-deploy admission', async () => { const h = await reads.gateway(); need(h.ok && !h.worker?.code && h.observations === 0, 'gateway'); }, 'Wait for a healthy gateway with no queued observations or current worker errors.');
    }
  }
  const ok = checks.every(c => c.ok);
  return { ok, stage, admitted: ok && stage === 'admission', checks };
}

// Keep the production entry point executable as well as importable. The common
// CLI owns formatting and never prints supplied values or upstream exceptions.
async function main() {
  const args = process.argv.slice(2);
  let filename, stage = 'preparation', online = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--online' && !online) online = true;
    else if (arg === '--target' && !filename && args[i + 1] && !args[i + 1].startsWith('--')) filename = args[++i];
    else if (arg === '--stage' && ['preparation', 'admission'].includes(args[i + 1])) stage = args[++i];
    else throw Error('arguments');
  }
  need(filename, 'target_required');
  const { loadTarget } = await import('./target.mjs');
  const { renderReport } = await import('./preflight.mjs');
  const target = await loadTarget(filename);
  need(target.mode === 'mainnet', 'production_target_required');
  const worksheet = JSON.parse(await readFile(filename, 'utf8'));
  if (!online && worksheet.operations?.layout === 'single-host') {
    need(stage === 'preparation', 'inventory_not_admission');
    const report = ownerInputReport(worksheet);
    console.log(report.checks.map(c => `${c.ok ? 'PASS' : 'GAP'} ${c.name}${c.detail ? ': ' + c.detail : ''}`).join('\n'));
    console.log('Operator input inventory only. Generated files and live safety checks are verified with --online before execution; admission remains closed.');
    process.exitCode = 1;
    return;
  }
  const report = await productionPreflight(target, { stage, online });
  console.log(renderReport(report));
  if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error('STOP: use node deploy/production-preflight.mjs --target FILE [--stage preparation|admission] [--online] with a valid mainnet target. No private values are printed.');
  process.exitCode = 1;
});
