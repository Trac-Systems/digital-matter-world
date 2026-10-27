// Binding flow needs no new blocks: real gateway + five signers, wallet-provider
// signatures generated with the existing local test payout wallets only.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { DATA, json } from '../../playground/common.mjs';
import { unlock, publicKey, wipeWallet } from '../../kit/lib/keyring.mjs';
import { signBytes } from '../../kit/lib/signing.mjs';
import { bindingMessage } from '../../rules/src/payout-bindings.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { signTestPayout, testPayoutAddress } from '../../playground/payout-wallets.mjs';
const origin = process.env.DMW_WEB_ORIGIN ?? 'http://127.0.0.1:58911';
const target = await (await fetch(origin+'/web-api/target')).json(); assert.equal(target.bitcoinNetwork,'regtest'); assert.equal(target.ethereum.chainId,'0x7a69');
const ownerDir = join(DATA,'players/owner'), payouts = await json(join(ownerDir,'payout-wallets.json'));
const wallet = await unlock({directory:ownerDir,password:await readFile(join(ownerDir,'password'),'utf8')}), owner=publicKey(wallet);
const browser=await chromium.launch({headless:true}), evidence=[];
async function api(path,body) { const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{accept:'application/json','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();assert.ok(r.ok,v.error);return v; }
try {
  for(const rail of ['tap','ethereum']) {
    const address=testPayoutAddress(payouts[rail],rail), now=Date.now(), r={agent:owner,rail,address,nonce:String(now),expiry:now+3600000};
    const message=bindingMessage(target.network,'regtest',r), pending=await api('/payout-bindings/request',{request:r,agentSignature:signBytes(wallet,Buffer.from(message))});
    const context=await browser.newContext();let signed=0,cancel=false;
    await context.exposeBinding('__sign',(_s,message)=>{signed++;if(cancel){cancel=false;return {cancel:true};} return signTestPayout(message,payouts[rail],rail);});
    await context.addInitScript(({address,rail})=>{
      window.wrongWallet=false;
      const sign=async message=>{const r=await window.__sign(message);if(r?.cancel)throw Object.assign(Error('cancelled'),{code:4001});return r;};
      window.tapprotocol={getNetwork:async()=>'regtest',requestAccounts:async()=>[window.wrongWallet?'bcrt1pwrong':address],signMessage:sign};
      window.ethereum={request:async({method,params})=>{if(method==='eth_chainId')return '0x7a69';if(method==='eth_requestAccounts')return [window.wrongWallet?'0x'+'11'.repeat(20):address];if(method==='personal_sign')return sign(new TextDecoder().decode(Uint8Array.from(params[0].slice(2).match(/../g),s=>parseInt(s,16))));throw Error(method);}};
    },{address,rail});
    const page=await context.newPage();await page.goto(origin+pending.bindPath);
    await page.evaluate(()=>window.wrongWallet=true);await page.getByRole('button',{name:'Sign with wallet and bind'}).click();
    await page.locator('.binding-status').filter({hasText:'Select the'}).waitFor();assert.equal(signed,0);
    await page.evaluate(()=>window.wrongWallet=false);cancel=true;await page.getByRole('button',{name:'Sign with wallet and bind'}).click();
    await page.getByText('Signature cancelled. You can retry.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Sign with wallet and bind'}).click();
    await page.getByText('Payout wallet bound.',{exact:true}).waitFor({timeout:120000});
    const accepted=await api(`/payout-bindings/${encodeTracAddress(owner)}/${rail}`);assert.equal(accepted.binding.id,pending.id);assert.ok(accepted.binding.attestations.length>=3);
    await page.reload();await page.getByText('Payout wallet bound.',{exact:true}).waitFor();assert.ok(await page.getByRole('button',{name:'Sign with wallet and bind'}).isDisabled());
    evidence.push({rail,id:pending.id,attestations:accepted.binding.attestations.length,state:'accepted'});console.log('PASS binding '+rail+': wrong account, cancel/retry, accepted quorum, reload');await context.close();
  }
}finally{await browser.close();wipeWallet(wallet);await writeFile(process.env.DMW_WEB_REPORT ?? join(DATA, 'web-bindings.json'),JSON.stringify(evidence,null,2));}
