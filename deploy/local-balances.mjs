import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { need, privateDirectory, privateJSON } from './target.mjs';
const require = createRequire(new URL('../contract/package.json', import.meta.url));

// The playground exposes no TNK balance RPC. Read its persisted MSB view using
// RocksDB's readOnly mode, with no Hypercore startup, locks, peers or writes.
// This is local evidence only; production needs an authenticated MSB reader.
export async function localBalances(spec) {
  await privateDirectory(spec.storeDirectory);
  const run = dirname(dirname(dirname(spec.storeDirectory)));
  need(spec.storeDirectory === join(run, 'trac/bus-client/development'), 'Local MSB store must be the existing playground store');
  const config = await privateJSON(join(run, 'gateway.json'));
  need(config.mode === 'regtest', 'Local MSB store requires a regtest deployment');
  const Storage = require('hypercore-storage'), { Node, Header } = require('hyperbee/lib/messages.js');
  const store = new Storage(spec.storeDirectory, { readOnly: true });
  try {
    await store.ready();
    for await (const { discoveryKey } of store.createCoreStream()) {
      const info = await store.getInfo(discoveryKey);
      if (info.auth.key.toString('hex') !== spec.viewKey) continue;
      need(info.head?.length > 1 && info.head.length <= 100000, 'MSB view is absent or exceeds the local read limit');
      const core = await store.resume(discoveryKey);
      try {
        const get = async n => { const rx = core.read(), promise = rx.getBlock(n); rx.tryFlush(); return promise; };
        need(Header.decode(await get(0)).protocol === 'hyperbee', 'Pinned MSB view is not a Hyperbee');
        const balances = {}, wanted = new Set([spec.hostAddress, spec.writerAddress]);
        // Hyperbee records each update under its key. The newest record wins,
        // including deletion; never fall back to an older balance for that key.
        for (let i = info.head.length - 1; i > 0 && wanted.size; i--) {
          const bytes = await get(i); need(bytes, 'MSB view has missing blocks');
          const node = Node.decode(bytes), address = node.key?.toString('ascii');
          if (!wanted.delete(address)) continue;
          need(node.value?.length === 69, 'MSB funding account is missing or deleted');
          balances[address] = BigInt('0x' + node.value.subarray(33, 49).toString('hex'));
        }
        need(wanted.size === 0, 'MSB funding account not found in the pinned view');
        return balances;
      } finally { await core.close(); }
    }
    throw Error('Pinned MSB view not found');
  } finally { await store.close(); }
}
