import { readFile } from 'node:fs/promises';
import { rules } from '../../src/rules.mjs';
import { bulkOrderId, bulkMembersRoot, bulkFeeRoot, bulkPermitPlans } from '../../../rules/src/bulk-mint.js';
import { requestKey, btc } from '../../src/mint-sender-keys.mjs';
import { quoteBulkFunding } from '../../src/bulk-mint-funding.mjs';
import { mintSenderSettings } from '../../src/mint-sender-settings.mjs';
import { hex, unhex, networkFor } from '../../../kit/lib/inscription-core.mjs';
const fixture = JSON.parse(await readFile(new URL('../../../rules/test/fixtures/bulk-v1.json', import.meta.url)));

export async function bulkFixture(count = 16, { feeRate = 1, network = 'regtest', seed = new Uint8Array(32).fill(7) } = {}) {
  const terms = structuredClone(fixture.terms), settings = mintSenderSettings();
  terms.bitcoinNetwork = network;
  const orderId = bulkOrderId(terms.network, terms.owner, terms.nonce), key = requestKey(seed, orderId, network);
  const receiver = requestKey(seed, 'ab'.repeat(32), network), payer = requestKey(seed, 'cd'.repeat(32), network);
  terms.receiver = receiver.address; terms.payer = payer.address; receiver.privateKey.fill(0); payer.privateKey.fill(0);
  terms.members = Array.from({ length: count }, (_, i) => ({ block: String(900000 + i), amount: '3' }));
  terms.membersRoot = bulkMembersRoot(terms.members); terms.totalAmount = String(count * 3);
  terms.groups = [{ ...terms.groups[0], to: terms.receiver, amount: String(count * 100) }];
  terms.grossFeeAtoms = terms.payableFeeAtoms = String(count * 100);
  const feeManifest = terms.members.map((_, member) => ({ ...structuredClone(fixture.feeManifest[0]), member }));
  terms.feeRoot = bulkFeeRoot(feeManifest);
  terms.feeQuote.scope = rules.stableJSON(['mint-bulk-v1', terms.asset, terms.deployment, terms.membersRoot]);
  const quote = await quoteBulkFunding({ orderId, network: terms.network, bitcoinNetwork: network, members: terms.members,
    deployment: { kind: 'dmt', id: terms.deployment, tick: terms.ticker }, receiver: terms.receiver, payer: terms.payer, settings, feeRate, address: key.address });
  if (!quote.fits) { key.privateKey.fill(0); return { quote, terms, orderId, settings }; }
  terms.mintFunding = quote.mintFunding;
  const permits = bulkPermitPlans(terms, fixture.receiptRoot), termsHash = rules.hashObject(terms);
  const manifest = { v: 1, orderId, termsHash, membersRoot: terms.membersRoot, paymentHash: permits.paymentHash, permitRoot: permits.permitRoot,
    count, readyCount: count, complete: true, offset: 0, next: null, members: permits.plans.map((p, index) => ({ index, memberId: p.memberId, ...terms.members[index], permitHash: p.digest,
      mintContent: { ...p.payload, prv: { address: p.address, salt: p.salt, hash: p.digest, sig: { r: '1', s: '2', v: '1' } } } })) };
  const funding = { paymentId: 'ef'.repeat(32) + 'i0', txid: 'de'.repeat(32), vout: 1, value: String(terms.mintFunding.satoshis),
    cardinal: true, confirmed: true, script: hex(btc.p2tr(unhex(key.publicKey).slice(1), undefined, networkFor(network)).script) };
  return { terms, feeManifest, manifest, orderId, key, funding, quote, seed, settings };
}
