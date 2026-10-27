import { mkdtemp, lstat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { init } from '../kit/lib/keyring.mjs';
import { privateDirectory, privateRead, check } from '../kit/lib/check.mjs';

// Each invocation gets a durable, independent signer unless the caller selects
// a named player or signer directory. The console owner's key is never implicit.
export async function preparePlayer(args, { root, env = process.env } = {}) {
  const forwarded=[];let name,directory;
  for(let i=0;i<args.length;i++) {
    const argument=args[i],match=/^--(player|directory)(?:=(.*))?$/.exec(argument);
    if(!match){forwarded.push(argument);continue;}
    const value=match[2]??args[++i];check(value&&!value.startsWith('--'),'Missing '+match[1]);
    if(match[1]==='player'){check(name===undefined,'Duplicate player');name=value;}
    else {check(directory===undefined,'Duplicate directory');directory=value;}
  }
  check(!(name&&directory),'Use either --player or --directory');
  directory??=env.DMW_SIGNER_DIRECTORY;
  check(!(name&&directory),'Use either --player or DMW_SIGNER_DIRECTORY');
  if(name)check(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name),'Player name must be 1–64 letters, numbers, dots, underscores or dashes');
  if(!directory){await privateDirectory(root);directory=name?join(root,name):await mkdtemp(join(root,'run-'));name??=directory.slice(root.length+1);}
  directory=await privateDirectory(resolve(directory));
  let exists=false;try {const file=await lstat(join(directory,'keystore.json'));check(file.isFile()&&!file.isSymbolicLink(),'Signer must be a regular private keyring');exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  let password=env.DMW_SIGNER_PASSWORD;
  if(!password)try{password=(await privateRead(join(directory,'password'),1024)).toString();}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!password){check(!exists,'Supply DMW_SIGNER_PASSWORD for this existing signer');password=randomBytes(32).toString('hex');await writeFile(join(directory,'password'),password,{mode:0o600,flag:'wx'});}
  if(!exists&&!['init','import'].includes(forwarded[0]))await init({directory,password});
  return {args:forwarded,directory,password,name,created:!exists};
}

// Public local test-wallet payment defaults. Payout wallets are independently
// bound through the double-signed binding API when the local adapter starts.
export function testWalletOwner(state) {
  return { receiver: { bitcoin: state.addresses.receiver, ethereum: state.ethPayer }, payer: { tap: state.addresses.payer, ethereum: state.ethPayer } };
}
export async function playerConfig(config, player, { readState }) {
  const path = join(player.directory, 'kit.json');
  let existing;
  try { existing = JSON.parse((await privateRead(path, 65536)).toString()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const owner = existing?.owner ?? config.owner ?? testWalletOwner(await readState());
  const value = { ...config, bitcoinNetwork: 'regtest', owner };
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  return path;
}
