// Shared by the local signer and the browser bundle. No network or storage.
import { tapBurnAddress } from '../../rules/src/tap-burn.js';
import { tapElementText } from '../../rules/src/pattern-amount.js';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';

export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export function unhex(value) {
  ensure(typeof value === 'string' && /^(?:[0-9a-f]{2})+$/i.test(value), 'Invalid hexadecimal data');
  return Uint8Array.from(value.match(/../g), b => parseInt(b, 16));
}
export const ensure = (ok, message, code = 'player_mint_invalid') => { if (!ok) throw Object.assign(new Error(message), { code }); };
export const digest = value => hex(sha256(new TextEncoder().encode(value)));
export function networkFor(network) {
  ensure(['mainnet', 'regtest', 'testnet'].includes(network), 'Unsupported Bitcoin network');
  return network === 'mainnet' ? btc.NETWORK : network === 'regtest' ? { ...btc.TEST_NETWORK, bech32: 'bcrt' } : btc.TEST_NETWORK;
}
export function fundingAddress(publicKey, network) {
  const key = typeof publicKey === 'string' ? unhex(publicKey) : publicKey;
  return btc.p2tr(key.length === 33 ? key.slice(1) : key, undefined, networkFor(network)).address;
}
const outputScript = (address, network) => btc.OutScript.encode(btc.Address(network).decode(address));
const same = (a, b) => hex(a) === hex(b);

// Wallet callers use confirmed, explicitly cardinal P2TR inputs. The server
// may opt into spending its dedicated unconfirmed set-aside. The TAP Wallet
// adapter marks coins cardinal only after its asset filtering.
function coinsFor(utxos, script, allowUnconfirmed = false) {
  ensure(Array.isArray(utxos) && utxos.length <= 1000, 'Invalid funding coins');
  const seen = new Set();
  return utxos.filter(c => c.cardinal === true && (c.confirmed === true || allowUnconfirmed && c.confirmed === false)).map(c => {
    ensure(/^[0-9a-f]{64}$/.test(c.txid) && Number.isSafeInteger(c.vout) && c.vout >= 0 && c.vout <= 0xffffffff, 'Invalid funding outpoint');
    ensure(typeof c.value === 'string' && /^[1-9][0-9]{0,15}$/.test(c.value), 'Funding value must be integer satoshis');
    ensure(same(unhex(c.script), script), 'Funding coin belongs to a different wallet');
    const id = `${c.txid}:${c.vout}`;
    ensure(!seen.has(id), 'Duplicate funding outpoint'); seen.add(id);
    return { ...c, amount: BigInt(c.value) };
  }).sort((a, b) => a.amount === b.amount ? `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`) : a.amount > b.amount ? -1 : 1);
}

export function buildInscription({ text, receiver, publicKey, network, utxos, feeRate, maxFeeSats, postage = 546, secret = schnorr.utils.randomPrivateKey(), changeAddress, allowUnconfirmed = false, allowNoChange = false, dustSats = 546 }) {
  const net = networkFor(network), content = new TextEncoder().encode(text);
  ensure(typeof text === 'string' && content.length > 0 && content.length <= 80000, 'Inscription must contain 1–80000 UTF-8 bytes');
  ensure(Number.isFinite(feeRate) && feeRate >= 1 && feeRate <= 1000, 'Choose a fee rate between 1 and 1000 sat/vB');
  ensure(typeof maxFeeSats === 'string' && /^[1-9][0-9]{0,9}$/.test(maxFeeSats), 'Set a maximum Bitcoin fee in satoshis');
  ensure(Number.isSafeInteger(postage) && postage >= 546 && postage <= 100000, 'Invalid inscription postage');
  const pub = typeof publicKey === 'string' ? unhex(publicKey) : publicKey;
  const internal = pub.length === 33 ? pub.slice(1) : pub;
  const payer = btc.p2tr(internal, undefined, net), destination = outputScript(receiver, net);
  ensure(Number.isSafeInteger(dustSats) && dustSats >= 546 && dustSats <= 100000, 'Invalid change dust');
  const changeScript = changeAddress ? outputScript(changeAddress, net) : payer.script;
  const chunks = [schnorr.getPublicKey(secret), 'CHECKSIG', 0, 'IF', new TextEncoder().encode('ord'), Uint8Array.of(1), new TextEncoder().encode('text/plain;charset=utf-8'), 0];
  for (let i = 0; i < content.length; i += 520) chunks.push(content.slice(i, i + 520));
  const script = btc.Script.encode([...chunks, 'ENDIF']);
  const leaf = btc.p2tr(btc.TAPROOT_UNSPENDABLE_KEY, { script }, net, true);
  const reveal = (txid, amount, sign) => {
    const tx = new btc.Transaction({ allowUnknownInputs: true });
    tx.addInput({ txid, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: leaf.script, amount }, tapInternalKey: leaf.tapInternalKey, tapMerkleRoot: leaf.tapMerkleRoot, tapLeafScript: leaf.tapLeafScript });
    tx.addOutput({ script: destination, amount: BigInt(postage) });
    if (sign) { tx.signIdx(secret, 0); tx.finalize(); }
    else tx.updateInput(0, { finalScriptWitness: [new Uint8Array(64), script, btc.TaprootControlBlock.encode(leaf.tapLeafScript[0][0])] }, true);
    return tx;
  };
  const revealFee = BigInt(Math.ceil(reveal('00'.repeat(32), 1000000n, false).vsize * feeRate));
  const commitValue = BigInt(postage) + revealFee, coins = coinsFor(utxos, payer.script, allowUnconfirmed);
  let selected = [], total = 0n, commitFee = 0n, change = 0n;
  for (const coin of coins.slice(0, 16)) {
    selected.push(coin); total += coin.amount;
    // Upper bound for key-path P2TR inputs and two P2TR outputs, including a
    // potentially 65-byte SIGHASH_ALL wallet signature.
    commitFee = BigInt(Math.ceil((12 + selected.length * 58 + 2 * 43) * feeRate));
    change = total - commitValue - commitFee;
    if (change >= BigInt(dustSats) || allowNoChange && change >= 0n) break;
  }
  if (!(selected.length > 0 && (change >= BigInt(dustSats) || allowNoChange && change >= 0n))) {
    const required = commitValue + BigInt(Math.ceil((12 + Math.max(1, selected.length) * 58 + 2 * 43) * feeRate)) + (allowNoChange ? 0n : BigInt(dustSats));
    throw Object.assign(Error('Fund this wallet with confirmed cardinal BTC (up to 16 inputs)'), {
      code: allowUnconfirmed || allowNoChange ? 'bitcoin_funding_insufficient' : 'player_mint_invalid',
      requiredSats: String(required), availableSats: String(total),
    });
  }
  if (allowNoChange && change < BigInt(dustSats)) { commitFee += change; change = 0n; }
  ensure(commitFee + revealFee <= BigInt(maxFeeSats), 'Bitcoin fee exceeds the approved maximum', 'bitcoin_fee_limit');
  const commit = new btc.Transaction();
  for (const coin of selected) commit.addInput({ txid: coin.txid, index: coin.vout, sequence: 0xfffffffd, witnessUtxo: { script: payer.script, amount: coin.amount }, tapInternalKey: internal });
  commit.addOutput({ script: leaf.script, amount: commitValue });
  if (change > 0n) commit.addOutput({ script: changeScript, amount: change });
  // Segwit signatures do not change the txid. Sign the reveal now and persist
  // it before allowing a commit broadcast; no ephemeral private key is saved.
  const commitTxid = hex(sha256(sha256(commit.unsignedTx)).reverse());
  let child;
  try { child = reveal(commitTxid, commitValue, true); }
  finally { secret.fill(0); }
  ensure(child.weight <= 400000, 'Reveal exceeds standard transaction weight');
  return { version: 1, network, receiver, payer: payer.address, textHash: digest(text),
    commitPsbt: hex(commit.toPSBT(0)), commitTxid,
    revealHex: child.hex, revealTxid: child.id, inscriptionId: `${child.id}i0`,
    feeRate, feeSats: String(commitFee + revealFee), postage,
    inputs: selected.map(c => ({ txid: c.txid, vout: c.vout })) };
}

export function acceptSignedCommit(plan, signedPsbt) {
  const signed = btc.Transaction.fromPSBT(unhex(signedPsbt));
  const original = btc.Transaction.fromPSBT(unhex(plan.commitPsbt));
  ensure(same(signed.unsignedTx, original.unsignedTx), 'Wallet changed the approved transaction');
  ensure(signed.isFinal && signed.id === plan.commitTxid, 'Wallet did not finalize the commit');
  ensure(signed.fee === original.fee && signed.fee >= BigInt(Math.ceil(signed.vsize * plan.feeRate)), 'Wallet fee does not match the approved plan');
  return { ...plan, signedCommitPsbt: signedPsbt, commitHex: signed.hex };
}
export function signCommit(plan, privateKey) {
  const tx = btc.Transaction.fromPSBT(unhex(plan.commitPsbt));
  tx.sign(privateKey); tx.finalize();
  return acceptSignedCommit(plan, hex(tx.toPSBT(0)));
}

export function feeItemKey(item) { return JSON.stringify([item.role, item.to, item.ticker, item.tt, item.dta ?? null]); }
export function missingItems(status) {
  ensure(status && /^[0-9a-f]{64}$/.test(status.requestId) && Array.isArray(status.fees) && Array.isArray(status.missing), 'Expected a player-paid mint status with fees and missing items');
  const fees = new Map();
  for (const item of status.fees) {
    ensure(item && typeof item.role === 'string' && (item.tt === 'b' ? item.to === null : typeof item.to === 'string') && typeof item.ticker === 'string' && item.ticker === 'tap' &&
      typeof item.amount === 'string' && /^[1-9][0-9]{0,77}$/.test(item.amount) && ['a', 'b'].includes(item.tt), 'Invalid quote fee item');
    const key = feeItemKey(item); ensure(!fees.has(key), 'Duplicate fee item'); fees.set(key, item);
  }
  const seen = new Set();
  for (const item of status.missing) {
    const key = feeItemKey(item); ensure(fees.has(key) && !seen.has(key) && typeof item.amount === 'string' && /^[1-9][0-9]{0,77}$/.test(item.amount) && BigInt(item.amount) <= BigInt(fees.get(key).amount), 'Missing item differs from the quote'); seen.add(key);
  }
  return status.missing;
}
export function transferItems(status, network = 'mainnet') {
  const missing = missingItems(status);
  ensure(!missing.some(i => i.tt === 'b'), 'TAP Wallet token-auth redeem items cannot carry a native burn item. No fee items were sent.', 'tap_burn_redeem_unsupported');
  ensure(status.fees.every(i => i.role !== 'burn' || i.to === tapBurnAddress(network)), 'TAP burn address differs from this Bitcoin network', 'tap_burn_address');
  return missing.map(i => {
    const padded = i.amount.padStart(19, '0'), fraction = padded.slice(-18).replace(/0+$/, '');
    return { address: i.to, tick: i.ticker, amt: padded.slice(0, -18) + (fraction ? '.' + fraction : ''), dta: i.dta ?? `dmw-pay-v2|${status.requestId}|${i.role}` };
  });
}

export function mintContent(status, address) {
  ensure(status.receiver === address, 'The request receiver differs from this player wallet', 'mint_receiver_mismatch');
  missingItems(status);
  ensure(status.state === 'permit_issued' && status.missing.length === 0, 'Wait for final payment and the mint permit', 'mint_permit_not_ready');
  const text = typeof status.mintContent === 'string' ? status.mintContent : JSON.stringify(status.mintContent);
  let payload; try { payload = JSON.parse(text); } catch { ensure(false, 'Missing or invalid inscription content'); }
  const commitment = /^dmw-mint-v1\|([a-zA-Z0-9._:-]{1,96})\|([0-9a-f]{64})\|([0-9a-f]{64})\|([0-9a-f]{64})$/.exec(payload?.dta ?? '');
  const bound = payload?.dta === status.requestId || commitment?.[2] === status.requestId &&
    (!status.deploymentId || commitment[3] === digest(status.deploymentId));
  ensure(payload?.p === 'tap' && ['dmt-mint', 'token-mint'].includes(payload.op) && payload.prv?.address === address && bound,
    'Mint content is not bound to this request and receiver');
  if (payload.op === 'token-mint') ensure(payload.amt === status.amount, 'Mint quantity differs from the quote');
  if (status.actualTicker) ensure(payload.tick === status.actualTicker, 'Mint ticker differs from the quote');
  if (payload.op === 'dmt-mint') {
    if (status.block !== undefined) ensure(payload.blk === String(status.block), 'Mint block differs from the quote');
    if (status.deploymentId) ensure(payload.dep === status.deploymentId, 'Mint deployment differs from the quote');
  }
  return text;
}

// During the discoverer's week only the discoverer's bound wallet deploys a pattern's
// token. The gateway refuses any other inscription; this says so before anyone pays.
export const discovererOnly = until => `Only the discoverer can deploy this token until block ${until}. After that anyone can, and the deployer keeps its art rights.`;
export function checkDeployer(job, { owner, address } = {}) {
  const rule = job?.kind === 'dmt' && job.state !== 'registered' ? job.deployer : null;
  if (!rule?.onlyDiscoverer) return;
  ensure(/^(0|[1-9][0-9]*)$/.test(rule.until ?? '') && typeof rule.address === 'string' && address === rule.address &&
    (owner === undefined || owner === rule.discoverer), discovererOnly(rule.until), 'discoverer_receiver');
}
export function deploymentContent(job) {
  const pattern = job?.kind === 'dmt';
  ensure((pattern ? /^(?:p[0-9a-z]{1,23}|p2:(?:0|[1-9][0-9]*))$/.test(job.asset) : job?.kind === 'compound' && /^(?:c[0-9a-z]{1,23}|c2:[0-9a-f]{64})$/.test(job.asset)) &&
    job.state === 'awaiting_player_deploy' && (job.phase === 'deployment' || pattern && job.phase === 'element'), 'Deployment is not ready for the player');
  const attempt = job.attempts?.find(a => a.phase === job.phase && a.attempt === (job.phase === 'element' ? job.elementAttempt : job.tickerAttempt));
  ensure(attempt && /^[0-9a-f]{64}$/.test(attempt.id), 'Missing deployment attempt');
  const text = job.inscriptionText;
  if (job.phase === 'element') {
    const name = typeof text === 'string' ? text.split('.')[0] : '';
    ensure(/^dmw[a-z0-9]{0,29}$/.test(name) && text === tapElementText(name, job.definition) &&
      text === job.content && text === attempt.text, 'Element differs from the accepted pattern');
  } else {
    let payload; try { payload = JSON.parse(text); } catch { ensure(false, 'Invalid deployment content'); }
    ensure(payload?.p === 'tap' && payload.op === (pattern ? 'dmt-deploy' : 'token-deploy') && /^dmw[a-z0-9]{2,29}$/.test(payload.tick) &&
      /^[0-9a-f]{64}i[0-9]+$/.test(payload.prv) && (!job.privilege || payload.prv === job.privilege), 'Invalid mint authority or ticker');
    // prov names the pattern's discoverer or the compound's first maker.
    ensure(payload.prov === undefined || payload.prov === (pattern ? job.definition?.discoverer : job.definition?.firstMaker), 'Deployment names another discoverer or first maker');
    if (pattern) ensure(payload.elem === job.elementId && /^[0-9a-f]{64}i[0-9]+$/.test(payload.elem) && payload.dt === job.definition?.dt &&
      ['dt,elem,op,p,prv,tick', 'dt,elem,op,p,prov,prv,tick'].includes(Object.keys(payload).sort().join(',')), 'Deployment differs from the indexed element');
    else ensure(payload.dec === '0' && typeof payload.max === 'string', 'Invalid compound supply');
    const ordered = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
    ensure(ordered(payload) === ordered(attempt.text) && ordered(payload) === ordered(job.content), 'Content differs from its deployment attempt');
  }
  return { text, attemptId: attempt.id, phase: job.phase };
}

export function checkSavedFee(plan, maxFeeSats) {
  ensure(typeof maxFeeSats === 'string' && /^[1-9][0-9]{0,9}$/.test(maxFeeSats) && BigInt(plan.feeSats) <= BigInt(maxFeeSats), 'Saved inscription exceeds the approved Bitcoin fee ceiling', 'bitcoin_fee_limit');
}
