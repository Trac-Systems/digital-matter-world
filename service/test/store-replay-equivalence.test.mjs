import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { rules } from '../src/rules.mjs';
import { v2StackFixture } from './v2-stack-fixture.mjs';
import { Feeds } from '../src/feeds.mjs';

// The reference captures the original store/projection implementation. Five
// independent policy services also replay each proposed batch in this scenario.
test('store optimizations preserve signed batch bytes, replay roots and closure page boundaries', { timeout: 180000 }, t =>
  v2StackFixture(t, { settingsValues: { settlementPageRows: 2, settlementPagesPerObservation: 1 }, scenario: async s => {
    t.after(() => rm(dirname(s.store.directory), { recursive: true, force: true }));
    s.pipeline.pipelineDepth = 1;
    const pattern = { ...s.legacyRecord, number: 0 };
    for (const [player, blocks] of [[0, [1, 10, 11]], [1, [12, 13, 14]]]) {
      await s.players[player].agent.claim({ event: { window: s.tip, hash: s.history.hashAt(s.tip) },
        plots: blocks.map(block => ({ block, patterns: [0] })), history: s.history, patterns: [pattern] });
      await s.drain();
    }
    await s.advance(1014); await s.runtime.intake.seal(); await s.drain();
    assert.equal(s.store.count('finds'), 6);
    const feeds = new Feeds({ store: s.store, files: s.files, history: s.history, reads: {} });
    while (s.store.count('feedEvents')) await feeds.events();
    const results = [];
    for (const { value: { batch } } of s.store.list('batches', { limit: 1000 })) {
      if (batch.v !== 2) continue;
      const replayed = await s.replayAccepted(batch.n);
      results.push({ n: batch.n, root: batch.root, digest: replayed.digest,
        batchBytes: rules.stableJSON(batch), fileDigests: replayed.files.map(file => rules.bytesToHex(rules.hashBytes(rules.encodeBinary(file)))),
        fileBytes: replayed.files.map(file => rules.encodeBinary(file).length), replayState: rules.hash(JSON.stringify(replayed.state)) });
    }
    assert.ok(results.length > 3);
    const fixture = new URL('./store-replay-fixture.json', import.meta.url);
    if (process.env.DMW_UPDATE_STORE_REPLAY_FIXTURE === '1') await writeFile(fixture, JSON.stringify(results, null, 2) + '\n');
    else assert.deepEqual(results, JSON.parse(await readFile(fixture)));
  } }));
