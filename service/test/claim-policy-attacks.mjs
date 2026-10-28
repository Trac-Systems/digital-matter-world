import assert from 'node:assert/strict';
import * as r from '../../rules/src/index.js';
import { Policy } from '../../committee/signer/policy.mjs';
import { BatchReplay } from '../../committee/signer/replay-worker.mjs';
import { preflightBatch } from '../../committee/signer/preflight.mjs';
import { rebuildBatch } from '../../committee/signer/adapter.mjs';

// Used inside the real five-policy/notary fixture, before each acceptance.
// Both accepted roots and account preflight come from that notary, not from
// the context being attacked. Replay runs in the ordinary signer worker.
export function claimAttackChecks({ network, store, contract, rulesContext, history, t, receiptFences }) {
  const replay = new BatchReplay(), done = new Set(); let prior, calls = 0;
  const check = async (draft, base) => {
    let context = base, proposal = draft.proposal, fetchNode, fetchNamed;
    const policy = new Policy({ network, publicKey: contract.options.committee, receiptFences: receiptFences?.(), replayBatch: replay.run.bind(replay), reads: {
      authority: async () => ({ network, committee: contract.options.committee, epoch: 0 }), counted: async () => draft.execution,
      rulesContext, settingsByHash: async hash => contract.db.get('v2/settings/' + hash),
      batchContext: async () => ({ ...context, history, hashAt: history.hashAt }),
      receiptCertificate: (tip, hash, segment) => store.get('receiptCertificates', `${tip}/${hash}/${segment}`),
      claimNode: async id => { calls++; return fetchNode?.(id); },
      namedNode: async (id, ancestors) => fetchNamed?.(id, ancestors),
      preflight: (batch, at) => preflightBatch(batch, at, { read: key => contract.db.get(key), deployment: contract.options })
    } });
    const attack = async (name, mutate, error) => {
      if (done.has(name)) return;
      context = structuredClone(base); proposal = structuredClone(draft.proposal); fetchNode = undefined; fetchNamed = undefined;
      mutate(context, proposal);
      await assert.rejects(policy.approve(proposal), error, name); done.add(name);
    };
    const snapshot = base.state.claimSnapshot;
    const closing = snapshot.hot.rounds.find(r => r.closing);
    if (closing) {
      await attack('rollback closure cursor', c => {
        c.state.rounds.find(r => r.window === closing.window).closing.scanPage = '0';
        c.state.rounds.find(r => r.window === closing.window).closing.phase = 'forged';
      }, /claim_state_hot/);
      await attack('replacement closure cursor with valid self-hash', (c, p) => {
        c.state.claimSnapshot.hot.rounds.find(r => r.window === closing.window).closing.phase = 'done';
        c.state.rounds = structuredClone(c.state.claimSnapshot.hot.rounds);
        c.state.claimRoot = r.claimStateRoot(c.state.claimSnapshot); p.batch.previousClaims = c.state.claimRoot;
      }, /batch_predecessor_state/);
    }
    if (snapshot.hot.rounds.length) {
      const policyRound = snapshot.hot.rounds.find(r => r.policy);
      if (policyRound) for (const field of ['settingsHash', 'claimsPerWindow', 'claimWindowBlocks', 'finderWindow']) {
        await attack(`changed round policy ${field}`, c => {
          c.state.rounds.find(r => r.window === policyRound.window).policy[field] = field === 'settingsHash' ? r.hash('forged-settings') : 999;
        }, /claim_state_hot/);
        await attack(`changed committed round policy ${field}`, (c, p) => {
          c.state.claimSnapshot.hot.rounds.find(r => r.window === policyRound.window).policy[field] = field === 'settingsHash' ? r.hash('forged-settings') : 999;
          c.state.rounds = structuredClone(c.state.claimSnapshot.hot.rounds);
          c.state.claimRoot = r.claimStateRoot(c.state.claimSnapshot); p.batch.previousClaims = c.state.claimRoot;
        }, /batch_predecessor_state/);
      }
      await attack('omitted accepted round', c => { c.state.rounds = []; }, /claim_state_hot/);
      await attack('replacement checkpoint with valid self-hash', (c, p) => {
        c.state.rounds = []; c.state.claimSnapshot.hot.rounds = [];
        c.state.claimRoot = r.claimStateRoot(c.state.claimSnapshot); p.batch.previousClaims = c.state.claimRoot;
      }, /batch_predecessor_state/);
      await attack('otherwise replay-valid omitted-round proposal', (c, p) => {
        c.state.rounds = []; c.state.claimSnapshot.hot.rounds = []; c.state.claimRoot = r.claimStateRoot(c.state.claimSnapshot);
        let state = c.state; const files = [];
        for (const input of c.inputs) {
          const out = r.processBlockV2({ ...input, state, settings: c.settings, network, gateway: c.gateway, patterns: c.patterns,
            executionHeight: c.counted, history, hashAt: history.hashAt, priorOperations: r.budgetOperations(files) }, { claimNodeGet: id => store.get('claimNodes', id) });
          state = out.state; files.push(out.file);
        }
        const built = r.buildBatchV2({ ...c.limits, network, epoch: p.batch.epoch, sequence: r.nextUint(r.decimalV2(c.last.n)), lastTo: c.last.to,
          previousRoot: c.previousRoot, files, executionHeight: c.counted, executionHash: history.hashAt(c.counted), deadline: p.batch.deadline,
          activation: c.activation, settings: c.settings, catalogRoot: state.catalogRoot, accountRoot: state.accountRoot, headers: c.headers });
        p.batch = built.batch; p.files = built.fileBytes.map(r.bytesToHex);
        assert.equal(rebuildBatch(network, p, { ...c, authority: { epoch: 0 }, history, hashAt: history.hashAt }).digest, r.bytesToHex(built.signingDigest));
      }, /batch_predecessor_state/);
    }
    const drawNode = base.inputs.flatMap(i => i.claimEvidence.nodes).find(([, node]) => node.value?.policy?.settingsHash && node.value?.senderRoot);
    if (drawNode) await attack('changed archived draw policy', c => {
      for (const input of c.inputs) {
        const node = input.claimEvidence.nodes.find(([id]) => id === drawNode[0]);
        if (node) node[1].value.policy.finderWindow++;
      }
    }, /claim_state_proof/);
    if (base.inputs.some(i => i.settingsDocuments?.length)) {
      await attack('unaccepted historical settings', c => {
        c.inputs.find(i => i.settingsDocuments?.length).settingsDocuments[0].values.finderWindow++;
      }, /settings_history_read/);
      await attack('omitted historical settings', c => {
        for (const input of c.inputs) input.settingsDocuments = [];
      }, /batch_settings|settings_unknown/);
      if (base.inputs.some(i => i.entries.some(e => e.move.t === 'discovery-reveal-v2'))) await attack('omitted original commitment settings', c => {
        for (const input of c.inputs) input.settingsDocuments = [];
      }, /settings_unknown/);
    }
    if (prior && prior.claimRoot !== base.state.claimRoot) await attack('rollback to old accepted checkpoint', (c, p) => {
      Object.assign(c.state, structuredClone(prior)); p.batch.previousClaims = prior.claimRoot;
    }, /batch_predecessor_state/);
    for (const field of r.CLAIM_MAPS) {
      const root = snapshot.maps[field].storage;
      if (!root) continue;
      await attack(`replace ${field} by authenticated empty map`, (c, p) => {
        c.state.claimSnapshot.maps[field] = { storage: null, root: r.EMPTY_NAMED_ROOT };
        c.state.claimRoot = r.claimStateRoot(c.state.claimSnapshot); p.batch.previousClaims = c.state.claimRoot;
      }, /batch_predecessor_state/);
      const item = base.inputs.findIndex(i => i.claimEvidence.nodes.some(([id]) => id === root));
      if (item < 0) continue;
      await attack(`corrupt ${field} proof`, c => {
        c.inputs[item].claimEvidence.nodes.find(([id]) => id === root)[1].prefix = 'bad';
      }, /claim_state_proof/);
      await attack(`omit ${field} proof`, c => {
        c.inputs[item].claimEvidence.nodes = c.inputs[item].claimEvidence.nodes.filter(([id]) => id !== root);
      }, /claim_state_proof/);
    }
    const round = snapshot.hot.rounds.find(r => r.closed && (r.cursor || r.offset));
    if (round) {
      await attack('rollback delivery cursor', c => {
        const r = c.state.rounds.find(r => r.window === round.window); r.cursor = 0; r.offset = 0;
      }, /claim_state_hot/);
      await attack('rollback committed cursor with new hash', (c, p) => {
        const round = c.state.claimSnapshot.hot.rounds.find(r => r.closed); round.cursor = 0; round.offset = 0;
        c.state.rounds = structuredClone(c.state.claimSnapshot.hot.rounds);
        c.state.claimRoot = r.claimStateRoot(c.state.claimSnapshot); p.batch.previousClaims = c.state.claimRoot;
      }, /batch_predecessor_state/);
      const oldPage = store.get('replay/settlementPages', `${round.window}/0`);
      const row = base.inputs.flatMap(i => i.claimEvidence.nodes).find(([, node]) => node.key === `${round.window}/${round.cursor}` && node.value?.winners);
      if (row && oldPage && r.stableJSON(row[1].value) !== r.stableJSON(oldPage)) await attack('stale accepted settlement page', c => {
        for (const input of c.inputs) { const leaf = input.claimEvidence.nodes.find(([id]) => id === row[0]); if (leaf) leaf[1].value = oldPage; }
      }, /claim_state_proof/);
    }
    if (base.inputs.some(i => i.claimEvidence.nodes.length) && !done.has('streamed authenticated reads')) {
      context = structuredClone(base); proposal = draft.proposal;
      for (const input of context.inputs) input.claimEvidence = { nodes: [] };
      fetchNode = id => store.get('claimNodes', id);
      const result = await policy.approve(proposal);
      assert.equal(result.digest, r.bytesToHex(r.batchDigest(network, proposal.batch))); assert.ok(calls > 0);
      done.add('streamed authenticated reads');
      await attack('unavailable streamed proof', c => { for (const input of c.inputs) input.claimEvidence = { nodes: [] }; }, /claim_state_proof/);
      await attack('malformed streamed proof cannot reject a move', c => {
        for (const input of c.inputs) input.claimEvidence = { nodes: [] };
        fetchNode = () => ({ prefix: 'bad', value: Array.from({ length: 20 }).reduce(v => [v], []) });
      }, /claim_state_proof/);
    }
    if (base.inputs.some(i => i.namedEvidence.nodes.length) && !done.has('streamed named proof')) {
      for (const input of base.inputs) assert(Buffer.byteLength(r.stableJSON({ nodes: input.namedEvidence.nodes, hints: input.namedEvidence.hints })) <= base.settings.document.values.proofBytes);
      context = structuredClone(base); proposal = draft.proposal;
      for (const input of context.inputs) input.namedEvidence.nodes = [];
      let hinted = false;
      fetchNamed = (id, ancestors) => { hinted ||= Array.isArray(ancestors); return store.get('namedNodes', id); };
      fetchNode = id => store.get('claimNodes', id);
      assert.equal((await policy.approve(proposal)).digest, r.bytesToHex(r.batchDigest(network, proposal.batch)));
      assert(hinted, 'streamed named reads preserve ancestor hints through the replay worker');
      done.add('streamed named proof');
      await attack('unavailable named proof', c => { for (const input of c.inputs) input.namedEvidence.nodes = []; }, /named_storage_/);
      await attack('corrupt streamed named proof', c => {
        for (const input of c.inputs) input.namedEvidence.nodes = [];
        fetchNamed = id => ({ ...store.get('namedNodes', id), prefix: 'forged' });
      }, /named_storage_/);
      await attack('malformed streamed named proof', c => {
        for (const input of c.inputs) input.namedEvidence.nodes = [];
        fetchNamed = () => ({ value: Array.from({ length: 20 }).reduce(v => [v], []) });
      }, /named_storage_/);
      await attack('invalid named hints', c => { c.inputs[0].namedEvidence.hints = ['not-a-node-hash']; }, /named_proof_hints/);
    }
    prior = { claimSnapshot: structuredClone(snapshot), claimRoot: base.state.claimRoot, ...structuredClone(snapshot.hot) };
  };
  check.close = () => replay.close();
  check.finish = () => {
    for (const name of ['omitted accepted round', 'replacement checkpoint with valid self-hash', 'rollback to old accepted checkpoint',
      'otherwise replay-valid omitted-round proposal', 'streamed named proof', 'unavailable named proof', 'corrupt streamed named proof', 'malformed streamed named proof', 'invalid named hints',
      'changed archived draw policy', 'unaccepted historical settings', 'omitted historical settings', 'omitted original commitment settings',
      ...['settingsHash', 'claimsPerWindow', 'claimWindowBlocks', 'finderWindow'].flatMap(k => [`changed round policy ${k}`, `changed committed round policy ${k}`]),
      'rollback delivery cursor', 'rollback committed cursor with new hash', 'stale accepted settlement page', 'streamed authenticated reads', 'unavailable streamed proof',
      ...r.CLAIM_MAPS.flatMap(k => [`replace ${k} by authenticated empty map`, `corrupt ${k} proof`, `omit ${k} proof`])]) assert.ok(done.has(name), name);
    t.diagnostic(JSON.stringify({ claimPolicyChecks: [...done], streamedClaimReads: calls }));
  };
  return check;
}
