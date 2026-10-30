import { publicKey } from './keyring.mjs';
import { check } from './check.mjs';
import { productionTrac } from './trac.mjs';
import { headerSource } from './headers.mjs';
import { validatePublicTarget } from '../../deploy/public-target.mjs';
import { openRuntime } from '../../service/prod/runtime.mjs';

// A public target carries only public pins. The agent supplies its own runtime
// config locally, with its own paid writer and credentials, outside that target.
export async function create({ wallet, network, config, runtime, dryRun = true, runtimeFile = process.env.DMW_TRAC_RUNTIME_CONFIG }) {
  validatePublicTarget(config); check(config.mode === 'mainnet' && config.network === network, 'Production target required');
  if (!runtime) { check(runtimeFile, 'Set DMW_TRAC_RUNTIME_CONFIG to your own private Trac runtime config'); runtime = await openRuntime({ configFile: runtimeFile }); }
  try {
    check(runtime.peer.wallet.publicKey.toString('hex') === publicKey(wallet), 'The paid writer must belong to this agent');
    const trac = productionTrac(runtime.peer, { network, msb: runtime.bus, pins: config.trac, dryRun });
    await trac.head();
    return { trac, source: headerSource(config.headerSource, config.headerHTTPSettings), close: () => runtime.close() };
  } catch (error) { await runtime.close(); throw error; }
}
