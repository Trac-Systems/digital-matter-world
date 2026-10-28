import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Frozen Trac packages do not expose Hyperswarm's UDP bind address. Restrict
// the native socket boundary only inside disposable local-network processes.
export function confineLocalUDP() {
  const Socket = require('udx-native/lib/socket.js');
  const installed = Symbol.for('dmw.local.udp.loopback');
  if (Socket.prototype[installed]) return;
  const bind = Socket.prototype.bind;
  Socket.prototype.bind = function (port) { return bind.call(this, port, '127.0.0.1'); };
  for (const name of ['send', 'trySend']) {
    const original = Socket.prototype[name];
    Socket.prototype[name] = function (buffer, port, host = '127.0.0.1', ...rest) {
      if (host !== '127.0.0.1') throw Error('local_trac_non_loopback');
      return original.call(this, buffer, port, host, ...rest);
    };
  }
  Socket.prototype[installed] = true;
}
