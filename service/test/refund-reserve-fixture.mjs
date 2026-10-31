import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MintSenderView } from '../src/mint-sender-view.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { senderJSON } from '../src/mint-sender-journal.mjs';

export async function reserveView(t, root, network = 'regtest') {
  const directory = join(root, 'reserve-sender'); await mkdir(directory, { mode: 0o700 });
  let now = 1000000, view;
  const initial = mintSenderSettings({ enabled: true, refundsEnabled: true, directory,
    seedFile: join(directory, 'seed'), bitcoinApiUrlFile: join(directory, 'source') });
  const restart = (overrides = {}) => {
    view?.close(); view = new MintSenderView({ seed: new Uint8Array(32).fill(73), network,
      settings: mintSenderSettings({ ...initial, ...overrides }), now: () => now });
    return view;
  };
  restart(); t.after(() => view.close());
  return { get view() { return view; }, get now() { return now; }, restart, advance: ms => { now += ms; },
    publish: (feeRate, changes = {}) => senderJSON(join(directory, 'health.json'),
      { keyId: view.keyId, policy: view.policy, ready: true, at: now, feeRate, feeRateAt: now, ...changes }) };
}
