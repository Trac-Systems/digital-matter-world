import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '../../committee/node_modules/@noble/curves/ed25519.js';
import { secp256k1 } from '../../committee/node_modules/@noble/curves/secp256k1.js';
import { createSigner } from '../../committee/signer/service.mjs';
import { fixture } from '../../committee/test/fixture.mjs';
import { publicScanBatch } from '../../committee/test/public-claim-batch-fixture.mjs';
import { observationFixture, requestInput, hashAt, network as legacyNetwork } from '../../rules/test/observation-fixture.mjs';
import { Committee } from '../src/committee.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { Store } from '../src/store.mjs';
import { rules } from '../src/rules.mjs';

export async function paymentTipFixture(t, { legacyRecovery = false, oldSigners = [], v2 = false, createLegacySigner = createSigner } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'payment-tip-'));
  let store = await Store.open(join(directory, 'gateway'));
  const financial = v2 ? await publicScanBatch() : null, network = financial?.proposal.network ?? legacyNetwork;
  const input = requestInput(fixture().publicKey), contexts = new Map();
  const makeDraft = fresh => {
    const o = observationFixture();
    o.add(100, 95, { mintOperations: fresh ? [] : [input] });
    if (fresh) o.add(101, 96, { mintOperations: [input] });
    const built = o.build(), proposal = { network, kind: 'batch', batch: built.batch, files: built.fileBytes.map(rules.bytesToHex) };
    contexts.set(built.batch.root, o.context());
    return { version: 3, execution: fresh ? 96 : 95, proposal };
  };
  const old = v2 ? { version: 3, execution: '1200', proposal: financial.proposal, settings: financial.context.settings } : makeDraft(false);
  const fresh = v2 ? null : makeDraft(true), key = `batch/0/${old.proposal.batch.n}`;
  if (v2) contexts.set(old.proposal.batch.root, financial.context);
  let counted = v2 ? '1200' : 95, tip = v2 ? '1200' : 100, published = contexts.get(old.proposal.batch.root), race = true, offline = new Set();
  const last = v2 ? financial.context.last : { n: 0, to: 94 };
  const members = Array.from({ length: 5 }, (_, i) => ({ id: 'signer' + i,
    identity: rules.bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(i + 10))) }));
  const signers = [], servers = [], configs = [], reads = [], states = [], calls = [];
  const gatewayReads = { counted: async () => counted, batchLast: async () => last,
    committeeEpoch: async () => v2 ? '0' : 0, batchRoot: async () => null,
    batchStamp: async () => ({ counted, tip, tipHash: hashAt(tip), revision: String(tip), last }) };
  const secrets = i => ({ journalKey: 'disposable-test', sidecarToken: 'disposable-test', identity: Buffer.alloc(32, i + 10).toString('hex') });
  t.after(async () => {
    for (const signer of signers) await signer?.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await store.close(); await rm(directory, { recursive: true });
  });
  for (let i = 0; i < 5; i++) {
    const f = fixture(), state = { session: null, signed: [] }; states.push(state);
    const r = { ...f.reads, ...financial?.reads, ...gatewayReads,
      authority: async () => ({ network, committee: f.publicKey, epoch: v2 ? '0' : 0 }), batchContext: async () => published, tip: async () => ({ tip }),
      balance: async () => '30', nonceUsed: async () => false, assetContext: async () => ({ ...structuredClone(input.evidence.context), payouts: {} }), mintPayoutSnapshot: async () => ({ payouts: {} }),
      bitmap: async () => null, isMinted: async () => false, blockHold: async () => null };
    reads.push(r);
    const server = createServer(async (req, res) => {
      let bytes = ''; for await (const chunk of req) bytes += chunk;
      const body = JSON.parse(bytes || '{}');
      if (req.url === '/prepare') state.session = { id: body.id, status: 'prepared', digest: body.digest };
      if (req.url === '/abort') state.session = null;
      if (req.url === '/go') {
        const signature = secp256k1.sign(state.session.digest, new Uint8Array(32).fill(2), { prehash: false, lowS: true });
        state.signed.push(state.session.digest);
        state.session = { ...state.session, status: 'complete', signature: { compact: signature.toCompactHex(), r: String(signature.r), s: String(signature.s), v: signature.recovery } };
      }
      if (req.url === '/result') { res.writeHead(409).end('{"error":"session_missing"}'); return; }
      res.end(JSON.stringify({ public: f.publicKey, epoch: 1, session: state.session }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
    const config = { directory: join(directory, members[i].id), network, id: members[i].id, epoch: 1, members,
      sidecar: 'http://127.0.0.1:' + server.address().port,
      ...(v2 ? { resources: rules.resourceRevision({ operator: members[i].id, values: rules.RESOURCE_PROFILE }) } : {}) };
    configs.push(config); signers.push(await (oldSigners.includes(i) ? createLegacySigner : createSigner)(config, secrets(i), r));
  }
  let releaseFirst;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const makeCommittee = () => {
    const c = new Committee({ store, network, batchRetryMs: 1, signers: members.map(peer => ({ id: peer.id, peer })) });
    if (legacyRecovery) c.retireStaleFinancial = undefined;
    c.request = async (member, path, body) => {
      const i = members.findIndex(m => m.id === member.id); calls.push({ i, path, body });
      if (offline.has(i)) throw Error('committee_http_timeout');
      if (createLegacySigner === createSigner && oldSigners.includes(i) && ['/reject-stale-batch', '/retire-rejected-batch'].includes(path)) throw Error('committee_route');
      if (race && path === '/prepare' && i !== 0) await first;
      try {
        const result = await signers[i].handle(path, body);
        if (race && path === '/prepare' && i === 0) { tip = v2 ? '1201' : 101; counted = v2 ? '1201' : 96; releaseFirst(); }
        return result;
      } catch (error) { if (race && path === '/prepare' && i === 0) releaseFirst(); throw Object.assign(Error('committee_' + error.message), { unreserved: !!error.unreserved }); }
    };
    return c;
  };
  let committee = makeCommittee();
  const pipeline = new Pipeline({ store, committee, reads: gatewayReads, replay: { close: async () => {} } });
  const due = async () => {
    const session = store.get('ceremonies', key);
    if (session) await store.put('ceremonies', key, { ...session, started: 0, lastReset: 0,
      ...(session.recovery ? { recovery: { ...session.recovery, checkedAt: 0 } } : {}) });
  };
  return { old, fresh, key, network, members, signers, reads, states, calls, configs, gatewayReads,
    get store() { return store; }, get committee() { return committee; }, pipeline,
    setOffline: indices => { offline = new Set(indices); }, setClock: (c, h = c + 5) => { counted = c; tip = h; }, due,
    digest: draft => rules.bytesToHex(rules.batchDigest(network, draft.proposal.batch)),
    records: async i => (await readFile(join(configs[i].directory, 'signed.log'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
    async startRace() {
      await pipeline.saveDraft(old);
      assert.equal(await committee.signature(key, old.proposal), null); race = false;
      const attempt = store.get('ceremonies', key);
      assert.deepEqual(attempt.failures, ['committee_batch_snapshot', 'committee_batch_snapshot']);
      assert.equal((await signers[0].handle('/preparation-state', { id: attempt.id })).reserved, true);
      assert.equal(counted, v2 ? '1201' : 96); await due(); return attempt;
    },
    async restartSigner(i) { await signers[i].close(); signers[i] = await (oldSigners.includes(i) ? createLegacySigner : createSigner)(configs[i], secrets(i), reads[i]); },
    async restartGateway() { await store.close(); store = await Store.open(join(directory, 'gateway')); committee = makeCommittee(); pipeline.store = store; pipeline.committee = committee; },
    async finish(draft = fresh) {
      published = contexts.get(draft.proposal.batch.root); await pipeline.saveDraft(draft);
      let result = await committee.signature(key, draft.proposal);
      result ??= await committee.signature(key, draft.proposal);
      assert.ok(result?.signature); return result;
    }
  };
}
