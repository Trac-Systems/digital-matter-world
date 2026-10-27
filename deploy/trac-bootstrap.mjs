import { controls, until } from '../contract/runtime/control.js';
import { MAINNET_PARAMS, REGTEST_PARAMS } from '../contract/beacon/bitcoin.js';
import { rules } from '../service/src/rules.mjs';
import { check } from '../service/src/util.mjs';
import { encodeTracAddress } from '../rules/src/trac-address.js';

// The peer factory owns file-backed wallets and discovery. No faucet, key
// generation or process lifecycle is part of the shared deployment phase.
export async function tracBootstrap({ indexer, writer, bus, deployment, mode, roles, register, boundary = async () => {}, admit = async () => {} }) {
  const key = p => p.wallet.publicKey.toString('hex');
  check(rules.stableJSON(deployment.beacon.params) === rules.stableJSON(mode === 'mainnet' ? MAINNET_PARAMS : REGTEST_PARAMS), 'trac_bootstrap_params');
  check(deployment.beacon.checkpoint.height % 2016 === 0, 'trac_bootstrap_checkpoint');
  if (roles) {
    check(key(indexer) === roles.host && key(writer) === roles.writer && deployment.admin === roles.admin, 'trac_bootstrap_roles');
    check(roles.writer !== roles.host && roles.writer !== roles.admin, 'trac_separate_writer');
  }
  check(indexer.base.key.toString('hex') === writer.base.key.toString('hex'), 'trac_subnet_binding');
  const balances = async () => Object.fromEntries(await Promise.all([indexer, writer].map(async p => {
    const row = await until(() => bus.state.getNodeEntry(p.wallet.address), 'Trac role funding');
    check(row.balance?.length === 16, 'trac_balance');
    return [encodeTracAddress(key(p)), BigInt('0x' + Buffer.from(row.balance).toString('hex')).toString()];
  })));
  const before = await balances(), admin = controls(indexer, bus);
  await admin.setup({ writer: writer.writerLocalKey, writerReady: async () => { await writer.base.update(); return writer.base.writable; }, boundary, admit, register });
  await until(async () => { await writer.base.update(); return writer.base.writable; }, 'paid writer admission');
  const authority = await writer.protocol.instance.api.dmwAuthority();
  check(authority.network === deployment.network && authority.committee === deployment.committee && (!deployment.admin || authority.admin === deployment.admin), 'trac_bootstrap_authority');
  const after = await balances();
  return { admin, registration: { before, after, atomicSpent: Object.keys(before).reduce((n, k) => n + BigInt(before[k]) - BigInt(after[k]), 0n).toString(),
    writer: writer.writerLocalKey, writerAddress: encodeTracAddress(key(writer)), hostAddress: encodeTracAddress(key(indexer)), writable: writer.base.writable, subnet: indexer.base.key.toString('hex') } };
}
