import { privateJSON, privateBytes, need } from './target.mjs';
import { productionURL } from '../service/prod/config.mjs';
import { HttpSource } from '../service/prod/http.mjs';
import { hash } from '../service/src/util.mjs';
import { verifyRuntime } from './safety.mjs';
import { rules } from '../service/src/rules.mjs';
import { calldata } from '../committee/signer/escrow.mjs';

// Solidity commits to an IPFS UnixFS file, not SHA256(raw JSON).
// Encoding reference: solidity v0.8.26 libsolutil/IpfsHash.cpp.
// Bound metadata to one 256 KiB UnixFS leaf; larger inputs fail closed.
export function metadataMultihash(metadata) {
  const bytes=Buffer.from(metadata);need(bytes.length>0&&bytes.length<=262144,'verification_metadata_size');
  const varint=value=>{const out=[];do{const byte=value&127;value=Math.floor(value/128);out.push(byte|(value?128:0));}while(value);return Buffer.from(out);};
  const length=varint(bytes.length),file=Buffer.concat([Buffer.from([8,2,18]),length,bytes,Buffer.from([24]),length]);
  return '1220'+hash(Buffer.concat([Buffer.from([10]),varint(file.length),file]));
}

// A publication is a retrievable compiler artifact and standard compiler input,
// pinned independently in a private receipt. A supplied "verified" flag has no
// authority. Every source and compiler setting must match the published input.
export async function publicVerification(target, reads, { sourceArtifactHash, fetchBytes = async url => new HttpSource({url:productionURL(url),maxBytes:8_000_000,retries:0}).request('',{format:'bytes'}) } = {}) {
  const view=await reads.ethereum('eth_getBlockByNumber',['latest',false]);
  need(/^0x[0-9a-f]+$/.test(view?.number)&&/^0x[0-9a-f]{64}$/.test(view?.hash),'verification_chain_view');
  const results=[];
  for(const role of ['source','token']) {
    const receipt=await privateJSON(target.ethereum[role+'VerificationFile']);
    const address=role==='source'?target.ethereum.escrowAddress:target.ethereum.tokenAddress;
    need(receipt.chainId===target.ethereum.chainId && receipt.address===address,'verification_address');
    // Same-host service transport must not turn private files into a claim of
    // public source publication. These artifacts still require public HTTPS.
    for (const url of [receipt.artifactURL, receipt.inputURL]) need(new URL(productionURL(url)).protocol === 'https:', 'verification_public_https');
    const artifactBytes=await privateBytes(receipt.artifactFile), inputBytes=await privateBytes(receipt.inputFile);
    need(hash(artifactBytes)===receipt.artifactSHA256 && hash(inputBytes)===receipt.inputSHA256,'verification_artifact_pin');
    const remoteArtifact=await fetchBytes(receipt.artifactURL),remoteInput=await fetchBytes(receipt.inputURL);
    need(hash(remoteArtifact)===receipt.artifactSHA256 && hash(remoteInput)===receipt.inputSHA256,'verification_publication');
    const artifact=JSON.parse(artifactBytes),input=JSON.parse(inputBytes),metadata=JSON.parse(artifact.rawMetadata);
    if(role==='source' && sourceArtifactHash)need(hash(rules.stableJSON(artifact))===sourceArtifactHash,'verification_launch_artifact');
    need(input.language==='Solidity' && metadata.compiler?.version && Object.keys(input.sources).length>0,'verification_compiler');
    // Solidity's IPFS metadata commitment is part of the deployed bytecode. It
    // binds the compiler version, source digests and settings to this runtime.
    const compiled=artifact.deployedBytecode.object.replace(/^0x/,'');
    const metadataBytes=parseInt(compiled.slice(-4),16),trailer=compiled.slice(-(metadataBytes+2)*2,-4);
    need(metadata.settings?.metadata?.bytecodeHash==='ipfs' && metadataBytes<=512 && trailer.includes('697066735822'+metadataMultihash(artifact.rawMetadata)),'verification_metadata_commitment');
    for(const path of Object.keys(metadata.sources)) {
      const source=input.sources[path];
      need(typeof source.content==='string' && metadata.sources?.[path]?.keccak256,'verification_source');
      const {keccak}=await import('../committee/signer/escrow.mjs');
      need('0x'+Buffer.from(keccak(Buffer.from(source.content))).toString('hex')===metadata.sources[path].keccak256,'verification_source_hash');
    }
    let codeAddress=address;
    if(receipt.implementation) {
      need(role==='token' && /^0x[0-9a-f]{40}$/.test(receipt.implementation),'verification_implementation');
      const proxyCode=await reads.ethereum('eth_getCode',[address,view.number]);
      if(receipt.proxyKind==='eip1167') {
        const match=/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/.exec(proxyCode);
        need(match && '0x'+match[1]===receipt.implementation,'verification_proxy');
      } else {
        need(receipt.proxyKind==='eip1967','verification_proxy_kind');
        const slot=await reads.ethereum('eth_getStorageAt',[address,'0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',view.number]);
        need('0x'+slot.slice(-40)===receipt.implementation,'verification_proxy');
      }
      codeAddress=receipt.implementation;
      need(hash(proxyCode)===receipt.proxyRuntimeSHA256,'verification_proxy_runtime');
    }
    const code=await reads.ethereum('eth_getCode',[codeAddress,view.number]);
    need(code.length>2 && hash(code)===receipt.runtimeSHA256,'verification_runtime_pin');
    verifyRuntime(artifact.deployedBytecode.object,code,artifact.deployedBytecode.immutableReferences);
    // Normalize only defined Solidity defaults. Metadata omits explicit default
    // metadata options and outputSelection, and adds empty remapping contexts.
    const settings={libraries:{},remappings:[],optimizer:{enabled:false,runs:200},metadata:{bytecodeHash:'ipfs'},...input.settings};
    settings.remappings=settings.remappings.map(r=>r.slice(0,r.indexOf('=')).includes(':')?r:':'+r).sort();
    const metadataOptions=value=>({bytecodeHash:'ipfs',appendCBOR:true,useLiteralContent:false,...value});
    for(const [key,value] of Object.entries(metadata.settings ?? {})) if(key!=='compilationTarget') {
      const supplied=key==='metadata'?metadataOptions(settings[key]):settings[key];
      const recorded=key==='metadata'?metadataOptions(value):key==='remappings'?[...value].sort():value;
      need(rules.stableJSON(supplied)===rules.stableJSON(recorded),'verification_settings');
    }
    if(role==='token')need(BigInt(await reads.ethereum('eth_call',[{to:address,data:calldata('decimals()',[])},view.number]))===18n,'verification_token_decimals');
    results.push({role,address,codeAddress,artifactSHA256:receipt.artifactSHA256,inputSHA256:receipt.inputSHA256,runtimeSHA256:hash(code),block:view.number,blockHash:view.hash,retrievedAt:Date.now()});
  }
  need((await reads.ethereum('eth_getBlockByNumber',[view.number,false])).hash===view.hash,'verification_reorg');
  return results;
}
