import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeBinary } from '../../rules/src/index.js';
import { ServiceClient } from '../lib/service-client.mjs';
import { Agent } from '../lib/agent.mjs';
import { backtest } from '../lib/backtest.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/v2-live-audit.json', import.meta.url)));
const bytes = Buffer.from(fixture.bytesBase64, 'base64'), file = decodeBinary(bytes), move = file.moves[0].move;
const makeClient = (overrides = {}) => new ServiceClient({ mode: 'mainnet', ...fixture, fetchImpl: async (url, options) => {
  assert.equal(options.method, 'GET'); assert.equal(new URL(url).pathname, fixture.publication.audit.path);
  return new Response(bytes);
}, ...overrides });
const hashAt = async height => { assert.equal(height, Number(file.tip)); return fixture.tipHash; };

test('recorded v2 audit verifies decimal provenance, receipt segment and witness signatures without rewriting bytes', async () => {
  const client = makeClient();
  const proof = await client.inclusion(move, { publication: fixture.publication, hashAt });
  assert.equal(proof.verified, true); assert.equal(proof.inclusion, 'witnessed');
  assert.equal(proof.contractCommitted, false, 'Witnessed admission is not independent batch acceptance');
  assert.equal(typeof proof.publication.height, 'string'); assert.equal(typeof proof.receipt.tip, 'string');
  assert.equal(proof.seal.v, 2);
  await assert.rejects(client.audit({ ...fixture.publication, observation: '0' }, { hashAt }), /Foreign audit/);
  await assert.rejects(client.audit(fixture.publication, { hashAt: async () => '00'.repeat(32) }), /differs from verified chain/);
  const damaged = Buffer.from(bytes); damaged[damaged.length - 1] ^= 1;
  await assert.rejects(makeClient({ fetchImpl: async () => new Response(damaged) }).audit(fixture.publication, { hashAt }), /Publication hash mismatch/);
  const foreignMembers = fixture.receiptSigners.map((m, i) => ({ ...m, identity: String(i + 1).repeat(64) }));
  await assert.rejects(makeClient({ receiptSigners: foreignMembers }).audit(fixture.publication, { hashAt }), /signer quorum/);
});

test('v2 receipt lookup follows empty cursor pages without a legacy height filter or string concatenation', async () => {
  const calls = [], client = makeClient();
  client.receipts = async options => {
    calls.push(options);
    assert.equal(options.height, undefined); assert.equal(options.limit, 50); assert.equal(options.order, 'desc');
    return calls.length === 1 ? { receipts: [], nextCursor: 'continue' } : {
      receipts: [{ seal: file.receiptRoot, archive: fixture.publication.audit }], nextCursor: null
    };
  };
  assert.deepEqual(await client.receiptPublication(move), fixture.publication);
  assert.equal(calls.length, 2); assert.equal(calls[1].cursor, 'continue');
});

test('v2 status exposes the specific missing accepted-batch verifier and preserves its packet', async () => {
  const saved = { body: move, state: 'received', result: file.receipts[0] };
  const agent = { journal: { get: () => saved, evidence: () => ({ outcome: null }) }, reconcileAction: Agent.prototype.reconcileAction };
  assert.deepEqual(await Agent.prototype.reconcileActions.call(agent, ['header/' + file.tip]), [
    { id: 'header/' + file.tip, reason: 'v2_batch_verifier_required' }
  ]);
  assert.deepEqual(saved.body, move);
});

test('legacy replay refuses activated settings or named catalogs before making v1 settlement assumptions', async () => {
  for (const input of [{ settings: { ruleset: 'dmw-v2' }, patterns: [] }, { patterns: [{ number: '0', key: 'ab'.repeat(32), asset: 'p2:0' }] }]) {
    await assert.rejects(backtest({ ...input, start: 0, end: 0 }), /V2 backtests require accepted catalog and claim-state snapshots/);
  }
});
