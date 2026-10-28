import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../signer/journal.mjs';
import { canonicalJSON, mac } from '../signer/crypto.mjs';

test('journal upgrades to decimal positions without rewriting retained MACs and reopens exactly', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'g4b2-journal-')), 'journal'), key = 'disposable';
  let journal = await new Journal(path, key, 'fixture', 'one').load();
  await journal.append('tip', { highestTip: 1 }); await journal.close();
  const legacy = await readFile(path, 'utf8');
  journal = await new Journal(path, key, 'fixture', 'one', { decimalIndex: true }).load();
  assert.equal(journal.nextIndex, '1');
  const position = await journal.append('tip', { highestTip: '9'.repeat(80) });
  assert.equal(position.index, '1'); await journal.close();
  const upgraded = await readFile(path, 'utf8'); assert.ok(upgraded.startsWith(legacy));
  journal = await new Journal(path, key, 'fixture', 'one').load();
  assert.equal((await journal.append('tip', { highestTip: '1' + '0'.repeat(80) })).index, '2');
  await assert.rejects(journal.append('tip', { index: '3' }), /journal_fields/);
  await journal.close();
  // A valid MAC cannot conceal a skipped position in the retained chain.
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
  const { tag, ...last } = rows.at(-1); last.index = '9007199254740993';
  rows[rows.length - 1] = { ...last, tag: mac(key, last) };
  await writeFile(path, rows.map(canonicalJSON).join('\n') + '\n');
  await assert.rejects(new Journal(path, key, 'fixture', 'one').load(), /journal_integrity/);
});

for (const base of ['9007199254740991', '9223372036854775807', '9'.repeat(80)]) test(`journal append arithmetic at synthetic retained position ${base}`, async () => {
  const journal = new Journal('unused', 'disposable', 'fixture', 'one', { decimalIndex: true }), lines = [];
  // Synthetic trusted checkpoint: this tests the writer, not a fabricated
  // claim that the test has persisted all preceding journal records.
  journal.nextIndex = base; journal.file = { async write(line) { lines.push(line); }, async sync() {} };
  await journal.append('tip', { highestTip: base }); await journal.append('tip', { highestTip: base });
  assert.deepEqual(lines.map(line => JSON.parse(line).index), [base, String(BigInt(base) + 1n)]);
});
