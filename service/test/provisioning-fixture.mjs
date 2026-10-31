import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Provisioner } from '../src/provisioning.mjs';
import { hash } from '../src/util.mjs';
import { authority } from '../../local/protocol.mjs';
import { createRequire } from 'node:module';
const { secp256k1 } = createRequire(new URL('../../local/package.json', import.meta.url))('@noble/curves/secp256k1');
export async function provisioningFixture(t, { secret = Buffer.alloc(32, 73) } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dmw-provision-')), store = await Store.open(join(directory, 'store')), registryPath = join(directory, 'registry.json');
  t.after(async () => { await operator.close(); await store.close(); await rm(directory, { recursive: true }); });
  await writeFile(registryPath, JSON.stringify({ assets: {}, feePolicy: { retained: true } }));
  const privilege = hash('privilege') + 'i0', auth = authority(secret, { privilege: true });
  const elements = [], deployments = new Map(), contents = new Map([[privilege, auth]]), packages = new Map(), canonical = new Map();
  let tip = 100, funds = 1000000000n, hook;
  const reads = { inscription: async () => ({address:'maker'}), bindings: {resolve:()=>({request:{address:'maker'}})}, registry: () => readFile(registryPath, 'utf8').then(JSON.parse), tip: async () => ({ tip }), counted: async () => tip,
    authority: async () => ({ committee: Buffer.from(secp256k1.getPublicKey(secret)).toString('hex') }),
    content: async id => contents.get(id), included: async id => canonical.has(id) ? { confirmations: tip - canonical.get(id) + 1, height: canonical.get(id), blockHash: hash('block/' + canonical.get(id)) } : null,
    tap: async path => {
      if (path === 'getCurrentBlock') return tip;
      if (path === 'getDmtElementsListLength') return elements.length;
      if (path.startsWith('getDmtElementsList?')) { const q = new URLSearchParams(path.split('?')[1]); return elements.slice(Number(q.get('offset')), Number(q.get('offset')) + Number(q.get('max'))); }
      if (path === 'getPrivilegeAuthList') return [{ ins: privilege }];
      if (path.startsWith('getPrivilegeAuthCancelled/')) return false;
      if (path.startsWith('getDeployment/')) return deployments.get(decodeURIComponent(path.slice(14))) ?? null;
      throw Error('unexpected_route');
    } };
  // The finder-week clock: public minting active from height 0 with a 1008 block finder window.
  const context = { ready: true, settings: { values: { finderWindow: 1008, publicMintActivationHeight: '0', publicMintLegacyFinderWindow: 1008 } } };
  reads.rulesContext = async () => context;
  reads.privilegeAuthority = async id => id === privilege ? { ins: privilege } : null;
  reads.element = async id => elements.find(e => e.ins === id) ?? null;
  reads.elementByDefinition = async (pat, fld) => elements.find(e => e.pat === pat && Number(e.fld) === fld) ?? null;
  reads.elementByName = async name => elements.find(e => e.tick.toLowerCase() === name.toLowerCase()) ?? null;
  const index = (text, id) => {
    contents.set(id, text); canonical.set(id, tip);
    if (typeof text === 'string') {
      const parts = text.split('.'), tick = parts[0], pat = parts.length === 3 ? null : parts.slice(1, -2).join('.'), fld = parts.at(-2);
      if (!elements.some(e => e.tick.toLowerCase() === tick.toLowerCase() || e.pat === pat && Number(e.fld) === Number(fld))) elements.push({ tick: tick.toLowerCase(), pat, fld: Number(fld), ins: id });
    } else {
      const tick = (text.op === 'dmt-deploy' ? 'dmt-' : '') + text.tick.toLowerCase();
      if (!deployments.has(tick)) deployments.set(tick, { ...text, tick, ins: id, dec: '0' });
    }
  };
  const inscriber = { feeRate: 2, postage: 10000, rpc: async () => ({ mine: { trusted: Number(funds) / 1e8 } }),
    prepare: async (entries, options) => {
      if (!packages.has(options.id)) packages.set(options.id, { id: options.id, entries, commit: { feeSats: '100' }, reveal: { feeSats: '200' }, inscriptions: [{ id: hash(options.id) + 'i0' }] });
      return packages.get(options.id);
    }, broadcast: async p => { if (canonical.has(p.inscriptions[0].id)) return; await hook?.(p); index(p.entries[0].text, p.inscriptions[0].id); } };
  const policy = { confirmations: 1, privilege, authorityKey: (await reads.authority()).committee, tapTreasury: 'treasury', ethereumTreasury: 'eth-treasury' };
  const args = { store, reads, inscriber, network: 'dmw-regtest', registryPath, policy }, operator = new Provisioner(args);
  const pattern = { number: 2, name: 'dmwexample', pat: '123', fld: 4, dt: 'n', discoverer: 'ab'.repeat(32) };
  return { ...args, operator, pattern, context, elements, deployments, contents, packages, canonical, privilege,
    index: (text, id = hash(String(contents.size)) + 'i0') => { index(text, id); return id; }, mine: (n = 1) => { tip += n; }, funds: n => { funds = n; }, hook: fn => { hook = fn; },
    async complete(asset = 'p2', definition = pattern, op = operator) { let job; for (let i = 0; i < 40; i++) {
      job = await op.advanceAsset(asset, definition); if (job.state === 'registered') return job;
      if (job.state === 'awaiting_player_deploy') {
        const item = job.attempts.at(-1), p = await inscriber.prepare([{text:item.text}], {id:item.id});
        await inscriber.broadcast(p); tip += 1;
        await op.submit(asset, { phase:item.phase, inscription:p.inscriptions[0].id });
      }
      tip += 1;
    } throw Error('not_registered:' + JSON.stringify(job)); } };
}
// A compound's first-maker ticker choice as the gateway stores it after verifying the signature
// (signatures and refusals: compound-ticker-choice.test.mjs).
export async function chosenTicker(operator, asset, definition, tick) {
  const job = await operator.enqueue(asset, definition);
  return operator.save(job, { chosenTicker: { tick, revision: (job.chosenTicker?.revision ?? 0) + 1, attempt: job.tickerAttempt, by: 'agent', at: Date.now() } });
}
