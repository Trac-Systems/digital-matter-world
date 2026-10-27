import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, statfs } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { bufferToBigInt } from 'trac-msb/src/utils/amountSerialization.js';
import { localNetwork } from '../tests/helpers/local-network.mjs';
import { deployment, signedBatch, invariants } from '../tests/helpers/harness.mjs';
import { chain, checkpoint } from '../tests/helpers/chain.mjs';
import { controls, until } from '../runtime/control.js';
import { bytesToHex, sha256, hexToBytes, signingDigest, requestDigest } from '../signing.js';
import { pearPeer } from './pear-process.mjs';

export async function runDevnet({ pear = false } = {}) {
  const disk = await statfs('/');
  if (disk.bavail * disk.bsize < 100_000_000_000) throw new Error('Less than 100 GB free');
  const local = await localNetwork(); const children = [];
  await writeFile(join(local.root, 'supervisor-pid.json'), JSON.stringify({ pid: process.pid }));
  const close = async () => { for (const child of children.reverse()) await child.close(); await local.close(); };
  let closing;
  const shutdown = () => { closing ??= close(); return closing; };
  const signal = () => void shutdown().then(() => process.exit(0));
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  try {
    const validator = await local.msb(), bus = await local.client(validator);
    const launch = async (name, bootstrap = null) => {
      if (pear) {
        const child = await pearPeer({ localOnly: true, directory: join(local.root, name), dhtBootstrap: local.dhtBootstrap,
          validatorKey: validator.wallet.publicKey.toString('hex'), msbBootstrap: validator.config.bootstrap.toString('hex'),
          subnetBootstrap: bootstrap, dmw: deployment }, local.root, name);
        children.push(child); return child;
      }
      const peer = await local.peer(name, bus, bootstrap);
      const handlers = controls(peer, bus);
      return { info: { pid: process.pid, runtime: 'node', address: peer.wallet.publicKey, msbAddress: peer.wallet.address,
        writer: peer.writerLocalKey, bootstrap: peer.base.key.toString('hex') }, rpc: (cmd, args = {}) => handlers[cmd](args) };
    };
    const indexer = await launch('indexer'), writer = await launch('writer', indexer.info.bootstrap);
    for (const peer of [indexer, writer]) await local.fund(validator, { address: peer.info.msbAddress });
    await indexer.rpc('setup', { writer: writer.info.writer });
    await until(async () => (await writer.rpc('status')).writable, 'writer admitted');
    const sync = async () => {
      const version = (await indexer.rpc('status')).version;
      await until(async () => (await writer.rpc('status')).version >= version, 'writer synchronized');
    };
    await sync();
    const headers = chain(27, checkpoint);
    await writer.rpc('post', { op: 'hd', value: { headers: headers.slice(0, 1) } });
    await until(async () => (await indexer.rpc('status')).head.counted === 1, 'first counted block');
    const batch = signedBatch({ n: 1, from: 1, to: 1, ops: [...['a','b','c'].map(asset=>({ op: 'mk', to: writer.info.address, asset, amount:'100' }))] });
    await writer.rpc('post', { op: 'bt', value: batch });
    await until(async () => await indexer.rpc('balance', { owner: writer.info.address, asset: 'a' }) === '100', 'signed committee batch');
    const before = bufferToBigInt((await bus.state.getNodeEntry(writer.info.msbAddress)).balance);
    await writer.rpc('tx', { op: 'tf', value: { to: indexer.info.address, assets: [['a','100']] } });
    await until(async () => await indexer.rpc('balance', { owner: indexer.info.address, asset: 'a' }) === '100', 'TNK transfer');
    const preimage = '42'.repeat(32), hash = bytesToHex(sha256(hexToBytes(preimage)));
    await writer.rpc('tx', { op: 'hl', value: { to: indexer.info.address, assets: [['b','100']], hash, refund: 7 } });
    const firstLock = bytesToHex(signingDigest('dmw-lock-v1', deployment.network, { from: writer.info.address, sequence:1, to:indexer.info.address, assets:[['b','100']], hash, refund:7 }));
    await indexer.rpc('tx', { op: 'hc', value: { lock: firstLock, preimage } });
    await until(async () => await writer.rpc('balance', { owner: indexer.info.address, asset: 'b' }) === '100', 'claim replicated');
    await writer.rpc('tx', { op: 'hl', value: { to: indexer.info.address, assets: [['c','100']], hash, refund: 7 } });
    const secondLock = bytesToHex(signingDigest('dmw-lock-v1', deployment.network, { from: writer.info.address, sequence:2, to:indexer.info.address, assets:[['c','100']], hash, refund:7 }));
    // Exercise both fallback TNK routes as well as free header and batch messages.
    await writer.rpc('tx', { op: 'hd', value: { headers: headers.slice(1, 7) } });
    await writer.rpc('tx', { op: 'hr', value: { lock: secondLock } });
    await writer.rpc('tx', { op: 'bt', value: signedBatch({ n: 2, from: 2, to: 7, ops: [] }) });
    await until(async () => (await indexer.rpc('read', { key: 'bt/last' }))?.n === 2, 'fallback batch replicated');
    const exchange = await writer.rpc('request', { op: 'xc', request: { owner: writer.info.address, in: [['c','100']], out: [['compound','100']], nonce: '01'.repeat(32), until: 27 } });
    const mint = await writer.rpc('request', { op:'rq', request:{owner:writer.info.address,asset:'compound',amount:'40',receive:'99'.repeat(32),nonce:'02'.repeat(32),until:27,expires:459} });
    const mintId = bytesToHex(requestDigest(deployment.network,'rq',mint.request));
    const ops = [exchange, mint, {op:'mp',id:mintId}, {op:'mc',id:mintId,permitHash:'cd'.repeat(32),payments:[{key:'ef'.repeat(32),amount:'1',total:'1'}]}, {op:'rl',id:mintId,inscription:'ab'.repeat(32)+'i0'}, ...Array.from({ length: 100 }, (_, i) => ({ op: 'mk', to: writer.info.address, asset: 'large' + i, amount:'1' }))];
    await writer.rpc('tx', { op: 'bt', value: signedBatch({ n: 3, from: 8, to: 27, hx:headers.slice(7,27), ops }) });
    await until(async () => (await indexer.rpc('read', { key: 'bt/last' }))?.n === 3, 'large fallback batch replicated');
    await sync();
    const one = new Map(await indexer.rpc('rows')), two = new Map(await writer.rpc('rows'));
    invariants(one); invariants(two); assert.deepEqual(one, two);
    const owner = one.get(`a/${writer.info.address}`);
    assert.equal(one.has(`v/${owner}/c`),false); assert.equal(one.get(`v/${owner}/compound`),'60'); assert.equal(one.get(`v/${owner}/large99`),'1');
    assert.equal(one.get(`m/${mintId}`).s,1);assert.equal(one.get(`m/${mintId}`).inscription,'ab'.repeat(32)+'i0');
    assert.equal(one.has(`l/${firstLock}`), false); assert.equal(one.has(`l/${secondLock}`), false);
    const after = bufferToBigInt((await until(async () => {
      const node = await bus.state.getNodeEntry(writer.info.msbAddress);
      return node && bufferToBigInt(node.balance) < before ? node : null;
    }, 'TNK fee charged')).balance);
    assert.ok(after < before);
    const result = { ok: true, runtime: pear ? 'pear' : 'node', counted: one.get('b/cnt'),
      peerPids: [indexer.info.pid, writer.info.pid], viewEntries: one.size, tnkSpent: (before - after).toString(),
      paths: ['hd-msg', 'bt-msg', 'tf-tx', 'hl-tx', 'hc-tx', 'hr-tx', 'hd-tx', 'bt-tx'] };
    await shutdown();
    if (pear) for (const child of children) { const exit = await child.exited; assert.equal(exit.signal, null); assert.equal(exit.code, 0); }
    return result;
  } catch (error) {
    console.error('DMW_DEVNET_ERROR', error);
    throw error;
  } finally {
    await shutdown(); process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDevnet({ pear: process.argv.includes('--pear') }).then(result => console.log('DMW_DEVNET ' + JSON.stringify(result)), error => { console.error(error); process.exitCode = 1; });
}
