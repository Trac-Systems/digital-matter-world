import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { bitcoinAddress } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcp } from '../lib/mcp.mjs';
import { init } from '../lib/keyring.mjs';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { fakeTrac, history, testWallet, cleanup, temp } from './helpers.mjs';

test('MCP exposes typed game tools, rejects malformed amounts and cannot enable live mode', async t => {
  const dir = await temp(t), { trac } = fakeTrac(history()), journal = await Journal.open(dir, 'mcp-test'); cleanup(t, () => journal.close());
  const agent = new Agent({ bitcoinNetwork: 'regtest', wallet: testWallet(), network: trac.network, service: new ServiceClient({ network: trac.network }), trac, journal });
  const server = await createMcp({ agent }); cleanup(t, () => server.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'kit-test', version: '1' }); cleanup(t, () => client.close());
  await server.connect(serverTransport); await client.connect(clientTransport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(t => t.name).sort(), ['rules', 'address', 'status', 'balance', 'transaction_status', 'mine_once', 'post_header', 'search_patterns', 'propose_pattern', 'reveal_pattern', 'recover_refused_reveal', 'verify_claim', 'backtest', 'compound_idea', 'craft', 'mint_idea', 'mint_on_chain', 'mint_status', 'link_bitmap', 'transfer',
    'public_status', 'world', 'patterns', 'compounds', 'finds', 'receipts', 'pattern_matches', 'block', 'mint_rights', 'mint_quote', 'events', 'event', 'results', 'agents', 'agent_profile', 'hunting', 'read_page', 'bind_payout_wallet', 'payout_binding', 'bitcoin_wallet', 'pay_mint', 'poll_mint', 'inscribe_mint', 'inscribe_deployment', 'register_deployment'].sort());
  for (const name of ['propose_pattern', 'reveal_pattern', 'verify_claim', 'link_bitmap']) assert.ok(tools.tools.some(t => t.name === name));
  assert.ok(tools.tools.every(t => !/secret|password|unlock|sign_bytes|admin|live_mode/.test(t.name)));
  const result = await client.callTool({ name: 'transfer', arguments: { actionId: 'preview', to: encodeTracAddress('ab'.repeat(32)), assets: [['p0', '1']] } });
  assert.equal(JSON.parse(result.content[0].text).state, 'dry-run'); assert.equal(journal.recent().length, 0);
  const bad = await client.callTool({ name: 'transfer', arguments: { actionId: 'bad', to: encodeTracAddress('ab'.repeat(32)), assets: [['p0', 1.5]] } }); assert.equal(bad.isError, true);
  const missing = await client.callTool({ name: 'search_patterns', arguments: {} }); assert.equal(missing.isError, true);
  const badPlot = await client.callTool({ name: 'link_bitmap', arguments: { actionId: 'bad', height: -1, payer: bitcoinAddress() } }); assert.equal(badPlot.isError, true);
  const noCommit = await client.callTool({ name: 'reveal_pattern', arguments: { actionId: 'missing', salt: '00'.repeat(32) } }); assert.equal(noCommit.isError, true);
  for (const name of ['link_bitmap']) {
    const preview = await client.callTool({ name, arguments: { actionId: 'preview', height: 7, payer: bitcoinAddress() } });
    assert.equal(preview.isError, undefined); assert.equal(JSON.parse(preview.content[0].text).signed, false);
  }
  assert.equal(journal.recent().length, 0);
});
test('CLI stdio MCP unlocks locally, emits only protocol JSON and exits when its client closes', async t => {
  const dir = await temp(t), password = 'disposable mcp password'; const identity = await init({ directory: dir, password });
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ localOnly: true, network: 'dmw-kit-test', gateway: 'http://127.0.0.1:5570', gatewayKey: '09'.repeat(32), adapter: fileURLToPath(new URL('./fixtures/mcp-adapter.mjs', import.meta.url)) }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/dmw.mjs', import.meta.url)), 'mcp', '--directory', dir, '--config', config],
    env: { PATH: process.env.PATH, DMW_SIGNER_PASSWORD: password }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', b => { stderr += b; });
  const client = new Client({ name: 'kit-stdio-test', version: '1' }); cleanup(t, () => client.close());
  await client.connect(transport); const pid = transport.pid; assert.ok(pid > 0);
  await writeFile(join(dir, 'mcp-pid.json'), JSON.stringify({ pid }));
  const answer = await client.callTool({ name: 'address', arguments: {} }); assert.equal(JSON.parse(answer.content[0].text).address, identity.address);
  const status = await client.callTool({ name: 'status', arguments: {} }); assert.equal(JSON.parse(status.content[0].text).dryRun, true);
  await client.close(); assert.equal(stderr.includes(password), false);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
