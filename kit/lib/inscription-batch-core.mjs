// Pure transaction construction. The sender must prove the one funding outpoint
// against the accepted redeem before invoking this module.
import * as btc from '@scure/btc-signer';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hashObject, stableJSON } from '../../rules/src/core.js';
import { merkleRoot } from '../../rules/src/merkle.js';
import { ensure, hex, unhex, digest, networkFor, fundingAddress } from './inscription-core.mjs';

const textBytes = text => new TextEncoder().encode(text);
const scriptFor = (address, net) => btc.OutScript.encode(btc.Address(net).decode(address));
const same = (a, b) => stableJSON(a) === stableJSON(b);
const txid = tx => hex(sha256(sha256(tx.unsignedTx)).reverse());
const positive = n => typeof n === 'string' && /^[1-9][0-9]*$/.test(n);
const id = n => typeof n === 'string' && /^[0-9a-f]{64}$/.test(n);

function leafFor(text, publicKey, net) {
  const content = textBytes(text);
  const chunks = [publicKey, 'CHECKSIG', 0, 'IF', textBytes('ord'), Uint8Array.of(1), textBytes('text/plain;charset=utf-8'), 0];
  for (let i = 0; i < content.length; i += 520) chunks.push(content.slice(i, i + 520));
  const script = btc.Script.encode([...chunks, 'ENDIF']);
  return { script, ...btc.p2tr(btc.TAPROOT_UNSPENDABLE_KEY, { script }, net, true), envelope: script };
}
function keyInput(tx, parent, index, amount, payer, internal) {
  tx.addInput({ txid: parent, index, sequence: 0xfffffffd, witnessUtxo: { script: payer.script, amount }, tapInternalKey: internal });
}
function revealFor(leaves, start, parent, feeIndex, fee, destination, payer, internal, postage) {
  const tx = new btc.Transaction({ allowUnknownInputs: true });
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    tx.addInput({ txid: parent, index: start + i, sequence: 0xfffffffd, witnessUtxo: { script: leaf.script, amount: BigInt(postage) },
      tapInternalKey: leaf.tapInternalKey, tapMerkleRoot: leaf.tapMerkleRoot, tapLeafScript: leaf.tapLeafScript });
    tx.addOutput({ script: destination, amount: BigInt(postage) });
  }
  keyInput(tx, parent, feeIndex, fee, payer, internal);
  return tx;
}
function dummyReveal(tx, leaves) {
  leaves.forEach((leaf, i) => tx.updateInput(i, { finalScriptWitness: [new Uint8Array(64), leaf.envelope, btc.TaprootControlBlock.encode(leaf.tapLeafScript[0][0])] }, true));
  tx.updateInput(leaves.length, { finalScriptWitness: [new Uint8Array(64)] }, true);
  return tx;
}

// Quotes and real plans share precisely the same scripts and transaction layout.
// Limits are passed from A's BULK_LIMITS by the caller, never inferred from bytes.
export function measureBulkInscriptions({ texts, receiver, payer, network, batchSize = 16, postage = 546 }) {
  ensure(Array.isArray(texts) && texts.length > 0 && texts.length <= 64 && batchSize === 16 && postage === 546, 'bulk_measure_input');
  const net = networkFor(network), internal = btc.TAPROOT_UNSPENDABLE_KEY;
  const key = btc.p2tr(internal, undefined, net), destination = scriptFor(receiver, net);
  const leaves = texts.map(text => leafFor(text, internal, net));
  const commit = new btc.Transaction();
  keyInput(commit, '00'.repeat(32), 0, 1000000n, key, internal);
  leaves.forEach(leaf => commit.addOutput({ script: leaf.script, amount: BigInt(postage) }));
  const reveals = [];
  for (let start = 0; start < leaves.length; start += batchSize) {
    const group = leaves.slice(start, start + batchSize), feeIndex = leaves.length + reveals.length;
    commit.addOutput({ script: key.script, amount: 10000n });
    const reveal = dummyReveal(revealFor(group, start, '00'.repeat(32), feeIndex, 10000n, destination, key, internal, postage), group);
    reveals.push({ vsize: reveal.vsize, weight: reveal.weight });
  }
  commit.addOutput({ script: scriptFor(payer, net), amount: 10000n });
  commit.updateInput(0, { finalScriptWitness: [new Uint8Array(65)] }, true);
  return { templateBytes: texts.map(t => textBytes(t).length), commitVsize: commit.vsize, revealVsizes: reveals.map(r => r.vsize), revealWeights: reveals.map(r => r.weight) };
}

export async function buildBulkInscriptionPlan({ terms, manifest, funding, publicKey, feeRate, leafSecrets }) {
  const { validateBulkTerms, bulkOrderId, bulkMemberId, BULK_LIMITS } = await import('../../rules/src/bulk-mint.js');
  validateBulkTerms(terms);
  const orderId = bulkOrderId(terms.network, terms.owner, terms.nonce), termsHash = hashObject(terms), count = terms.members.length;
  ensure(manifest?.v === 1 && same(Object.keys(manifest).sort(), ['complete', 'count', 'members', 'membersRoot', 'next', 'offset', 'orderId', 'paymentHash', 'permitRoot', 'readyCount', 'termsHash', 'v']) &&
    textBytes(stableJSON(manifest)).length <= BULK_LIMITS.permitBytes && manifest.offset === 0 && manifest.next === null &&
    manifest.orderId === orderId && manifest.termsHash === termsHash && manifest.membersRoot === terms.membersRoot &&
    manifest.count === count && manifest.complete === true && manifest.readyCount === count && manifest.members?.length === count && id(manifest.paymentHash) && id(manifest.permitRoot), 'bulk_permit_incomplete');
  const texts = manifest.members.map((row, i) => {
    ensure(row && same(Object.keys(row).sort(), ['amount', 'block', 'index', 'memberId', 'mintContent', 'permitHash']), 'bulk_permit_member');
    const memberId = bulkMemberId(orderId, i), m = terms.members[i], p = row.mintContent;
    const salt = digest(`dmw-mint-salt-v1|${terms.network}|${memberId}`);
    const dta = `dmw-mint-v1|${terms.network}|${memberId}|${digest(terms.deployment)}|${manifest.paymentHash}`;
    const expectedDigest = digest(['tap', 'dmt-mint', terms.ticker, m.block, terms.deployment, terms.receiver, dta, salt].join('-'));
    ensure(row.index === i && row.memberId === memberId && row.block === m.block && row.amount === m.amount && row.permitHash === expectedDigest &&
      same(Object.keys(p ?? {}).sort(), ['blk', 'dep', 'dta', 'op', 'p', 'prv', 'tick']) && p.p === 'tap' && p.op === 'dmt-mint' && p.tick === terms.ticker &&
      p.blk === m.block && p.dep === terms.deployment && p.dta === dta && p.prv?.address === terms.receiver && p.prv.salt === salt && p.prv.hash === expectedDigest &&
      same(Object.keys(p.prv).sort(), ['address', 'hash', 'salt', 'sig']) && same(Object.keys(p.prv.sig ?? {}).sort(), ['r', 's', 'v']) &&
      ['0', '1', '2', '3'].includes(p.prv.sig.v) && [p.prv.sig.r, p.prv.sig.s].every(v => positive(v) && v.length <= 78 && BigInt(v) < secp256k1.CURVE.n), 'bulk_permit_binding');
    return stableJSON(p);
  });
  ensure(merkleRoot(manifest.members.map(row => stableJSON(['dmw-bulk-permit-v1', row.memberId, row.permitHash]))) === manifest.permitRoot, 'bulk_permit_root');
  ensure(texts.every(t => textBytes(t).length <= BULK_LIMITS.mintPayloadBytes), 'bulk_content_limit');
  ensure(Number.isFinite(feeRate) && feeRate >= 1 && feeRate <= terms.mintFunding.feeRateCeiling, 'bulk_fee_wait', 'bulk_fee_wait');
  const pub = typeof publicKey === 'string' ? unhex(publicKey) : publicKey, internal = pub.length === 33 ? pub.slice(1) : pub;
  const net = networkFor(terms.bitcoinNetwork), payer = btc.p2tr(internal, undefined, net), destination = scriptFor(terms.receiver, net);
  ensure(payer.address === terms.mintFunding.address && fundingAddress(pub, terms.bitcoinNetwork) === payer.address, 'bulk_funding_address');
  ensure(funding && /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(funding.paymentId) && id(funding.txid) && Number.isSafeInteger(funding.vout) && funding.vout >= 0 && funding.vout <= 0xffffffff &&
    positive(funding.value) && BigInt(funding.value) === BigInt(terms.mintFunding.satoshis) && funding.cardinal === true && funding.script === hex(payer.script), 'bulk_funding_binding');
  ensure(leafSecrets === undefined || Array.isArray(leafSecrets) && leafSecrets.length === count, 'bulk_leaf_secrets');
  const secrets = leafSecrets ?? texts.map(() => schnorr.utils.randomPrivateKey());
  try {
    const leaves = texts.map((text, i) => leafFor(text, schnorr.getPublicKey(secrets[i]), net));
    const sizes = measureBulkInscriptions({ texts, receiver: terms.receiver, payer: terms.payer, network: terms.bitcoinNetwork });
    ensure(sizes.revealWeights.every(w => w <= BULK_LIMITS.revealWeight), 'bulk_reveal_weight');
    const revealFees = sizes.revealVsizes.map(v => BigInt(Math.max(546, Math.ceil(v * feeRate))));
    const commitFee = BigInt(Math.ceil(sizes.commitVsize * feeRate)), fee = commitFee + revealFees.reduce((a, b) => a + b, 0n);
    const change = BigInt(funding.value) - BigInt(count * 546) - fee;
    ensure(fee <= BigInt(terms.mintFunding.maxFeeSats) && fee <= 90000n && change >= 546n, 'bulk_fee_wait', 'bulk_fee_wait');
    const commit = new btc.Transaction(); keyInput(commit, funding.txid, funding.vout, BigInt(funding.value), payer, internal);
    leaves.forEach(leaf => commit.addOutput({ script: leaf.script, amount: 546n }));
    revealFees.forEach(amount => commit.addOutput({ script: payer.script, amount }));
    commit.addOutput({ script: scriptFor(terms.payer, net), amount: change });
    const commitTxid = txid(commit), reveals = [];
    for (let start = 0; start < count; start += 16) {
      const batchIndex = reveals.length, group = leaves.slice(start, start + 16);
      const tx = revealFor(group, start, commitTxid, count + batchIndex, revealFees[batchIndex], destination, payer, internal, 546);
      group.forEach((_, i) => tx.signIdx(secrets[start + i], i));
      reveals.push({ batchIndex, psbt: hex(tx.toPSBT(0)), feeSats: String(revealFees[batchIndex]), members: group.map((_, i) => ({ index: start + i, input: i, output: i, contentHash: digest(texts[start + i]) })) });
    }
    return { v: 1, orderId, termsHash, permitRoot: manifest.permitRoot, network: terms.bitcoinNetwork, payer: terms.payer, receiver: terms.receiver,
      funding: { paymentId: funding.paymentId, txid: funding.txid, vout: funding.vout, value: funding.value }, feeRate, feeSats: String(fee), postageSats: 546, changeSats: String(change),
      commitPsbt: hex(commit.toPSBT(0)), commitTxid, revealPsbts: reveals };
  } finally { secrets.forEach(secret => secret.fill(0)); }
}

export async function signBulkCommit(draft, privateKey) {
  const commit = btc.Transaction.fromPSBT(unhex(draft.commitPsbt)); commit.sign(privateKey); commit.finalize();
  ensure(commit.id === draft.commitTxid && commit.fee >= BigInt(Math.ceil(commit.vsize * draft.feeRate)), 'bulk_commit_binding');
  const reveals = draft.revealPsbts.map(row => {
    const tx = btc.Transaction.fromPSBT(unhex(row.psbt), { allowUnknownInputs: true });
    tx.signIdx(privateKey, row.members.length); tx.finalize();
    ensure(tx.weight <= 100000 && tx.fee === BigInt(row.feeSats) && tx.fee >= BigInt(Math.ceil(tx.vsize * draft.feeRate)), 'bulk_reveal_fee');
    return { batchIndex: row.batchIndex, txid: tx.id, hex: tx.hex, feeSats: row.feeSats, members: row.members.map((m, i) => ({ ...m, inscription: `${tx.id}i${i}` })) };
  });
  const { commitPsbt, commitTxid, revealPsbts, ...plan } = draft;
  return { ...plan, commit: { txid: commit.id, hex: commit.hex }, reveals };
}
