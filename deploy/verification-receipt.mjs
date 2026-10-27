import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTarget, privateBytes, need, sha256 } from './target.mjs';
import { endpoint, productionURL } from '../service/prod/config.mjs';
import { HttpSource, jsonRpc } from '../service/prod/http.mjs';
import { atomicWrite } from '../service/src/util.mjs';

// Produces measured receipt fields, not a verification assertion. The launch
// still checks source/compiler metadata, published bytes and chain identity.
export async function prepareVerificationReceipt(t, kind, { ethereum } = {}) {
  need(t.mode==='mainnet' && ['token','escrow'].includes(kind), 'verification_kind');
  const address=kind==='token'?t.ethereum.tokenAddress:t.ethereum.escrowAddress;
  need(/^0x[0-9a-f]{40}$/.test(address) && !/^0x0{40}$/.test(address), 'verification_address');
  ethereum ??= jsonRpc(new HttpSource({...await endpoint(t.ethereum.rpc),retries:0}));
  need(BigInt(await ethereum('eth_chainId'))===BigInt(t.ethereum.chainId), 'verification_chain');
  const view=await ethereum('eth_getBlockByNumber',['latest',false]);
  need(/^0x[0-9a-f]+$/.test(view?.number)&&/^0x[0-9a-f]{64}$/.test(view?.hash),'verification_view');
  const artifactFile=join(t.paths.output,'verification',kind+'-artifact.json'),inputFile=join(t.paths.output,'verification',kind+'-input.json');
  const artifact=await privateBytes(artifactFile),input=await privateBytes(inputFile);
  const origin=productionURL(t.public.gateway);need(origin.startsWith('https:'),'verification_public_https');
  const receipt={chainId:t.ethereum.chainId,address,artifactFile,inputFile,
    artifactURL:origin+'/verification/'+kind+'-artifact.json',inputURL:origin+'/verification/'+kind+'-input.json',
    artifactSHA256:await sha256(artifact),inputSHA256:await sha256(input)};
  let code=await ethereum('eth_getCode',[address,view.number]);
  need(/^0x(?:[0-9a-f]{2})+$/.test(code),'verification_code');
  if(kind==='token') {
    const minimal=/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/.exec(code);
    const slot= minimal ? null : await ethereum('eth_getStorageAt',[address,'0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',view.number]);
    need(minimal || /^0x[0-9a-f]{64}$/.test(slot),'verification_storage');
    if(minimal || !/^0x0{64}$/.test(slot)) {
      receipt.implementation='0x'+(minimal?minimal[1]:slot.slice(-40));
      receipt.proxyKind=minimal?'eip1167':'eip1967';receipt.proxyRuntimeSHA256=await sha256(code);
      code=await ethereum('eth_getCode',[receipt.implementation,view.number]);need(/^0x(?:[0-9a-f]{2})+$/.test(code),'verification_implementation');
    }
  }
  receipt.runtimeSHA256=await sha256(code);
  need((await ethereum('eth_getBlockByNumber',[view.number,false])).hash===view.hash,'verification_reorg');
  return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    need(process.argv.length===6&&process.argv[2]==='--target'&&process.argv[4]==='--kind','arguments');
    const t=await loadTarget(process.argv[3]),kind=process.argv[5],receipt=await prepareVerificationReceipt(t,kind);
    await atomicWrite(t.ethereum[kind==='token'?'tokenVerificationFile':'sourceVerificationFile'],JSON.stringify(receipt,null,2));
    console.log('Measured source receipt prepared. Full source, publication and runtime checks remain mandatory at admission.');
  } catch {console.error('STOP: supply a valid target, token|escrow kind and matching owned compiler files. No private provider values are printed.');process.exitCode=1;}
}
