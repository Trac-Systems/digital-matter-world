import { evaluateDiscovery, CLAIM_DEFAULTS } from '../../../rules/src/index.js';
import { publicIdentities } from '../../../rules/src/trac-address.js';
import { encodeTracAddress } from '../../../rules/src/trac-address.js';
// API fixtures in the documented shapes, with every money field as an 18-decimal atomic string.
const U = { currency: 'TAP', denomination: 'atomic', decimals: 18 };
const TAP = n => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();
// Synthetic display identities and transaction hash, unrelated to any wallet.
const ME = encodeTracAddress('11'.repeat(32));
const BOT = encodeTracAddress('22'.repeat(32));
const ADDR = 'bcrt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsqysakq';
const HASH = 'ab'.repeat(32);
const split = { firstMaker: '0', finder: TAP(67.8), landowner: '0', burn: TAP(79.1), treasury: TAP(79.1), discoverer: '0' };
const quote = { asset: 'p0', block: 151, kind: 'tap', baseFee: TAP(22.6), unit: U, price: TAP(226), split, networkFeeSats: '100000',
  destinations: { treasury: ADDR, finder: ADDR }, feeQuote: { baseFee: TAP(22.6), unit: U, validUntil: 4412, expiresAt: Date.now() + 300000, scope: '["mint","p0",151,"tap"]' } };

const fixtureHistory = { length: 2402, get: h => ({hash: HASH, height: h, nonce: h * 777, bits: 545259519}), field: (h, fld, dt) => (fld === 4 ? h : fld === 10 ? h * 777 : 545259519).toString(dt === 'h' ? 16 : 10) };
const fixturePatterns = [];
for (const proposal of [{name:'dmwdigit',pat:'[0-9]',fld:4,dt:'n'}, {name:'dmwsmall',pat:'[0-4]',fld:4,dt:'n'}, {name:'dmwember',pat:'7{3}',fld:10,dt:'n'}]) {
  const {record} = evaluateDiscovery({proposal,discoverer:'11'.repeat(32),history:fixtureHistory,existing:fixturePatterns,number:fixturePatterns.length});
  fixturePatterns.push(record);
}
const publicEvents = [
  { sequence: 8, id: 'e8', at: Date.now(), type: 'header_find', data: { asset: 'p0', block: 67, count: 3, winner: BOT, finder: BOT, source: 'header', tickets: 2 } },
  { sequence: 7, id: 'e7', at: Date.now(), type: 'mint_complete', data: { id: HASH, owner: ME, asset: 'p0', amount: '3', block: 151, inscription: `${HASH}i0` } },
  { sequence: 6, id: 'e6', at: Date.now(), type: 'transfer', data: { from: ME, to: BOT, assets: [['p0', '1']], tx: HASH } },
  { sequence: 5, id: 'e5', at: Date.now(), type: 'find', data: { asset: 'p1', block: 66, count: 2, winner: BOT, finder: BOT, findHeight: 2399 } },
  { sequence: 4, id: 'e4', at: Date.now(), type: 'claim', data: { agent: ME, block: 2398, window: 2398, patterns: [0, 1], header: true } },
  { sequence: 3, id: 'e3', at: Date.now(), type: 'discovery', data: { agent: ME, state: 'accepted', name: 'dmwember', tier: 4, rarity: 120, asset: 'p2' } },
  { sequence: 2, id: 'e2', at: Date.now(), type: 'mint_request', data: { id: HASH, owner: ME, asset: 'p0', amount: '3', block: 151 } },
  { sequence: 1, id: 'e1', at: Date.now(), type: 'block', data: { height: 2401, tip: 2401, windows: [2399], found: [12, 900, 1500] } }];
export const lists = {
  'player/balances': ['balances', [{ asset: 'p0', amount: '76' }, { asset: 'p1', amount: '48' }, { asset: 'c1', amount: '2' }]],
  'player/mintRights': ['mintRights', [{ asset: 'p0', block: 151, amount: '3', deploymentRegistered: true, allowed: true, reason: 'finder', finderUntil: 3230, minted: false, pending: null, finder: ME },
    { asset: 'p1', block: 66, amount: '2', deploymentRegistered: true, allowed: true, reason: 'public', finderUntil: 1100, minted: false, pending: null, finder: BOT }]],
  'player/history': ['history', [{ id: 'mint/tour-mint-tap-abcd1234', type: 'mint', state: 'submitted', sequence: 4 }, { id: 'claim/2051', type: 'claim', state: 'received', sequence: 3 }]],
  'player/pendingPayments': ['pendingPayments', [{ id: HASH, type: 'mint', asset: 'p0', block: 151, amount: '3', kind: 'tap', state: 'awaiting_payment', price: TAP(226), unit: U, split, refundAfter: 2663 }]],
  'player/bitmaps': ['bitmaps', [{ height: 600, inscription: `${HASH}i0`, linked: true }, { height: 701, inscription: `${HASH}i1`, linked: false }]],
  'player/discoveries': ['discoveries', [{ actionId: 'dmwember-1', name: 'dmwember', pat: '7{3}', fld: 4, dt: 'n', revealFrom: 2100, revealUntil: 2242, state: 'accepted', asset: 'p2' }]],
  patterns: ['patterns', publicIdentities(fixturePatterns.map((p,i)=>({...p,asset:'p'+i,supply:['72','40','3'][i],minted:[4,1,0][i],madeReal:['9','2','0'][i]})))],
  'patterns/p0/blocks': ['rows', [{ block: 151, count: 3, finder: ME, findHeight: 2100, found: true, minted: true, link: null }, { block: 66, count: 2, finder: null, findHeight: null, found: false, minted: false, link: null }]],
  compounds: ['compounds', [{ id: 'c1', name: 'Fusion: 1 dmwdigit + 1 dmwsmall', tier: 3, supply: '2', madeReal: '1', firstMaker: ME, token: 'dmwc1', properties: { mass: '2' } }]],
  'results/mints': ['mints', [{ id: HASH, state: 'minted', kind: 'ethereum', asset: 'p0', block: 151, amount: '3', price: TAP(226), unit: U, inscription: `${HASH}i0`, receiver: ADDR },
    { id: HASH.replace('8', '9'), state: 'minted', kind: 'tap', asset: 'c1', amount: '1', price: TAP(226), unit: U, inscription: `${HASH}i2`, receiver: ADDR }]],
  'results/payments': ['payments', [{ id: `${HASH}i0:0`, consumed: { lock: `${HASH}i0:0`, action: 'claim', amt: TAP(79.1), total: TAP(226), target: ADDR, blck: 2107, tx: HASH,
    al: [{ tt: 'a', to: ADDR, amt: TAP(67.8), rl: 'of' }, { tt: 'b', to: '1BitcoinEaterAddressDontSendf59kuE', amt: TAP(79.1), rl: 'bn' }] } }]],
  'results/ethereum': ['ethereum', [{ id: HASH, requestId: HASH, payer: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', confirmations: 1, unit: U,
    deposit: { amount: TAP(226), status: 2, split: { finderAmount: TAP(67.8), landownerAmount: '0', burnAmount: TAP(79.1), treasuryAmount: TAP(79.1) } } }]],
  'results/payouts': ['payouts', [{ id: HASH, beneficiary: ADDR, accrued: TAP(33.9), paid: '0', owed: TAP(33.9) }]],
  'results/owed': ['owed', [{ id: HASH, role: 'discoverer', to: ADDR, amount: TAP(33.9), inscription: `${HASH}i0`, batch: 209 }]],
  'results/links': ['links', [{ id: '0000000000000001', block: 1, linkHeight: 2383 }]],
  world: ['plots', Array.from({ length: 40 }, (_, i) => ({ height: i, x: 0, y: 0, region: 0, halving: 0, hash: HASH, found: i % 3 === 1, linked: i === 1, minted: i === 5, finds: [] }))],
  'blocks/7/mintRights': ['mintRights', [{ asset: 'p0', block: 7, amount: '1', deploymentRegistered: true, allowed: true, reason: 'public', minted: false, pending: null }]],
  'blocks/7/matches': ['matches', [{ asset: 'p0', number: 0, count: 1 }]],
  'blocks/7/claims': ['claims', [{ agent: ME, patterns: [0], header: true, receipt: { sig: HASH } }]],
  'blocks/7/draws': ['draws', [{ window: 2050, claims: 4, winners: [{ asset: 'p0', block: 7, count: 1, winner: ME }], void: false }]],
  jobs: ['jobs', [{ id: 'j1', type: 'player/mint/quote', state: 'complete', created: Date.now(), result: quote }, { id: 'j2', type: 'mine', state: 'complete', created: Date.now(), result: { tip: 2401, mined: 1 } }]],
  bots: ['agents', [{ name: 'bot-0', address: BOT, strategy: 'prospector' }]],
  feed: ['events', publicEvents],
  'lab/feed': ['events', [
    { sequence: 3, at: Date.now(), type: 'payment', data: { id: HASH, state: 'complete', asset: 'p0', block: 151, kind: 'tap', price: TAP(226), unit: U } },
    { sequence: 2, at: Date.now(), type: 'player', data: { actor: ME, name: 'owner', action: 'mint/quote', result: quote } },
    { sequence: 1, at: Date.now(), type: 'job', data: { id: 'j2', type: 'mine', state: 'complete', result: { tip: 2401, mined: 1 } } }]],
  agents: ['agents', [{ address: BOT, finds: 12, discoveries: 1, crafts: 0, mints: 2 }, { address: ME, finds: 9, discoveries: 2, crafts: 3, mints: 4 }]],
  [`agents/${ME}/history`]: ['history', publicEvents.filter(e => [e.data.agent, e.data.owner, e.data.finder, e.data.from].includes(ME))],
  [`agents/${ME}/discoveries`]: ['discoveries', [{ name: 'dmwember', pat: '7{3}', fld: 10, dt: 'n', tier: 4, asset: 'p2', state: 'accepted' }, { state: 'sealed', exists: true, opensAt: 2410 }]],
};

const labStatus = { version: 1, state: 'ready', network: 'dmw-regtest', tip: 2401, counted: 2401, batch: { n: 344, to: 2401 }, units: { tap: 18, bridgedTap: 18, bitcoin: 8, ethereum: 18, matter: 0 },
    mining: { enabled: false, intervalMs: 30000 }, bots: { count: 1, intervalMs: 60000, paused: true }, feePolicy: { baseFee: TAP(22.6), unit: U, revision: HASH },
    components: [{ name: 'bitcoind', state: 'ready' }, { name: 'gateway', state: 'ready' }], history: { kind: 'regtest', seedBlocks: 2048 }, player: { address: ME } };
export const reads = {
  'lab/status': labStatus,
  status: { network: 'dmw-regtest', tip: 2401, counted: 2401, batch: { n: 344, to: 2401 }, settings: CLAIM_DEFAULTS, units: labStatus.units, feePolicy: labStatus.feePolicy, publicIndex: { processedObservation: 120, latestObservation: 120, observationLag: 0, indexedHeight: 2401, indexedTip: 2401, latestHeight: 2401, latestTip: 2401, processedBatch: 344, latestBatch: 344, batchLag: 0, indexedBatchHeight: 2401, eventSequence: 7, caughtUp: true } },
  [`agents/${ME}`]: { address: ME, finds: 9, discoveries: 2, crafts: 3, mints: 4, scores: { finds: 9, discoveries: 2, crafts: 3, mints: 4 } },
  player: { address: ME, balances: lists['player/balances'][1], mintRights: lists['player/mintRights'][1], pendingPayments: lists['player/pendingPayments'][1],
    history: lists['player/history'][1], bitmaps: lists['player/bitmaps'][1], discoveries: lists['player/discoveries'][1], items: [],
    counts: { balances: 3, mintRights: 2 }, wallets: { bitcoin: { address: ADDR, receiver: ADDR, btc: 125.00379364, tap: TAP(999973220.5) },
      ethereum: { address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', chainId: 31337, token: '0x5fbdb2315678afecb367f032d93f642f64180aa3', balance: '9999999475370000000000' } } }, // gitleaks:allow (public Anvil contract address)
  results: { unit: U, counts: { mints: 2, payments: 1, ethereum: 1, payouts: 1, owed: 1, links: 1 },
    mints: lists['results/mints'][1], treasury: { bitcoin: ADDR, tap: TAP(3423.9), ethereum: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc', erc20: TAP(158.2) },
    burn: { tap: TAP(2745.9), ethereum: TAP(158.2) }, outstandingSupply: { ethereum: TAP(1999841.8) } },
  'blocks/7': { height: 7, x: 1, y: 1, region: 0, halving: 0, found: true, header: { hash: HASH, nonce: 3, bits: 545259519, time: 1792841314, prev: HASH, version: 536870912 },
    slots: { used: 1, total: 16 }, finds: [], link: null, mintRights: lists['blocks/7/mintRights'][1] },
};
export { quote };
