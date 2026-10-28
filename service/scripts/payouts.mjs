import { supportedNode } from '../../node-version.mjs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Payouts } from '../src/payouts.mjs';
import { check } from '../src/util.mjs';
check(supportedNode(), 'node_version');
const [filename, command, beneficiary, amount, txid, reference] = process.argv.slice(2);
check(command === 'record' || command === 'publish', 'payout_command');
const config = await loadConfig(filename), store = await Store.open(config.data);
try {
  const ledger = new Payouts({ store, files: new Files(join(config.data, 'static')) });
  if (command === 'record') await ledger.record({ beneficiary, amount, txid, reference });
  else await ledger.publish();
  console.log('Payout ledger updated.');
} finally { await store.close(); }
