import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { same } from './deployments.mjs';

// A valid detached permit can be inscribed by anyone. Follow the official
// deployment/block's winning record rather than requiring our reveal txid.
export async function winningMint(reads, row, entry, recovered, view) {
  if (!row.permit) return null;
  const d = row.context.deployment;
  let inscription = entry?.id;
  if (d.kind === 'dmt') {
    const deployment = await reads.tap('getDeployment/' + encodeURIComponent('dmt-' + d.tick));
    check(deployment?.ins === d.id, 'deployment_binding');
    const winner = await reads.tap('getDmtMintHolderByBlock/' + encodeURIComponent('dmt-' + d.tick) + '/' + row.request.block);
    if (!winner) return null;
    inscription = winner.ins;
  }
  if (!inscription && d.kind === 'compound' && !reads.namedSources) {
    const path=encodeURIComponent(row.receiver)+'/'+encodeURIComponent(d.tick);
    const count=Number(await reads.tap('getAccountMintListLength/'+path));
    check(Number.isSafeInteger(count) && count>=0 && count<=1000000,'mint_list_bound');
    const recent=[];
    // The indexer caps each response at 500, even when max is larger.
    for(let offset=Math.max(0,count-1000);offset<count;offset+=500){
      const page=await reads.tap('getAccountMintList/'+path+'?offset='+offset+'&max=500');
      check(Array.isArray(page)&&page.length===Math.min(500,count-offset),'mint_list');recent.push(...page);
    }
    inscription=recent.find(m=>m.fail===false && m.dta===row.permit.dta && m.amt===row.request.amount)?.ins;
  }
  if (!inscription) return null;
  const rows = reads.mintedItem ? [await reads.mintedItem(inscription, row.mintLocator)] : await reads.tap('getMintedList/' + inscription.slice(0, 64));
  const minted = rows.find(r => r?.ins === inscription && r.fail === false);
  if (!minted) return null;
  const canonical = await reads.included(inscription, view); if (!canonical) return null;
  const payload = await reads.content(inscription);
  check(same(payload, row.permit) && payload.tick === d.tick && minted.tick === (d.kind === 'dmt' ? 'dmt-' + d.tick : d.tick) &&
    payload.prv.address === row.receiver && minted.addr === row.receiver && minted.amt === row.request.amount && payload.dta === minted.dta, 'indexed_mint_binding');
  check(d.kind !== 'dmt' || payload.dep === d.id && Number(payload.blk) === row.request.block, 'indexed_mint_deployment');
  const committee = recovered(payload.prv.hash, payload.prv.sig);
  check(committee === d.privilegePublicKey, 'indexed_mint_authority');
  return { accepted: true, fail: false, confirmations: canonical.confirmations, inscription, deployment: d.id, tick: d.tick,
    receiver: minted.addr, amount: minted.amt, dta: payload.dta, permitHash: payload.prv.hash, committee,
    ...(d.kind === 'dmt' ? { block: Number(payload.blk) } : {}) };
}

// An accepted financial batch runs at its final counted height. The callback
// verifies the audit's Merkle root against Trac before any frozen term is used.
export async function admittedMint({ store, reads, audits, network, id }) {
  const pending = await reads.pendingAcceptance(id);
  check(pending?.id === id && Number.isSafeInteger(pending.created), 'pending_acceptance');
  if (store.batchAt) {
    const hint = store.get('mints', id)?.admissionBatch;
    const batches = hint ? [{ batch: { n: hint } }] : store.batchAt(pending.created);
    for (const batch of batches) for (const file of await audits(batch.batch.n)) for (const [index, input] of (file.mintOperations ?? []).entries()) {
      if (input.op !== 'rq' || file.mintOutcomes?.[index]?.reason !== 'accepted' || rules.pendingId(network, input.request) !== id) continue;
      check(rules.verifyRequest('rq', network, input.request, input.sig, input.request.until), 'owner_signature');
      return { context: input.evidence.context, bitmap: input.evidence.bitmap };
    }
    throw Error('mint_admission_evidence_missing');
  }
  let after = '';
  for (;;) {
    const page = store.list('batches', { after, limit: 256 });
    for (const { value } of page) if (value.batch?.to === pending.created) {
      for (const file of await audits(value.batch.n)) for (const [index, input] of (file.mintOperations ?? []).entries()) {
        if (input.op !== 'rq' || file.mintOutcomes?.[index]?.reason !== 'accepted' || rules.pendingId(network,input.request) !== id) continue;
        check(rules.verifyRequest('rq',network,input.request,input.sig,input.request.until), 'owner_signature');
        return { context: input.evidence.context, bitmap: input.evidence.bitmap };
      }
    }
    if (page.length < 256) break;
    after = page.at(-1).id;
  }
  throw Error('mint_admission_evidence_missing');
}
