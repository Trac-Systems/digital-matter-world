import { TerminalHandlers } from 'trac-peer/src/terminal/handlers.js';
import { applyStateMessageFactory } from 'trac-msb/src/messages/state/applyStateMessageFactory.js';
import b4a from 'b4a';
import { requestDigest } from '../signing.js';

export async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  do { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < end);
  throw new Error('Timed out: ' + label);
}
export function controls(peer, bus) {
  const api = peer.protocol.instance.api;
  const settled = async result => {
    if (!result?.txo?.tx) throw new Error('Missing transaction');
    const row = await until(async () => {
      const marker = await peer.base.view.get(`tx/${result.txo.tx}`);
      return marker && peer.base.view.get(`txi/${marker.value}`);
    }, 'MSB settlement');
    if (row.value.err) throw new Error(row.value.err);
    return row.value;
  };
  return {
    status: async () => {
      await peer.base.update();
      return { version: peer.base.view.version, writable: peer.base.writable, head: await api.dmwHead() };
    },
    setup: async ({ writer, writerReady = async () => false, register, admit = async () => {}, boundary = async () => {} }) => {
      const c = new TerminalHandlers(peer);
      await peer.base.update();
      if (!await peer.base.view.get('admin')) { await boundary(); await c.addAdmin(`/add_admin --address ${peer.wallet.publicKey}`); }
      await until(() => peer.base.view.get('admin'), 'subnet admin');
      if ((await peer.base.view.get('admin')).value !== peer.wallet.publicKey.toString('hex')) throw Error('trac_host_admin');
      await until(() => bus.state.getNodeEntry(peer.wallet.address), 'TNK funds');
      if (!await bus.state.getRegisteredBootstrapEntry(peer.base.key.toString('hex'))) {
        const prepare = async () => applyStateMessageFactory(peer.wallet, bus.config).buildPartialBootstrapDeploymentMessage(
          peer.wallet.address, peer.base.key, peer.config.channel, await bus.state.getIndexerSequenceState(), 'json');
        if (register) await register(prepare);
        else {
          const deployment = await prepare(); await admit(deployment); await boundary();
          if (!await bus.network.validatorMessageOrchestrator.send(deployment)) throw new Error('Subnet deployment rejected');
        }
      }
      await until(() => bus.state.getRegisteredBootstrapEntry(peer.base.key.toString('hex')), 'subnet registration');
      for (const [key, value, method, command] of [
        ['chat_status', 'on', 'setChatStatus', '/chat_status --enabled 1'],
        ['txen', true, 'enableTransactions', '/enable_transactions --enabled 1'],
        ['wlst', false, 'enableWhitelist', '/enable_whitelist --enabled 0'],
        ['auto_add_writers', 'off', 'setAutoAddWriters', '/auto_add_writers --enabled 0']
      ]) if ((await peer.base.view.get(key))?.value !== value) {
        await boundary(); await c[method](command);
        await until(async () => (await peer.base.view.get(key))?.value === value, key);
      }
      if (!await writerReady()) { await boundary(); await c.addWriter(`/add_writer --key ${writer}`); }
      return true;
    },
    post: async ({ op, value }) => {
      const message = JSON.stringify({ network: peer.config.dmw.network, op, value });
      const prepared = api.prepareMessage(message, peer.wallet.publicKey), nonce = api.generateNonce();
      const signature = peer.wallet.sign(JSON.stringify(prepared) + nonce);
      await api.post(prepared, signature, nonce);
      await until(() => peer.base.view.get(`sh/${signature}`), 'message application');
      return true;
    },
    tx: async ({ op, value }) => settled(await peer.protocol.instance.tx({ command: JSON.stringify({ network: peer.config.dmw.network, op, value }) })),
    request: ({ op, request }) => {
      if (request.owner !== peer.wallet.publicKey) throw new Error('Only the local operator signs requests');
      return { op, request, sig: peer.wallet.sign(b4a.from(requestDigest(peer.config.dmw.network, op, request))) };
    },
    balance: ({ owner, asset }) => api.dmwBalance(owner, asset),
    mint: ({ id }) => api.dmwMint(id),
    agent: ({ address }) => api.dmwAgentNumber(address),
    read: async ({ key }) => (await peer.base.view.get(key))?.value ?? null,
    rows: async () => {
      const rows = []; for await (const { key, value } of peer.base.view.createReadStream()) rows.push([key, value]); return rows;
    }
  };
}
