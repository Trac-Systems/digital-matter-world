import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { localNetwork, until } from '../../contract/tests/helpers/local-network.mjs';
import { controls } from '../../contract/runtime/control.js';
import { deployment, signedBatch } from '../../contract/tests/helpers/harness.mjs';
import { chain, checkpoint } from '../../contract/tests/helpers/chain.mjs';
import { runtimeTrac } from '../../kit/lib/trac.mjs';
import { settlePaid } from '../scripts/soak/paid.mjs';
import { build, diskFloor, recorded, save } from '../scripts/soak/common.mjs';

test('soak retries retain identity on a real local MSB/Trac ledger', { timeout: 120000 }, async () => {
  await diskFloor(); await mkdir(join(build, 'service'), { recursive: true });
  await save(join(build, 'service', 'soak-transport-process.json'), await recorded(process.pid, 'soak-transport-test'));
  const directory = await mkdtemp(join(build, 'service', 'soak-transport-')), local = await localNetwork({ directory, cleanup: false });
  try {
    const validator = await local.msb(), bus = await local.client(validator);
    const indexer = await local.peer('indexer', bus), writer = await local.peer('writer', bus, indexer.base.key.toString('hex'));
    for (const peer of [indexer, writer]) await local.fund(validator, peer.wallet);
    const admin = controls(indexer, bus); await admin.setup({ writer: writer.writerLocalKey }); await until(() => writer.base.writable, 'writer');
    await admin.post({ op: 'hd', value: { headers: chain(6, checkpoint) } });
    await admin.post({ op: 'bt', value: signedBatch({ n: 1, from: 1, to: 1, ops: [{ op: 'mk', to: writer.wallet.publicKey, asset: 'load', amount: '10' }] }) });
    const kit = runtimeTrac(writer, { network: deployment.network, localOnly: true, msb: bus });
    await until(async () => await kit.balance(writer.wallet.publicKey, 'load') === '10', 'credits');
    const accepted = [];
    for (const mode of ['drop', 'lost-response', 'normal']) {
      let first = true, prepared = 0; const persisted = [], sent = [];
      const client = {
        prepare: async (...args) => { prepared++; return kit.prepare(...args); },
        transactionStatus: tx => kit.transactionStatus(tx),
        submit: async packet => {
          sent.push(structuredClone(packet)); const initial = first; first = false;
          if (mode === 'drop' && initial) return { tx: packet.tx };
          const response = await kit.submit(packet);
          if (mode === 'lost-response' && initial) throw Error('response lost');
          return response;
        }
      };
      const tx = await settlePaid({ client, wallet: writer.wallet, op: 'tf', value: { to: writer.wallet.publicKey, assets: [['load', '1']] },
        connect: async () => { if (!bus.network.validatorConnectionManager.connectionCount()) await bus.network.tryConnect(validator.wallet.publicKey.toString('hex'), 'validator'); },
        persist: async row => persisted.push(structuredClone(row)), retryMs: 200 });
      assert.equal(prepared, 1); assert.equal(persisted[0].state, 'prepared'); assert.equal(persisted.at(-1).state, 'accepted');
      for (const packet of sent) assert.deepEqual(packet, persisted[0].packet);
      if (mode === 'drop') assert.ok(sent.length >= 2);
      assert.equal((await kit.transactionStatus(tx)).state, 'accepted'); accepted.push(tx);
    }
    assert.equal(new Set(accepted).size, 3); assert.equal(await kit.balance(writer.wallet.publicKey, 'load'), '10');
    assert.equal(await admin.read({ key: 'txl' }), 3, 'one accepted ledger transaction per signed identity');
  } finally { await local.close(); await rm(directory, { recursive: true, force: true }); }
});
