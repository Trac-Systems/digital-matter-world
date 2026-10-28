import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { permit } from '../../committee/signer/adapter.mjs';
import { createRequire } from 'node:module';
const { secp256k1 } = createRequire(new URL('../../committee/package.json', import.meta.url))('@noble/curves/secp256k1');
const { ed25519 } = createRequire(new URL('../../committee/package.json', import.meta.url))('@noble/curves/ed25519');

// This is an offline import of reconciled public financial records, not a
// chain reader. The enclosing, authority-pinned terminal import authenticates
// the snapshot. Never infer an empty permit/payment set from an empty catalog.
export function importFinancialIdentities({ network, records, snapshot }) {
  const pending = [...records].filter(([key]) => /^m\/[0-9a-f]{64}$/.test(key));
  if (!snapshot) {
    check(!pending.length, 'financial_snapshot_required');
    return { records: [], gateway: [], root: null };
  }
  check(snapshot.version === 2 && snapshot.requests instanceof Map && snapshot.links instanceof Map &&
    snapshot.custody instanceof Map, 'financial_snapshot');
  const imported = new Map(), gateway = [], capacities = new Map(), plots = new Map(), allocated = new Map();
  const keep = (key, value) => { check(!imported.has(key), 'financial_import_duplicate'); imported.set(key, structuredClone(value)); };
  check(snapshot.requests.size === pending.length, 'financial_request_coverage');
  for (const [key, raw] of pending) {
    const id = key.slice(2), row = snapshot.requests.get(id);
    check(row && rules.pendingId(network, row.request) === id && rules.verifyRequest('rq', network, row.request, row.signature, row.request.until), 'financial_request_identity');
    const request = row.request;
    check(records.get('a/' + request.owner) === raw.o && request.asset === raw.asset && request.amount === raw.amount &&
      request.receive === raw.receive && request.expires === raw.e && request.block === raw.block && rules.hash(row.receiver) === request.receive,
    'financial_request_binding');
    check(row.deployment?.id && row.deployment.asset === raw.asset && row.payment && ['tap', 'ethereum'].includes(row.payment.rail) &&
      typeof row.payment.payer === 'string' && row.payment.payer.length > 0 && Array.isArray(row.payment.ids) &&
      new Set(row.payment.ids).size === row.payment.ids.length && row.payment.ids.every(id => typeof id === 'string' && id.length > 0), 'financial_external_identity');
    // A consumed authorization remains recoverable even if the detached
    // signature was never delivered. Its original deployment/payment digest
    // must reproduce exactly; inventing a fresh permit is forbidden.
    let authorization = null;
    if (raw.s === 1) {
      check(rules.hex(raw.permitHash, 32) && rules.hex(raw.paymentHash, 32), 'financial_consumed_identity');
      check(Array.isArray(row.payment.allocations) && rules.paymentCommitment(row.payment.allocations) === raw.paymentHash, 'financial_payment_commitment');
      for (const item of row.payment.allocations) {
        const payment = records.get('pay/' + item.key);
        const used = (allocated.get(item.key) ?? 0n) + BigInt(item.amount);
        check(payment && BigInt(payment.used) >= used && payment.total === item.total, 'financial_payment_usage');
        allocated.set(item.key, used);
      }
      authorization = permit(network, request, row.deployment, row.receiver, id, raw.paymentHash);
      check(authorization.digest === raw.permitHash, 'financial_permit_binding');
      if (row.permit) {
        const { prv, ...payload } = row.permit;
        check(rules.stableJSON(payload) === rules.stableJSON(authorization.payload) && prv?.hash === raw.permitHash &&
          prv.address === authorization.address && prv.salt === authorization.salt, 'financial_permit_binding');
        check(prv.sig && /^[0-9]+$/.test(prv.sig.r) && /^[0-9]+$/.test(prv.sig.s) && ['0', '1'].includes(String(prv.sig.v)), 'financial_permit_signature');
        const signature = new secp256k1.Signature(BigInt(prv.sig.r), BigInt(prv.sig.s));
        check(secp256k1.verify(signature.toCompactHex(), authorization.digest, row.deployment.privilegePublicKey, { prehash: false, lowS: true }) &&
          signature.addRecoveryBit(Number(prv.sig.v)).recoverPublicKey(authorization.digest).toHex(true) === row.deployment.privilegePublicKey, 'financial_permit_signature');
      }
    } else check(!row.permit && !row.terminal, 'financial_unconsumed_permit');
    if (row.terminal) check(row.terminal.id === id && row.terminal.deployment === row.deployment.id &&
      row.terminal.permitHash === raw.permitHash && row.terminal.state === 'minted' && rules.hex(row.terminal.evidence, 32), 'financial_terminal_identity');
    const identity = { id, request, signature: row.signature, receiver: row.receiver, deployment: row.deployment,
      payment: row.payment, authorization, permit: row.permit ?? null, terminal: row.terminal ?? null };
    keep('fi/request/' + id, identity);
    gateway.push({ space: 'financialRequests', id, value: identity });
    const outstanding = raw.s === 0 && (raw.h || snapshot.height <= raw.e) || raw.s === 1 && !row.terminal;
    if (outstanding) {
      capacities.set(row.deployment.id, (capacities.get(row.deployment.id) ?? 0n) + BigInt(raw.amount));
      const terms = { id, asset: raw.asset, deployment: row.deployment.id, amount: raw.amount, plot: raw.block ?? null };
      const reservation = { terms, state: 'reserved' };
      keep('fi/capacity/' + id, reservation); gateway.push({ space: 'capacityRequests', id, value: reservation });
    }
    if ((outstanding || raw.s === 1) && raw.block !== undefined) {
      const plot = raw.asset + '/' + raw.block; check(!plots.has(plot), 'financial_plot_conflict');
      plots.set(plot, { id, state: row.terminal ? 'minted' : 'reserved' });
    }
  }
  for (const [id, amount] of capacities) {
    keep('fi/deployment/' + id, amount.toString()); gateway.push({ space: 'deploymentReserved', id, value: amount.toString() });
  }
  for (const [id, value] of plots) { keep('fi/plot/' + id, value); gateway.push({ space: 'capacityPlots', id, value }); }
  for (const [id, row] of snapshot.links) {
    check(rules.hex(id, 32) && row?.request && rules.linkId(network, row.request) === id && (row.paymentId === undefined || typeof row.paymentId === 'string') &&
      rules.hex(row.sig, 64) && ed25519.verify(row.sig, rules.paymentDigest(network, row.request), row.request.owner, { zip215: false }), 'financial_link_identity');
    keep('fi/link/' + id, row); gateway.push({ space: 'financialLinks', id, value: row });
  }
  for (const [id, row] of snapshot.custody) {
    check(rules.hex(id, 32) && row?.id === id && rules.hex(row.owner, 32) && /^[1-9][0-9]*$/.test(row.amount), 'financial_custody_identity');
    keep('fi/custody/' + id, row); gateway.push({ space: 'financialCustody', id, value: row });
  }
  const rows = [...imported].sort(([a], [b]) => a < b ? -1 : 1);
  return { records: rows, gateway, root: rules.hashObject(['dmw-financial-identities-v2', network, snapshot.height, rows]) };
}
