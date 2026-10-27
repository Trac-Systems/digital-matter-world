import { open, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve, basename, join } from 'node:path';
import { credentialDirectoryOk, credentialFileOk } from './systemd-credential.mjs';

// No endpoint value or filesystem exception escapes this boundary. The local
// default is ignored private state; a server supplies a root-owned 0600 file.
export async function readTapSourceURL(filename = resolve('.local/secrets/tap-source.url'), { rootOwned = false, credentialName = basename(filename), credentialsDirectory = process.env.CREDENTIALS_DIRECTORY } = {}) {
  let fd;
  try {
    if (!isAbsolute(filename) || resolve(filename) !== filename) throw Error();
    let credential = false;
    if (credentialsDirectory !== undefined) {
      if (!isAbsolute(credentialsDirectory) || await realpath(credentialsDirectory) !== credentialsDirectory || !/^[a-zA-Z0-9_.-]+$/.test(credentialName) || ['.', '..'].includes(credentialName)) throw Error();
      const directory = await lstat(credentialsDirectory);
      if (!credentialDirectoryOk(directory)) throw Error();
      filename = join(credentialsDirectory, credentialName); credential = true;
    }
    if (!isAbsolute(filename) || await realpath(filename) !== filename) throw Error();
    fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await fd.stat();
    if (credential ? !credentialFileOk(stat) : !stat.isFile() || (stat.mode & 0o777) !== 0o600 || !(rootOwned ? stat.uid === 0 : [0, process.getuid()].includes(stat.uid)) || stat.size < 1 || stat.size > 4096) throw Error();
    const bytes = Buffer.alloc(4097), { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw Error();
    const value = bytes.subarray(0, bytesRead).toString('utf8').trim(), url = new URL(value);
    if (!/^https?:\/\//.test(value) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname !== '/' || /[\s\\]/.test(value)) throw Error();
    return url.origin;
  } catch { throw Error('tap_source_file_required'); }
  finally { await fd?.close(); }
}
