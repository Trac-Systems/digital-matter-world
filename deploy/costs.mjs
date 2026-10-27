import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, realpath, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { BUILD, validate, diskCheck } from './safety.mjs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const { Transaction } = createRequire(new URL('../local/package.json', import.meta.url))('@scure/btc-signer');

export function productionEstimate({ target, signedBitcoin, ethereum, msb, localBaseline, provenance, now = Date.now() }) {
  assert(target.mode === 'mainnet' && provenance?.chain === 'main' && provenance.chainId === target.ethereum.chainId);
  assert(Number.isSafeInteger(provenance.observedAt) && provenance.observedAt <= now && now - provenance.observedAt < 60000, 'stale_production_estimate');
  assert(provenance.confirmations >= target.policy.confirmations && /^[0-9a-f]{64}$/.test(provenance.tipHash));
  assert(signedBitcoin.length > 0 && ethereum.length > 0 && BigInt(msb.feeAtoms) > 0n);
  const rate = BigInt(target.bitcoin.estimateFeeRate);
  const bitcoin = signedBitcoin.map(row => {
    assert(row.transactions.length > 0 && row.cancellations.length > 0 && /^[0-9]+$/.test(row.postageSats), 'complete_signed_package_required');
    const parse = hex => Transaction.fromRaw(Buffer.from(hex, 'hex'), { allowUnknownInputs: true, allowUnknownOutputs: true });
    const transactions = row.transactions.map(parse), cancellations = row.cancellations.map(parse);
    assert(transactions.every(t => t.isFinal) && cancellations.every(t => t.isFinal), 'signed_transactions_required');
    const vbytes = transactions.reduce((n, t) => n + t.vsize, 0), cancelVbytes = cancellations.reduce((n, t) => n + t.vsize, 0);
    return { label: row.label, transactionIds: transactions.map(t => t.id), vbytes, estimatedFeeSats: String(BigInt(vbytes) * rate), postageSats: row.postageSats,
      cancellationVbytes: cancelVbytes, cancellationReserveSats: '0' };
  });
  const gas = ethereum.map(row => { assert(row.chainId === target.ethereum.chainId && Number.isSafeInteger(row.gas) && row.gas > 0 && row.gas <= target.policy.ethereumMaxGas && BigInt(row.gasPriceWei) > 0n && BigInt(row.gasPriceWei) <= BigInt(target.policy.ethereumMaxGasPriceWei)); return { ...row, estimatedWei: String(BigInt(row.gas) * BigInt(row.gasPriceWei)) }; });
  assert(Number.isSafeInteger(msb.registrationOperations) && msb.registrationOperations >= 0 && Number.isSafeInteger(msb.paidFallbackOperations) && msb.paidFallbackOperations >= 0);
  return { kind: 'production-estimate', label: 'Production-shaped estimate; selected fee assumptions, not a broadcast or final charge',
    provenance, bitcoin, ethereum: gas, trac: { feeAtoms: msb.feeAtoms, registrationAtoms: String(BigInt(msb.feeAtoms) * BigInt(msb.registrationOperations)), paidFallbackAtoms: String(BigInt(msb.feeAtoms) * BigInt(msb.paidFallbackOperations)) },
    localBaseline: { label: 'Measured regtest/LocalTap baseline retained separately', ...localBaseline } };
}

// Reprice the measured transactions; keep postage and cancellation liquidity
// separate from fees. Each sender must have its own gas budget.
export function fundingRequirements(costs, target) {
  const amount = v => { assert(typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)); return BigInt(v); };
  const rate = BigInt(target.bitcoin.estimateFeeRate), gasPrice = amount(target.ethereum.estimateGasPriceGwei) * 1000000000n;
  assert(rate > 0n && gasPrice > 0n);
  const labels = ['privilege-authority', 'privilege-authority-activation'];
  const launch = labels.map(label => { const rows = costs.bitcoin.filter(r => r.label === label); assert.equal(rows.length, 1); return rows[0]; });
  let bitcoinSats = amount(target.funding.bitcoinReserveSats);
  for (const r of launch) {
    assert(Number.isSafeInteger(r.vbytes) && r.vbytes > 0);
    const reserve = r.cancellationReserve ?? { parent: '0', child: '0' };
    const cancel = [amount(reserve.parent), amount(reserve.child)].reduce((a, b) => a > b ? a : b);
    bitcoinSats += BigInt(r.vbytes) * rate + amount(r.postageSats) + cancel;
  }
  const gas = label => { const rows = costs.ethereum.filter(r => r.label === label); assert.equal(rows.length, 1); assert(Number.isSafeInteger(rows[0].gas) && rows[0].gas > 0); return BigInt(rows[0].gas) * gasPrice; };
  const tnk = amount(costs.trac.registrationAtomic); assert(tnk > 0n);
  return { bitcoinSats, ethereumAdminWei: gas('escrow-deploy'), tnkHostAtoms: tnk, tnkWriterAtoms: tnk };
}

async function main() {
const args = process.argv.slice(2);
assert(args.length === 3 && args[1] === '--dry-run' && args[2] === '--regtest', 'Usage: node deploy/costs.mjs ABSOLUTE_RUN --dry-run --regtest');
const directory = resolve(args[0]); assert(directory.startsWith(BUILD + '/deploy/run-')); assert.equal(await realpath(directory), directory);
const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
const config = validate(JSON.parse(await readFile(join(directory, 'target.json'), 'utf8')));
assert(result.complete && result.through === 'kit' && result.processesStopped, 'Require a completed, stopped whole rehearsal');
await diskCheck();
const sha = value => createHash('sha256').update(value).digest('hex');
const verification = JSON.parse(await readFile(join(directory, 'source-verification.json'), 'utf8'));
const artifactBytes = await readFile(join(BUILD, 'target/eth-out/DmwEscrow.sol/DmwEscrow.json'));
assert.equal(sha(artifactBytes), verification.artifactSHA256, 'Compiler artifact changed since deployment; retain the original before reporting');
const artifact = JSON.parse(artifactBytes), buildDirectory = join(BUILD, 'target/eth-out/build-info');
let compilerInput;
for (const filename of await readdir(buildDirectory)) {
  if (!filename.endsWith('.json')) continue;
  const info = JSON.parse(await readFile(join(buildDirectory, filename), 'utf8'));
  const contract = info.output?.contracts?.['src/DmwEscrow.sol']?.DmwEscrow;
  if (contract?.evm?.bytecode?.object === artifact.bytecode.object.replace(/^0x/, '')) {
    compilerInput = { language: info.input.language, sources: info.input.sources, settings: info.input.settings }; break;
  }
}
assert(compilerInput, 'Matching compiler input missing');
await mkdir(join(directory, 'verification'), { recursive: true, mode: 0o700 });
await writeFile(join(directory, 'verification/artifact.json'), artifactBytes, { mode: 0o600 });
await writeFile(join(directory, 'verification/standard-input.json'), JSON.stringify(compilerInput), { mode: 0o600 });
const rate = BigInt(config.bitcoin.estimateFeeRate), gasPrice = BigInt(config.ethereum.estimateGasPriceGwei) * 1000000000n;
const bitcoin = result.bitcoin.filter(r => !r.label.startsWith('smoke-service')).map(r => ({ label: r.label, inscriptions: r.inscriptions?.length ?? 0,
  vbytes: (r.commit?.vbytes ?? 0) + (r.reveal?.vbytes ?? 0) + (r.transaction?.vbytes ?? 0),
  commitVbytes: r.commit?.vbytes, revealVbytes: r.reveal?.vbytes, postageSats: String((r.inscriptions?.length ?? 0) * config.bitcoin.postage),
  cancellationReserve: r.cancellationReserve }));
bitcoin.forEach(r => { assert(Number.isSafeInteger(r.vbytes) && r.vbytes > 0); r.estimatedFeeSats = (BigInt(r.vbytes) * rate).toString(); });
const launch = bitcoin.filter(r => ['privilege-authority', 'privilege-authority-activation'].includes(r.label));
const totals = { launchVbytes: launch.reduce((n, r) => n + r.vbytes, 0), launchPostageSats: launch.reduce((n, r) => n + BigInt(r.postageSats), 0n).toString() };
totals.launchFeeSats = (BigInt(totals.launchVbytes) * rate).toString();
const ethereum = result.ethereum.map(r => ({ label: r.label, gas: r.gas, estimatedWei: (BigInt(r.gas) * gasPrice).toString() }));
const costs = { basis: { bitcoin: 'Signed regtest transactions; same payload and input/output structure, excluding local funding and fixtures. Estimate changes with wallet inputs, signatures and fee conditions.', satPerVbyte: Number(rate), gasPriceGwei: config.ethereum.estimateGasPriceGwei,
  ethereum: 'Measured Anvil execution against LocalTap; bridged token clone calls and mainnet state can alter gas. No live price quote.', tnk: 'Measured local MSB balance debit; mainnet fee schedule and registration costs need fresh verification.' },
  bitcoin, totals, ethereum, trac: { registrationAtomic: result.trac.registration.atomicSpent, registrationTNK: format(result.trac.registration.atomicSpent, 18), normalHeaderAndBatchTNK: '0', paidFallback: 'Not measured by this launch rehearsal; quote the target MSB before funding.' },
  exclusions: ['Postage is locked output value, not miner fees.', 'Cancellation reserves are alternative-path funding, not added to successful-path fees.', 'BTC faucet funding, stand-in TAP deployment/mint, fixture elements and wallet authorities are local setup.', 'No fiat conversion, infrastructure bill or claimed exact mainnet gas/fee quote.'] };
function format(value, decimals) { const s = BigInt(value).toString().padStart(decimals + 1, '0'); return s.slice(0, -decimals) + '.' + s.slice(-decimals); }
await writeFile(join(directory, 'costs.json'), JSON.stringify(costs, null, 2) + '\n', { mode: 0o600 });
const text = [`# Measured launch cost model`, '', `Bitcoin estimate: ${rate} sat/vbyte. Ethereum estimate: ${config.ethereum.estimateGasPriceGwei} gwei/gas.`, '', '| Bitcoin step | Commit vB | Reveal vB | Total vB | Estimated fee (sat) |', '| --- | ---: | ---: | ---: | ---: |', ...bitcoin.map(r => `| ${r.label} | ${r.commitVbytes ?? '—'} | ${r.revealVbytes ?? '—'} | ${r.vbytes} | ${r.estimatedFeeSats} |`), '', `Launch-only: ${totals.launchVbytes} vbytes, ${totals.launchFeeSats} sat (${format(totals.launchFeeSats, 8)} BTC) plus ${totals.launchPostageSats} sat of inscription postage.`, '', '| Ethereum step | Gas | Estimated ETH |', '| --- | ---: | ---: |', ...ethereum.map(r => `| ${r.label} | ${r.gas} | ${format(r.estimatedWei, 18)} |`), '', `Local Trac registration: ${costs.trac.registrationTNK} TNK (${costs.trac.registrationAtomic} atoms). Free header/batch messages: 0 TNK. Paid fallback: not measured.`, '', costs.basis.bitcoin, costs.basis.ethereum, costs.basis.tnk, '', ...costs.exclusions.map(s => '- ' + s), ''].join('\n');
await writeFile(join(directory, 'COSTS.md'), text, { mode: 0o600 }); console.log(text);

}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
