#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { current, bitcoin, receiveAddress, ordJson, mine, save } from './common.mjs';
import { inscribe, sendInscription } from './inscriber.mjs';
import { authority, tokenMintPermit, redeem, testKey, sha256 } from './protocol.mjs';
import { paymentLock, paymentMessage, tapBurnAddress } from './payments.mjs';

function harness(manifest) {
  const tap = async path => (await ordJson(manifest, '/r/tap/' + path)).result;
  const batch = async entries => { const result = await inscribe(manifest, entries); await mine(manifest); return result; };
  const write = async (text, receiver) => (await batch([{ text, receiver }])).inscriptions[0].id;
  const activate = async (text, receiver) => {
    const id = await write(text, receiver); await sendInscription(manifest, id, receiver); await mine(manifest); return id;
  };
  return { tap, batch, write, activate };
}

export async function proveCompounds(manifest, log = () => {}) {
  const { tap, batch, write, activate } = harness(manifest);
  const key = testKey(), committee = await receiveAddress(manifest), receiver = await receiveAddress(manifest), other = await receiveAddress(manifest);
  const tick = 'cmp' + randomBytes(5).toString('hex'), max = '18446744073709551615';
  const balance = async address => BigInt(await tap(`getBalance/${address}/${tick}`) || 0);
  log('Deploying a compound with an activated committee privilege authority');
  const privilege = await activate(authority(key, { privilege: true }), committee);
  assert((await tap('getPrivilegeAuthList')).some(a => a.ins === privilege));
  const deploymentPayload = { p: 'tap', op: 'token-deploy', tick, max, dec: '0', prv: privilege };
  const deployment = await write(deploymentPayload, committee);
  const deployed = await tap(`getDeployment/${tick}`);
  assert.equal(deployed.prv, privilege); assert.equal(deployed.lim, '0'); assert.equal(deployed.dec, 0);
  const permit = fields => tokenMintPermit({ tick, ...fields }, key);
  const changedAmount = permit({ amt: '11', address: receiver });
  const changedData = permit({ amt: '12', address: receiver, dta: 'request-original' });
  const rejectedEntries = [
    { text: { p: 'tap', op: 'token-mint', tick, amt: '10' }, receiver },
    { text: permit({ amt: '10', address: receiver }), receiver: other },
    { text: { ...changedAmount, amt: '13' }, receiver },
    { text: { ...changedData, dta: 'request-changed' }, receiver },
    { text: tokenMintPermit({ tick, amt: '14', address: receiver }, testKey()), receiver },
  ];
  const refused = await batch(rejectedEntries);
  assert.equal(await balance(receiver), 0n); assert.equal(await balance(other), 0n);
  assert.equal(await tap(`getMintTokensLeft/${tick}`), max);
  log('Batching three arbitrary compound amounts, including an integer above 2^53');
  const entries = ['17', '2501', '9007199254740993'].map((amt, i) => ({ text: permit({ amt, address: i === 1 ? other : receiver, dta: `compound-request-${i}` }), receiver: i === 1 ? other : receiver }));
  const minted = await batch(entries);
  assert.equal(minted.inscriptions.length, 3);
  assert.equal(await balance(receiver), 9007199254741010n); assert.equal(await balance(other), 2501n);
  const records = (await tap(`getTickerMintList/${tick}`)).filter(r => !r.fail);
  assert.equal(records.length, 3);
  for (const [i, entry] of entries.entries()) {
    const record = records.find(r => r.ins === minted.inscriptions[i].id);
    assert(record); assert.equal(record.addr, entry.receiver); assert.equal(record.amt, entry.text.amt); assert.equal(record.dta, entry.text.dta);
    assert.equal((await ordJson(manifest, `/inscription/${record.ins}`)).address, entry.receiver);
  }
  const replay = await write(entries[0].text, receiver);
  assert.equal(await balance(receiver), 9007199254741010n);
  const compact = ['r', 's'].map(k => BigInt(entries[0].text.prv.sig[k]).toString(16).padStart(64, '0')).join('');
  assert.equal(await tap(`getPrivilegeAuthCompactHexExists/${compact}`), true);
  assert.equal((await tap(`getTickerMintList/${tick}`)).filter(r => !r.fail).length, 3);
  assert.equal(BigInt(await tap(`getMintTokensLeft/${tick}`)), BigInt(max) - 9007199254743511n);
  const proof = { tick, committee, receiver, other, privilege, deployment, deploymentPayload, refused: Object.fromEntries(['unsigned', 'wrongReceiver', 'changedAmount', 'changedData', 'wrongSigner'].map((name, i) => [name, refused.inscriptions[i].id])), batch: { commit: minted.commit, reveal: minted.reveal, inscriptions: minted.inscriptions, payloads: entries.map(e => e.text) }, replay, records, balances: { receiver: String(await balance(receiver)), other: String(await balance(other)) } };
  await save(`${manifest.root}/compound-proof.json`, proof);
  return { proof, permit };
}

export async function provePayments(manifest, compound, log = () => {}) {
  const { tap, batch, write, activate } = harness(manifest);
  const payerKey = testKey(), releaseKey = testKey();
  const addresses = {};
  for (const role of ['payer', 'finder', 'landowner', 'treasury', 'release']) addresses[role] = await receiveAddress(manifest);
  const { payer, finder, landowner, treasury, release } = addresses;
  const bitcoinNetwork = 'regtest', burn = tapBurnAddress(bitcoinNetwork);
  const unit = 10n ** 18n, price = 100n * unit;
  const balance = async address => BigInt(await tap(`getBalance/${address}/tap`) || 0);
  const snapshot = async () => {
    const result = {};
    for (const [role, address] of Object.entries({ ...addresses, burn: burn })) result[role] = String(await balance(address));
    return result;
  };
  log('Funding a regtest TAP token and independent payer/release authorities');
  assert.equal(await tap('getDeployment/tap'), null, 'proof requires a fresh local TAP ticker');
  const deployment = await write({ p: 'tap', op: 'token-deploy', tick: 'tap', max: '1000', dec: '18' }, payer);
  const funding = await write({ p: 'tap', op: 'token-mint', tick: 'tap', amt: '1000' }, payer);
  assert.equal(await balance(payer), 1000n * unit);
  const payerAuth = await activate(authority(payerKey, { auth: ['tap'] }), payer);
  const releaseAuth = await activate(authority(releaseKey, { auth: ['tap'] }), release);
  assert((await tap(`getAccountAuthList/${payer}`)).some(a => a.ins === payerAuth));
  assert((await tap(`getAccountAuthList/${release}`)).some(a => a.ins === releaseAuth));
  const signed = (message, key) => redeem(message.auth, message.actions, key, { items: message.items, data: message.data });
  const payerAction = (action, request = 'payment') => write(signed(paymentMessage(payerAuth, action, request), payerKey), payer);
  const releaseAction = action => write(redeem(releaseAuth, [action], releaseKey), release);
  const makeLock = async (owner = landowner, blocks = 30) => {
    const preimage = randomBytes(32).toString('hex');
    const expiry = (await bitcoin(manifest, 'getblockcount')) + blocks;
    const action = paymentLock({ bitcoinNetwork, priceAtoms: price, payer, finder, landowner: owner, treasury, hash: sha256(Buffer.from(preimage, 'hex')), expiry });
    return { preimage, expiry, action };
  };
  const locked = async () => BigInt(await tap(`getLockedBalance/${payer}/tap`) || 0);
  const consume = lock => tap(`getLockConsume/${lock}`);
  const post = async (path, body) => {
    const response = await fetch(manifest.gateway.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).data;
  };
  const walletWrite = async message => {
    const envelope = signed(message, payerKey);
    assert.deepEqual(envelope.redeem, message);
    const order = await post('/v1/inscribe/order/texts', { feeRate: 1, postage: 10000, connectedAddress: payer, rebar: false, data: [{ text: JSON.stringify(envelope), receiver: payer }], orderType: 'REDEEM' });
    await bitcoin(manifest, 'sendtoaddress', [order.payAddress, order.totalFee / 1e8], 'faucet'); await mine(manifest);
    const paid = await post(`/v1/inscribe/order/paid/${order.id}`, {}); await mine(manifest);
    assert.equal(paid.files.length, 1); assert.equal(paid.files[0].receiver, payer);
    return { id: paid.files[0].inscriptionId, order: order.id, envelope };
  };
  log('Locking 100 TAP through the wallet order route with a native four-way split');
  const first = await makeLock();
  const requestId = randomBytes(32).toString('hex');
  const message = paymentMessage(payerAuth, first.action, requestId);
  const walletOrder = await walletWrite(message), lock = walletOrder.id + ':0';
  const record = await tap(`getLock/${lock}`);
  assert(record); assert.equal(record.total, String(price)); assert.equal(record.amt, String(35n * unit));
  assert.equal(record.owner, payer); assert.equal(record.claim, treasury); assert.equal(record.refund, payer);
  assert.deepEqual(record.al.map(a => [a.tt, a.to, a.amt, a.rl]), first.action.al.map(a => [a.tt, a.to, String(BigInt(a.amt) * unit), a.rl]));
  assert.equal(await locked(), price); assert.equal(await balance(payer), 1000n * unit, 'lock reserves balance without debiting it');
  const overspend = await payerAction(paymentLock({ bitcoinNetwork, priceAtoms: 1000n * unit, payer, finder, landowner, treasury, hash: first.action.condition.hash, expiry: first.expiry }));
  assert.equal(await tap(`getLock/${overspend}:0`), null, 'allocations count toward reserved balance');
  const badClaim = await releaseAction({ op: 'claim', lock, preimage: 'wrong' });
  const earlyRefund = await payerAction({ op: 'refund', lock });
  assert.equal(await consume(lock), null); assert.equal(await locked(), price);

  // The observer gate is application policy; the hashlock itself does not inspect a mint.
  const claimAfterMint = async (payment, id, expected, secret, extra = {}) => {
    const rows = await tap(`getTickerMintList/${compound.proof.tick}`);
    const minted = rows.find(r => r.ins === id && !r.fail);
    assert(minted && minted.addr === expected.address && minted.amt === expected.amt && minted.dta === expected.dta, 'matching successful mint must be indexed before release');
    const height = await bitcoin(manifest, 'getblockcount');
    assert(height >= minted.blck && height < payment.expiry - 1, 'confirmed mint and time for claim inclusion are required');
    return releaseAction({ ...extra, op: 'claim', lock: payment.lock, preimage: secret });
  };
  const expected = { amt: '137', address: payer, dta: requestId };
  await assert.rejects(claimAfterMint({ lock, expiry: first.expiry }, '00'.repeat(32) + 'i0', expected, first.preimage), /matching successful mint/);
  const mint = await write(compound.permit(expected), payer);
  await assert.rejects(claimAfterMint({ lock, expiry: first.expiry }, mint, { ...expected, amt: '138' }, first.preimage), /matching successful mint/);
  const claim = await claimAfterMint({ lock, expiry: first.expiry }, mint, expected, first.preimage);
  const consumed = await consume(lock);
  assert.equal(consumed?.ins, claim); assert.equal(consumed.action, 'claim'); assert.equal(consumed.target, treasury);
  assert(consumed.blck < first.expiry); assert.equal(await locked(), 0n);
  assert.equal(await balance(payer), 900n * unit); assert.equal(await balance(finder), 30n * unit);
  assert.equal(await balance(landowner), 15n * unit); assert.equal(await balance(treasury), 35n * unit);
  assert.equal(await balance(burn), 0n); assert.equal(await balance(release), 0n);
  assert.equal(consumed.al.find(a => a.tt === 'b').amt, String(20n * unit));
  assert.equal(await tap('getMintTokensLeft/tap'), '0', 'burn does not reopen mint capacity');
  const afterSplit = await snapshot();
  const replayEnvelope = redeem(releaseAuth, [{ op: 'claim', lock, preimage: first.preimage }], releaseKey);
  const doubleRelease = await batch([{ text: replayEnvelope, receiver: release }, { text: replayEnvelope, receiver: release }]);
  const refundAfterClaim = await payerAction({ op: 'refund', lock });
  assert.deepEqual(await consume(lock), consumed); assert.deepEqual(await snapshot(), afterSplit);

  log('Burning the absent landowner share and proving the stored split cannot be redirected');
  const noLand = await makeLock(null);
  const noLandRequest = randomBytes(32).toString('hex');
  const noLandLock = (await payerAction(noLand.action, noLandRequest)) + ':0';
  assert.equal(await locked(), price);
  const noLandExpected = { amt: '23', address: payer, dta: noLandRequest };
  const noLandMint = await write(compound.permit(noLandExpected), payer);
  const noLandClaim = await claimAfterMint({ lock: noLandLock, expiry: noLand.expiry }, noLandMint, noLandExpected, noLand.preimage, { claim: release, al: [{ tt: 'a', to: release, amt: '65', rl: 'of' }] });
  const noLandConsumed = await consume(noLandLock);
  assert.equal(noLandConsumed?.ins, noLandClaim);
  assert.equal(noLandConsumed.target, treasury, 'claim-time recipient overrides cannot redirect the stored split');
  assert.equal(noLandConsumed.al.find(a => a.tt === 'b').amt, String(35n * unit));
  assert.equal(await balance(payer), 800n * unit); assert.equal(await balance(finder), 60n * unit);
  assert.equal(await balance(landowner), 15n * unit); assert.equal(await balance(treasury), 70n * unit);
  assert.equal(await balance(burn), 0n); assert.equal(await balance(release), 0n);
  assert.equal(await balance(payer) + await balance(finder) + await balance(landowner) + await balance(treasury), 945n * unit, '55 TAP burned across both splits');

  log('Rejecting claims at the expiry height and refunding the entire split with the payer key alone');
  const refundable = await makeLock(landowner, 8);
  const refundLock = (await payerAction(refundable.action)) + ':0';
  const beforeRefund = await snapshot();
  const early = await payerAction({ op: 'refund', lock: refundLock });
  assert.equal(await consume(refundLock), null); assert.equal(await locked(), price);
  // Put a valid claim at H and the payer-only refund at H, in that inscription order.
  await mine(manifest, refundable.expiry - await bitcoin(manifest, 'getblockcount') - 1);
  const boundary = await batch([
    { text: redeem(releaseAuth, [{ op: 'claim', lock: refundLock, preimage: refundable.preimage }], releaseKey), receiver: release },
    { text: redeem(payerAuth, [{ op: 'refund', lock: refundLock }], payerKey), receiver: payer },
  ]);
  assert.equal(await bitcoin(manifest, 'getblockcount'), refundable.expiry);
  const refunded = await consume(refundLock);
  assert.equal(refunded?.action, 'refund'); assert.equal(refunded.ins, boundary.inscriptions[1].id);
  assert.equal(refunded.blck, refundable.expiry); assert.equal(refunded.target, payer); assert.equal(refunded.total, String(price));
  assert.equal(await locked(), 0n); assert.deepEqual(await snapshot(), beforeRefund, 'refund pays no recipients and burns nothing');
  const lateClaim = await releaseAction({ op: 'claim', lock: refundLock, preimage: refundable.preimage });
  const doubleRefund = await payerAction({ op: 'refund', lock: refundLock });
  assert.deepEqual(await consume(refundLock), refunded); assert.deepEqual(await snapshot(), beforeRefund);

  log('Refunding a second expired lock through the payer wallet route without revealing its secret');
  const abandoned = await makeLock(landowner, 4);
  const abandonedLock = (await payerAction(abandoned.action)) + ':0';
  assert.equal(await locked(), price);
  await mine(manifest, abandoned.expiry - await bitcoin(manifest, 'getblockcount'));
  const abandonedRefund = await walletWrite(paymentMessage(payerAuth, { op: 'refund', lock: abandonedLock }, 'abandoned-payment'));
  const abandonedConsumed = await consume(abandonedLock);
  assert.equal(abandonedConsumed?.ins, abandonedRefund.id); assert.equal(abandonedConsumed.action, 'refund');
  assert(abandonedConsumed.blck > abandoned.expiry); assert.equal(await locked(), 0n);
  assert.deepEqual(await snapshot(), beforeRefund);

  log('Checking authority escrow claim behavior at expiry');
  const escrowExpiry = (await bitcoin(manifest, 'getblockcount')) + 3;
  const escrowLock = (await payerAction({ op: 'lock', kind: 'escrow', tick: 'tap', amt: '1', claim: treasury, refund: payer, refund_after: String(escrowExpiry), condition: { type: 'authority', auth: releaseAuth }, data: { dom: 'dmw', ref: 'escrow-comparison', payer, payee: treasury } })) + ':0';
  assert.equal((await tap(`getLock/${escrowLock}`))?.kind, 'escrow');
  const wrongEscrowClaim = await payerAction({ op: 'claim', lock: escrowLock });
  assert.equal(await consume(escrowLock), null);
  const escrowClaim = await releaseAction({ op: 'claim', lock: escrowLock });
  assert.equal((await consume(escrowLock))?.ins, escrowClaim);
  assert.equal((await consume(escrowLock)).blck, escrowExpiry);
  assert.equal(await balance(payer), 799n * unit); assert.equal(await balance(treasury), 71n * unit);
  assert.equal(await locked(), 0n);
  const proof = { addresses: { ...addresses, burn: burn }, deployment, funding, payerAuth, releaseAuth, wallet: { message, ...walletOrder }, split: { lock, record, mint, claim, consumed, overspend, badClaim, earlyRefund, doubleRelease: doubleRelease.inscriptions, refundAfterClaim, balances: afterSplit }, noLandowner: { lock: noLandLock, mint: noLandMint, claim: noLandClaim, consumed: noLandConsumed, balances: beforeRefund }, refund: { lock: refundLock, expiry: refundable.expiry, early, boundary: boundary.inscriptions, consumed: refunded, lateClaim, doubleRefund }, abandoned: { lock: abandonedLock, expiry: abandoned.expiry, refund: abandonedRefund, consumed: abandonedConsumed }, escrow: { lock: escrowLock, expiry: escrowExpiry, wrongClaim: wrongEscrowClaim, claim: escrowClaim, consumed: await consume(escrowLock) }, finalBalances: await snapshot() };
  await save(`${manifest.root}/payments-proof.json`, proof);
  return proof;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await current();
    const compound = await proveCompounds(manifest, console.log);
    await provePayments(manifest, compound, console.log);
    console.log(`Proofs saved in ${manifest.root}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
}
