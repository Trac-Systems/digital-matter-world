import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../engine.mjs';
import { provisioningFixture } from '../../service/test/provisioning-fixture.mjs';

test('playground delegates provisioning to the durable service, including unbound discoverers', async t => {
  const f = await provisioningFixture(t), calls = [];
  const engine = new Engine({ config: {}, operatorCommand: async (_, request) => {
    calls.push(request); return f.complete(request.asset ?? 'p2');
  } });
  engine.write = () => { throw Error('playground_must_not_inscribe_assets'); };
  await engine.registerPatterns(); const result = await engine.ensureAsset('p2');
  assert.equal(result.state, 'registered'); assert.equal(result.definition.discoverer, f.pattern.discoverer);
  assert.deepEqual(calls, [{ action: 'provision' }, { action: 'provision', asset: 'p2' }]);
  assert.equal(f.packages.size, 2);
});
