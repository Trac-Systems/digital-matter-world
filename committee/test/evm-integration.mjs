import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, statfs, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { buildRoot, root, createGroup, startSidecar, stopChild, ceremony, descriptor, privateJSON, randomHex, rpc as signerRPC, delay } from '../tss.mjs';
import { sha256 } from '../signer/crypto.mjs';
import { TYPES, abiWord, calldata, committeeAddress, hashSplit } from '../signer/escrow.mjs';
import { createEscrowReader } from '../signer/escrow-reader.mjs';
import { ethereumPayments } from '../../service/src/ethereum.mjs';
import { signProposal } from '../client.mjs';
import { ethereumFixture } from './ethereum-fixture.mjs';
import { network } from './fixture.mjs';
import { createReads } from './mock-reads.mjs';
import { Policy } from '../signer/policy.mjs';
import { signerError } from '../signer/errors.mjs';

const disk = await statfs('/'); assert.ok(disk.bavail * disk.bsize >= 100_000_000_000, '100 GB free space required');
const directory = resolve(buildRoot, `evm-${Date.now()}`), children = [], pids = [], checks = [], transactions = [];
const output = resolve(directory, 'escrow-out'), cache = resolve(directory, 'escrow-cache');
await mkdir(directory, { recursive: true, mode: 0o700 });
const record = async (pid, command) => { assert.ok(pid); pids.push({ pid, command }); await writeFile(resolve(directory, 'pids.json'), JSON.stringify(pids), { mode: 0o600 }); };
const test = async (name, fn) => { await fn(); checks.push(name); console.log('PASS', name); };
const port = Number(process.env.DMW_EVM_TEST_PORT ?? 59720), endpoint = new URL(`http://127.0.0.1:${port}`);
const rpc = async (method, params = []) => {
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
  const value = await response.json(); if (value.error) throw Error(value.error.message); return value.result;
};
const word = (type, value) => abiWord(type, value).toString('hex');
const call = (to, method, args = []) => rpc('eth_call', [{ to, data: calldata(method, args) }, 'latest']);
const send = async (from, to, data) => {
  const hash = await rpc('eth_sendTransaction', [{ from, ...(to ? { to } : {}), data, gas: '0x7a1200' }]);
  let receipt;
  for (let i = 0; i < 100 && !receipt; i++) { receipt = await rpc('eth_getTransactionReceipt', [hash]); if (!receipt) await delay(50); }
  assert.equal(receipt?.status, '0x1', 'local EVM transaction failed'); transactions.push(receipt); return receipt;
};
const transact = (from, to, method, args) => send(from, to, calldata(method, args));
const signedCall = (method, args, signature) => calldata(method, [...args, ['uint256', String((args.length + 1) * 32)]]) + word('uint256', String((signature.length - 2) / 2)) + signature.slice(2).padEnd(192, '0');
try {
  await promisify(execFile)(process.env.DMW_TEST_FORGE_BIN ?? 'forge', ['build', '--offline', '--threads', '1', '--out', output, '--cache-path', cache], { cwd: resolve(root, '../eth'), env: { ...process.env, FOUNDRY_OUT: output, FOUNDRY_CACHE_PATH: cache, FOUNDRY_BROADCAST: resolve(directory, 'broadcast') } });
  const artifact = JSON.parse(await readFile(resolve(output, 'DmwEscrow.sol/DmwEscrow.json')));
  assert.equal(artifact.abi.find(row => row.name === 'deposit').inputs[2].components.length, TYPES.Split.length);
  // No state persistence flags: all custody/rotation transactions are disposable.
  const anvil = spawn(process.env.DMW_TEST_ANVIL_BIN ?? 'anvil', ['--host', endpoint.hostname, '--port', String(port), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  let spawnError; anvil.on('error', e => { spawnError = e; }); children.push(anvil);
  if (anvil.pid) await record(anvil.pid, 'anvil');
  let ready = false;
  for (let i = 0; i < 100; i++) { if (spawnError) throw spawnError; if (anvil.exitCode !== null) throw Error('anvil_start_failed'); try { assert.equal(await rpc('eth_chainId'), '0x7a69'); ready = true; break; } catch { await delay(100); } }
  assert.ok(ready);
  const group = await createGroup(directory, { prefix: 'evm', port: port + 1 });
  for (const member of group) children.push(await startSidecar(member, record));
  console.log('Generating a fresh real 3-of-5 committee key...');
  const { publicKey } = await ceremony(group, 'keygen'), committee = committeeAddress(publicKey);
  const [admin, payer, treasury, finder, landowner, relayer, successor, otherParty] = await rpc('eth_accounts');
  const deploy = async (name, args) => {
    const artifact = JSON.parse(await readFile(resolve(output, `${name}.sol/${name}.json`), 'utf8'));
    return (await send(admin, null, artifact.bytecode.object + args.map(([type, value]) => word(type, value)).join(''))).contractAddress;
  };
  const token = await deploy('LocalTap', [['address', admin]]);
  const contract = await deploy('DmwEscrow', [['address', token], ['address', committee], ['address', admin]]);
  const escrow = { chainId: '31337', address: contract, token }, unit = 10n ** 18n;
  const options = { publicKey, ethereum: { endpoint: endpoint.href, escrow, payer, treasury, finder, landowner, baseFee: (100n * unit).toString() } };
  const f = ethereumFixture({ ...options.ethereum, publicKey }), split = f.data.escrow.deposit.split;
  const reader = createEscrowReader({ ...escrow, rpc });
  let deposit, collisionExpiry;
  await test('immutable LocalTap and DmwEscrow deploy; funded deposit event/getter agree with exact split hash and digest', async () => {
    await transact(admin, token, 'mint(address,uint256)', [['address', payer], ['uint256', (1000n * unit).toString()]]);
    await transact(payer, token, 'approve(address,uint256)', [['address', contract], ['uint256', (100n * unit).toString()]]);
    const block = await rpc('eth_getBlockByNumber', ['latest', false]), expiry = (BigInt(block.timestamp) + 864000n).toString();
    // A different payer can occupy the same public ID first without blocking it.
    collisionExpiry = (BigInt(block.timestamp) + 7200n).toString();
    const collisionSplit = { ...split, treasuryAmount: '1', finder: '0x' + '00'.repeat(20), finderAmount: '0', landowner: '0x' + '00'.repeat(20), landownerAmount: '0', discoverer: '0x' + '00'.repeat(20), discovererAmount: '0', burnAmount: '0' };
    await transact(admin, token, 'mint(address,uint256)', [['address', otherParty], ['uint256', '1']]);
    await transact(otherParty, token, 'approve(address,uint256)', [['address', contract], ['uint256', '1']]);
    await transact(otherParty, contract, 'deposit(bytes32,uint256,(address,uint256,address,uint256,address,uint256,address,uint256,uint256),uint256)', [['bytes32', f.id], ['uint256', '1'], ...TYPES.Split.map(({ name, type }) => [type, collisionSplit[name]]), ['uint256', collisionExpiry]]);
    await transact(payer, contract, 'deposit(bytes32,uint256,(address,uint256,address,uint256,address,uint256,address,uint256,uint256),uint256)', [['bytes32', f.id], ['uint256', (100n * unit).toString()], ...TYPES.Split.map(({ name, type }) => [type, split[name]]), ['uint256', expiry]]);
    deposit = await reader.deposit(payer, f.id);
    assert.equal(deposit.confirmations, 1); assert.equal(deposit.deposit.status, 1);
    assert.equal(deposit.deposit.payer, payer); assert.deepEqual(deposit.deposit.split, split);
    assert.equal(deposit.deposit.splitHash, hashSplit(split));
    assert.equal(await call(contract, 'hashSplit((address,uint256,address,uint256,address,uint256,address,uint256,uint256))', TYPES.Split.map(({ name, type }) => [type, split[name]])), hashSplit(split));
    assert.equal(BigInt(await call(contract, 'totalOpen()')), 100n * unit + 1n);
    const collision = await reader.deposit(otherParty, f.id);
    assert.equal(collision.deposit.amount, '1'); assert.equal(collision.deposit.payer, otherParty);
    assert.notEqual(collision.releaseDigest, deposit.releaseDigest);
  });
  await test('reader rejects wrong chain/token, altered event, missing event and reorg during a snapshot', async () => {
    await assert.rejects(createEscrowReader({ ...escrow, chainId: '31338', rpc }).deposit(payer, f.id), /escrow_chain/);
    await assert.rejects(createEscrowReader({ ...escrow, token: treasury, rpc }).deposit(payer, f.id), /escrow_token/);
    for (const mutation of ['amount', 'missing', 'reorg', 'removed']) {
      const altered = async (method, params) => {
        const value = await rpc(method, params);
        if (method === 'eth_getLogs') {
          if (mutation === 'missing') return [];
          if (mutation === 'amount') value[0].data = '0x' + word('uint256', '1') + value[0].data.slice(66);
          if (mutation === 'removed') value[0].removed = true;
        }
        if (method === 'eth_getTransactionReceipt' && mutation === 'amount')
          for (const log of value.logs.filter(log => log.address === contract)) log.data = '0x' + word('uint256', '1') + log.data.slice(66);
        if (method === 'eth_getBlockByNumber' && params[0] === deposit.blockNumber && mutation === 'reorg') value.hash = '0x' + '00'.repeat(32);
        return value;
      };
      await assert.rejects(createEscrowReader({ ...escrow, rpc: altered }).deposit(payer, f.id), /escrow_(event_mismatch|deposit_event|event_reorg|reorg)/);
    }
  });
  const clients = [], files = [];
  for (let i = 0; i < 3; i++) {
    const member = group[i], base = JSON.parse(await readFile(resolve(member.directory, 'credentials.json'), 'utf8'));
    const credentials = resolve(member.directory, 'service-credentials.json'), config = resolve(member.directory, 'service.json'), file = resolve(member.directory, 'reads.json'); files.push(file);
    const secrets = { identity: base.identity, encryption: base.encryption, apiToken: randomHex(), sidecarToken: member.token, passphrase: randomHex(), journalKey: randomHex() };
    await privateJSON(credentials, secrets); await privateJSON(file, options);
    await privateJSON(config, { id: member.id, network, epoch: 1, escrow, listen: `127.0.0.1:${port + 6 + i}`, directory: member.directory, secrets: credentials, sidecar: member.url, members: group.map(descriptor), readModule: resolve(root, 'test/mock-reads.mjs'), readOptions: { file } });
    const log = await open(resolve(member.directory, 'service.log'), 'a', 0o600);
    const child = spawn(process.execPath, [resolve(root, 'signer/service.mjs'), config], { stdio: ['ignore', log.fd, log.fd] }); child.on('error', () => {}); await log.close(); children.push(child); await record(child.pid, config);
    const client = { id: member.id, url: `http://127.0.0.1:${port + 6 + i}`, token: secrets.apiToken, peer: descriptor(member) }; clients.push(client);
    let healthy = false;
    for (let n = 0; n < 100; n++) { if (child.exitCode !== null) throw Error('service_failed'); try { await signerRPC(client.url, client.token, '/health', {}, 500); healthy = true; break; } catch { await delay(100); } }
    assert.equal(healthy, true);
  }
  let permit, release;
  const policy = new Policy({ network, publicKey, escrow, reads: await createReads({ file: files[0] }) });
  const refused = async (proposal, expected) => {
    let reason;
    await assert.rejects(policy.approve(proposal), error => { assert.match(error.message, expected); reason = error; return true; });
    // Policy reasons are checked above; HTTP exposes only its allowlisted code.
    await assert.rejects(signProposal(clients, proposal), error => error.message === signerError(reason).error);
  };
  await test('no permanent mint permit exists before release and Trac consumption', async () => {
    await refused(f.proposal, /payment_incomplete|units_not_consumed/);
  });
  const releaseProposal = { network, kind: 'ethereum-payment-release', id: f.id };
  await test('real 3-of-5 release agrees with contract digest, Anvil typed data and EVM ecrecover', async () => {
    release = await signProposal(clients, releaseProposal);
    assert.equal(release.digest, deposit.releaseDigest); assert.equal(release.ethereumSignature.length, 132);
    const recovered = await rpc('eth_call', [{ to: '0x' + '0'.repeat(39) + '1', data: '0x' + release.digest + word('uint256', String(parseInt(release.ethereumSignature.slice(130), 16))) + release.ethereumSignature.slice(2, 130) }, 'latest']);
    assert.equal('0x' + recovered.slice(-40), committee);
    const oracle = await rpc('eth_signTypedData_v4', [admin, release.typedData]);
    assert.equal(committeeAddress(secp256k1.Signature.fromCompact(oracle.slice(2, 130)).addRecoveryBit(parseInt(oracle.slice(130), 16) - 27).recoverPublicKey(release.digest).toHex(true)), admin);
  });
  const releaseData = () => signedCall('release(address,bytes32,bytes)', [['address', payer], ['bytes32', f.id]], release.ethereumSignature);
  await test('an unrelated gas payer releases 35 treasury, 30 finder, 15 holder and burns 20', async () => {
    await assert.rejects(call(contract, 'release(address,bytes32,bytes)', []), /revert/);
    await assert.rejects(rpc('eth_call', [{ from: relayer, to: contract, data: signedCall('release(address,bytes32,bytes)', [['address', otherParty], ['bytes32', f.id]], release.ethereumSignature) }, 'latest']), /revert/);
    await send(relayer, contract, releaseData());
    for (const [account, amount] of [[treasury, 35n], [finder, 30n], [landowner, 15n], [payer, 900n]]) assert.equal(BigInt(await call(token, 'balanceOf(address)', [['address', account]])), amount * unit);
    assert.equal(BigInt(await call(token, 'totalSupply()')), 980n * unit + 1n);
    assert.equal(BigInt(await call(token, 'balanceOf(address)', [['address', contract]])), 1n);
    assert.equal(BigInt(await call(contract, 'totalOpen()')), 1n);
    assert.equal((await reader.deposit(payer, f.id)).deposit.status, 2);
  });
  await test('one-block release and Trac consumption allow three policy services to sign the permanent permit', async () => {
    assert.equal((await ethereumPayments({ rpc, escrow }).settled('ethereum', f.id, payer)).confirmations, 1);
    await refused(f.proposal, /units_not_consumed/);
    options.consumed = true; // Simulated accepted Trac mc, tested separately against the real contract reducer.
    for (const file of files) await writeFile(file, JSON.stringify(options));
    permit = await signProposal(clients, f.proposal);
    assert.ok(secp256k1.verify(permit.signature.compact, permit.digest, publicKey, { prehash: false }));
    assert.deepEqual(permit.certificate.details.commissions, []);
    assert.equal(permit.payload.op, 'dmt-mint'); assert.equal(permit.payload.blk, '10');
  });
  await test('terminal release and repeated signer contribution are refused', async () => {
    await assert.rejects(rpc('eth_call', [{ from: relayer, to: contract, data: releaseData() }, 'latest']), /revert/);
    await refused(releaseProposal, /pending_not_held|escrow_expired/);
  });
  await test('payer-bound refund closes only the colliding namespace', async () => {
    await rpc('evm_setNextBlockTimestamp', [Number(collisionExpiry)]); await rpc('evm_mine');
    await transact(relayer, contract, 'refund(address,bytes32)', [['address', otherParty], ['bytes32', f.id]]);
    assert.equal((await reader.deposit(otherParty, f.id)).deposit.status, 3);
    assert.equal((await reader.deposit(payer, f.id)).deposit.status, 2);
    assert.equal(BigInt(await call(contract, 'totalOpen()')), 0n);
    assert.equal(BigInt(await call(token, 'balanceOf(address)', [['address', otherParty]])), 1n);
  });
  let rotation, rotationProposal;
  await test('rotation requires independent approval and a real threshold signature over current nonce and epoch', async () => {
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    options.rotation = { newCommittee: successor, nonce: '0', committeeEpoch: '0', deadline: (BigInt(block.timestamp) + 3600n).toString() };
    rotationProposal = { network, kind: 'ethereum-rotation', ...options.rotation };
    await refused(rotationProposal, /rotation_not_authorized/);
    for (const file of files) await writeFile(file, JSON.stringify(options));
    rotation = await signProposal(clients.slice(0, 3), rotationProposal);
    assert.equal(rotation.digest, (await reader.rotation(successor, options.rotation.deadline)).rotationDigest);
    const oracle = await rpc('eth_signTypedData_v4', [admin, rotation.typedData]);
    assert.equal(committeeAddress(secp256k1.Signature.fromCompact(oracle.slice(2, 130)).addRecoveryBit(parseInt(oracle.slice(130), 16) - 27).recoverPublicKey(rotation.digest).toHex(true)), admin);
    await assert.rejects(signProposal(clients.slice(0, 3), rotationProposal), /slot_already_reserved/);
    await send(relayer, contract, signedCall('proposeCommittee(address,uint256,bytes)', [['address', successor], ['uint256', options.rotation.deadline]], rotation.ethereumSignature));
    assert.equal(BigInt(await call(contract, 'rotationNonce()')), 1n);
    assert.equal('0x' + (await call(contract, 'committee()')).slice(-40), committee);
  });
  await test('rotation rejects replay and premature application, then activates after three days', async () => {
    await refused(rotationProposal, /rotation_stale/);
    await assert.rejects(rpc('eth_call', [{ from: relayer, to: contract, data: signedCall('proposeCommittee(address,uint256,bytes)', [['address', successor], ['uint256', options.rotation.deadline]], rotation.ethereumSignature) }, 'latest']), /revert/);
    await assert.rejects(call(contract, 'applyCommittee()'), /revert/);
    await rpc('evm_increaseTime', [259200]); await rpc('evm_mine');
    await transact(relayer, contract, 'applyCommittee()', []);
    assert.equal('0x' + (await call(contract, 'committee()')).slice(-40), successor);
    assert.equal(BigInt(await call(contract, 'committeeEpoch()')), 1n);
    assert.notEqual((await reader.deposit(payer, f.id)).releaseDigest, release.digest);
    await refused(rotationProposal, /escrow_committee/);
  });
  await test('reader exposes admin recovery origin before and after maturity; signing refuses interference', async () => {
    // Restore the threshold key through the admin's delayed route.
    await transact(admin, contract, 'proposeCommitteeByAdmin(address)', [['address', committee]]);
    let state = await reader.rotation(committee, '0');
    assert.equal(state.pendingCommittee.adminOrigin, true);
    await rpc('evm_setNextBlockTimestamp', [Number(state.pendingCommittee.executableAt)]); await rpc('evm_mine');
    await transact(relayer, contract, 'applyCommittee()', []);
    await transact(admin, contract, 'proposeCommitteeByAdmin(address)', [['address', successor]]);
    state = await reader.rotation(successor, '0');
    assert.equal(state.pendingCommittee.adminOrigin, true);
    options.rotation = { newCommittee: otherParty, nonce: state.rotationNonce, committeeEpoch: state.committeeEpoch, deadline: (BigInt(state.pendingCommittee.executableAt) + 100n).toString() };
    for (const file of files) await writeFile(file, JSON.stringify(options));
    const proposal = { network, kind: 'ethereum-rotation', ...options.rotation };
    await refused(proposal, /admin_recovery_pending/);
    await rpc('evm_setNextBlockTimestamp', [Number(state.pendingCommittee.executableAt)]); await rpc('evm_mine');
    assert.equal((await reader.rotation(otherParty, options.rotation.deadline)).pendingCommittee.adminOrigin, true);
    await refused(proposal, /admin_recovery_pending/);
    await transact(relayer, contract, 'applyCommittee()', []);
    assert.equal((await reader.rotation(otherParty, options.rotation.deadline)).pendingCommittee.adminOrigin, false);
  });
  console.log(`${checks.length} EVM integration checks passed.`);
} finally {
  // Stop Node policy services before their sidecars, then stop the exact Anvil PID.
  for (const child of children.slice().reverse()) if (child.pid) await stopChild(child);
  const processesStopped = children.every(child => !child.pid || child.exitCode !== null || child.signalCode !== null);
  await writeFile(resolve(directory, 'results.json'), JSON.stringify({ checks, transactions, pids, processesStopped }, null, 2), { mode: 0o600 });
  assert.ok(processesStopped);
  console.log(`Stopped all ${pids.length} recorded processes. Evidence: ${directory}`);
}
