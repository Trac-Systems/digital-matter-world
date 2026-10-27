const { createRequire, registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const load = createRequire(join(__dirname, '../contract/package.json'));
const filename = load.resolve('hyperswarm');
const Hyperswarm = load(filename);
const DHT = load('hyperdht');

// The pinned peer runtimes accept bootstrap addresses but do not expose the
// DHT bind host. Install a process-local transport constructor before loading
// those runtimes; their source and installed modules remain unchanged.
class LoopbackSwarm extends Hyperswarm {
  constructor(options = {}) {
    if (!Array.isArray(options.bootstrap) || !options.bootstrap.length ||
      !options.bootstrap.every(node => typeof node === 'string' ? /^127\.0\.0\.1:\d+$/.test(node) : node.host === '127.0.0.1')) {
      throw new Error('Playground swarms require explicit loopback bootstrap nodes');
    }
    super({ ...options, dht: new DHT({ bootstrap: options.bootstrap, host: '127.0.0.1' }) });
  }
}
module.exports = LoopbackSwarm;
registerHooks({resolve(specifier, context, next) {
  return specifier === 'hyperswarm' ? {url:pathToFileURL(__filename).href,shortCircuit:true} : next(specifier,context);
}});
