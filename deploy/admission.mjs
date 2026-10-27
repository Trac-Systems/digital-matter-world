import { createRequire } from 'node:module';
import { rules } from '../service/src/rules.mjs';
import { check, hash } from '../service/src/util.mjs';
import { rlp } from './ethereum-signing.mjs';
import { keccak } from '../committee/signer/escrow.mjs';
const require = createRequire(new URL('../local/package.json', import.meta.url));
const { secp256k1 } = require('@noble/curves/secp256k1');
export const operationHash = op => hash(rules.stableJSON(op));
const integer = b => b.length ? BigInt('0x' + b.toString('hex')) : 0n;

export function decodeSignedEthereum(raw) {
  check(/^0x(?:[a-f0-9]{2})+$/.test(raw) && raw.length <= 200000, 'signed_ethereum');
  const bytes = Buffer.from(raw.slice(2), 'hex');
  const read = start => {
    const prefix = bytes[start]; check(prefix !== undefined, 'ethereum_rlp');
    if (prefix < 128) return [bytes.subarray(start,start+1),start+1];
    const list = prefix >= 192, base = list ? 192 : 128; let length = prefix - base, offset = start + 1;
    if (length > 55) { const n = length - 55; check(n <= 4 && bytes[offset] > 0, 'ethereum_rlp'); length = Number(integer(bytes.subarray(offset,offset+n))); offset += n; check(length > 55, 'ethereum_rlp'); }
    const end = offset + length; check(end <= bytes.length, 'ethereum_rlp');
    if (!list) return [bytes.subarray(offset,end),end];
    const children = []; while (offset < end) { const [value,next] = read(offset); children.push(value); offset = next; } check(offset === end, 'ethereum_rlp'); return [children,end];
  };
  const [fields,end] = read(0); check(end === bytes.length && Array.isArray(fields) && fields.length === 9 && fields.every(Buffer.isBuffer), 'ethereum_legacy');
  const [nonce,gasPrice,gas,to,value,data,v,r,s] = fields;
  check([nonce,gasPrice,gas,value,v,r,s].every(b => !b.length || b[0] !== 0) && [0,20].includes(to.length), 'ethereum_rlp_canonical');
  const vi = integer(v); check(vi >= 37n, 'ethereum_eip155');
  const chainId = (vi - 35n) / 2n, recovery = Number((vi - 35n) % 2n);
  const unsigned = [integer(nonce),integer(gasPrice),integer(gas),'0x'+to.toString('hex'),integer(value),'0x'+data.toString('hex'),chainId,0n,0n];
  const signature = new secp256k1.Signature(integer(r), integer(s), recovery); check(!signature.hasHighS(), 'ethereum_low_s');
  const pub = signature.recoverPublicKey(keccak(rlp(unsigned))).toRawBytes(false);
  return { chainId: String(chainId), from: '0x'+Buffer.from(keccak(pub.subarray(1))).subarray(-20).toString('hex'), to: '0x'+to.toString('hex'), data: '0x'+data.toString('hex'), nonce: String(integer(nonce)), gas: String(integer(gas)), gasPrice: String(integer(gasPrice)), value: String(integer(value)), hash: '0x'+Buffer.from(keccak(bytes)).toString('hex') };
}

// Re-observe immediately before each write. Plans contain signed bytes, and
// Bitcoin fees come from their actual prevouts, never a caller's size estimate.
export async function admitOperation(target, operation, reads, { now = Date.now } = {}) {
  const chain = await reads.chainAgreement();
  check(chain.height >= target.bitcoin.checkpointHeight + target.policy.confirmations - 1, 'admission_chain');
  const result = { operationHash: operationHash(operation), observedAt: now(), chain, requirements: {}, fees: {} };
  const amount = (role, value) => { result.requirements[role] = String(BigInt(result.requirements[role] ?? 0) + BigInt(value)); };
  if (operation.rail === 'ethereum') {
    const tx = decodeSignedEthereum(operation.raw), role = operation.role;
    check(role === 'admin' && tx.chainId === target.ethereum.chainId && tx.from === target.ethereum[role+'Address'].toLowerCase() && tx.value === '0', 'ethereum_plan_role');
    const price = BigInt(await reads.ethereum('eth_gasPrice'));
    const gas = BigInt(await reads.ethereum('eth_estimateGas',[{from:tx.from,...(tx.to==='0x'?{}:{to:tx.to}),data:tx.data,value:'0x0'}]));
    check(BigInt(tx.gas)>=gas && BigInt(tx.gas)<=BigInt(target.policy.ethereumMaxGas) && BigInt(tx.gasPrice)>=price && BigInt(tx.gasPrice)<=BigInt(target.policy.ethereumMaxGasPriceWei),'ethereum_plan_fee');
    const required = BigInt(tx.gas)*BigInt(tx.gasPrice);
    check(BigInt(await reads.ethereum('eth_getBalance',[tx.from,'pending']))>=required,'ethereum_observed_funds');
    amount('ethereum'+role[0].toUpperCase()+role.slice(1)+'Wei',required); result.fees={gas:tx.gas,gasPrice:tx.gasPrice,hash:tx.hash};
  } else {
    check(operation.rail==='trac' && ['host','writer'].includes(operation.role) && operation.packet && operation.count===1,'trac_plan');
    const funds = await reads.funding();
    const age=now()-funds.observedAt;
    check(funds.source==='pinned-msb-runtime' && age>=0 && age<60000 && new Set(funds.validators).size>=3 && BigInt(funds.feeAtoms)>0n,'trac_observation');
    check(BigInt(funds.balances[target.trac.balance[operation.role+'Address']])>=BigInt(funds.feeAtoms),'trac_observed_funds');
    amount('tnk'+operation.role[0].toUpperCase()+operation.role.slice(1)+'Atoms',funds.feeAtoms); result.fees={feeAtoms:funds.feeAtoms,packetHash:operationHash(operation.packet)};
  }
  for(const [role,value] of Object.entries(result.requirements)) check(BigInt(target.funding[role])>=BigInt(value),'operation_budget');
  result.observedAt=now();
  return result;
}

export class AdmittedWrites {
  constructor({target,store,reads,boundary}) { Object.assign(this,{target,store,reads,boundary}); }
  async execute(id, operation, send, observed) {
    const digest = operationHash(operation), old = this.store.get('launchWrites',id);
    check(!old || old.digest===digest,'launch_operation_changed');
    if (!old) await this.store.put('launchWrites',id,{digest,operation,state:'prepared'});
    const found = await observed?.();
    if (found) { await this.store.put('launchWrites',id,{...old,digest,operation,state:'confirmed',result:found}); return found; }
    const admission = await admitOperation(this.target,operation,this.reads);
    const prior=this.store.list('launchWrites',{limit:4096});check(prior.length<4096,'launch_operation_limit');
    for(const [role,value] of Object.entries(admission.requirements)) {
      const reserve=role==='bitcoinSats'?BigInt(this.target.funding.bitcoinReserveSats):0n;
      const spent=prior.filter(r=>r.id!==id&&r.value.admission?.requirements[role]).reduce((n,r)=>n+BigInt(r.value.admission.requirements[role])-reserve,0n);
      check(spent+BigInt(value)<=BigInt(this.target.funding[role]),'launch_cumulative_budget');
    }
    await this.store.put('launchWrites',id,{digest,operation,state:'sending',admission});
    await this.boundary();
    const result = await send();
    await this.store.put('launchWrites',id,{digest,operation,state:'submitted',admission,result});
    return result;
  }
}
