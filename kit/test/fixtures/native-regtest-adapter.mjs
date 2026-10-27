// Local integration fixture: the real player runtime, the running loopback
// subnet, and its public header messages. No operator wallet or RPC credentials.
import { openPlayerRuntime } from '../../lib/player-runtime.mjs';
import { runtimeTrac } from '../../lib/trac.mjs';
import { parseHeader } from '../../../rules/src/index.js';
import { check } from '../../lib/check.mjs';
import { publicAddress } from '../../lib/keyring.mjs';

export async function create({ wallet, config, network, service }) {
  console.log = console.info = console.debug = () => {};
  const runtime = await openPlayerRuntime({ wallet, config });
  try {
    const trac = runtimeTrac(runtime.peer, { network, localOnly: true, msb: runtime.bus });
    const health = await service.health(), end = Date.now() + 90000;
    while ((await trac.head()).tip.height < health.tip) {
      check(Date.now() < end, 'Local player runtime synchronization timed out');
      await runtime.peer.base.update();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    while (!await runtime.bus.state.getAdminEntry()) {
      check(Date.now() < end, 'Local MSB synchronization timed out');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    check(await runtime.bus.state.getNodeEntry(publicAddress(wallet)) === null, 'This proof requires a fresh unfunded MSB identity');
    console.error('KIT1 proof: synchronized MSB; player account absent; TNK balance 0; no registration sent');
    return { trac, source: {
      async header(hash) {
        const count = (await runtime.peer.base.view.get('msgl'))?.value ?? 0;
        for (let i = count - 1; i >= Math.max(0, count - 256); i--) {
          const row = await runtime.peer.base.view.get(`msg/${i}`);
          let packet; try { packet = JSON.parse(row?.value?.msg); } catch { continue; }
          if (packet.network !== network) continue;
          const headers = packet.op === 'hd' ? packet.value.headers : packet.op === 'bt' ? packet.value.hx : [];
          for (const raw of headers ?? []) if (parseHeader(raw).hash === hash) return raw;
        }
        throw Error('Current header missing from the bounded public Trac message window');
      }
    }, close: runtime.close };
  } catch (error) { await runtime.close(); throw error; }
}
