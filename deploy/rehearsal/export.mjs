import { MigrationRows } from '../../service/src/migration-pages.mjs';
import { isApplicationNotaryKey } from '../../contract/runtime/notary-records.js';
import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { realpath, open, mkdir, writeFile, statfs, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { rules as r } from '../../service/src/rules.mjs';

const need = (ok, reason) => { if (!ok) throw Error(reason); };
const sensitivePath = /(?:^|[/_.-])(?:credentials?|secrets?|keypair|keyshare|wallet|cookie)(?:[/_.-]|$)|source\.url/i;
const sensitiveField = /^(?:secret|secrets|secretKey|privateKey|private_key|keypair|keyshare|shares|journalKey|mnemonic|seedPhrase|preimage|password|passphrase|apiKey|apiToken|sidecarToken|authorizationHeader|sourceURL|sourceUrl|tapSource|tapSourceFile)$/i;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => r.stableJSON(a) === r.stableJSON(b);

export function checkPublic(value) {
  if (!value || typeof value !== 'object') return;
  if (value instanceof MigrationRows) { checkPublic(value.commitment); return; }
  for (const [key, child] of Object.entries(value)) {
    need(!sensitiveField.test(key), 'export_private_field');
    checkPublic(child);
  }
}
async function regular(path) {
  need(typeof path === 'string' && path === resolve(path) && !sensitivePath.test(path), 'export_input_path');
  need(await realpath(path) === path, 'export_symlink');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { need((await fd.stat()).isFile(), 'export_regular_file'); return fd; }
  catch (error) { await fd.close(); throw error; }
}
export async function readPublicJSON(path) {
  const fd = await regular(path);
  try { const bytes = await fd.readFile(); const value = JSON.parse(bytes); checkPublic(value); return { value, sha256: hash(bytes), bytes: bytes.length }; }
  finally { await fd.close(); }
}
const readJSON = readPublicJSON;
async function fileDigest(path) {
  const fd = await regular(path), h = createHash('sha256'); let bytes = 0;
  try { for await (const chunk of fd.createReadStream({ autoClose: false })) { h.update(chunk); bytes += chunk.length; } return { bytes, sha256: h.digest('hex') }; }
  finally { await fd.close(); }
}
async function optionalDigest(path) {
  try { return await fileDigest(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
async function save(path, value) { await writeFile(path, r.stableJSON(value) + '\n', { mode: 0o600, flag: 'wx' }); }
async function copyExact(from, to) {
  const source = await regular(from), target = await open(to, 'wx', 0o600);
  try { for await (const chunk of source.createReadStream({ autoClose: false })) await target.writeFile(chunk); await target.sync(); }
  finally { await target.close(); await source.close(); }
}
async function disk(path, reserveGiB, extra = 0) {
  const st = await statfs(path); need(st.bavail * st.bsize - extra >= reserveGiB * 1024 ** 3, 'export_disk_reserve');
}

// A neutral v1-compatible checkpoint, without newer Store triggers/functions.
// Both the archived legacy binary and the new Store can open this schema.
// Only public logical rows enter it; no deleted SQLite cells are copied.
export async function writeGatewayCheckpoint({ output, rows, sequence, checkpoint = async () => {} }) {
  const position = r.safeNumberV2(r.decimalV2(sequence));
  await mkdir(output, { mode: 0o700 });
  const db = new DatabaseSync(join(output, 'index.sqlite')); let count = 0;
  try {
    db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE records (space TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(space,id)) WITHOUT ROWID; CREATE TABLE progress (id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL); BEGIN');
    const put = db.prepare('INSERT INTO records VALUES(?,?,?)');
    for (const [space, id, value] of rows) {
      checkPublic(value); need(!sensitivePath.test(space), 'export_private_space');
      await checkpoint(space, id, value, count++);
      put.run(space, id, r.stableJSON(value));
    }
    db.prepare('INSERT INTO progress VALUES(1,?)').run(position); db.exec('COMMIT');
  } finally { db.close(); }
  await writeFile(join(output, 'pending.log'), '', { flag: 'wx', mode: 0o600 });
  return count;
}

// A host operator can call this on an ALREADY OPEN public notary view. It
// checks out an immutable revision; it never opens a wallet, runtime config,
// network peer or source credential. No update, signing or send method is used.
export async function exportNotaryView({ view, options, output }) {
  checkPublic(options);
  const snapshot = view.checkout(view.version), records = [];
  try {
    for await (const { key, value } of snapshot.createReadStream()) {
      need(typeof key === 'string', 'export_notary_key');
      if (isApplicationNotaryKey(key)) { checkPublic(value); records.push([key, value]); }
    }
    records.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    await save(output, { options, records, revision: snapshot.version });
    return { rows: records.length, ...await fileDigest(output) };
  } finally { await snapshot.close(); }
}

async function journalAt(path, sequence, maxFrameBytes) {
  const fd = await regular(path); let offset = 0, last = null;
  try {
    const st = await fd.stat(), header = Buffer.alloc(36);
    while (offset < st.size) {
      need(st.size - offset >= 36, 'export_journal_incomplete');
      need((await fd.read(header, 0, 36, offset)).bytesRead === 36, 'export_journal_changed');
      const n = header.readUInt32BE(); need(n > 0 && n <= maxFrameBytes && offset + 36 + n <= st.size, 'export_journal_incomplete');
      const body = Buffer.alloc(n); need((await fd.read(body, 0, n, offset + 36)).bytesRead === n, 'export_journal_changed');
      need(hash(body) === header.subarray(4).toString('hex'), 'export_journal_checksum');
      const row = JSON.parse(body); checkPublic(row);
      const next = r.decimalV2(row.sequence);
      need(last === null || next === r.nextUint(last), 'export_journal_sequence');
      need(BigInt(next) <= BigInt(sequence), 'export_gateway_unapplied_journal');
      last = next; offset += 36 + n;
    }
    return { bytes: offset, last };
  } finally { await fd.close(); }
}

// Exact input paths only. No recursive walk of a host/service directory and
// no Store.open on the source: that would acquire a writer lock and recover it.
export async function exportSnapshot({ gatewayDirectory, contractFile, headersFile, operatorFiles, publicFiles = [], output,
  reserveGiB = 40, maxBytes = 12 * 1024 ** 3, maxFrameBytes = 4000000 }) {
  need(Number.isSafeInteger(reserveGiB) && reserveGiB >= 40 && Number.isSafeInteger(maxBytes) && maxBytes > 0 &&
    Number.isSafeInteger(maxFrameBytes) && maxFrameBytes > 0, 'export_limits');
  need(output === resolve(output) && await realpath(dirname(output)) === dirname(output), 'export_output_path');
  need(gatewayDirectory === resolve(gatewayDirectory) && await realpath(gatewayDirectory) === gatewayDirectory &&
    !sensitivePath.test(gatewayDirectory), 'export_gateway_path');
  need(output !== gatewayDirectory && !output.startsWith(gatewayDirectory + '/') && !gatewayDirectory.startsWith(output + '/'), 'export_output_overlap');
  need(Array.isArray(operatorFiles) && operatorFiles.length === 5 && new Set(operatorFiles.map(f => f.id)).size === 5 &&
    operatorFiles.every(f => /^operator[1-5]$/.test(f.id)), 'export_operator_coverage');
  need(Array.isArray(publicFiles) && publicFiles.every(f => /^[a-z][a-z0-9-]*\.json$/.test(f.name)) &&
    new Set(publicFiles.map(f => f.name)).size === publicFiles.length, 'export_public_files');
  await disk(dirname(output), reserveGiB);
  const contract = await readJSON(contractFile), { options, records } = contract.value;
  need(options?.network && Array.isArray(records) && records.every(row => Array.isArray(row) && row.length === 2 && typeof row[0] === 'string') &&
    new Set(records.map(([key]) => key)).size === records.length, 'export_contract');
  const notary = new Map(records), accepted = notary.get('bt/last');
  need(accepted && notary.get('bt/' + accepted.n) && !notary.has('v2/ready'), 'export_legacy_head');
  const operators = [];
  for (const row of operatorFiles) operators.push({ id: row.id, ...await readJSON(row.path) });
  const additional = [];
  for (const row of publicFiles) additional.push({ name: row.name, ...await readJSON(row.path) });
  const headerDigest = await fileDigest(headersFile);
  need(headerDigest.bytes % 80 === 0, 'export_headers');
  const sqlite = join(gatewayDirectory, 'index.sqlite'), journal = join(gatewayDirectory, 'pending.log');
  const sqliteBefore = await fileDigest(sqlite), journalBefore = await fileDigest(journal);
  const walBefore = await optionalDigest(sqlite + '-wal');
  need(sqliteBefore.bytes + (walBefore?.bytes ?? 0) + headerDigest.bytes <= maxBytes, 'export_byte_budget');
  await disk(dirname(output), reserveGiB, sqliteBefore.bytes + (walBefore?.bytes ?? 0));
  await mkdir(output, { mode: 0o700 });
  // Even SQLite readOnly readers change WAL shared-memory read marks. Copy
  // the exact DB/WAL pair first, double-check it, then open only that copy.
  const capture = join(output, '.capture'); await mkdir(capture, { mode: 0o700 });
  let source, count = 0, complete = false;
  const draftInputs = [];
  try {
    await copyExact(sqlite, join(capture, 'index.sqlite'));
    if (walBefore) await copyExact(sqlite + '-wal', join(capture, 'index.sqlite-wal'));
    need(same(await fileDigest(sqlite), sqliteBefore) && same(await optionalDigest(sqlite + '-wal'), walBefore), 'export_gateway_changed');
    need(same(await fileDigest(join(capture, 'index.sqlite')), sqliteBefore) &&
      (!walBefore || same(await fileDigest(join(capture, 'index.sqlite-wal')), walBefore)), 'export_gateway_changed');
    source = new DatabaseSync(join(capture, 'index.sqlite'), { readOnly: true });
    source.exec('PRAGMA query_only=ON; BEGIN');
    const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const progress = tables.has('journal_progress') && source.prepare('SELECT sequence FROM journal_progress WHERE id=1').get();
    const sequence = r.decimalV2(progress?.sequence ?? source.prepare('SELECT sequence FROM progress WHERE id=1').get().sequence);
    if (tables.has('staged_transactions')) need(!source.prepare('SELECT 1 FROM staged_transactions LIMIT 1').get(), 'export_gateway_uncommitted_transaction');
    await journalAt(journal, sequence, maxFrameBytes);
    const state = JSON.parse(source.prepare("SELECT value FROM records WHERE space='meta' AND id='ruleState'").get()?.value ?? 'null');
    need(state && String(state.counted) === String(accepted.to), 'export_gateway_notary_head');
    const height = notary.get('b/cnt'); need(Number.isSafeInteger(height) && height >= accepted.to && headerDigest.bytes >= (height + 1) * 80, 'export_counted_anchor');
    const sourceRows = createHash('sha256'); let bytes = 0;
    const retainedArtifacts = [];
    function* publicRows() {
      for (const row of source.prepare('SELECT space,id,value FROM records ORDER BY space,id').iterate()) yield [row.space, row.id, JSON.parse(row.value)];
    }
    count = await writeGatewayCheckpoint({ output: join(output, 'gateway'), sequence, rows: publicRows(), checkpoint: async (space, id, value, index) => {
      const text = r.stableJSON([space, id, value]) + '\n'; sourceRows.update(text); bytes += Buffer.byteLength(text);
      if (space === 'supersededDrafts') {
        need(/^[0-9a-f]{64}$/.test(value.evidence?.id) && /^[0-9a-f]{64}$/.test(value.evidence?.hash), 'export_retired_reference');
        retainedArtifacts.push({ path: 'retired-drafts/' + value.evidence.id + '.json', hash: value.evidence.hash, kind: 'retired', row: value });
      }
      if (space === 'observationRecovery') {
        need(value.path === '/records/deferred/' + id + '.json' && /^[0-9]+$/.test(id), 'export_recovery_reference');
        retainedArtifacts.push({ path: 'static' + value.path, kind: 'recovery', row: value });
      }
      need(bytes + headerDigest.bytes <= maxBytes, 'export_byte_budget');
      if (index % 256 === 0) await disk(output, reserveGiB);
    } });
    for (const artifact of retainedArtifacts) {
      const path = join(gatewayDirectory, artifact.path), saved = await readJSON(path);
      if (artifact.kind === 'retired') need(saved.sha256 === artifact.hash && same(saved.value.draft?.proposal?.batch, artifact.row.batch), 'export_retired_checksum');
      else need(saved.value.reason === artifact.row.reason && Array.isArray(saved.value.entries), 'export_recovery_evidence');
      bytes += saved.bytes; need(bytes + headerDigest.bytes <= maxBytes, 'export_byte_budget');
      const target = join(output, 'gateway', artifact.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyExact(path, target); need((await readJSON(path)).sha256 === saved.sha256 && (await readJSON(target)).sha256 === saved.sha256, 'export_artifact_changed');
      draftInputs.push({ role: 'gateway/' + artifact.path, sha256: saved.sha256, bytes: saved.bytes });
    }
    const draft = JSON.parse(source.prepare("SELECT value FROM records WHERE space='meta' AND id='draft'").get()?.value ?? 'null');
    if (draft?.external) {
      need(/^[0-9a-f]{64}$/.test(draft.external), 'export_draft_reference');
      const path = join(gatewayDirectory, 'drafts', draft.external + '.json'), artifact = await readJSON(path);
      need(artifact.sha256 === draft.external && same(artifact.value.proposal?.batch, draft.proposal.batch), 'export_draft_checksum');
      need(artifact.bytes + bytes + headerDigest.bytes <= maxBytes, 'export_byte_budget');
      await mkdir(join(output, 'gateway', 'drafts'), { mode: 0o700 });
      await copyExact(path, join(output, 'gateway', 'drafts', draft.external + '.json'));
      need((await readJSON(path)).sha256 === artifact.sha256, 'export_draft_changed');
      draftInputs.push({ role: 'gateway/drafts/' + draft.external + '.json', bytes: artifact.bytes, sha256: artifact.sha256 });
    }
    need(same(await fileDigest(journal), journalBefore) && same(await fileDigest(sqlite), sqliteBefore) &&
      same(await optionalDigest(sqlite + '-wal'), walBefore), 'export_gateway_changed');
    source.exec('COMMIT');
    source.close(); source = null; await rm(capture, { recursive: true });
    await save(join(output, 'contract.json'), contract.value);
    await mkdir(join(output, 'operators')); for (const row of operators) {
      await save(join(output, 'operators', row.id + '.json'), row.value);
      if (row.value.version === 2) await copyExact(operatorFiles.find(f => f.id === row.id).path + '.rows.sqlite', join(output, 'operators', row.id + '.json.rows.sqlite'));
    }
    await mkdir(join(output, 'public')); for (const row of additional) await save(join(output, 'public', row.name), row.value);
    const inputHeaders = await regular(headersFile), copied = await open(join(output, 'headers.bin'), 'wx', 0o600);
    try { for await (const chunk of inputHeaders.createReadStream({ autoClose: false })) { await disk(output, reserveGiB, chunk.length); await copied.writeFile(chunk); } await copied.sync(); }
    finally { await copied.close(); await inputHeaders.close(); }
    need(same(await fileDigest(headersFile), headerDigest) && same(await fileDigest(join(output, 'headers.bin')), headerDigest), 'export_headers_changed');
    need((await readJSON(contractFile)).sha256 === contract.sha256, 'export_contract_changed');
    for (const row of operatorFiles) need((await readJSON(row.path)).sha256 === operators.find(o => o.id === row.id).sha256, 'export_operator_changed');
    for (const row of publicFiles) need((await readJSON(row.path)).sha256 === additional.find(o => o.name === row.name).sha256, 'export_public_changed');
    const descriptor = { version: 1, synthetic: false, reconciled: false, network: options.network, height, accepted,
      source: 'explicit public notary export and verified gateway database/WAL copy',
      gateway: { sequence, rows: count, rowsHash: sourceRows.digest('hex'), journal: journalBefore },
      inputs: [{ role: 'contract', bytes: contract.bytes, sha256: contract.sha256 }, { role: 'headers', ...headerDigest },
        { role: 'gateway/index.sqlite', ...sqliteBefore }, ...(walBefore ? [{ role: 'gateway/index.sqlite-wal', ...walBefore }] : []),
        { role: 'gateway/pending.log', ...journalBefore },
        ...draftInputs, ...operators.map(({ id, bytes, sha256 }) => ({ role: id, bytes, sha256 })), ...additional.map(({ name, bytes, sha256 }) => ({ role: name, bytes, sha256 }))],
      reconciliation: 'Required: independently verify the accepted head, pending-work plan and financial identities on all five signers before marking this snapshot reconciled.' };
    await save(join(output, 'snapshot.json'), descriptor);
    const { inventory } = await import('./snapshot.mjs');
    const files = await inventory(output); await save(join(output, 'export-files.json'), { version: 1, ...files });
    complete = true;
    return { output, rows: count, files: files.files.length + 1, inventoryHash: files.hash, reconciled: false };
  } finally {
    source?.close(); await rm(capture, { recursive: true, force: true });
    if (!complete) await rm(join(output, 'snapshot.json'), { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    need(process.argv.length === 3, 'export_usage_plan_json');
    const { value: plan } = await readJSON(resolve(process.argv[2]));
    process.stdout.write(JSON.stringify(await exportSnapshot(plan)) + '\n');
  } catch (error) {
    // Never echo filenames, input records or provider errors into a host log.
    process.stderr.write((/^export_[a-z_]+$/.test(error.message) ? error.message : 'export_failed_preserve_partial_output') + '\n');
    process.exitCode = 1;
  }
}
