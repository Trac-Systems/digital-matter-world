import { committeeAddress } from '../committee/signer/escrow.mjs';
import { encodeTracAddress, wireIdentities } from '../rules/src/trac-address.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { steps } from './safety.mjs';
import { config, sharedTarget } from './test-target.mjs';
import { Store } from '../service/src/store.mjs';
import { serve } from '../service/src/http.mjs';
import { hash } from '../service/src/util.mjs';
import { agent, signEd } from '../service/test/helpers.mjs';
import { bindingFixture } from '../service/test/bindings-fixture.mjs';
import { ServiceClient } from '../kit/lib/service-client.mjs';
import { bindTestPayoutWallets } from '../service/test/payout-wallets.mjs';
const { secp256k1 } = createRequire(new URL('../rules/package.json', import.meta.url))('@noble/curves/secp256k1');
const exec = promisify(execFile);

test('offline deployment verification requires accepted finder bindings from the local HTTP protocol', async t => {
  const build = await realpath(await mkdtemp(join(tmpdir(), 'dmw-deploy-test-')));
  const target = { ...config, output: join(build, 'deploy') };
  await mkdir(target.output);
  const directory = await mkdtemp(join(target.output, 'run-verifier-'));
  const execOptions = { env: { ...process.env, DMW_BUILD_ROOT: build } };
  const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value));
  const store = await Store.open(join(directory, 'bindings'));
  const f = bindingFixture(store, { network: target.network }), who = agent(91);
  let http;
  try {
    http = await serve({ intake: { store }, files: { serve: async () => false }, bindings: f.bindings });
    const service = new ServiceClient({ origin: http.url, network: target.network, receiptSigners: f.members });
    const wallets = await bindTestPayoutWallets({ directory: join(directory, 'smoke-finder'),
      wallet: { publicKey: who.address, sign: bytes => signEd(bytes, who.secret) }, service });
    const bindings = {};
    for (const rail of ['tap', 'ethereum']) {
      bindings[rail] = wireIdentities((await service.payoutBinding(encodeTracAddress(who.address), rail)).binding);
      assert.equal(bindings[rail].request.address, wallets[rail]);
      assert.equal(bindings[rail].attestations.length, 5);
    }
    await save('smoke-payout-bindings.json', bindings);
    // Synthetic offline evidence exercises the verifier without starting chains.
    const authority = { auth: { fixture: true }, slt: 'local' }, key = Buffer.alloc(32, 3);
    authority.hash = hash(JSON.stringify(authority.auth) + authority.slt);
    const signature = secp256k1.sign(authority.hash, key);
    authority.sig = { r: signature.r.toString(), s: signature.s.toString(), v: signature.recovery };
    await save('authority.json', authority);
    await save('committee-public.json', { publicKey: Buffer.from(secp256k1.getPublicKey(key)).toString('hex'), ethereumAddress:committeeAddress(Buffer.from(secp256k1.getPublicKey(key)).toString('hex')), members: f.members });
    await save('target.json', target);
    await save('launch-target.json', sharedTarget);
    await save('fixture-target.json', sharedTarget);
    await save('bitcoin-registry.json', Array.from({ length: 4 }, (_, i) => ({ number:i,name: 'dmwtest' + i, reuse: i < 3,
      element: hash('element-' + i) + 'i0', deployment: hash('deployment-' + i) + 'i0' })));
    await mkdir(join(directory, 'verification'));
    const runtime='0x'+'01'.repeat(200);
    await save('verification/artifact.json', {deployedBytecode:{object:runtime,immutableReferences:{}}});
    const escrow = { address: '0x' + '11'.repeat(20), token: '0x' + '22'.repeat(20),chainId:'31337' };
    await save('source-verification.json', { escrow, runtime,runtimeSHA256:hash(runtime),constructorArguments:[escrow.token,committeeAddress(Buffer.from(secp256k1.getPublicKey(key)).toString('hex')),'0x'+'55'.repeat(20)].map(a=>a.slice(2).padStart(64,'0')).join(''), source: hash('fixture'), artifactSHA256: hash(await readFile(join(directory, 'verification/artifact.json'))) });
    await save('verification/standard-input.json', { sources: { 'src/DmwEscrow.sol': { content: 'fixture' } } });
    const treasury = '0x' + '33'.repeat(20), payer = '0x' + '44'.repeat(20), burn = '0x' + '00'.repeat(20);
    await save('registry.json', { assets: { p0: {id:hash('deployment-0')+'i0', ethereum: { treasury } } } });
    const smoke = rail => ({deploymentId:hash('deployment-0')+'i0', state: 'complete', kind: rail, price: '100', split: { treasury: '70', finder: '20', burn: '10' },
      feeQuote: { payouts: { finder: bindings[rail].id }, issuedAt: Date.now() } });
    const tapSmoke = smoke('tap'), ethSmoke = smoke('ethereum');
    await save('smoke-tap.json', tapSmoke); await save('smoke-ethereum.json', ethSmoke);
    const transfer = (from, to, amount) => ({ address: escrow.token, data: '0x' + BigInt(amount).toString(16), topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x' + from.slice(2).padStart(64, '0'), '0x' + to.slice(2).padStart(64, '0') ] });
    const receipt = (label, logs) => ({ label, receipt: { status: '0x1', logs } });
    await save('result.json', {mode:'regtest', complete: true, through: 'kit', processesStopped: true,
      phases: steps.map(name => ({ name, status: 'passed' })), checks: Array(14).fill({}),
      cleanup: { errors: [], processes: Array.from({ length: 16 }, () => ({ alive: false })) }, ethereum: [
        receipt('smoke-deposit', [transfer(payer, escrow.address, '100')]),
        receipt('smoke-release', [transfer(escrow.address, treasury, '70'), transfer(escrow.address, wallets.ethereum, '20'), transfer(escrow.address, burn, '10')]) ] });
    await save('agent-kit.json', { localOnly: true, network: target.network, gateway: service.origin, gatewayKey: who.address,
      receiptSigners: f.members, adapter: 'fixture', trac: 'fixture', headerSource: 'fixture', puzzleBits: 0, powLimitBits: 0x207fffff, paymentOrigin: service.origin });
    await save('deployment-outputs.json',{version:1,mode:'regtest',committee:Buffer.from(secp256k1.getPublicKey(key)).toString('hex'),network:sharedTarget.network,targetSHA256:hash(JSON.stringify(sharedTarget)),ethereum:escrow,assets:Array.from({length:4},(_,i)=>({asset:'p'+i.toString(36),element:hash('element-'+i)+'i0',deployment:hash('deployment-'+i)+'i0'})),roles:{ethereumAdmin:'0x'+'55'.repeat(20)}});
    const verify = () => exec(process.execPath, [fileURLToPath(new URL('./verify.mjs', import.meta.url)), directory, '--dry-run', '--regtest', '--target', join(directory, 'fixture-target.json')], execOptions);
    await t.test('valid certificates match both quote snapshots and the finder receipt', async () => {
      assert.match((await verify()).stdout, /offline evidence checks passed/);
    });
    await t.test('the same shared target verifies offline and a substituted target fails', async () => {
      const path = join(directory, 'selected-target.json'); await save('selected-target.json', sharedTarget);
      const run = () => exec(process.execPath, [fileURLToPath(new URL('./verify.mjs', import.meta.url)), directory, '--dry-run', '--regtest', '--target', path], execOptions);
      assert.match((await run()).stdout, /offline evidence checks passed/);
      await save('selected-target.json', { ...sharedTarget, network: 'different-network' });
      await assert.rejects(run());
    });
    const cases = [
      ['missing certificate', b => { delete b.ethereum; }],
      ['wallet substitution', b => { b.ethereum.request.address = treasury; }],
      ['invalid committee endorsement', b => { b.ethereum.attestations[0].sig = '00'.repeat(64); }],
      ['insufficient quorum', b => { b.ethereum.attestations.length = 2; }],
      ['swapped rails', b => { [b.tap, b.ethereum] = [b.ethereum, b.tap]; }]
    ];
    for (const [name, mutate] of cases) await t.test(name, async () => {
      const invalid = structuredClone(bindings); mutate(invalid);
      await save('smoke-payout-bindings.json', invalid); await assert.rejects(verify());
    });
    await save('smoke-payout-bindings.json', bindings);
    await t.test('quote cannot select a different accepted binding', async () => {
      const next = await f.bind(who, 'ethereum', agent(92).secret.toString('hex'), (BigInt(bindings.ethereum.request.nonce) + 1n).toString());
      await save('smoke-payout-bindings.json', { ...bindings, ethereum: next }); await assert.rejects(verify());
    });
    await save('smoke-payout-bindings.json', bindings);
    await t.test('quote cannot predate its binding', async () => {
      await save('smoke-ethereum.json', { ...ethSmoke, feeQuote: { ...ethSmoke.feeQuote, issuedAt: bindings.ethereum.acceptedAt - 1 } });
      await assert.rejects(verify());
    });

    await t.test('production-shaped evidence verifies without local smoke or service shutdown assumptions', async () => {
      const {publicTarget}=await import('./public-target.mjs'),{calldata}=await import('../committee/signer/escrow.mjs');
      const recorded=JSON.parse(await readFile(new URL('./fixtures/production-reads.json',import.meta.url)));
      const production=structuredClone(sharedTarget);production.mode='mainnet';production.network='fixture-main';production.bitcoin.chain='main';production.ethereum.chainId='1';production.ethereum.signing='files';
      production.committee.publicKey=Buffer.from(secp256k1.getPublicKey(key)).toString('hex');
      production.committee.members=production.committee.members.map((m,i)=>({...m,...f.members[i]}));
      Object.assign(production.public,{gateway:'https://dmtworld.much.fun',headerSource:'https://dmtworld.much.fun',paymentOrigin:'https://dmtworld.much.fun',gatewayKey:who.address});
      Object.assign(production.trac,{networkId:'918',bootstrap:'11'.repeat(32),msbBootstrap:'22'.repeat(32),adminPublicKey:'33'.repeat(32)});
      Object.assign(production.ethereum,{adminAddress:'0x'+'55'.repeat(20),treasuryAddress:treasury,escrowAddress:escrow.address,tokenAddress:escrow.token});production.bitcoin.treasuryAddress='fixture-treasury';production.bitcoin.checkpointHeight=2016;
      await save('fixture-target.json',production);await save('launch-target.json',production);
      await save('result.json',{mode:'mainnet',complete:true,phases:['preflight','committee','bitcoin','trac','ethereum','config','kit'].map(name=>({name,status:'passed'}))});
      const outputs=JSON.parse(await readFile(join(directory,'deployment-outputs.json')));Object.assign(outputs,{mode:'mainnet',network:production.network,targetSHA256:hash(JSON.stringify(production)),ethereum:{...escrow,chainId:'1'},checkpoint:recorded.checkpoint.checkpoint});Object.assign(outputs.roles,{ethereumTreasury:treasury,tapTreasury:production.bitcoin.treasuryAddress});await save('deployment-outputs.json',outputs);
      const source=JSON.parse(await readFile(join(directory,'source-verification.json')));source.escrow=outputs.ethereum;await save('source-verification.json',source);
      await save('agent-kit.json',publicTarget(production));await save('checkpoint.json',{...recorded.checkpoint,independentValidation:true,validators:['core-a','core-b'],observedTip:2022});
      const calls=Object.fromEntries([['token()',escrow.token],['admin()',production.ethereum.adminAddress],['committee()',committeeAddress(production.committee.publicKey)]].map(([fn,a])=>[calldata(fn,[]),'0x'+a.slice(2).padStart(64,'0')]));calls[calldata('committeeEpoch()',[])]='0x0';
      await save('onchain-verification.json',{chainId:'1',escrow:escrow.address,runtime,calls});
      for(const [name,address]of [['source',escrow.address],['token',escrow.token]])await save(name+'-public-verification.json',{verified:true,chainId:'1',address,publicURL:'https://explorer.invalid/fixture',runtimeSHA256:hash(runtime)});
      await save('admission.json',{ok:true,admitted:true,stage:'admission',checks:[{ok:true}]});
      const verifyProd=()=>exec(process.execPath,[fileURLToPath(new URL('./verify.mjs',import.meta.url)),directory,'--dry-run','--mainnet','--target',join(directory,'fixture-target.json')],execOptions);
      assert.match((await verifyProd()).stdout,/offline evidence checks passed/);
      await save('admission.json',{ok:true,admitted:false,stage:'preparation',checks:[{ok:true}]});await assert.rejects(verifyProd());
      await save('admission.json',{ok:true,admitted:true,stage:'admission',checks:[{ok:true}]});
      calls[calldata('admin()',[])]='0x'+'00'.repeat(32);await save('onchain-verification.json',{chainId:'1',escrow:escrow.address,runtime,calls});await assert.rejects(verifyProd());
    });

  } finally { await http?.close(); await store.close(); await rm(build, { recursive: true, force: true }); }
});
