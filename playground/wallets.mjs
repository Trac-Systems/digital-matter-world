import { join } from 'node:path';
import { check, maybe, save } from './common.mjs';
import { bitcoin } from '../local/common.mjs';
import { sendInscription } from '../local/inscriber.mjs';
import { rules } from '../service/src/rules.mjs';
import { escrowSplitForItems } from '../committee/signer/escrow.mjs';
import { calldata, TYPES } from '../committee/signer/escrow.mjs';
import { hash } from '../service/src/util.mjs';

export async function paymentPlan(e,id) {
  check(/^[0-9a-f]{64}$/.test(id),'payment_request');
  const full=e.store.get('mints',id);check(full,'mint_missing');check(full.request.owner===e.state.player.address,'payment_plan_owner');const row=await e.get('/mint/'+id);
  const plan={id,kind:full.kind,payer:full.payer,state:row.state,price:row.price,unit:rules.TAP_UNIT,quote:full.quote,
    networkFee:{payer:'player_wallet'},submit:{path:'/api/player/payment',body:{id,paymentId:full.kind==='ethereum'?id:'INSCRIPTION_ID'}}};
  if(full.kind==='tap')plan.redeem={p:'tap',op:'token-auth',redeem:{items:rules.walletFeeItems(row.missing??row.fees, 'regtest'),data:id}};
  else {
    const split=escrowSplitForItems(row.missing??row.fees);
    const expiry=(BigInt((await e.evm.rpc('eth_getBlockByNumber',['latest',false])).timestamp)+864000n).toString();
    plan.chainId='0x7a69';plan.rpc=e.manifest.ethereum.rpc;plan.refundAfter=expiry;
    plan.transactions=[{from:full.payer,to:e.state.escrow.token,data:calldata('approve(address,uint256)',[['address',e.state.escrow.address],['uint256',row.payableAmount]])},
      {from:full.payer,to:e.state.escrow.address,data:calldata('deposit(bytes32,uint256,(address,uint256,address,uint256,address,uint256,address,uint256,uint256),uint256)',[['bytes32',id],['uint256',row.payableAmount],...TYPES.Split.map(({name,type})=>[type,split[name]]),['uint256',expiry]])}];
  }
  return plan;
}
export async function fundWallet(e,{bitcoin:btc,ethereum:eth}) {
  check(btc||eth,'wallet_address_required');
  if(btc)check(typeof btc==='string'&&btc.startsWith('bcrt1')&&(await bitcoin(e.manifest,'validateaddress',[btc])).isvalid,'regtest_address_required');
  if(eth)check(/^0x[0-9a-fA-F]{40}$/.test(eth),'ethereum_address_required');
  const path=join(e.directory,'faucet-'+hash(JSON.stringify([btc??null,eth?.toLowerCase()??null]))+'.json'),saved=await maybe(path);
  if(saved){check(saved.state==='complete','uncertain_faucet_inspect_evidence');return saved;}
  const result={state:'started',bitcoin:btc??null,ethereum:eth??null};await save(path,result);
  if(btc){
    result.btcTx=await bitcoin(e.manifest,'sendtoaddress',[btc,1],'faucet');await save(path,result);
    const transfer=await e.write({p:'tap',op:'token-transfer',tick:'tap',amt:'10000'},e.state.addresses.payer);
    result.tapInscription=transfer;await save(path,result);await sendInscription(e.manifest,transfer,btc);await e.blocks(1);
  }
  if(eth){
    result.ethTx=await e.evm.rpc('eth_sendTransaction',[{from:e.manifest.ethereum.accounts[0],to:eth,value:'0x8ac7230489e80000'}]);
    result.tokenTx=(await e.evmSend(e.manifest.ethereum.accounts[0],e.state.escrow.token,calldata('transfer(address,uint256)',[['address',eth],['uint256',(10000n*10n**18n).toString()]]))).transactionHash;
    await e.evm.checkpoint();
  }
  result.state='complete';await save(path,result);return result;
}
