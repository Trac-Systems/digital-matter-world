// Explicit read-only provider bootstrap. No Trac writer, signer, wallets or
// transaction-send interfaces are opened by this command.
import { resolve, join } from 'node:path';
import { readPrivateJSON, privatePath } from '../prod/config.mjs';
import { createBitcoin } from '../prod/bitcoin.mjs';
import { createTap } from '../prod/tap.mjs';
import { createEthereum } from '../prod/ethereum.mjs';
import { TapLookupIndex } from '../prod/tap-index.mjs';
import { check } from '../src/util.mjs';

const [filename, ...flags] = process.argv.slice(2);
check(filename && flags.every(f => f === '--once'), 'usage_index_source_lookups_config_optional_once');
const config = await readPrivateJSON(resolve(filename)), p = config.prod;
check(config.mode === 'prod' && p, 'source_index_prod_config');
await privatePath(p.readerData, { directory: true });
const bitcoin = await createBitcoin(p.bitcoin, p.http), indexer = await createTap(p.tap, bitcoin, p.http, p.lookupSettings);
const lookups = new TapLookupIndex({ filename: join(p.readerData, 'tap-lookups.sqlite'), indexer, settings: p.lookupSettings });
let ethereum;
try {
  ethereum = await createEthereum(p.ethereum, p.http, { filename: join(p.readerData, 'ethereum-events.sqlite') });
  let complete;
  do {
    await lookups.tick();
    const tap = await lookups.complete(lookups.watch('privilege')) && await lookups.complete(lookups.watch('element'));
    const latest = await ethereum.rpc('eth_getBlockByNumber', ['latest', false]), eth = await ethereum.events.advance(latest.number);
    complete = tap && eth;
    console.log(JSON.stringify({ complete, tap, ethereum: eth, authorityOffset: lookups.stream(lookups.watch('privilege')).offset, elementOffset: lookups.stream(lookups.watch('element')).offset }));
  } while (!complete && !flags.includes('--once'));
} finally { lookups.close(); ethereum?.close(); }
