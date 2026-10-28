import { encodeTracAddress, wireIdentities } from '../../rules/src/trac-address.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../../service/src/store.mjs';
import { serve } from '../../service/src/http.mjs';
import { bindingFixture } from '../../service/test/bindings-fixture.mjs';
import { agent as identity, temp } from '../../service/test/helpers.mjs';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { runTool } from '../lib/tools.mjs';
import { signTestPayout } from '../../service/test/payout-wallets.mjs';
import { signTapWalletMessage } from '../../rules/test/tap-wallet-signing.mjs';
import { verifyBinding } from '../../rules/src/payout-bindings.mjs';

for (const format of ['ethereum', 'bip322', 'legacy']) test(`payout tools preserve a signed retry and keep dry-run unsigned without a link (${format})`, async () => {
  const rail = format === 'ethereum' ? 'ethereum' : 'tap';
  const directory = await temp('kit-binding-'), store = await Store.open(join(directory, 'service')), f = bindingFixture(store), who = identity(71);
  const http = await serve({ intake: { store }, files: { serve: async () => false }, bindings: f.bindings });
  const service = new ServiceClient({ origin: http.url, network: 'dmw-regtest', receiptSigners: f.members });
  const journal = await Journal.open(join(directory, 'kit'), 'binding');
  const wallet = f.wallet(who); let signatures = 0; const sign = wallet.sign; wallet.sign = bytes => { signatures++; return sign(bytes); };
  const agent = new Agent({ wallet, service, journal, trac: { network: service.network }, network: service.network, bitcoinNetwork: 'regtest' });
  try {
    const address = f.packet(who, rail, who.secret.toString('hex')).request.address, args = { actionId: 'human-wallet', rail, address };
    const dry = await runTool({ agent }, 'bind_payout_wallet', args);
    assert.equal(dry.signed, false); assert.equal(dry.bindingLink, undefined); assert.equal(signatures, 0);
    await assert.rejects(runTool({ agent }, 'bind_payout_wallet', args, { readOnly: true }), /Use action/);
    agent.dryRun = false;
    const first = await runTool({ agent }, 'bind_payout_wallet', args), retry = await runTool({ agent }, 'bind_payout_wallet', args);
    assert.equal(first.bindingLink, retry.bindingLink); assert.equal(signatures, 1); assert.equal(retry.replayed, true);
    await assert.rejects(agent.bindPayoutWallet({ ...args, address: f.packet(who, rail, identity(72).secret.toString('hex')).request.address }), /Conflicting payout/);
    const walletSignature = format === 'legacy' ? signTapWalletMessage(first.request.message, who.secret) : signTestPayout(first.request.message, who.secret.toString('hex'), rail);
    await service.request('/payout-bindings/complete', { value: { id: first.request.id, walletSignature } });
    await agent.reconcileAction('payout/' + args.actionId); assert.equal(journal.get('payout/' + args.actionId).state, 'accepted');
    assert.equal((await runTool({ agent }, 'payout_binding', { rail })).binding.request.address, address);
    const history = await runTool({ agent }, 'payout_binding', { rail, history: true, limit: 1 });
    assert.equal(history.total, 1);
    assert.equal(verifyBinding(wireIdentities(history.bindings[0]), { network: service.network, bitcoinNetwork: 'regtest', members: f.members }).walletSignature, walletSignature);
    const replacement = await agent.bindPayoutWallet({ ...args, actionId: 'replacement' });
    assert.ok(BigInt(replacement.request.request.nonce) > BigInt(first.request.request.nonce));
    assert.equal(history.bindings[0].request.agent, encodeTracAddress(who.address));
    const foreign = await f.bind(identity(72), rail);
    service.payoutBinding = async () => ({ binding: foreign });
    await assert.rejects(agent.bindPayoutWallet({ ...args, actionId: 'foreign-proof' }), /Payout binding mismatch/);
  } finally { journal.close(); await http.close(); await store.close(); }
});
