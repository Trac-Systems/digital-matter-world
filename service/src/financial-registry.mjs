import { pendingId } from '../../rules/src/index.js';

// Registry hints schedule independent verification; they never supply evidence
// or change the order in which financial operations are checked and applied.
export async function warmFinancialRegistry(reads, transitions, at, extra = []) {
  if (!reads.ensureRegistryAssets) return;
  const queries = [...extra];
  for (const t of transitions) {
    const a = t.action;
    if (t.type === 'lifecycle' && ['deployment-open', 'deployment-add'].includes(a?.type))
      queries.push({ asset: a.asset, deploymentId: a.type === 'deployment-add' ? a.deployment : null });
    else if (t.type === 'reserve-many') queries.push({ asset: t.terms.asset, deploymentId: t.terms.deployment });
    else if (t.type === 'public-scan') queries.push({ asset: t.asset, deploymentId: t.deployment ?? null });
    else if (reads.financialRegistryQuery) {
      // A missing request must not prevent discovery of the other keys. The
      // ordinary evidence pass reports its original validation/read failure.
      try { const query = await reads.financialRegistryQuery(t, at); if (query) queries.push(query); } catch {}
    }
  }
  await reads.ensureRegistryAssets(queries);
}

export async function warmBatchRegistry(reads, files, network, at) {
  if (!reads.ensureRegistryAssets) return;
  const inputs = files.flatMap(file => file.financialOperations ?? []), extra = [];
  for (const input of inputs) {
    if (input.transition.type !== 'public-scan') continue;
    for (const payment of input.evidence?.payments ?? []) {
      const source = payment.source;
      if (source) extra.push({ asset: source.asset, deploymentId: source.quote?.deploymentId ?? source.deployment?.id ?? null });
      else if (payment.deployment) extra.push({ asset: payment.asset, deploymentId: payment.deployment });
    }
  }
  // Legacy mint evidence can precede financial evidence in a mixed proposal.
  // Resolve its pinned quote too, before either verifier can stop on a cold key.
  for (const file of files) for (const input of file.mintOperations ?? []) {
    if (!reads.financialRegistryQuery) continue;
    try {
      const query = await reads.financialRegistryQuery({ type: 'reserve', id: pendingId(network, input.request) }, at);
      if (query) extra.push(query);
    } catch {}
  }
  await warmFinancialRegistry(reads, inputs.map(input => input.transition), at, extra);
}
