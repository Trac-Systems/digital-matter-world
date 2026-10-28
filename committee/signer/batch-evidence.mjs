import { paidMintPlan } from './pay-first.mjs';
import * as rules from '../../rules/src/index.js';
import { check, equal } from './crypto.mjs';

// Balance and hold reads start at the accepted contract head. Earlier operations
// in the proposed batch are applied locally, never read back from the gateway.
export async function verifyBatchEvidence({ reads, bitcoinNetwork = reads.bindings?.bitcoinNetwork ?? 'mainnet', network, publicKey, context, files, authorizedMint, confirmations = 1 }) {
  const balances = new Map(), holds = new Map(), nonces = new Set(), requests = new Set();
  const at = { counted: context.counted, last: context.last };
  const balance = async (owner, asset) => {
    const key = `${owner}/${asset}`;
    if (!balances.has(key)) {
      const n = await reads.balance(owner, asset, at);
      check(typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n), 'batch_balance_read'); balances.set(key, BigInt(n));
    }
    return balances.get(key);
  };
  const change = async (owner, asset, delta) => {
    const n = await balance(owner, asset) + delta; check(n >= 0n, 'batch_balance'); balances.set(`${owner}/${asset}`, n);
  };
  const hold = async r => {
    const key = `${r.asset}/${r.block}`;
    if (!holds.has(key)) holds.set(key, await reads.blockHold(r.asset, r.block, at));
    return holds.get(key);
  };
  for (const file of files) {
    const view = { observation: file.observation, height: file.height, tip: file.tip, tipHash: file.tipHash };
    const appliedMints = (file.mintOperations ?? []).filter((_, i) => !file.mintOutcomes || file.mintOutcomes[i].reason === 'accepted');
    let index = 0;
    for (const op of file.ops) {
      if (op.op === 'kv') continue;
      if (op.op === 'ac') { for (const [asset, amount] of op.assets) await change(op.to, asset, BigInt(amount)); continue; }
      if (op.op === 'mk') { await change(op.to, op.asset, BigInt(op.amount)); continue; }
      if (op.op === 'xc') {
        const r = op.request, nonce = `${r.owner}:${r.nonce}`;
        check(!nonces.has(nonce) && await reads.nonceUsed(r.owner, r.nonce, at) === false, 'batch_nonce'); nonces.add(nonce);
        for (const [asset, n] of r.in) await change(r.owner, asset, -BigInt(n));
        for (const [asset, n] of r.out) await change(r.owner, asset, BigInt(n));
        continue;
      }
      const input = appliedMints[index++]; check(input?.op === op.op, 'batch_mint_input');
      const r = input.request, e = input.evidence, id = rules.pendingId(network, r), key = Object.hasOwn(r, 'block') ? `${r.asset}/${r.block}` : null;
      check(!requests.has(id), 'batch_mint_duplicate'); requests.add(id);
      if (op.op === 'rq') {
        const snapshot = await reads.mintPayoutSnapshot?.(id);
        const context = await reads.assetContext(r.asset, r.block, view, snapshot);
        await reads.verifyPayoutSnapshot?.(snapshot, context.payouts);
        const c = rules.mintContext(context);
        check(equal(c, e.context) && c.deployment.privilegePublicKey === publicKey, 'mint_context_read');
        check(equal(e.bitmap, c.link ? await reads.bitmap(r.block, view) : null), 'mint_bitmap_read');
        check(e.minted === (key ? await reads.isMinted(c.deployment.id, c.deployment.tick, r.block, view) : false), 'mint_status_read');
        check(equal(e.hold, key ? await hold(r) : null), 'mint_hold_read');
        const nonce = `${r.owner}:${r.nonce}`;
        check(!nonces.has(nonce) && e.nonceUsed === await reads.nonceUsed(r.owner, r.nonce, at) && e.nonceUsed === false, 'batch_nonce');
        check(e.balance === (await balance(r.owner, r.asset)).toString(), 'mint_balance_read');
        await change(r.owner, r.asset, -BigInt(r.amount)); nonces.add(nonce);
        if (key) holds.set(key, { id, expiry: r.expires });
      } else {
        const plan = await paidMintPlan({ reads, bitcoinNetwork, network, publicKey, request: r, signature: input.sig, receiver: input.receiver, confirmations, final: op.op === 'mc' });
        check(equal(e.pending, plan.pending) && equal(e.reservation, plan.raw), 'pending_acceptance_read');
        check(equal(e.payment, plan.payment), 'mint_payment_read');
        const authorization = { ...rules.mintAuthorization(plan.details), fees: plan.fees, paymentHash: rules.paymentCommitment(plan.progress.allocations) };
        check(equal(e.authorization, authorization), 'mint_authorization_read');
        check(e.balance === (await balance(r.owner, r.asset)).toString(), 'mint_balance_read');
        if (op.op === 'mp' && context.counted > r.expires && !plan.raw.h) await change(r.owner, r.asset, -BigInt(r.amount));
        if (key) holds.set(key, { id, expiry: Number.MAX_SAFE_INTEGER });

      }
    }
    check(index === appliedMints.length, 'batch_mint_input');
  }
}
