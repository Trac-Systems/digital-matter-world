import { createHash } from 'node:crypto';
import { rules as r } from '../src/rules.mjs';
import { check } from '../src/util.mjs';
import { terminalRecordsRoot } from '../src/pending-financial.mjs';
import { checkPublic } from '../../deploy/rehearsal/export.mjs';

export async function collectMigrationEvidence({ store, notarySnapshot, historyFor }) {
  const notary = await notarySnapshot(), records = new Map(notary.records);
  const counted = records.get('b/cnt'), last = records.get('bt/last');
  check(Number.isSafeInteger(counted) && last, 'pending_export_legacy_notary');
  const evidence = await store.migrationRows();
  check(evidence.stamp.counted === counted && r.stableJSON(evidence.stamp.last) === r.stableJSON(last), 'pending_export_snapshot_changed');
  const history = await historyFor(evidence.stamp), digest = createHash('sha256');
  const raws = history.rawRange ? history.rawRange(counted) : (function* () { for (let h = 0; h <= counted; h++) yield history.raw(h); })();
  let headers = 0;
  for (const raw of raws) { digest.update(typeof raw === 'string' ? Buffer.from(raw, 'hex') : raw); headers++; }
  check(headers === counted + 1, 'pending_export_header_coverage');
  const anchor = { height: String(counted), hash: history.hashAt(counted) };
  check(records.get('b/r/' + anchor.hash)?.[0] === counted &&
    terminalRecordsRoot(new Map((await notarySnapshot()).records)) === terminalRecordsRoot(records), 'pending_export_snapshot_changed');
  const result = { notary, gatewayRows: evidence.rows, artifacts: evidence.artifacts, anchor, headersHash: digest.digest('hex') };
  checkPublic(result); return result;
}
