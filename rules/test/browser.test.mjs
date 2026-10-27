import { CLAIM_DEFAULTS } from '../src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
test('entire ESM graph loads with browser globals and no Node APIs', () => {
  const context = vm.createContext({ TextEncoder, TextDecoder });
  const cache = new Map(), root = fileURLToPath(new URL('../', import.meta.url));
  function module(path) {
    if (!cache.has(path)) cache.set(path, new vm.SourceTextModule(readFileSync(path, 'utf8'), { context, identifier: path }));
    return cache.get(path);
  }
  function link(name, parent) {
    assert.equal(name.startsWith('node:'), false);
    if (name.startsWith('@noble/')) {
      const [, packageName, ...tail] = name.split('/');
      const file = tail.join('/'); return module(resolve(root, 'node_modules', '@noble', packageName, 'esm', file.endsWith('.js') ? file : file + '.js'));
    }
    if (name.startsWith('@scure/') || name === 'micro-packed') return module(fileURLToPath(import.meta.resolve(name)));
    assert.ok(name.startsWith('.')); return module(resolve(dirname(parent.identifier), name));
  }
  const entry = module(resolve(root, 'src/index.js'));
  return entry.link(link).then(() => entry.evaluate()).then(async () => {
    const smoke = new vm.SourceTextModule(`
      import {hash, stableJSON, heightToPlot, ordMatchCount, CLAIM_DEFAULTS, merkleRoot, tapBurnAddress} from './src/index.js';
      if(typeof process !== 'undefined' || typeof Buffer !== 'undefined') throw Error('node globals');
      if (tapBurnAddress('mainnet') !== '1BitcoinEaterAddressDontSendf59kuE' || tapBurnAddress('regtest') === tapBurnAddress('mainnet')) throw Error('burn network');
      export const result = [hash('abc'),stableJSON({z:2,a:1}),heightToPlot(8),ordMatchCount('0?', '12'),
        CLAIM_DEFAULTS.claimsPerWindow,merkleRoot(['one','two']).length];
    `, { context, identifier: resolve(root, 'smoke.js') });
    await smoke.link(link); await smoke.evaluate();
    assert.deepEqual(JSON.parse(JSON.stringify(smoke.namespace.result)), [
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', '{"a":1,"z":2}', {x:1,y:-1},3,CLAIM_DEFAULTS.claimsPerWindow,64
    ]);
  });
});
