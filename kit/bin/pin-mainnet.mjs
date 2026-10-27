#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAINNET_FILE, readNetworkJSON, validateMainnet } from '../lib/network.mjs';
import { validatePublicTarget } from '../../deploy/public-target.mjs';
import { TRAC_MAINNET } from '../../service/prod/mainnet.mjs';
import { check, nonce } from '../lib/check.mjs';

// Operator-only, offline projection of two PUBLIC launch outputs. No private
// worksheet, wallet, remote endpoint or first-contact trust is accepted here.
export function launchPins(target, deployment) {
  validatePublicTarget(target);
  check(target.mode === 'mainnet', 'Mainnet public launch target required');
  const pins = { ...target, receiptSigners: target.receiptSigners.map(({ id, identity }) => ({ id, identity })),
    runtime: { msbChannel: TRAC_MAINNET.msbChannel, peerChannel: TRAC_MAINNET.peerChannel,
      dhtBootstrap: [...TRAC_MAINNET.dhtBootstrap], deployment } };
  return validateMainnet(pins);
}
async function main() {
  const { values } = parseArgs({ options: { public: { type: 'string' }, deployment: { type: 'string' }, output: { type: 'string' } } });
  check(values.public && values.deployment, 'Use --public /absolute/kit-public.json --deployment /absolute/deployment.json');
  const pins = launchPins(await readNetworkJSON(values.public), await readNetworkJSON(values.deployment));
  const output = resolve(values.output ?? MAINNET_FILE), stage = `${output}.${nonce()}.stage`;
  try { await writeFile(stage, JSON.stringify(pins, null, 2) + '\n', { flag: 'wx', mode: 0o644 }); await rename(stage, output); }
  catch (error) { await unlink(stage).catch(() => {}); throw error; }
  process.stdout.write(JSON.stringify({ written: output, network: pins.network, note: 'Review and commit this public file in the player release before distributing it.' }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
