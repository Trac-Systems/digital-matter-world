import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { WalletProvider } from 'trac-wallet';
import { check, exact, hex32, privateDirectory, privateRead } from './check.mjs';

const derive = promisify(scrypt), provider = new WalletProvider({ addressPrefix: 'trac' });
export const defaultDirectory = () => join(homedir(), '.dmw-signer');
export const publicKey = wallet => typeof wallet.publicKey === 'string' ? wallet.publicKey : Buffer.from(wallet.publicKey).toString('hex');
export const publicAddress = wallet => encodeTracAddress(publicKey(wallet));
export const createWallet = mnemonic => mnemonic === undefined ? provider.generate() : provider.fromMnemonic({ mnemonic });
export const wipeWallet = wallet => wallet.secretKey?.fill(0);
function passwordCheck(password) { check(typeof password === 'string' && password.length >= 12, 'Password must have at least 12 characters'); }
async function keyFor(password, salt) {
  passwordCheck(password);
  return derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
export async function init({ directory = defaultDirectory(), password, mnemonic } = {}) {
  passwordCheck(password);
  const dir = await privateDirectory(directory), wallet = await createWallet(mnemonic);
  let key, plaintext;
  try {
    const salt = randomBytes(16), iv = randomBytes(12);
    const header = { v: 1, address: publicKey(wallet), kdf: 'scrypt-32768-8-1', cipher: 'aes-256-gcm', salt: salt.toString('hex'), iv: iv.toString('hex') };
    key = await keyFor(password, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(header)));
    plaintext = Buffer.from(JSON.stringify({ mnemonic: wallet.mnemonic, derivationPath: wallet.derivationPath }));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const fd = await open(join(dir, 'keystore.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(JSON.stringify({ ...header, ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex') }) + '\n'); await fd.sync(); }
    finally { await fd.close(); }
    return { address: encodeTracAddress(header.address) };
  } finally { key?.fill(0); plaintext?.fill(0); wipeWallet(wallet); }
}
export async function unlock({ directory = defaultDirectory(), password } = {}) {
  const dir = await privateDirectory(directory, false), data = JSON.parse(await privateRead(join(dir, 'keystore.json')));
  exact(data, ['v', 'address', 'kdf', 'cipher', 'salt', 'iv', 'ciphertext', 'tag']);
  check(hex32(data.address) && data.v === 1 && data.kdf === 'scrypt-32768-8-1' && data.cipher === 'aes-256-gcm', 'Unsupported keyring');
  for (const [k, size] of [['salt', 32], ['iv', 24], ['tag', 32]]) check(typeof data[k] === 'string' && new RegExp(`^[0-9a-f]{${size}}$`).test(data[k]), 'Invalid keyring');
  check(typeof data.ciphertext === 'string' && /^(?:[0-9a-f]{2}){1,4096}$/.test(data.ciphertext), 'Invalid keyring');
  const { ciphertext, tag, ...header } = data, key = await keyFor(password, Buffer.from(data.salt, 'hex'));
  let plaintext, wallet;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'hex'));
    decipher.setAAD(Buffer.from(JSON.stringify(header))); decipher.setAuthTag(Buffer.from(tag, 'hex'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]);
    wallet = await provider.fromMnemonic(JSON.parse(plaintext.toString()));
    check(publicKey(wallet) === data.address, 'Keyring mismatch'); return wallet;
  } catch { if (wallet) wipeWallet(wallet); throw new Error('Wrong password or damaged keyring'); }
  finally { key.fill(0); plaintext?.fill(0); }
}
