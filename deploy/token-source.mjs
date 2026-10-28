import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { need, sha256 } from './target.mjs';
import { privatePath } from '../service/prod/config.mjs';
import { HttpSource } from '../service/prod/http.mjs';
import { metadataMultihash } from './public-verification.mjs';
import { verifyRuntime } from './safety.mjs';
import { keccak } from '../committee/signer/escrow.mjs';
import { rules } from '../service/src/rules.mjs';

// Public verified source for the selected token's EIP-1167 implementation.
// Live admission independently checks the proxy points here and matches code.
export const TAP_IMPLEMENTATION = '0x8a2042b4e010b715f8e2a5a8baf0d52ac6edae8b';
export const TAP_SOURCE_URL = 'https://sourcify.dev/server/v2/contract/1/'+TAP_IMPLEMENTATION+'?fields=all';
export function tokenSourceArtifacts(record) {
  need(record.chainId==='1' && record.address?.toLowerCase()===TAP_IMPLEMENTATION && record.runtimeMatch==='exact_match','token_source_identity');
  const c=record.stdJsonOutput?.contracts?.['bridge-final/TapToken.sol']?.TapToken;
  need(typeof c?.metadata==='string' && c.evm?.deployedBytecode?.object && record.stdJsonInput?.language==='Solidity','token_source_compilation');
  const metadata=JSON.parse(c.metadata),input=record.stdJsonInput;
  need(metadata.compiler?.version==='0.8.26+commit.8a97fa7a' && metadata.settings?.metadata?.bytecodeHash==='ipfs','token_source_compiler');
  for(const [path,source] of Object.entries(metadata.sources)) {
    need(typeof input.sources?.[path]?.content==='string' && '0x'+Buffer.from(keccak(Buffer.from(input.sources[path].content))).toString('hex')===source.keccak256,'token_source_hash');
  }
  const code=c.evm.deployedBytecode.object.replace(/^0x/,''),size=parseInt(code.slice(-4),16),trailer=code.slice(-(size+2)*2,-4);
  // The API can decode Unicode in its metadata JSON string. Recover Solidity's
  // ASCII escaping only when those exact bytes match the on-chain commitment.
  const candidates=[c.metadata,c.metadata.replace(/[\u007f-\uffff]/g,ch=>'\\u'+ch.charCodeAt(0).toString(16).padStart(4,'0'))];
  const rawMetadata=candidates.find(raw=>size<=512 && trailer.includes('697066735822'+metadataMultihash(raw)));
  need(rawMetadata,'token_source_metadata');
  verifyRuntime(code,record.runtimeBytecode.onchainBytecode,c.evm.deployedBytecode.immutableReferences);
  return { input, artifact:{abi:c.abi,bytecode:c.evm.bytecode,deployedBytecode:c.evm.deployedBytecode,rawMetadata,metadata} };
}
export async function writeTokenSource(directory, record) {
  await mkdir(directory,{recursive:true,mode:0o700});await privatePath(directory,{directory:true});
  const values=tokenSourceArtifacts(record),hashes={};
  for(const kind of ['artifact','input']) {
    const bytes=rules.stableJSON(values[kind])+'\n';
    await writeFile(join(directory,'token-'+kind+'.json'),bytes,{mode:0o600,flag:'wx'});
    hashes[kind+'SHA256']=await sha256(bytes);
  }
  return hashes;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    need(process.argv.length===4&&process.argv[2]==='--output','arguments');
    const record=await new HttpSource({url:TAP_SOURCE_URL,maxBytes:8000000,retries:0,
      headers:{'user-agent':'DMW-launch-preparation/1.0 (+https://dmtworld.tap-protocol.com)'}}).request();
    const hashes=await writeTokenSource(resolve(process.argv[3]),record);
    console.log(JSON.stringify({implementation:TAP_IMPLEMENTATION,...hashes}));
  } catch {console.error('STOP: public verified token source must match; use a new private output directory. No admission was granted.');process.exitCode=1;}
}
