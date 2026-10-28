// Offline repair, also runnable against 75afe51 with --repo pointing at that checkout.
// No network, keys, signing, retirement, or submission. Stop the gateway first.
import { readFile, open, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const need = (ok, code) => { if (!ok) throw Error(code); };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function save(path, value) {
  const fd = await open(path, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value) + '\n'); await fd.sync(); } finally { await fd.close(); }
  const dir = await open(dirname(resolve(path)), 'r'); try { await dir.sync(); } finally { await dir.close(); }
}
async function saveDraft(data, text) {
  const path = join(data, 'drafts', hash(text) + '.json');
  await mkdir(join(data, 'drafts'), { recursive: true, mode: 0o700 });
  let fd;
  try { fd = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; need(await readFile(path, 'utf8') === text, 'draft_checksum'); return; }
  try { await fd.writeFile(text); await fd.sync(); } finally { await fd.close(); }
  const dir = await open(join(data, 'drafts'), 'r'); try { await dir.sync(); } finally { await dir.close(); }
}
export async function auditJournal({ journal, member, session, key }) {
  need(/^[0-9a-f]{64}$/.test(session) && /^batch\/\d+\/\d+$/.test(key), 'audit_identity');
  const text = await readFile(journal, 'utf8');
  need(!text || text.endsWith('\n'), 'journal_truncated');
  const records = text.split('\n').filter(Boolean).map(JSON.parse);
  let previous = '0'.repeat(64);
  for (const [index, r] of records.entries()) {
    need(r.index === index && r.previous === previous && r.signer === member && r.network === records[0].network && /^[0-9a-f]{64}$/.test(r.tag), 'journal_structure');
    previous = r.tag;
  }
  // This is a read-only inventory, not a replacement for the live signer's MAC validation.
  const reservations = records.filter(r => r.type === 'reserve' && (r.session === session || r.slots.includes(key)));
  return { version: 1, member, network: records[0]?.network, session, key, checkedAt: Date.now(), journalHash: hash(text), records: records.length,
    reservations: reservations.map(r => ({ session: r.session, digest: r.digest, slots: r.slots })),
    signed: records.filter(r => r.type === 'signed' && r.session === session).length,
    retired: records.some(r => ['retired-preparation', 'retired-batch'].includes(r.type) && r.session === session) };
}
export async function recoverPreparation({ repo, data, key, session: id, counted, proofs, backup, apply = false, rollback }) {
  const { Store } = await import(pathToFileURL(resolve(repo, 'service/src/store.mjs')));
  const { rules } = await import(pathToFileURL(resolve(repo, 'service/src/rules.mjs')));
  const store = await Store.open(resolve(data)); // Exclusive writer lock refuses a running gateway.
  try {
    if (rollback) {
      const saved = await json(rollback);
      need(saved.key === key && saved.before.session.id === id && same(store.get('ceremonies', key), saved.after.session)
        && same(store.get('meta', 'draft'), saved.after.reference) && !store.get('outbox', key) && !store.get('sent', key), 'rollback_state_changed');
      need(hash(JSON.stringify(saved.before.draft)) === saved.before.reference.external, 'backup_draft_checksum');
      if (apply) {
        await saveDraft(data, JSON.stringify(saved.before.draft));
        await store.transact([{ space: 'ceremonies', id: key, value: saved.before.session }, { space: 'meta', id: 'draft', value: saved.before.reference }]);
      }
      return { mode: apply ? 'rolled-back' : 'rollback-dry-run', key, session: id };
    }
    const session = store.get('ceremonies', key), reference = store.get('meta', 'draft');
    need(session?.id === id && session.stage === 'blocked' && session.reason === 'prepare_incomplete'
      && session.peers.length === 3 && new Set(session.peers).size === 3, 'blocked_preparation_required');
    // The legacy wrapper sent these HTTP refusals only after each original
    // prepare completed. A timeout, partial reply or earlier retry is NOT an
    // offline proof that no old request is still writing a reservation.
    need(!session.retryBusy && !session.retryPrepare && session.failures?.length === 3
      && session.failures.every(code => code === 'committee_host_signer_unavailable'), 'completed_legacy_refusals_required');
    need(!session.result && !store.get('outbox', key) && !store.get('sent', key), 'submission_exists');
    need(/^[0-9a-f]{64}$/.test(reference?.external), 'draft_reference');
    const originalText = await readFile(join(data, 'drafts', reference.external + '.json'), 'utf8');
    need(hash(originalText) === reference.external, 'draft_checksum');
    const draft = JSON.parse(originalText), proposal = draft.proposal, batch = proposal.batch;
    need(!draft.signature && same(session.proposal, proposal) && key === `batch/${batch.epoch}/${batch.n}`, 'proposal_changed');
    const audits = await Promise.all(proofs.map(json));
    need(audits.length === 3 && new Set(audits.map(a => a.member)).size === 3 && session.peers.every(member => audits.some(a => a.member === member)), 'proof_members');
    for (const a of audits) need(a.version === 1 && a.network === proposal.network && a.session === id && a.key === key && a.records > 0
      && a.checkedAt <= Date.now() && Date.now() - a.checkedAt < 300000 && a.reservations.length === 0 && a.signed === 0 && a.retired === false, 'reservation_not_proven_absent');
    need(Number.isSafeInteger(counted) && counted >= draft.execution && counted >= batch.to && counted <= batch.deadline, 'recovery_clock');
    // Rebase only snapshot-independent files. The actual proposal stays byte-for-byte identical.
    const files = proposal.files.map(f => rules.decodeBinary(Buffer.from(f, 'hex')));
    need(batch.ops.every(o => o.op === 'kv') && !(batch.hx?.length)
      && files.every(f => f.mintOperations.length === 0 && f.linkOperations.length === 0 && f.moves.every(m => m.move.t !== 'craft')), 'recovery_requires_snapshot_independent_batch');
    for (const file of files) {
      const certificate = store.get('receiptCertificates', `${file.tip}/${file.tipHash}`);
      need(certificate === null ? file.receipts.length === 0 && file.rootAttestations.length === 0 :
        (file.receiptReference === certificate.seal.root || rules.stableJSON(file.receiptRoot) === rules.stableJSON(certificate.seal))
        && rules.verifyRootAttestations(certificate.seal, certificate.attestations, draft.settings?.receiptSigners), 'receipt_certificate_changed');
    }
    const updatedDraft = { ...draft, execution: counted }, updatedText = JSON.stringify(updatedDraft), external = hash(updatedText);
    const after = { session: { ...session, retryBusy: true }, reference: { ...reference, external } };
    const record = { version: 1, key, checkedAt: Date.now(), proposalHash: hash(JSON.stringify(proposal)),
      before: { session, reference, draft }, after, audits, counted };
    if (apply) {
      need(backup, 'backup_required'); await save(backup, record);
      await saveDraft(data, updatedText);
      await store.transact([{ space: 'ceremonies', id: key, value: after.session }, { space: 'meta', id: 'draft', value: after.reference }]);
    }
    return { mode: apply ? 'applied' : 'dry-run', key, session: id, proposalHash: record.proposalHash, execution: counted,
      unchangedProposal: true, unchangedPeers: true, noReservations: audits.map(a => a.member) };
  } finally { await store.close(); }
}
async function main() {
  const args = process.argv.slice(2), options = { proofs: [] };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--apply') options.apply = true;
    else { need(/^--(repo|data|key|session|counted|proof|backup|rollback|journal|member)$/.test(name) && args[i + 1], 'arguments');
      const value = args[++i]; if (name === '--proof') options.proofs.push(value); else options[name.slice(2)] = name === '--counted' ? Number(value) : value; }
  }
  const result = options.journal ? await auditJournal(options) : await recoverPreparation(options);
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error('Recovery refused: ' + (/^[a-z][a-z_]{1,70}$/.test(error.message) ? error.message : 'recovery_dependency') + '. Preserve state.'); process.exitCode = 1; });
