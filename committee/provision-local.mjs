import { randomBytes } from 'node:crypto';
import { mkdir, lstat, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { provisionOperator } from './provision.mjs';
import { committeeAddress } from './signer/escrow.mjs';
import { privateJSON, secret, worksheetTarget, need } from '../deploy/target.mjs';
import { privatePath } from '../service/prod/config.mjs';
import { atomicWrite, edPublic } from '../service/src/util.mjs';
const require = createRequire(new URL('../contract/package.json', import.meta.url));
const { secp256k1 } = createRequire(new URL('./package.json', import.meta.url))('@noble/curves/secp256k1');
const exists = async file => { try { await lstat(file); return true; } catch (e) { if (e.code !== 'ENOENT') throw e; return false; } };
const directory = async path => { await mkdir(path, { recursive:true,mode:0o700 }); await privatePath(path,{directory:true}); };

async function nativeWallet(filename, { generate = false } = {}) {
  const { default:Wallet } = await import(pathToFileURL(require.resolve('trac-wallet')).href);
  const wallet = new Wallet(); await wallet.ready;
  if (await exists(filename)) { await privatePath(filename); wallet.importFromFile(filename,Buffer.alloc(0)); }
  else {
    need(generate,'funded_wallet_required'); await directory(dirname(filename));
    // Only unfunded observer identities are generated here. Host and writer
    // role wallets must already be installed by their owner.
    await wallet.generateKeyPair(); wallet.exportToFile(filename,Buffer.alloc(0)); await chmod(filename,0o600);
  }
  return wallet;
}
async function token(filename, value) {
  if (!await exists(filename)) await atomicWrite(filename,(value ?? randomBytes(32).toString('hex'))+'\n');
  await privatePath(filename);
  if (value) need(await secret(filename)===value,'local_token_changed');
}
const pin = (object, key, value) => { need(!object[key] || object[key]===value,'public_role_pin_changed'); object[key]=value; };

// Owner-console provisioning only. Does not contact any chain, start services,
// fund accounts, print secrets or collect operator share credentials centrally.
export async function provisionLocal(filename, id) {
  const w=await privateJSON(filename),t=worksheetTarget(w.target);
  need(w.operations?.layout==='single-host','single_host_required');
  if (id==='gateway') {
    need(!await exists(join(t.paths.output,'launch-journal')),'launch_already_started');
    await directory(dirname(t.gateway.keyFile));
    await token(t.gateway.keyFile);
    const roles=await privateJSON(w.files.roleAddressesFile);
    need(roles.bitcoin && roles.ethereum,'public_receiving_addresses_required');
    pin(roles,'gatewayKey',edPublic(Buffer.from(await secret(t.gateway.keyFile),'hex')));
    for(const role of ['admin','relayer','payer']) {
      const key=Buffer.from(await secret(t.ethereum[role+'KeyFile']),'hex');
      try { need(key.length===32,'sender_key'); pin(roles.ethereum,role+'Address',committeeAddress(Buffer.from(secp256k1.getPublicKey(key)).toString('hex'))); }
      finally { key.fill(0); }
    }
    roles.trac ??= {};
    for(const role of ['host','writer']) {
      const wallet=await nativeWallet(t.trac[role+'KeyFile']);
      pin(roles.trac,role+'PublicKey',wallet.publicKey.toString('hex'));
      if(role==='host') {
        const seed=Buffer.from(wallet.secretKey).subarray(0,32);
        try { need(edPublic(seed)===roles.trac.hostPublicKey,'admin_host_key'); await token(t.trac.adminKeyFile,seed.toString('hex')); }
        finally { seed.fill(0); }
      }
    }
    await nativeWallet(w.files.tracRuntime.msbWallet,{generate:true});
    await atomicWrite(w.files.roleAddressesFile,JSON.stringify(roles,null,2));
  } else {
    const i=t.committee.members.findIndex(m=>m.id===id);need(i>=0,'operator_id');
    const m=t.committee.members[i],dir=dirname(m.sidecarCredentialsFile),h=w.operations.hosts.operators[i];
    await directory(dir);await directory(join(dir,'endpoints'));
    if(!await exists(m.sidecarCredentialsFile)) await provisionOperator({directory:dir,id,url:h.sidecarURL,network:t.network});
    const own=await privateJSON(m.sidecarCredentialsFile),descriptor=await privateJSON(join(dir,'operator-public.json'));
    need(descriptor.network===t.network&&descriptor.id===id&&descriptor.url===h.sidecarURL&&descriptor.identity===edPublic(Buffer.from(own.identity,'hex')),'operator_identity_changed');
    await token(join(dir,'endpoints/sidecar.token'),own.token);
    await token(join(dir,'endpoints/signer.token'));
    for(const file of [w.files.operatorTrac[i].msbWallet,w.files.operatorTrac[i].peerWallet])await nativeWallet(file,{generate:true});
  }
  return {id};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    need(process.argv.length===6&&process.argv[2]==='--inputs'&&process.argv[4]==='--id','arguments');
    process.umask(0o077); await provisionLocal(process.argv[3],process.argv[5]);
    console.log('Local identity files prepared. No network requests, funded keys generated or services started.');
  } catch {console.error('STOP: install the owned role files and worksheet first; preserve any existing identity files.');process.exitCode=1;}
}
