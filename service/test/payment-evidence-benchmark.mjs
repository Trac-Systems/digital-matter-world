// Run with PAYMENT_LATENCY_MS=300 for wall-clock measurements. All source data
// is generated locally; each modeled remote call has the same fixed latency.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { rm } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { financialSourceFixture } from './financial-source-fixture.mjs';
import { publicMintSourceFixture } from './public-mint-source-fixture.mjs';
import { buildFinancialExecution } from '../src/financial-execution.mjs';
import { verifyFinancialExecution } from '../../committee/signer/financial-execution.mjs';
import { installFinancialSources } from '../src/financial-sources.mjs';
import { rules as r } from '../src/rules.mjs';
import { publicScanKey } from '../../contract/public-mint.js';

const latency = Number(process.env.PAYMENT_LATENCY_MS ?? 1);
const cases = process.env.PAYMENT_CASES?.split(',') ?? ['public-scan', 'fund+consume', 'capacity-finish'];
const sizes = process.env.PAYMENT_SIZES?.split(',').map(Number) ?? [1, 10];
const concurrency = Number(process.env.PAYMENT_CONCURRENCY ?? 4);
function meter() {
  let enabled = false, calls = {}, steps = [];
  const checkout = new AsyncLocalStorage(), step = new AsyncLocalStorage();
  return {
    async read(name, fn) {
      if (enabled && !(name === 'record' && checkout.getStore()?.active)) {
        calls[name] = (calls[name] ?? 0) + 1; const row = step.getStore(); if (row) row.calls++;
        await delay(latency);
      }
      return fn();
    },
    trace(reads) {
      const create = reads.financialScope;
      reads.financialScope = options => {
        const scoped = create(options), evidence = scoped.financialEvidence;
        scoped.financialEvidence = async (transition, at) => {
          if (!enabled) return evidence(transition, at);
          const row = { transition, calls: 0, ms: 0 }, start = performance.now(); steps.push(row);
          try { return await step.run(row, () => evidence(transition, at)); }
          finally { row.ms = Math.round(performance.now() - start); }
        };
        return scoped;
      };
      return reads;
    },
    // Model one remote checkout acquisition; its immutable point reads are
    // local, just as in the production notary adapter. Older readers ignore
    // this hook and pay the remote latency on every individual point read.
    async snapshot(_at, task) {
      return this.read('notaryCheckout', async () => {
        const scope = { active: true };
        try { return await checkout.run(scope, task); } finally { scope.active = false; }
      });
    },
    wrap(reads, names) { for (const name of names) if (reads[name]) { const fn = reads[name]; reads[name] = (...args) => this.read(name, () => fn(...args)); } },
    async measure(fn) { calls = {}; steps = []; enabled = true; const start = performance.now(); try { const value = await fn(); return { value, ms: Math.round(performance.now() - start), calls: Object.values(calls).reduce((a, b) => a + b, 0), detail: calls, steps }; } finally { enabled = false; } }
  };
}
async function native(kind, count, tickers, m, cleanups) {
  const f = await financialSourceFixture({ after: fn => cleanups.push(fn) }, {}, tickers > 1 ? r.MULTI_TICKER_HEIGHT : '100', {
    twoTickers: tickers > 1, threeTickers: tickers > 2,
    record: (key, at, store) => m.read('record', () => store.get('accountRecords', key)),
    sources: reads => {
      reads.feeQuotes.now = () => 1000;
      reads.withNotaryReadSnapshot = m.snapshot.bind(m);
      reads.withTapReadSnapshot = async (_at, task) => task();
      m.wrap(reads, ['batchStamp', 'settingsByHash', 'tap', 'content', 'included', 'privilegeAuthority', 'paymentTransfers', 'mint']);
    }
  });
  cleanups.unshift(() => rm(f.store.directory, { recursive: true, force: true }));
  for (const entry of f.entries.slice(1)) {
    const generation = await f.reads.financialDeployment('c1', await f.stamp(), entry.id);
    await f.financial.submit({ type: 'lifecycle', id: generation.id, action: generation.action }); await f.execute();
  }
  const transitions = [], observations = new Map();
  for (let i = 0; i < count; i++) {
    const p = await f.prepare('benchmark/' + i, 'tap', f.owner, tickers > 1 ? f.entries[i % tickers].id : undefined);
    await f.mints.request({ ...p.body, reserve: p.action }); await f.execute();
    const row = f.store.get('mints', p.id), reference = r.hash('benchmark/payment/' + i) + 'i0';
    f.transfers.set(reference, row.quote.fees.map(fee => ({ ins: reference, fail: false, int: true, addr: row.payer, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
    const receipts = await f.reads.financialReceipts(p.id, [reference], await f.stamp());
    const fund = { type: 'fund', id: p.id, references: [reference], items: receipts.map(receipt => ({ key: receipt.key,
      fee: '', total: receipt.amount, amount: receipt.amount })) };
    // Use the independently derived fee keys already recorded in the reservation.
    const funding = f.store.get('accountRecords', 'fp/' + p.id);
    fund.items.forEach((item, index) => item.fee = funding.fees[index].key);
    if (kind === 'fund+consume' || kind === 'mixed' && i % 2 === 0) {
      // Derive the consume digest against a disposable local funding simulation.
      const preview = await buildFinancialExecution({ store: f.store, reads: f.reads, document: f.document,
        height: (await f.stamp()).counted, at: await f.stamp(), transitions: [fund], followUp: (await import('../src/financial-execution.mjs')).completingFundFollowUp });
      transitions.push(...preview.inputs.map(input => input.transition));
    } else {
      await f.financial.submit(fund); await f.execute(); await f.mints.tick(); await f.execute(); await f.mints.tick();
      const mintedRow = f.store.get('mints', p.id), permit = mintedRow.permit;
      assert.ok(permit, 'a real consumed permit was issued');
      observations.set(p.id, { accepted: true, fail: false, confirmations: 1, inscription: r.hash('benchmark/mint/' + i) + 'i0',
        deployment: row.context.deployment.id, tick: row.context.deployment.tick, receiver: row.receiver, amount: row.request.amount,
        permitHash: permit.prv.hash, committee: row.context.deployment.privilegePublicKey });
      transitions.push({ type: 'lifecycle', id: p.id, action: { type: 'capacity-finish', id: p.id, permitHash: permit.prv.hash } });
    }
  }
  f.minted(id => observations.get(id));
  return { store: f.store, makeReads: f.makeReads, document: f.document, at: await f.stamp(), transitions };
}
async function scans(count, tickers, m) {
  const f = publicMintSourceFixture({ legacyPolicy: true }); f.setHeight('203');
  const contexts = new Map();
  for (let i = 0; i < tickers; i++) {
    const asset = 'p2:' + i, context = structuredClone(f.context);
    context.pattern.number = String(i); context.deployment.id = r.hash('benchmark/deployment/' + i) + 'i0'; context.deployment.tick = 'fixture' + i;
    context.publicClaims.unsettled = false; contexts.set(asset, context);
    f.records.set('fd/asset/' + asset, 'generation' + i);
    f.records.set('fd/generation' + i, { asset, deployment: context.deployment.id, minted: '0', reserved: '0', maximum: '1000000' });
  }
  f.reads.assetContext = async asset => structuredClone(contexts.get(asset));
  const transitions = [], transactions = [];
  for (let i = 0; i < count; i++) {
    const asset = 'p2:' + (i % tickers), block = String(100 + i), id = r.publicPlotId(asset, block);
    const quote = await f.reads.publicMintQuote({ ...f.input, asset, block }, { counted: '203' });
    f.pay(quote); transactions.push(...f.blocks.get('203'));
    const old = { next: { height: '203', transactionIndex: '0', inscriptionIndex: '0' }, scannedHeight: '202', blockHash: r.hash('block/202'), winner: null };
    f.records.set(publicScanKey(id), old);
    transitions.push({ type: 'public-scan', id, asset, block, previous: r.hashObject(old) });
  }
  f.blocks.set('203', transactions);
  const at = { counted: '203', tip: '203', tipHash: r.hash('tip'), last: { n: '1', to: '203' }, revision: 1 };
  const makeReads = () => {
    const reads = { ...f.reads, batchStamp: async () => at, settingsByHash: async () => f.document,
      withNotaryReadSnapshot: m.snapshot.bind(m), withTapReadSnapshot: async (_at, task) => task() };
    m.wrap(reads, ['batchStamp', 'rulesContext', 'assetContext', 'settingsByHash', 'isMinted', 'publicMintHeader', 'publicBitcoinHash', 'publicBitcoinBlock', 'content', 'paymentTransfers', 'included']);
    // Keep issuer/validator instances independent, as in the two processes.
    reads.feeQuotes = Object.assign(Object.create(Object.getPrototypeOf(f.reads.feeQuotes)), f.reads.feeQuotes);
    return installFinancialSources(reads, { network: f.document.network, document: f.document, bitcoinNetwork: 'regtest', recoveryVersion: 2,
      request: async () => null, reservation: async () => null, record: key => m.read('record', () => f.records.get(key)) });
  };
  return { store: { get: (space, id) => space === 'accountRecords' ? f.records.get(id) ?? null : null }, makeReads, document: f.document, at, transitions };
}
for (const kind of cases) for (const count of sizes) for (const tickers of count === 1 ? [1] : [1, 3]) {
  const cleanups = [], m = meter();
  try {
    const f = kind === 'public-scan' ? await scans(count, tickers, m) : await native(kind, count, tickers, m, cleanups);
    const reads = m.trace(f.makeReads()), signer = m.trace(f.makeReads());
    const build = () => buildFinancialExecution({ ...f, reads, height: f.at.counted, evidenceConcurrency: concurrency });
    const gateway = await m.measure(build);
    const files = [{ ops: gateway.value.operations, financialOperations: gateway.value.inputs }];
    const verify = () => verifyFinancialExecution({ files, reads: signer, document: f.document, network: f.document.network,
      height: f.at.counted, at: f.at, evidenceConcurrency: concurrency });
    const committee = await m.measure(verify);
    assert.equal(gateway.value.inputs.length, f.transitions.length);
    const again = await buildFinancialExecution({ ...f, reads, height: f.at.counted, evidenceConcurrency: 1 });
    assert.equal(r.stableJSON(again), r.stableJSON(gateway.value), 'parallel and sequential serialization match');
    for (const [path, result] of [['gateway', gateway], ['signer', committee]]) console.log(JSON.stringify({ kind, steps: count, tickers, path,
      latency, concurrency, calls: result.calls, ms: result.ms, perStepCalls: result.calls / count, perStepMs: Math.round(result.ms / count), detail: result.detail,
      outputHash: r.hashObject(gateway.value),
      evidenceSteps: result.steps.map(({ transition, ...timing }) => ({ index: f.transitions.indexOf(transition), type: transition.type, ...timing })) }));
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
}
