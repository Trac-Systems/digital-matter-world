import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rules } from '../service/src/rules.mjs';
import { atomicWrite, check, hash } from '../service/src/util.mjs';

// Input is the public committee-signed privilege-auth content produced by launch.
// No element catalog, spending key, connection URL or broadcast is needed.
export async function launchInscriptionTexts({ authority, receiver }) {
  check(authority?.p === 'tap' && authority.op === 'privilege-auth' && authority.auth?.name === 'dmw' &&
    /^[0-9a-f]{64}$/.test(authority.salt) && authority.hash === hash(JSON.stringify(authority.auth) + authority.salt) &&
    ['r', 's'].every(k => typeof authority.sig?.[k] === 'string' && /^[1-9][0-9]*$/.test(authority.sig[k])) &&
    ['0', '1'].includes(authority.sig?.v), 'launch_authority_content');
  check(typeof receiver === 'string' && receiver.length >= 14 && receiver.length <= 90 && !/PLACEHOLDER|TO-BE-FILLED/.test(receiver), 'launch_receiver');
  return [{ label: 'privilege-authority', receiver, content: authority, inscriptionText: rules.stableJSON(authority),
    activation: 'Inscribe into your own Tap Wallet address, then send that inscription to the same address.' }];
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    check(process.argv.length === 6 && process.argv[2] === '--input' && process.argv[4] === '--out', 'arguments');
    const rows = await launchInscriptionTexts(JSON.parse(await readFile(process.argv[3], 'utf8')));
    await atomicWrite(resolve(process.argv[5]), JSON.stringify(rows, null, 2) + '\n');
    console.log('Wrote the privilege-auth text and self-send instructions. Nothing was signed or sent.');
  } catch { console.error('Provide the public committee-signed authority content, owner address and output file. Nothing was sent.'); process.exitCode = 1; }
}
