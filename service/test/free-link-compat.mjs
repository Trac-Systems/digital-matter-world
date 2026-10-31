// Run the same corpus against two immutable trees and compare stdout bytes.
// node service/test/free-link-compat.mjs /absolute/tree > corpus.json
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(process.argv[2]);
const load = path => import(pathToFileURL(resolve(root, path)));
const r = await load('rules/src/index.js');
const { FeeQuotes, createFeePolicy, changeFeePolicy } = await load('service/src/fees.mjs');
const { linkInput } = await load('committee/test/link-fixture.mjs');
const { network } = await load('rules/test/observation-fixture.mjs');
const { feeArguments } = await load('service/scripts/base-fee.mjs');
const { buildSuccessor } = await load('deploy/host-157/settings-successor.mjs');
const output = [], error = fn => { try { fn(); return null; } catch (e) { return e.message; } };
for (const height of ['0', '973889', '973890', '2099999999']) {
  for (const baseFee of ['1', '101', '11100000000000000000']) {
    for (const feeSettings of [undefined, r.FEE_DEFAULTS, { tierMultipliers: [1,1,1,1,1], compoundMinimum: 1, link: 1 }]) {
      const registry = { feePolicy: createFeePolicy(baseFee, 0, feeSettings) };
      for (const linkBurnBps of [0, 1234, 5000, 10000]) {
        const document = r.settingsRevision({ network, effectiveBatch: '0', effectiveBitcoinWindow: '0', values: {
          ...r.SETTINGS_PROFILE, feePolicyRevision: registry.feePolicy.current, linkMultiplier: (feeSettings ?? r.FEE_DEFAULTS).link, linkBurnBps } });
        const issuer = new FeeQuotes({ network, secret: new Uint8Array(32).fill(9), registry: async () => registry,
          now: () => 1000, settings: () => document, settingsHistory: { get: async () => document } });
        const q = await issuer.issue('link/retained', height), a = await issuer.accept(q, q.scope, 'retained', String(BigInt(height) + 100n), height);
        const terms = await issuer.accepted(a, q.scope, 'retained', String(BigInt(height) + 100n));
        const economics = [];
        for (const kind of ['find', 'compound', 'link']) for (let tier = 1; tier <= 5; tier++) {
          const price = r.feeFor(kind, baseFee, tier, feeSettings, height);
          const split = r.financialSplit(price, { kind, linked: true, discovered: true, executionHeight: height }, document);
          economics.push({ kind, tier, price, split, treasury: r.treasuryPayment(split),
            fees: r.mintFeeItems(split, { treasury: 'regtest-treasury', finder: 'regtest-finder', firstMaker: 'regtest-maker', landowner: 'regtest-holder', discoverer: 'regtest-discoverer' }, 'a'.repeat(64), 'regtest-payer', 'tap', 'regtest') });
        }
        const payments = [];
        for (const rail of ['tap', 'ethereum']) {
          const input = linkInput(42, rail); input.terms.settingsHash = r.hashObject(document);
          input.terms.baseFee = baseFee; if (feeSettings) input.terms.feeSettings = feeSettings;
          const total = r.feeFor('link', baseFee, 1, feeSettings, height), split = r.linkPaymentSplit(total, document, height);
          input.payment.total = total;
          if (rail === 'tap') { input.payment.base = split.treasury; input.payment.allocations = r.tapPaymentAllocations(split, {}, 'link'); }
          else { input.payment.split.treasuryAmount = split.treasury; input.payment.split.burnAmount = split.burn;
            if (split.treasury === '0') input.payment.split.treasury = '0x' + '00'.repeat(20); }
          payments.push(r.verifyLinkInput(input, network, 100, { executionHeight: height, document }));
        }
        output.push({ height, registry, document, settingsHash: r.hashObject(document), q, a, terms, economics, payments,
          changed: changeFeePolicy(registry, { link: 7 }, 1001),
          zeroFee: error(() => r.feeFor('link', baseFee, 1, { ...r.FEE_DEFAULTS, link: 0 }, height)),
          zeroSettings: error(() => r.validateSettings({ ...document.values, linkMultiplier: 0 })),
          zeroTool: error(() => feeArguments(['/config', '--link', '0'])) });
      }
    }
  }
}
const current = r.settingsRevision({ network, effectiveBatch: '0', effectiveBitcoinWindow: '0', values: r.SETTINGS_PROFILE });
const resources = r.resourceRevision({ operator: network, values: r.RESOURCE_PROFILE });
output.push(buildSuccessor({ current, resources, last: { n: '1', to: '1000' }, head: { counted: '1000' } },
  { activationHeight: '1020', feePolicyRevision: 'a'.repeat(64), linkMultiplier: 1 }));
process.stdout.write(r.stableJSON(output) + '\n');
