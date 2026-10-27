// RESET's runtime/peer.js uses the official MAINNET environment with validator
// observation enabled. These public values match its signer/networks/mainnet.json
// and both applications' pinned trac-msb/trac-peer src/config/env.js files.
// A pinned trac-msb MainSettlementBus keeps its identity in its config (trac-peer's
// msbClient exposes the same values as bootstrapHex/networkId).
export function msbIdentity(bus) {
  const bootstrap = bus?.config?.bootstrap;
  return { bootstrapHex: Buffer.isBuffer(bootstrap) ? bootstrap.toString('hex') : null, networkId: bus?.config?.networkId };
}
export const TRAC_MAINNET = Object.freeze({
  networkId: 918,
  msbBootstrap: 'acbc3a4344d3a804101d40e53db1dda82b767646425af73599d4cd6577d69685',
  msbChannel: '0000trac0network0msb0mainnet0000',
  peerChannel: '0000trac0network0peer0mainnet0000',
  dhtBootstrap: Object.freeze(['116.202.214.149:10001', '157.180.12.214:10001',
    'node1.hyperdht.org:49737', 'node2.hyperdht.org:49737', 'node3.hyperdht.org:49737'])
});
