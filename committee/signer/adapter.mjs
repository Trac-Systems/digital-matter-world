import * as rules from '../../rules/src/index.js';
import { requestDigest } from '../../contract/signing.js';
import { check, equal, hex, sha256 } from './crypto.mjs';

export { rules };
export const requestID = (network, request) => hex(requestDigest(network, 'rq', request));
export async function pendingRecord(reads, network, request, signature, counted) {
  // until limits admission; an already accepted request lives through expires.
  check(rules.verifyRequest('rq', network, request, signature, request?.until), 'owner_signature');
  const id = requestID(network, request), raw = await reads.pending(id);
  check(raw && raw.s === 1 && raw.permitHash && Number.isSafeInteger(raw.e), 'pending_missing');
  const owner = await reads.agentAddress(raw.o);
  const fields = { asset: raw.asset, amount: raw.amount, receive: raw.receive, ...(Object.hasOwn(raw, 'block') ? { block: raw.block } : {}) };
  const expected = { asset: request.asset, amount: request.amount, receive: request.receive, ...(Object.hasOwn(request, 'block') ? { block: request.block } : {}) };
  check(owner === request.owner && equal(fields, expected) && raw.e === request.expires, 'pending_binding');
  // The compact record does not store creation height. Read the accepted rq
  // event and its batch inclusion height instead of using today's setting.
  const accepted = await reads.pendingAcceptance(id);
  check(accepted?.id === id && Number.isSafeInteger(accepted.created) && accepted.created >= 0 && accepted.created <= request.until && accepted.expiry === raw.e && raw.e - accepted.created >= 6 && raw.e - accepted.created <= 2016, 'pending_acceptance');
  const pending = { id, created: accepted.created, expiry: raw.e };
  check(raw.h === true, 'units_not_consumed');
  return pending;
}
export function rebuildBatch(network, proposal, context) {
  const clock = rules.ordinalCodec(!!context.settings?.document);
  check(clock.compare(proposal.batch.to, context.counted) <= 0, 'batch_uncounted');
  check(Array.isArray(context.inputs) && context.inputs.length > 0 && context.inputs.length <= (context.settings?.document ? rules.batchSettings(context.settings).maxObservations : context.limits?.maxObservations ?? 512), 'batch_inputs');
  check(!context.views || context.views.length === context.inputs.length, 'batch_views');
  let state = context.state, patterns = context.patterns;
  const files = [], claimNodes = new Map(), namedNodes = new Map();
  context.inputs.forEach((input, i) => {
    const view = context.views?.[i] ?? context;
    const args = { ...input, renewal: context.renewal, priorOperations: rules.budgetOperations(files), executionHeight: context.counted, network, state, patterns, history: view.history, hashAt: view.hashAt, gateway: context.gateway, settings: context.settings };
    const output = context.settings?.document ? rules.processBlockV2(args, {
      claimNodeGet: (id, ancestors) => claimNodes.get(id) ?? context.claimNode?.(id, ancestors),
      namedNodeGet: (id, ancestors) => namedNodes.get(id) ?? context.namedNode?.(id, ancestors) }) : rules.processBlock(args);
    for (const row of output.claimWrites ?? []) claimNodes.set(row.id, row.value);
    for (const row of output.namedWrites ?? []) namedNodes.set(row.id, row.value);
    state = output.state; patterns = output.patterns; files.push(output.file);
  });
  const built = rules.buildBatch({ ...context.limits, renewal: context.renewal, renewalSlice: proposal.batch.renewal?.slice, settings: context.settings, activation: context.activation, previousRoot: context.previousRoot,
    // Observation views retain their witnessed branch. The execution anchor
    // comes from the independent notary reader and is checked by preflight;
    // an old receipt view cannot supply a later or replacement branch tip.
    executionHash: proposal.batch.v === 2 ? context.executionHash ?? (context.views?.at(-1) ?? context).hashAt(context.counted) : undefined, catalogRoot: state.catalogRoot, accountRoot: state.accountRoot,
    executionHeight: context.counted, deadline: proposal.batch.deadline, network, epoch: context.authority.epoch, sequence: clock.add(context.last.n), lastTo: context.last.to, files, headers: context.headers ?? [] });
  check(equal(built.batch, proposal.batch), 'batch_mismatch');
  check(Array.isArray(proposal.files) && proposal.files.length === built.fileBytes.length && proposal.files.every((f, i) => f === hex(built.fileBytes[i])), 'file_mismatch');
  check(clock.compare(built.batch.to, context.counted) <= 0, 'batch_uncounted');
  if (built.batch.ops.some(op => ['rq', 'mp', 'mc', 'rx', 'xc'].includes(op.op))) check(built.batch.to === context.counted, 'batch_execution_height');
  return { digest: hex(built.signingDigest), slots: [`batch/${built.batch.epoch}/${built.batch.n}`,
    ...(context.renewal ? [`receipt-renewal/${context.renewal.id}/execute/${context.renewal.cursor.segment}`] : [])], details: { root: built.batch.root, epoch: built.batch.epoch, n: built.batch.n, deadline: built.batch.deadline, batch: built.batch }, batch: built.batch, files, state, patterns };
}
export function permit(network, request, deployment, receiver, id, paymentHash) {
  const data = `dmw-mint-v1|${network}|${id}|${sha256(deployment.id)}|${paymentHash}`;
  const salt = sha256(`dmw-mint-salt-v1|${network}|${id}`);
  if (deployment.kind === 'compound') {
    const p = rules.compoundMintPermit({ tick: deployment.tick, quantity: request.amount, address: receiver, salt, data });
    return { payload: p.payload, digest: hex(p.signingDigest), address: receiver, salt };
  }
  const payload = { p: 'tap', op: 'dmt-mint', tick: deployment.tick, blk: String(request.block), dep: deployment.id, dta: data };
  const text = ['tap', 'dmt-mint', payload.tick, payload.blk, payload.dep, receiver, data, salt].join('-');
  return { payload, digest: sha256(text), address: receiver, salt };
}
export function attachPermit(p, signature) {
  return { ...p.payload, prv: { address: p.address, salt: p.salt, hash: p.digest, sig: { r: signature.r, s: signature.s, v: String(signature.v) } } };
}
