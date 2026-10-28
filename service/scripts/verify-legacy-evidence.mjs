import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { rules, rebuildBatch } from '../../committee/signer/adapter.mjs';
import { BatchReplay } from '../../committee/signer/replay-worker.mjs';
import { Policy } from '../../committee/signer/policy.mjs';
// Explicit public fixture inputs; no runtime configuration or credentials.
const [fixtureDirectory, draftFile, certificateFile, outputFile] = process.argv.slice(2);
if (![fixtureDirectory, draftFile, certificateFile, outputFile].every(Boolean)) throw Error('usage: fixtures draft certificates output');
const read = async url => JSON.parse(await readFile(url)), oldBase = pathToFileURL(resolve(fixtureDirectory) + '/');
const draft = await read(draftFile), certificates = (await read(certificateFile)).receiptCertificates;
const full=new rules.HeaderHistory(await readFile(new URL('headers.bin',oldBase)));
const views=inputs=>inputs.map(i=>({hashAt:h=>h>=0&&h<=i.tip?full.get(h).hash:null,history:{length:i.tip+1,get:h=>full.get(h),field:(...args)=>full.field(...args)}}));
const network=draft.proposal.network, publicKey='offline-test-authority', replay=new BatchReplay(), report={accepted:[],draft:{},omissions:[]};
const policy=(Class,context,certs,counted)=>new Class({network,publicKey,replayBatch:replay.run.bind(replay),reads:{authority:async()=>({network,committee:publicKey,epoch:0}),counted:async()=>counted,batchContext:async()=>context,receiptCertificate:async(t,h)=>certs[`${t}/${h}`]??null,preflight:async(batch,at)=>({ok:true,...at,digest:Buffer.from(rules.batchDigest(network,batch)).toString('hex')})}});
let state,patterns=[]; const atAcceptance={};
try {
 const expectedResults=await read(new URL('accepted-results.json',oldBase));
 for(let n=1;n<=42;n++) {
  const saved=await read(new URL(`accepted/batch-${n}.json`,oldBase)), batch=saved.batch;
  const bytes=await Promise.all(saved.publications.map(p=>readFile(new URL(`accepted/${p.observation}.bin`,oldBase))));
  saved.publications.forEach((p,i)=>assert.equal(rules.hash(bytes[i]),p.audit.hash));
  const files=bytes.map(b=>rules.decodeBinary(b));
  state??={lastTip:files[0].tip-1,counted:files[0].previousHeight,highestTip:files[0].tip-1,balances:{},finds:{},types:{},usedNonces:{},linkPayments:{},rounds:[]};
  for(const f of files)if(f.rootAttestations.length){
   const key=`${f.tip}/${f.tipHash}`, c={seal:f.receiptRoot,attestations:f.rootAttestations};
   if(certificates[key])assert.deepEqual(c.seal,certificates[key].seal);
   atAcceptance[key]=c;
  }
  const inputs=files.map(f=>({height:f.height,blockHash:f.hash,tip:f.tip,tipHash:f.tipHash,confirmed:f.confirmed,entries:f.moves.map(({move})=>({move,receipt:f.receipts.find(r=>r.move===rules.moveId(move))})),receiptRoot:f.receiptRoot,rootAttestations:f.rootAttestations,mintOperations:f.mintOperations,linkOperations:f.linkOperations}));
  const context={last:{n:n-1,to:files[0].previousHeight},counted:batch.deadline-6,state,patterns,gateway:files[0].receiptRoot.gateway,settings:draft.settings,limits:draft.limits,headers:batch.hx??[],authority:{epoch:batch.epoch},inputs,views:views(inputs)};
  const proposal={network,kind:'batch',batch,files:bytes.map(b=>b.toString('hex'))};
  const started=performance.now(), expected=rebuildBatch(network,proposal,context);
  assert.equal(expected.digest,expectedResults[n-1].digest);
  const current=await policy(Policy,context,atAcceptance,context.counted).approve(proposal);
  assert.equal(current.digest,expected.digest);
  state=expected.state;patterns=expected.patterns;
  const row={n,observations:files.length,digest:current.digest,ms:performance.now()-started};report.accepted.push(row);console.log(JSON.stringify(row));
 }
 // Exercise the real accepted discovery terminal state on a copy. This does
 // not claim an unavailable complete notary/financial snapshot was imported.
 const before = rules.hash(JSON.stringify(state));
 const document = rules.settingsRevision({ network, effectiveBatch: '43', effectiveBitcoinWindow: String(state.counted), values: { ...rules.SETTINGS_PROFILE } });
 const named = rules.importLegacyDiscoveries({ commitments: state.discoveryCommits ?? [], queued: state.discoveryQueue ?? [], settings: document,
   receiptPosition: String(state.lastSequence ?? 0), lifetime: rules.DISCOVERY_LIMITS.lifetime, minDelay: 2 });
 const saved = new rules.NamedStorage({ get: () => null, cacheSize: 64 }).save(named), nodes = new Map(saved.writes.map(w => [w.id, w.value]));
 const cold = new rules.NamedStorage({ get: id => nodes.get(id), cacheSize: 1 }).load(saved.snapshot);
 for (const original of [...state.discoveryCommits ?? [], ...state.discoveryQueue ?? []]) {
   const imported = rules.namedGet(cold.records, `commit/${original.agent}/${original.commitment}`);
   assert.equal(imported.tip, String(original.tip)); assert.equal(imported.expires, String(original.tip + rules.DISCOVERY_LIMITS.lifetime));
 }
 for (const original of state.discoveryQueue ?? []) assert.deepEqual(rules.namedGet(cold.records, `legacy-reveal/${original.agent}/${original.commitment}`).original, original);
 assert.equal(rules.hash(JSON.stringify(state)), before);
 report.discoveryMigration = { acceptedBatch: 42, unchangedLegacyState: before, commitments: state.discoveryCommits?.length ?? 0,
   queuedWitnessAttachments: state.discoveryQueue?.length ?? 0, namedRoot: rules.namedStateRoot(cold), scope: 'accepted discovery state only; no live financial database available' };
 const inputs=draft.items.map(({input})=>{const {state,patterns,settings,...rest}=input;return rest;});
 const context={last:draft.last,counted:draft.execution,state:draft.startState,patterns:draft.startPatterns,gateway:inputs[0].gateway,settings:draft.settings,limits:draft.limits,headers:draft.headers,inputs,views:views(inputs),authority:{epoch:0}};
 const start=performance.now(), expected=rebuildBatch(network,draft.proposal,context);
 const approved=await policy(Policy,context,certificates,973449).approve(draft.proposal);
 assert.equal(approved.digest,expected.digest);assert.equal(approved.digest,'7af3d23b9b3f9bd12924c48ebda0bc29b8de3c98ad3ce579c93976b572e340e1');
 report.draft={observations:inputs.length,digest:approved.digest,counted:973449,deadline:draft.proposal.batch.deadline,ms:performance.now()-start,result:'approved'};
 console.log(JSON.stringify(report.draft));
 // Rebuild otherwise valid malicious proposals with each receipt-bearing file
 // removed. These pass exact replay, but must fail independent certificate checks.
 for(const tip of [973440,973442,973443,973444,973445,973446]) {
  const kept=inputs.filter(i=>!(i.tip===tip&&i.entries.length)), localViews=views(kept), files=[];
  let state=context.state,patterns=context.patterns;
  for(const [index,input] of kept.entries()) {
   const output=rules.processBlock({...input,network,gateway:context.gateway,state,patterns,settings:context.settings,executionHeight:973449,priorOperations:rules.budgetOperations(files),...localViews[index]});
   files.push(output.file);state=output.state;patterns=output.patterns;
  }
  const built=rules.buildBatch({...context.limits,network,epoch:0,sequence:43,lastTo:context.last.to,executionHeight:973449,deadline:draft.proposal.batch.deadline,files,headers:context.headers});
  const proposal={network,kind:'batch',batch:built.batch,files:built.fileBytes.map(b=>Buffer.from(b).toString('hex'))};
  const altered={...context,counted:973449,inputs:kept,views:localViews};
  rebuildBatch(network,proposal,altered);
  await assert.rejects(policy(Policy,altered,certificates,973449).approve(proposal),/receipt_certificate_read/);
  report.omissions.push({tip,validReplay:true,result:'receipt_certificate_read'});
 }
 await assert.rejects(policy(Policy,context,certificates,973454).approve(draft.proposal),/batch_deadline/);
 report.expired='batch_deadline at 973454';
 await writeFile(outputFile,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({accepted:42,observations:report.accepted.reduce((n,r)=>n+r.observations,0),omissions:report.omissions,expired:report.expired}));
} finally { await replay.close(); }
