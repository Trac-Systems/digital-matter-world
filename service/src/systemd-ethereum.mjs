import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { credentialDirectoryOk, credentialFileOk } from './systemd-credential.mjs';

// Only the Ethereum provider credential uses this boundary. Ordinary private
// keys/configs retain their owned-0600 policy; this is never a key loader.
export async function readEthereumCredential(directory = process.env.CREDENTIALS_DIRECTORY) {
  let fd;
  try {
    if (!isAbsolute(directory ?? '') || resolve(directory) !== directory || await realpath(directory) !== directory) throw Error();
    const parent = await lstat(directory);
    if (!credentialDirectoryOk(parent)) throw Error();
    const path = join(directory, 'ethereum.url');
    if (await realpath(path) !== path) throw Error();
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await fd.stat();
    if (!credentialFileOk(stat)) throw Error();
    const bytes = Buffer.alloc(4097), { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    if (bytesRead < 1 || bytesRead > 4096) throw Error();
    return bytes.subarray(0, bytesRead).toString('utf8').trim();
  } catch { throw Error('ethereum_credential_unavailable'); }
  finally { await fd?.close(); }
}
