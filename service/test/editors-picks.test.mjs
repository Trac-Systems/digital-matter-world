import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWeb, staticWebRequest } from '../src/web.mjs';
import { PICKS_URL, readPicks, readPick, pickNow, roughTime, NOW_PILLS } from '../public/web/picks-data.js';

const file = new URL('../public/web/data/editors-picks.json', import.meta.url);
const pick = (extra = {}) => readPick({ asset: 'p2:4', name: 'jackpot', title: 'jackpot: 777 in the nonce', highlightBlocks: ['974462'], ...extra });

test('the picks file served with the site is valid and every pick has a card', async () => {
  const raw = JSON.parse(await readFile(file, 'utf8')), doc = readPicks(raw);
  assert.equal(raw.v, 1);
  assert.ok(doc.intro && doc.updated);
  assert.equal(doc.picks.length, raw.picks.length);
  for (const p of doc.picks) {
    assert.match(p.asset, /^p2:\d+$/);
    assert.ok(p.title && p.utility && p.why && p.points.length && p.facts.length, p.name);
  }
});

test('missing or broken fields leave a card with what is there', () => {
  assert.deepEqual(readPicks(null), { intro: '', updated: null, stats: [], statsNote: '', tierNote: '', picks: [] });
  assert.deepEqual(readPicks({ picks: 'nope', updated: 'yesterday' }).picks, []);
  const doc = readPicks({ picks: [null, 7, [], {}, { name: 'bare' }, { title: '  Spaced   out  ', points: ['plain text', { lead: 'Lead.' }, {}, 3], facts: [{ label: 'Only label' }, { label: 'Blocks', value: 100 }], highlightBlocks: ['1', 1, '01', '-2', 'x', '1'], kind: 'other' }] });
  assert.equal(doc.picks.length, 2);
  assert.deepEqual(doc.picks[0], { asset: null, name: 'bare', title: 'bare', emoji: '', tagline: '', utility: '', why: '', points: [], facts: [], kind: 'utility', tier: null, related: [], blocks: [] });
  const second = doc.picks[1];
  assert.equal(second.title, 'Spaced out');
  assert.deepEqual(second.points, [{ lead: '', text: 'plain text' }, { lead: 'Lead.', text: '' }]);
  assert.deepEqual(second.facts, [{ label: 'Blocks', value: '100' }]);
  assert.deepEqual(second.blocks, ['1']);
  assert.equal(readPick({ title: 'Meme', kind: 'meme' }).kind, 'meme');
  assert.equal(readPick({ title: 'x'.repeat(500) }).title.length, 140);
  assert.equal(readPicks({ picks: Array.from({ length: 60 }, (_, i) => ({ title: 'P' + i })) }).picks.length, 40);
});

test('stats, notes, the editor\'s tier and related patterns', () => {
  const doc = readPicks({ stats: [{ label: 'Patterns discovered', value: '3,614' }, { label: 'No value' }, 'junk'], statsNote: ' Up to block 974,466. ', tierNote: 'Tiers count all of history.',
    picks: [{ asset: 'p2:18', title: 'pizza', tier: 5, related: [{ asset: 'p2:2142', name: 'pizzaday' }, { asset: 'p2:2142', name: 'again' }, { asset: 'p2:18', name: 'itself' }, { asset: 'bad', name: 'x' }, { asset: 'p2:1302' }] },
      { title: 'odd tiers', tier: 7 }, { title: 'text tier', tier: '3' }] });
  assert.deepEqual(doc.stats, [{ label: 'Patterns discovered', value: '3,614' }]);
  assert.equal(doc.statsNote, 'Up to block 974,466.');
  assert.equal(doc.tierNote, 'Tiers count all of history.');
  assert.equal(doc.picks[0].tier, 5);
  assert.deepEqual(doc.picks[0].related, [{ asset: 'p2:2142', name: 'pizzaday' }, { asset: 'p2:1302', name: '' }]);
  assert.deepEqual([doc.picks[1].tier, doc.picks[2].tier], [null, null]);
});

test('a pick without highlighted blocks still links its public blocks', () => {
  const now = pickNow(pick({ highlightBlocks: undefined }), { token: { step: 'deployed' } });
  assert.deepEqual([now.mint.state, now.mint.href], [null, '/mint?asset=p2%3A4']);
  assert.equal(now.claim, null);
});

test('an asset that is not a pattern gives a card without links or live state', () => {
  for (const asset of ['jackpot', 'p2:04', 'c2:' + 'ab'.repeat(32), '/etc/passwd', 4]) assert.equal(readPick({ title: 't', asset }).asset, null);
  assert.deepEqual(pickNow(readPick({ title: 't', asset: 'nope' }), { token: { step: 'deployed' }, block: { state: 'public' } }), { token: null, mint: null, claim: null });
});

test('failed reads leave their line out', () => {
  const now = pickNow(pick(), { token: null, block: null, tip: '974466' });
  assert.deepEqual([now.token, now.mint, now.claim], [null, null, null]);
  assert.equal(now.mintAll, '/mint?asset=p2%3A4');
  // A block state for a pick with no highlighted block says nothing about a block.
  assert.equal(pickNow(pick({ highlightBlocks: [] }), { block: { state: 'public' } }).mint.state, null);
  // An unexpected state is not guessed at.
  assert.equal(pickNow(pick(), { block: { state: 'something_new' } }).mint, null);
});

test('token: created, being created, or who can create it now', () => {
  assert.equal(pickNow(pick(), { token: { step: 'deployed' } }).token.state, 'created');
  assert.equal(pickNow(pick(), { token: { step: 'inflight' } }).token.state, 'creating');
  const week = pickNow(pick(), { token: { step: 'none', deployer: { onlyDiscoverer: true, until: '975205' } }, tip: '974466' }).token;
  assert.deepEqual([week.state, week.who, week.until, week.href], ['none', 'discoverer', '975205', '/mint/p2:4']);
  assert.match(week.text, /Until block 975,205 \(about 5 days\) only its discoverer can create it\. After that, anyone can\./);
  const anyone = pickNow(pick(), { token: { step: 'inscribed', deployer: { onlyDiscoverer: false } } }).token;
  assert.equal(anyone.who, 'anyone');
  assert.match(anyone.text, /^The pattern is inscribed; its token is not created yet\. Anyone can create it now/);
});

test('mint: public blocks link the mint flow; closed ones say when they open', () => {
  const open = pickNow(pick(), { block: { state: 'public' } });
  assert.deepEqual([open.mint.state, open.mint.href, open.mint.all], ['public', '/mint?asset=p2%3A4&block=974462', '/mint?asset=p2%3A4']);
  assert.ok(open.claim, 'a public block is untaken, so agents can still claim it');
  const soon = pickNow(pick(), { block: { state: 'not_yet_public', publicFrom: '975470' }, tip: '974466' });
  assert.equal(soon.mint.state, 'opens');
  assert.equal(soon.mint.text, 'Block 974,462 opens for public minting at block 975,470 (about 7 days), unless an agent claims it first.');
  assert.equal(soon.claim.href, '/about#steps');
  assert.equal(pickNow(pick(), { block: { state: 'not_yet_public', publicFrom: '975470' } }).mint.text.includes('about'), false, 'no tip, no rough time');
  for (const [state, want] of [['claimed', 'claimed'], ['finder', 'claimed'], ['already_minted', 'minted'], ['paid', 'pending'], ['block_pending', 'pending']]) {
    const now = pickNow(pick(), { block: { state } });
    assert.equal(now.mint.state, want, state);
    assert.equal(now.claim, null, state);
  }
  for (const part of ['token', 'mint']) for (const [label] of Object.values(NOW_PILLS[part])) assert.ok(label);
});

test('rough times read like the rest of the site', () => {
  assert.deepEqual([1, 5, 6, 30, 144, 1004].map(roughTime), ['about 10 minutes', 'about 50 minutes', 'about 1 hour', 'about 5 hours', 'about 1 day', 'about 7 days']);
  assert.equal(roughTime(0), null);
  assert.equal(roughTime(-3), null);
});

function request(path, accept = 'application/json') {
  return { url: path, method: 'GET', headers: { accept, host: '127.0.0.1' } };
}
function response() {
  const headers = {};
  return { headers, statusCode: 200, setHeader(k, v) { headers[k.toLowerCase()] = v; }, end(body) { this.body = body; } };
}
test('the gateway serves the picks page, its modules and the picks file as it is on disk', async () => {
  const web = createWeb(null);
  for (const path of ['/web/picks.js', '/web/picks-data.js', PICKS_URL]) assert.equal(staticWebRequest(request(path)), true, path);
  assert.equal(staticWebRequest(request('/editors-picks', 'text/html')), true);
  assert.equal(staticWebRequest(request('/web/data/other.json')), false);
  const res = response();
  assert.equal(await web.handle(request(PICKS_URL), res), true);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(res.body), JSON.parse(await readFile(file, 'utf8')));
  const page = response();
  assert.equal(await web.handle(request('/editors-picks', 'text/html'), page), true);
  assert.match(String(page.body), /<div id="app"><\/div>/);
});
