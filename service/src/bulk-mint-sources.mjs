import { check } from './util.mjs';
import { rules } from './rules.mjs';
import { reserveNonceDigest } from '../../contract/root-accounts.js';
import { financialSplit } from '../../rules/src/financial-fees.js';
import { financialGenerationId } from './financial-capacity-sources.mjs';
import { capacityKey, plotKey } from '../../contract/financial-capacity.js';
import { legacyDeployMintCommissions } from './legacy-deploy-sources.mjs';
import { selectedDeployment } from './registry.mjs';
import { verifyDeployment } from './deployments.mjs';
import { createRequire } from 'node:module';
import { POINT_BATCH_SIZE } from '../../rules/src/point-read-batch.js';
import { parallelPage } from './keyed-work.mjs';
import { timeStep } from './read-timing.mjs';
const require = createRequire(new URL('../../rules/package.json', import.meta.url));
const { ed25519 } = require('@noble/curves/ed25519');
const { secp256k1 } = require('@noble/curves/secp256k1');
export const bulkSchema = () => import('../../rules/src/bulk-mint.js');
const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
export const bulkFeeScope = t => rules.stableJSON(['mint-bulk-v1', t.asset, t.deployment, t.membersRoot]);
const roles = ['finder', 'landowner', 'discoverer', 'treasury', 'burn'];
const discoverySchemas = new WeakSet();
export function bulkFinancialKeys(id, t, b, funding, creditReferences = []) {
  const keys = ['fp/' + id, 'ao/' + id, 'ar/' + t.owner, 'ar/supply', 'fd/' + t.generation,
    capacityKey(t.deployment), 'fi/deployment/' + t.deployment,
    ...t.members.flatMap((m, i) => ['dc/' + b.bulkMemberId(id, i), plotKey(t.asset, m.block, t.supplyScope),
      'dc/plot/' + rules.mintPlotKey(t.asset, m.block, t.supplyScope), 'fi/plot/' + rules.mintPlotKey(t.asset, m.block, t.supplyScope)])];
  for (const reference of new Set([funding?.reference, ...creditReferences].filter(Boolean))) {
    const receipt = b.bulkReceiptKey(t.bitcoinNetwork, reference);
    keys.push('fp/bulk-receipt/' + receipt, 'fp/bulk-credit/' + receipt);
  }
  return keys;
}
const deploymentIdentity = d => Object.fromEntries(['id', 'generation', 'privilege', 'elementId', 'dt', 'options', 'approval', 'kind', 'tick', 'privilegePublicKey', 'decimals']
  .map(k => [k, d[k] ?? null]).concat(d.officialDeployment ? [['officialDeployment', d.officialDeployment]] : []));

export async function verifyBulkRequest(body, network, bitcoinNetwork) {
  const b = await bulkSchema();
  b.bulkBytes(body, b.BULK_LIMITS.requestBytes);
  check(rules.exactKeys(body, ['version', 'terms', 'feeManifest', 'reserve']) && body.version === 1, 'bulk_request');
  b.validateBulkTerms(body.terms); b.validateBulkFees(body.terms, body.feeManifest);
  checkBulkRecoveryBytes(b, body.terms, body.feeManifest);
  const { sig, ...unsigned } = body.reserve ?? {};
  check(body.terms.network === network && body.terms.bitcoinNetwork === bitcoinNetwork &&
    same(unsigned, b.bulkReserveAction(body.terms)) && rules.hex(sig, 64) &&
    ed25519.verify(sig, reserveNonceDigest(network, body.reserve), body.terms.owner, { zip215: false }), 'bulk_signature');
  return unsigned.id;
}

// Every accepted quote must fit its terminal credit operation too. A larger
// fee manifest can fit the request envelope while exceeding the existing
// operation limit; defer that tail before the owner signs or pays.
export function checkBulkRecoveryBytes(b, terms, feeManifest) {
  const hash = '0'.repeat(64);
  b.bulkBytes({ op: 'fp', v: 2, type: 'bulk-credit', id: hash, terms: hash, evidence: hash,
    reference: hash + 'i4294967295', block: { height: terms.expires + '0', hash },
    paid: terms.groups.map(g => g.amount), receiptRoot: hash, feeManifest }, b.BULK_LIMITS.operationBytes);
}

// Fees are split and rounded before grouping; suspense identity never becomes
// part of the destination key. This helper consumes authenticated contexts.
export function bulkFeeManifest(reads, contexts, { payer, bitcoinNetwork, document, policy, height, orderId }) {
  const groups = new Map(), rows = [], sources = [];
  for (const [member, context] of contexts.entries()) {
    const d = context.deployment, holder = context.holder;
    const grossFeeAtoms = rules.feeFor('find', policy.baseFee, context.tier, policy.feeSettings, height);
    const base = financialSplit(grossFeeAtoms, { kind: 'find', linked: !!holder,
      discovered: !!(context.beneficiaries?.discoverer ?? context.discoverer) }, document);
    const { split, legacyDeploy, deployer } = rules.deploymentHolderFee(grossFeeAtoms, base,
      { kind: 'find', deployment: d, document, height, bitcoinNetwork });
    const destinations = { treasury: context.treasury, finder: context.finderAddress ?? null,
      landowner: holder?.address ?? null, discoverer: context.discoverer ?? null };
    const args = { split, destinations, beneficiaries: context.beneficiaries, id: orderId, rail: 'tap' };
    const full = reads.financialFeePlan({ ...args, payer: null }), payable = reads.financialFeePlan({ ...args, payer });
    const shares = [];
    for (const role of roles) {
      const fee = full.fees.find(f => f.role === role); if (!fee) continue;
      const paid = payable.fees.find(f => f.role === role);
      const key = paid ? rules.stableJSON([paid.ticker, paid.tt, paid.to]) : null;
      if (paid) {
        const group = groups.get(key) ?? { to: paid.to, ticker: paid.ticker, tt: paid.tt, amount: '0' };
        group.amount = rules.tapAtoms((BigInt(group.amount) + BigInt(paid.amount)).toString()).toString(); groups.set(key, group);
      }
      shares.push({ role, group: key, beneficiary: paid ? payable.custody.find(c => c.role === role)?.owner ?? null : null,
        gross: fee.amount, payable: paid?.amount ?? '0' });
    }
    rows.push({ member, grossFeeAtoms, shares, deferred: { legacyDeploy: legacyDeploy?.amount ?? '0', deployer: deployer?.amount ?? '0' } });
    sources.push({ deployment: deploymentIdentity(d), ...(legacyDeploy ? { legacyDeploy } : {}), ...(deployer ? { deployer } : {}) });
  }
  const sorted = [...groups].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const indices = new Map(sorted.map(([key], i) => [key, i])), custody = [];
  const feeManifest = rows.map(m => ({ ...m, shares: m.shares.map(s => {
    const share = { ...s, group: s.group === null ? null : indices.get(s.group) };
    if (share.beneficiary) custody.push({ member: m.member, role: share.role, group: share.group, owner: share.beneficiary, amount: share.payable });
    return share;
  }) }));
  return { feeManifest, groups: sorted.map(([, value]) => value), custody, sources,
    grossFeeAtoms: rules.tapAtoms(rows.reduce((n, r) => n + BigInt(r.grossFeeAtoms), 0n).toString()).toString(),
    payableFeeAtoms: rules.tapAtoms(sorted.reduce((n, [, g]) => n + BigInt(g.amount), 0n).toString()).toString() };
}

export function installBulkMintSources(reads, { network, bitcoinNetwork = 'mainnet', document, request, reservation, record }) {
  const get = (key, at) => record(key, at);
  const records = async (keys, at) => {
    const result = [];
    for (let offset = 0; offset < keys.length; offset += POINT_BATCH_SIZE) {
      const page = keys.slice(offset, offset + POINT_BATCH_SIZE);
      let values;
      if (reads.financialRecords) values = await reads.financialRecords(page, at);
      else {
        values = new Array(page.length);
        await parallelPage(page.map((key, index) => ({ key, index })), async ({ key, index }) => { values[index] = await get(key, at); }, 4);
      }
      check(Array.isArray(values) && values.length === page.length, 'point_read_batch'); result.push(...values);
    }
    return result;
  };
  const acceptedCache = new Map();
  const sameBatch = (x, y) => ['counted', 'tip', 'tipHash', 'last', 'tap', 'batchRoot', 'authority', 'admissionPolicy'].every(k => same(x?.[k] ?? null, y?.[k] ?? null));
  const fenced = async (at, task, transactions = false) => {
    const before = await reads.batchStamp();
    // The raw Trac view revision also moves on unrelated appends (every agent's claims and
    // headers); fence on the batch clock, TAP and any gateway authority/policy stamp.
    check(!at || rules.compareOrdinal(at.counted, before.counted) === 0 && same(at.last, before.last) &&
      (at.tipHash === undefined || at.tipHash === before.tipHash), 'financial_snapshot_changed', 503);
    const anchor = { ...before, ...(at?.executionHeight === undefined ? {} : { executionHeight: at.executionHeight }) };
    if (transactions) check(reads.withBulkSnapshot && reads.bulkTransactions, 'bulk_source_unavailable', 503);
    let result, failure;
    try { result = transactions ? await reads.withBulkSnapshot(anchor, view => task(anchor, view)) : await task(anchor); }
    catch (error) { failure = error; }
    // A new accepted batch can expose a new checkpoint between provenance
    // reads. Classify that as a changed snapshot, while preserving validation
    // errors when the source stayed still. Never accept mixed evidence.
    check(sameBatch(before, await reads.batchStamp()), 'financial_snapshot_changed', 503);
    if (failure) throw failure;
    return result;
  };
  const unfrozen = async (id, t, at) => {
    check(!await get('fr/active', at), 'financial_recovery_active', 503);
    const b = await bulkSchema();
    const keys = bulkFinancialKeys(id, t, b);
    check((await records(keys.map(key => 'fq/' + key), at)).every(value => !value), 'financial_quarantined', 503);
    check(reads.financialChainAnchor, 'bulk_chain_adapter', 503);
    await reads.financialChainAnchor({ at, prior: await get('fp/chain', at) });
  };
  const accepted = async (id, at) => {
    const funding = await get('fp/' + id, at);
    check(funding?.kind === 'bulk-v1', 'bulk_not_accepted', 409);
    const cacheKey = rules.stableJSON([id, at, rules.hashObject(funding)]);
    if (acceptedCache.has(cacheKey)) return acceptedCache.get(cacheKey);
    const validate = async () => {
    const b = await bulkSchema(), terms = b.validateBulkTerms(funding.manifest);
    check(b.bulkOrderId(network, terms.owner, terms.nonce) === id && terms.bitcoinNetwork === bitcoinNetwork &&
      funding.terms === rules.hashObject(terms), 'bulk_accepted_terms');
    const source = await reservation(id, at);
    check(source?.requestId === id && same(source.terms, terms), 'bulk_accepted_terms');
    b.validateBulkFees(terms, source.feeManifest);
    await unfrozen(id, terms, at);
    if (funding.reference) {
      const key = b.bulkReceiptKey(bitcoinNetwork, funding.reference);
      check(!await get('fq/fp/bulk-receipt/' + key, at) && !await get('fq/fp/bulk-credit/' + key, at), 'financial_quarantined', 503);
    }
    return { terms, funding, source };
    };
    const pending = validate(); acceptedCache.set(cacheKey, pending);
    // Coalesce concurrent readers only. A completed check must never hide a
    // later canonical-chain or quarantine change at the same accepted tip.
    const clear = () => { if (acceptedCache.get(cacheKey) === pending) acceptedCache.delete(cacheKey); };
    pending.then(clear, clear);
    if (acceptedCache.size > 128) acceptedCache.delete(acceptedCache.keys().next().value);
    return pending;
  };
  reads.bulkAccepted = accepted;
  reads.bulkCustodyOriginal = async (row, at) => {
    const { terms, funding, source } = await accepted(row.request, at), b = await bulkSchema();
    const c = terms.custody.find(c => b.bulkCustodyFeeKey(row.request, c) === row.fee);
    check(c && ['bulk-consumed', 'bulk-complete'].includes(funding.state) && c.owner === row.owner && c.amount === row.amount &&
      row.rail === 'tap' && terms.groups[c.group].to === row.custodian, 'financial_custody_terms');
    return { source, funding: { ...funding, consumedRoot: funding.receiptRoot },
      fee: { ticker: 'tap', amount: c.amount, to: row.custodian, financialIdentity: { beneficiary: c.owner, domain: ['tap', bitcoinNetwork, 'tap'] } } };
  };
  const candidates = async (input, anchor, { strict = false, policy = document } = {}) => {
    const b = await bulkSchema(); b.validateBulkQuoteInput(input);
    b.bulkAddress(input.receiver, bitcoinNetwork); b.bulkAddress(input.payer, bitcoinNetwork);
    const contexts = [], skipped = [], counted = rules.decimalV2(anchor.counted), authority = await reads.authority();
    const blocks = [...input.blocks].sort((a, z) => BigInt(a) < BigInt(z) ? -1 : 1);
    const outcomes = new Array(blocks.length);
    await timeStep('memberReads', parallelPage(blocks.map((block, index) => ({ block, index })), async ({ block, index }) => {
      let reason, context;
      try {
        // bulkMint selects TAP without the legacy active-mint range lookup.
        context = structuredClone(await reads.assetContext(input.asset, block, { ...anchor, bulkMint: true }, undefined, undefined, input.deployment));
        const d = context?.deployment;
        if (!d?.active || d.kind !== 'dmt' || d.decimals !== 0 || d.id !== input.deployment || d.privilegePublicKey !== authority.committee) reason = 'deployment_unavailable';
        else if (!context.find || context.find.asset !== input.asset || rules.decimalV2(context.find.block) !== block) reason = 'find_missing';
        else if (BigInt(context.find.count) === 0n) reason = 'zero_occurrences';
        else {
          context.holder = context.link ? context.bitmapHolder ?? await reads.bitmap(block, anchor) : null;
          if (context.link) check(context.holder?.address, 'bitmap_missing', 503);
          if (!rules.mintRight({ find: context.find, owner: input.owner, counted, link: context.link, currentHolder: context.holder?.agent,
            finderWindow: policy.values.finderWindow, settings: policy }).allowed) reason = 'mint_right_unavailable';
          else if (await reads.isMinted(d.id, d.tick, block, anchor)) reason = 'already_minted';
        }
      } catch (error) {
        if (['asset_unregistered', 'financial_deployment_missing'].includes(error.message)) reason = 'deployment_unavailable';
        else throw error;
      }
      outcomes[index] = { block, reason, context };
    }, 4));
    // Read all member locks in bounded point-read pages, instead of opening a
    // separate notary snapshot for every block. Preserve the reason ordering.
    const eligible = outcomes.filter(row => !row.reason);
    const locks = await timeStep('memberLocks', records(eligible.flatMap(({ block, context }) => {
      const scope = rules.tickerSupplyScope(context.deployment, anchor.executionHeight ?? counted);
      return [plotKey(input.asset, block, scope), 'fi/plot/' + rules.mintPlotKey(input.asset, block, scope),
        'dc/plot/' + rules.mintPlotKey(input.asset, block, scope)];
    }), anchor));
    for (const [index, row] of eligible.entries()) {
      const d = row.context.deployment, amount = BigInt(row.context.find.count);
      if (locks.slice(index * 3, index * 3 + 3).some(Boolean)) row.reason = 'block_pending';
      else if (BigInt(d.remaining) < amount || BigInt(d.limit ?? '0') > 0n && amount > BigInt(d.limit)) row.reason = 'insufficient_units';
    }
    const conflicts = outcomes.flatMap((row, index) => row.reason ? [index] : []);
    if (strict && conflicts.length) throw Object.assign(Error('bulk_member_conflict'), { status: 409, details: { indices: conflicts } });
    for (const { block, reason, context } of outcomes) {
      if (reason) skipped.push({ block, reason }); else contexts.push(context);
    }
    return { contexts, skipped, anchor };
  };
  reads.bulkCandidates = (input, at, options) => fenced(at, anchor => reads.withBulkCandidateReads
    ? reads.withBulkCandidateReads(anchor, () => candidates(input, anchor, options)) : candidates(input, anchor, options));
  const reserve = async (transition, at) => {
    const row = await request(transition.id), b = await bulkSchema();
    // mints is already an authenticated exported evidence space. Its bulk
    // projection carries Terms/signature/acceptance; fee rows are reconstructed
    // locally instead of trusting a gateway-supplied fee breakdown.
    check(row?.body || row?.context?.kind === 'bulk-v1', 'bulk_request_missing', 503);
    const t = row.body?.terms ?? row.request;
    b.validateBulkTerms(t);
    const id = b.bulkOrderId(network, t.owner, t.nonce);
    const body = row.body ?? { version: 1, terms: t, reserve: { ...b.bulkReserveAction(t), sig: row.signature } };
    check(id === transition.id && same(body.reserve, transition.action) && same(t, transition.terms), 'bulk_request_binding');
    const original = await reads.financialSettings(t.settingsHash), v = original.values;
    check(BigInt(at.counted) <= BigInt(t.until) && BigInt(t.expires) - BigInt(at.counted) >= BigInt(v.requestMinBlocks) &&
      BigInt(t.expires) - BigInt(at.counted) <= BigInt(v.requestMaxBlocks), 'bulk_request_expired', 409);
    const policy = await reads.feeQuotes.accepted(row.feeAuthorization, bulkFeeScope(t), id, t.expires);
    check(policy.settingsHash === t.settingsHash && same(row.feeAuthorization.quote, t.feeQuote), 'bulk_fee_quote');
    const { contexts } = await reads.bulkCandidates({ v: 1, owner: t.owner, nonce: t.nonce, asset: t.asset, deployment: t.deployment,
      receiver: t.receiver, payer: t.payer, blocks: t.members.map(m => m.block) }, at, { strict: true, policy: original });
    const members = contexts.map(c => ({ block: rules.decimalV2(c.find.block), amount: String(c.find.count) }));
    check(same(members, t.members), 'bulk_members_changed', 409);
    const plan = bulkFeeManifest(reads, contexts, { payer: t.payer, bitcoinNetwork, document: original, policy,
      height: at.executionHeight ?? at.counted, orderId: id });
    body.feeManifest ??= plan.feeManifest;
    await verifyBulkRequest(body, network, bitcoinNetwork);
    const d = contexts[0].deployment, generation = financialGenerationId(network, t.asset, d.id);
    const registered = await get('fd/' + generation, at);
    check(generation === t.generation && registered?.deployment === d.id && registered.asset === t.asset &&
      await get(d.officialDeployment ? 'fd/external/' + rules.hashObject(d.id) : 'fd/asset/' + t.asset, at) === generation, 'bulk_deployment_unavailable', 503);
    check(d.tick === t.ticker && (rules.tickerSupplyScope(d, at.executionHeight ?? at.counted) || null) === t.supplyScope &&
      contexts.every(c => same(deploymentIdentity(c.deployment), deploymentIdentity(d))), 'bulk_deployment_changed', 409);
    const ownership = contexts.map(c => rules.hashObject({ bitmap: c.holder, link: c.link ?? null, ...(c.assetRevision ? { assetRevision: c.assetRevision } : {}) }));
    check(t.feeQuote.mintOwnershipHash === rules.hashObject(['dmw-bulk-ownership-v1', ownership]) && same(plan.feeManifest, body.feeManifest) &&
      same(plan.groups, t.groups) && same(plan.custody, t.custody), 'bulk_fees_changed', 409);
    const outstanding = BigInt(await get(capacityKey(d.id), at) ?? '0') + BigInt(await get('fi/deployment/' + d.id, at) ?? '0');
    check(outstanding + BigInt(t.totalAmount) <= BigInt(d.remaining) &&
      BigInt(registered.reserved) + BigInt(registered.minted) + BigInt(t.totalAmount) <= BigInt(registered.maximum), 'financial_capacity', 409);
    await unfrozen(id, t, at);
    return b.bulkBytes({ version: 1, requestId: id, terms: t, feeManifest: body.feeManifest, feeAuthorization: row.feeAuthorization,
      owner: t.owner, asset: t.asset, amount: t.totalAmount, receiver: t.receiver, payer: t.payer, rail: 'tap',
      capacity: { deployment: d.id, asset: t.asset, amount: t.totalAmount, block: null, remaining: d.remaining, limit: d.limit ?? '0', supplyScope: t.supplyScope },
      generationCapacity: { deployment: generation, reserved: registered.reserved, minted: registered.minted, maximum: registered.maximum },
      members: contexts.map((c, i) => ({ ...members[i], memberId: b.bulkMemberId(id, i), find: c.find, link: c.link ?? null, holder: c.holder, ...plan.sources[i] })),
      expiry: t.expires, settingsHash: t.settingsHash }, b.BULK_LIMITS.evidenceBytes, 'bulk_evidence_bytes');
  };
  const receipt = async (id, reference, at, view) => {
    const { terms, funding } = await accepted(id, at), b = await bulkSchema();
    check(b.bulkInscription(reference), 'bulk_payment_reference');
    const receiptKey = b.bulkReceiptKey(bitcoinNetwork, reference);
    check(!await get('fq/fp/bulk-receipt/' + receiptKey, at) && !await get('fq/fp/bulk-credit/' + receiptKey, at), 'financial_quarantined', 503);
    const transactions = await reads.bulkTransactions([reference.slice(0, 64)], { kinds: ['transfers'], view });
    const tx = transactions.find(t => t.txid === reference.slice(0, 64));
    check(tx?.inclusion?.confirmations >= 1 && tx.complete?.transfers === true, 'bulk_payment_unknown', 503);
    const content = tx.inscriptions.find(i => i.id === reference)?.content;
    check(content?.p === 'tap' && content.op === 'token-auth' && same(content.redeem?.items, b.bulkWalletItems(terms)), 'bulk_payment_items', 409);
    b.bulkBytes(content, b.BULK_LIMITS.redeemBytes, 'bulk_redeem_bytes');
    const transfers = tx.transfers.filter(r => r.value.ins === reference).map(({ index, value }) => ({ index,
      ...Object.fromEntries(['ins', 'fail', 'int', 'addr', 'taddr', 'tick', 'amt', 'dta'].map(k => [k, value[k]])) })).sort((a, z) => a.index - z.index);
    check(transfers.length === terms.groups.length && new Set(transfers.map(r => r.index)).size === transfers.length, 'bulk_payment_unknown', 503);
    const paid = terms.groups.map((g, i) => {
      const matches = transfers.filter(r => r.dta === b.bulkPaymentData(id, i));
      check(matches.length === 1, 'bulk_payment_unknown', 503);
      const r = matches[0];
      check(Number.isSafeInteger(r.index) && r.index >= 0 && typeof r.fail === 'boolean' && r.int === true &&
        r.ins === reference && r.addr === terms.payer && r.taddr === g.to && r.tick === 'tap' && r.amt === g.amount, 'bulk_payment_binding', 409);
      return r.fail ? '0' : g.amount;
    });
    const block = { height: rules.decimalV2(tx.inclusion.height), hash: tx.inclusion.hash };
    check(rules.hex(block.hash, 32), 'bulk_payment_block');
    const receiptRoot = rules.hashObject(['dmw-bulk-receipt-v1', network, reference, block.hash, transfers]);
    return { requestId: id, terms: funding.terms, reference, block, paid, receiptRoot, transfers, confirmations: tx.inclusion.confirmations };
  };
  reads.bulkReceipt = (id, reference, at) => fenced(at, (anchor, view) => receipt(id, reference, anchor, view), true);
  reads.bulkResolvePayment = (report, terms, at) => fenced(at, async (anchor, view) => {
    const b = await bulkSchema(), txids = [...new Set([report.revealTxid, report.commitTxid].filter(Boolean))];
    const txs = await reads.bulkTransactions(txids, { kinds: ['transfers'], view }), candidates = [];
    for (const tx of txs) for (const inscription of tx.inscriptions ?? []) {
      if (inscription.content?.op === 'token-auth' && same(inscription.content.redeem?.items, b.bulkWalletItems(terms))) candidates.push(inscription.id);
    }
    // A commit txid is never guessed to mean redeem i0. Background recovery
    // will find its actual reveal if it is not indexed yet.
    return candidates;
  }, true);
  // Background-only indexing over the already bounded TAP lookup stream. One
  // cursor indexes a payer once; all orders then query their exact data domain.
  // No per-member list/max=1 calls and no public read enumerates payer history.
  reads.bulkDiscoverPayments = async (id, terms, { after = 0, epoch: previousEpoch } = {}) => {
    const b = await bulkSchema(), index = reads.lookups;
    if (!index?.db) return { references: [], next: after };
    const db = index.db;
    if (!discoverySchemas.has(db)) {
      db.exec("CREATE TABLE IF NOT EXISTS bulk_redeem_scan(stream TEXT PRIMARY KEY,pos INTEGER,height TEXT,hash TEXT,epoch TEXT NOT NULL DEFAULT '0');" +
        'CREATE TABLE IF NOT EXISTS bulk_redeem_locations(stream TEXT,order_id TEXT,pos INTEGER,reference TEXT,PRIMARY KEY(stream,order_id,pos));');
      if (!db.prepare('PRAGMA table_info(bulk_redeem_scan)').all().some(c => c.name === 'epoch'))
        db.exec("ALTER TABLE bulk_redeem_scan ADD COLUMN epoch TEXT NOT NULL DEFAULT '0'");
      discoverySchemas.add(db);
    }
    const stream = index.watch('redeem', [terms.payer]);
    return index.work.run('bulk-discovery/' + stream, async () => {
      await index.advance(stream, b.BULK_LIMITS.sourcePages);
      const state = index.stream(stream); check(await index.canonical(state), 'bulk_discovery_reorg', 503);
      let cursor = db.prepare('SELECT * FROM bulk_redeem_scan WHERE stream=?').get(stream);
      let epoch = cursor?.epoch ?? '0';
      if (cursor && (!await index.canonical(cursor) || cursor.pos > state.offset)) {
        epoch = (BigInt(epoch) + 1n).toString();
        db.prepare('DELETE FROM bulk_redeem_locations WHERE stream=?').run(stream); cursor = null; after = 0;
      }
      if (previousEpoch !== undefined && previousEpoch !== epoch) after = 0;
      const rows = db.prepare('SELECT pos,value FROM lookup_rows WHERE stream=? AND pos>=? ORDER BY pos LIMIT ?')
        .all(stream, cursor?.pos ?? 0, b.BULK_LIMITS.sourcePageRows);
      db.exec('BEGIN');
      try {
        for (const row of rows) {
          const value = JSON.parse(row.value); if (!b.bulkInscription(value.ins)) continue;
          for (const item of value.rdm?.items ?? []) {
            const order = /^dmw-bulk-pay-v1\|([0-9a-f]{64})\|0$/.exec(item.dta ?? '')?.[1];
            if (order) db.prepare('INSERT OR REPLACE INTO bulk_redeem_locations VALUES(?,?,?,?)').run(stream, order, row.pos, value.ins);
          }
        }
        db.prepare('INSERT OR REPLACE INTO bulk_redeem_scan VALUES(?,?,?,?,?)').run(stream,
          rows.length ? rows.at(-1).pos + 1 : cursor?.pos ?? 0, state.height == null ? null : String(state.height), state.hash ?? null, epoch);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const matches = db.prepare('SELECT pos,reference FROM bulk_redeem_locations WHERE stream=? AND order_id=? AND pos>=? ORDER BY pos LIMIT ?')
        .all(stream, id, after, b.BULK_LIMITS.members);
      return { references: [...new Set(matches.map(row => row.reference))], next: matches.length ? matches.at(-1).pos + 1 : after, epoch };
    }, { after: true });
  };
  const mintObservations = async (id, members, at, view) => {
    const { terms: t, funding, source } = await accepted(id, at), b = await bulkSchema();
    b.bulkIndices(members, t.members.length, true);
    check(['bulk-consumed', 'bulk-complete'].includes(funding.state) && BigInt(funding.issuedMask) === b.bulkAllMask(t.members.length), 'bulk_not_issued', 409);
    const plans = b.bulkPermitPlans(t, funding.receiptRoot);
    check(plans.permitRoot === funding.permitRoot, 'bulk_permit_root');
    const transactions = await reads.bulkTransactions([...new Set(members.map(m => m.inscription.slice(0, 64)))], { kinds: ['mints'], view });
    const observations = [];
    for (const m of members) {
      const p = plans.plans[m.index], expected = t.members[m.index], tx = transactions.find(tx => tx.txid === m.inscription.slice(0, 64));
      check(tx?.inclusion?.confirmations >= 1 && tx.complete?.mints === true, 'bulk_mint_unknown', 503);
      const payload = tx.inscriptions.find(i => i.id === m.inscription)?.content, mintRows = tx.mints.filter(r => r.value.ins === m.inscription);
      check(mintRows.length === 1 && mintRows[0].value.fail === false, 'bulk_mint_unknown', 503);
      const minted = mintRows[0].value, { prv, ...unsigned } = payload ?? {};
      check(same(unsigned, p.payload) && rules.exactKeys(prv, ['address', 'salt', 'hash', 'sig']) &&
        prv.address === t.receiver && prv.salt === p.salt && prv.hash === p.digest &&
        minted.addr === t.receiver && minted.tick === 'dmt-' + t.ticker && minted.amt === expected.amount && minted.dta === p.payload.dta, 'bulk_mint_binding', 409);
      check(rules.exactKeys(prv.sig, ['r', 's', 'v']) && ['0', '1'].includes(prv.sig.v) &&
        ['r', 's'].every(k => typeof prv.sig[k] === 'string' && /^[0-9]{1,78}$/.test(prv.sig[k])), 'bulk_mint_signature');
      const compact = ['r', 's'].map(k => BigInt(prv.sig[k]).toString(16).padStart(64, '0')).join('');
      const committee = secp256k1.Signature.fromCompact(compact).addRecoveryBit(Number(prv.sig.v)).recoverPublicKey(p.digest).toHex(true);
      check(committee === source.members[m.index].deployment.privilegePublicKey, 'bulk_mint_signature');
      b.bulkBytes(payload, b.BULK_LIMITS.mintPayloadBytes, 'bulk_mint_bytes');
      observations.push({ index: m.index, memberId: p.memberId, inscription: m.inscription, amount: expected.amount, block: expected.block,
        deployment: t.generation, permitHash: p.digest, confirmations: tx.inclusion.confirmations,
        ...await legacyDeployMintCommissions({ ...reads, withTapSnapshot: (_at, fn) => fn(view.stamp) },
          { ...source.members[m.index], requestId: p.memberId }, at, bitcoinNetwork) });
    }
    return observations;
  };
  reads.bulkMintObservations = (id, members, at) => fenced(at, (anchor, view) => mintObservations(id, members, anchor, view), true);
  reads.bulkPermit = (id, index, at) => fenced(at, async anchor => {
    const { terms, funding } = await accepted(id, anchor), b = await bulkSchema(), obligation = await get('ao/' + id, anchor);
    check(['bulk-consumed', 'bulk-complete'].includes(funding.state) && obligation?.state === 'bulk-issued' &&
      Number.isSafeInteger(index) && index >= 0 && index < terms.members.length, 'bulk_not_issued', 409);
    const plans = b.bulkPermitPlans(terms, funding.receiptRoot), permit = plans.plans[index];
    check(plans.permitRoot === funding.permitRoot && obligation.permitRoot === plans.permitRoot, 'bulk_permit_root');
    return { terms, funding, permit, memberId: permit.memberId };
  });
  reads.bulkEvidence = (transition, at) => fenced(at, async (anchor, view) => {
    const b = await bulkSchema(), t = transition;
    if (t.type === 'reserve-many') return reserve(t, anchor);
    const { terms, funding } = await accepted(t.id, anchor), base = { requestId: t.id, owner: terms.owner, terms: funding.terms };
    let evidence;
    if (['bulk-fund', 'bulk-fund-held', 'bulk-credit'].includes(t.type)) {
      const r = await receipt(t.id, t.reference, anchor, view);
      if (t.type !== 'bulk-credit') check(!funding.reference && BigInt(r.block.height) >= BigInt(funding.created) &&
        (t.type === 'bulk-fund-held' || BigInt(r.block.height) <= BigInt(terms.expires) && BigInt(anchor.counted) <= BigInt(terms.expires)), 'bulk_payment_window', 409);
      evidence = { ...base, ...r, state: 'settled' };
    } else if (['bulk-consume', 'bulk-consume-held'].includes(t.type)) {
      check(funding.state === 'bulk-funded' && funding.reference && BigInt(funding.releasedMask) === 0n &&
        (t.type === 'bulk-consume-held' || BigInt(anchor.counted) <= BigInt(terms.expires)), 'bulk_not_funded', 409);
      const r = await receipt(t.id, funding.reference, anchor, view);
      const entry = selectedDeployment(await reads.registry(), terms.asset, terms.deployment);
      check(entry, 'bulk_deployment_unavailable', 503);
      const current = await verifyDeployment({ ...reads, withTapSnapshot: (_at, fn) => fn(view.stamp) }, entry, { view: anchor });
      const outstanding = BigInt(await get(capacityKey(terms.deployment), anchor) ?? '0') + BigInt(await get('fi/deployment/' + terms.deployment, anchor) ?? '0');
      const source = await reservation(t.id, anchor);
      check(current.authorityKey === source.members[0].deployment.privilegePublicKey && outstanding >= BigInt(terms.totalAmount) &&
        outstanding <= BigInt(await reads.tap('getMintTokensLeft/' + (entry.indexTick ?? entry.tick))), 'financial_capacity', 409);
      const claim = await get('fp/bulk-receipt/' + b.bulkReceiptKey(bitcoinNetwork, funding.reference), anchor);
      const plans = b.bulkPermitPlans(terms, r.receiptRoot);
      check(same(r.paid, terms.groups.map(g => g.amount)) && r.receiptRoot === funding.receiptRoot &&
        claim?.orderId === t.id && claim.receiptRoot === r.receiptRoot && t.permitRoot === plans.permitRoot, 'bulk_funding_incomplete', 409);
      evidence = { ...base, state: 'authorized', receiptRoot: r.receiptRoot, permitRoot: plans.permitRoot };
    } else if (t.type === 'bulk-finish') evidence = { ...base, state: 'minted', members: await mintObservations(t.id, t.members, anchor, view) };
    else {
      check(t.type === 'bulk-release' && t.reason === 'expired' && BigInt(anchor.counted) > BigInt(terms.expires) &&
        BigInt(funding.issuedMask) === 0n && ['bulk-open', 'bulk-funded', 'bulk-releasing'].includes(funding.state), 'bulk_release_forbidden', 409);
      b.bulkIndices(t.members, terms.members.length);
      evidence = { ...base, state: 'expired', expiry: terms.expires, members: t.members };
    }
    if (t.type === 'bulk-credit' || t.type === 'bulk-release' && funding.reference && funding.releasedMask === '0') {
      const source = await reservation(t.id, anchor);
      b.validateBulkFees(terms, source.feeManifest);
      evidence.feeManifest = source.feeManifest;
    }
    return b.bulkBytes(evidence, b.BULK_LIMITS.evidenceBytes, 'bulk_evidence_bytes');
  }, ['bulk-fund', 'bulk-fund-held', 'bulk-credit', 'bulk-consume', 'bulk-consume-held', 'bulk-finish'].includes(transition.type));
  return reads;
}
