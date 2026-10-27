import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../src/store.mjs';
import { Committee } from '../src/committee.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { rules } from '../src/rules.mjs';
import { hash } from '../src/util.mjs';
import { temp, network, agent } from './helpers.mjs';



for (const reserved of [false, true]) test(`rejected draft ${reserved ? 'retains a reserved ceremony' : 'automatically rebuilds after all original signers fence it'}`, async () => {
  const store = await Store.open(await temp('unprepared-')), servers = [], signers = [], id = hash('session'), key = 'batch/0/1';
  let fences = 0;
  try {
    for (let i = 0; i < 5; i++) {
      const server = createServer(async (req, res) => {
        let text = ''; for await (const chunk of req) text += chunk; const body = JSON.parse(text);
        assert.equal(body.id, id);
        if (req.url === '/status') {
          if (reserved && i === 0) res.end(JSON.stringify({ status: 'prepared' }));
          else res.writeHead(409).end('{"error":"ceremony_id"}');
        } else { assert.equal(req.url, '/retire-unprepared'); fences++; res.end(JSON.stringify({ id, status: 'retired-unprepared' })); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
      signers.push({ id: 's' + i, url: 'http://127.0.0.1:' + server.address().port, token: 'local-test' });
    }
    const proposal = { kind: 'batch', network, batch: { epoch: 0, n: 1, deadline: 106, root: hash('old') } };
    const session = { id, proposal, stage: 'blocked', reason: 'prepare_incomplete', peers: ['s0', 's1', 's2'], failures: Array(3).fill('committee_header_sender') };
    await store.put('ceremonies', key, session);
    const p = new Pipeline({ store, committee: new Committee({ store, network, signers }), replay: {},
      reads: { batchLast: async () => ({ n: 0, to: 94 }), counted: async () => 100, committeeEpoch: async () => 0, batchRoot: async () => null } });
    const draft = { proposal, execution: 100 }; await p.saveDraft(draft);
    const result = await p.reconcileDraft(await p.loadDraft());
    assert.equal(fences, reserved ? 0 : 3);
    if (reserved) { assert.deepEqual(result.draft, draft); assert.deepEqual(store.get('ceremonies', key), session); }
    else {
      assert.equal(result.draft, null); assert.equal(store.get('ceremonies', key), null);
      assert.equal(store.list('supersededDrafts')[0].value.proof.reason, 'preparation_unreserved');
      assert.equal(await p.loadDraft(), null);
    }
  } finally { for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await store.close(); }
});
