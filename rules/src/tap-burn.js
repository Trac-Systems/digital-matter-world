import { Address, NETWORK, TEST_NETWORK } from '@scure/btc-signer';

// One destination: change only the Base58Check P2PKH network version, never
// the eater's hash160 or scriptPubKey. Testnet, signet and regtest share it.
export const TAP_BURN = '1BitcoinEaterAddressDontSendf59kuE';
export function tapBurnAddress(network = 'mainnet') {
  if (!['mainnet', 'regtest', 'testnet', 'signet'].includes(network)) throw Error('tap_burn_network');
  return Address(network === 'mainnet' ? NETWORK : TEST_NETWORK).encode(Address(NETWORK).decode(TAP_BURN));
}
