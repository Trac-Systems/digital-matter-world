import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { rotationBody, attestRotation, rotateRoster, verifyRotation } from '../rosters.mjs';
import { provisioningFixture } from '../../service/test/provisioning-fixture.mjs';
import { bindingFixture } from '../../service/test/bindings-fixture.mjs';
import { agent } from '../../service/test/helpers.mjs';
import { Bindings } from '../../service/src/bindings.mjs';

test('five local identity endpoints rotate one member with quorum continuity and retain old binding proofs', async t => {
  const f = await provisioningFixture(t), b = bindingFixture(f.store), who = agent(88), proof = await b.bind(who, 'tap');
  const clients = [];
  for (let i = 0; i < 6; i++) {
    const key = Buffer.alloc(32, 180 + i), peer = i < 5 ? b.members[i] : { id: 'replacement', identity: Buffer.from(ed25519.getPublicKey(key)).toString('hex') };
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks));
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/health' ? { id: peer.id, network: 'dmw-regtest', publicKey: f.policy.authorityKey, epoch: 1 } : attestRotation(body, peer.id, key.toString('hex'))));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
    clients.push({ id: peer.id, peer, token: 'local-test', url: 'http://127.0.0.1:' + server.address().port });
  }
  const path = join(f.store.directory, 'gateway.json'); await writeFile(path, JSON.stringify({ network: 'dmw-regtest', epoch: 1, committee: clients.slice(0, 5) }));
  const options = { replace: clients[0].id, replacement: clients[5] };
  assert.equal((await rotateRoster(path, options)).healthy, 5);
  const result = await rotateRoster(path, { ...options, dryRun: false }); assert.equal(result.restartRequired, true);
  const config = JSON.parse(await readFile(path, 'utf8'));
  const bindings = new Bindings({ store: f.store, network: 'dmw-regtest', bitcoinNetwork: 'regtest', members: config.committee.map(s => s.peer), rosterHistory: config.rosterHistory });
  assert.equal(bindings.proof(proof.id).id, proof.id); assert.equal(config.rosterHistory.length, 2);
  assert.throws(() => verifyRotation(result.body, result.votes.slice(0, 2), b.members), /rotation_quorum/);
  assert.throws(() => rotationBody('dmw-regtest', b.members, [clients[5].peer, clients[5].peer, ...b.members.slice(2)], f.policy.authorityKey));
});
