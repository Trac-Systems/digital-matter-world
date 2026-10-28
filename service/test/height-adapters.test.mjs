import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Intake } from '../src/intake.mjs';
import { Replay } from '../src/replay.mjs';
import { HeaderFiles } from '../src/header-files.mjs';
import { rules, initialState } from '../src/rules.mjs';
import { validateManifest } from '../../kit/lib/header-download.mjs';
import { newStore, agent, secret, network, attestRoot, receiptSigners } from './helpers.mjs';

const raw = (await readFile(new URL('../../kit/test/fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim().slice(0, 160);
const hash = rules.parseHeader(raw).hash;
test('header manifest and named route accept heights beyond the old calendar ceilings and reject rounded byte lengths', async () => {
  for (const height of [2000001, 4000001, 10000000]) {
    const manifest = { version: 1, network: 'mainnet', height, count: height + 1, bytes: (height + 1) * 80, tip: hash, sha256: hash, path: `/headers/mainnet-${height}-${hash}.bin` };
    assert.equal(validateManifest(manifest, 'mainnet'), manifest);
    const headers = new HeaderFiles({ network: 'mainnet', files: {}, history: { length: height + 1, hashAt: () => hash } });
    headers.current = manifest; assert.equal(await headers.manifest(), manifest);
    let body;
    assert.equal(await headers.serve({ method: 'GET', url: `/headers/height/${height}.json` }, { setHeader() {}, end: value => { body = value; } }), true);
    assert.equal(JSON.parse(body).height, height);
  }
  assert.throws(() => validateManifest({ version: 1, network: 'mainnet', height: Number.MAX_SAFE_INTEGER, count: Number.MAX_SAFE_INTEGER + 1, bytes: (Number.MAX_SAFE_INTEGER + 1) * 80, tip: hash, sha256: hash, path: `/headers/mainnet-${Number.MAX_SAFE_INTEGER}-${hash}.bin` }, 'mainnet'), /manifest/);
});
test('intake and nondatabase replay work above two million using bounded requested pages', async () => {
  const store = await newStore(), replay = new Replay({ headerPageSize: 128 }), who = agent(), tip = 2000010;
  let reads = 0;
  const history = { length: tip + 1, hashAt: h => h >= 0 && h <= tip ? hash : null, raw: () => { reads++; return raw; } };
  try {
    const intake = new Intake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
    await intake.observe({ tip, hash, counted: tip, confirmed: tip });
    const proposal = { name: 'dmwheight', pat: '1', fld: 4, dt: 'n' }, salt = rules.hash('height fixture');
    const commitment = rules.discoveryCommitment(proposal, salt, who.address);
    const move = rules.solveMove({ v: 1, network, a: who.address, t: 'discovery-reveal', b: tip, h: hash, p: { proposal, salt } }, who.secret, 0);
    await intake.accept(rules.stableJSON(move));
    const entries = intake.entries().map(r => r.value), sealed = await intake.seal();
    const state = { ...initialState(tip, hash, tip - 1), discoveryCommits: [{ agent: who.address, commitment, tip: tip - 2 }] };
    const output = await replay.run({ network, gateway: intake.gateway, tip, tipHash: hash, height: tip, blockHash: hash,
      state, patterns: [], entries, receiptRoot: sealed.receiptRoot, rootAttestations: await attestRoot(sealed.receiptRoot), settings: { puzzleBits: 0, receiptSigners } }, history);
    assert.equal(output.file.moves[0].reason, 'accepted'); assert.equal(output.file.discovery.work, 4096);
    assert.ok(reads <= 4096 + 3 * 128, `only bounded work pages were read: ${reads}`);
  } finally { await replay.close(); await store.close(); }
});
