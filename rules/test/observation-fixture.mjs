import { attest, receiptSigners } from './witness-fixture.mjs';
import { ed25519 } from '@noble/curves/ed25519';
import * as rules from '../src/index.js';
export const network = 'dmw-regtest', secret = new Uint8Array(32).fill(1), gatewaySecret = new Uint8Array(32).fill(9);
export const owner = rules.bytesToHex(ed25519.getPublicKey(secret)), gateway = rules.bytesToHex(ed25519.getPublicKey(gatewaySecret));
export const hashAt = h => rules.hash(String(h));
export const patterns = [{ number: 0, name: 'dmwany', pat: '[0-9]', fld: 4, dt: 'n', rarity: 101, historyHeight: 100 }];
export function observationFixture({ checkpoint = 100, counted = 94, table = patterns, initial = {}, network: observationNetwork = network } = {}) {
  const initialState = { lastTip: checkpoint - 1, counted, ...initial };
  let state = initialState, currentPatterns = table;
  const inputs = [], views = [], files = [];
  function add(tip, height = Math.max(counted, tip - 5), options = {}) {
    const hashes = options.hashAt ?? hashAt;
    const history = { length: tip + 1, get: h => ({ height: h, nonce: h, bits: 1, hash: hashes(h) }), field: h => String(h) };
    const entries = (options.moves ?? []).map((p, i) => {
      const move = rules.solveMove({ v: 1, network: observationNetwork, a: owner, t: 'claim', b: tip, h: hashes(tip), p }, secret, 0);
      return { move, receipt: rules.signReceipt(move, { tip, hash: hashes(tip), sequence: (state.lastSequence ?? -1) + 1 + i }, gatewaySecret) };
    });
    const input = { height, blockHash: hashes(height), tip, tipHash: hashes(tip), confirmed: Math.min(height, Math.max(0, tip - 5)), entries,
      receiptRoot: rules.sealReceipts(entries.map(e => e.receipt), { network: observationNetwork, tip, hash: hashes(tip) }, gatewaySecret),
      mintOperations: options.mintOperations ?? [], linkOperations: options.linkOperations ?? [] };
    input.rootAttestations = tip <= state.lastTip && !entries.length ? [] : attest(input.receiptRoot);
    const result = rules.processBlock({ ...input, network: observationNetwork, gateway, state, patterns: currentPatterns, history, hashAt: hashes, settings: { receiptSigners, puzzleBits: 0, ...options.settings } });
    state = result.state; currentPatterns = result.patterns; inputs.push(input); views.push({ history, hashAt: hashes }); files.push(result.file);
    return result;
  }
  return { add, files, inputs, views, get state() { return state; },
    context: () => ({ network: observationNetwork, gateway, state: initialState, patterns: table, inputs, views, settings: { receiptSigners, puzzleBits: 0 }, counted: state.counted, last: { n: 0, to: counted } }),
    build: overrides => rules.buildBatch({ network: observationNetwork, epoch: 0, sequence: 1, lastTo: counted, executionHeight: state.counted, files, ...overrides }) };
}
export function requestInput(publicKey, overrides = {}) {
  const receiver = 'regtest-receiver', request = { owner, asset: 'p0', block: 10, amount: '3', receive: rules.hash(receiver), nonce: rules.hash('batch-request'), until: 500, expires: 527, ...overrides };
  const compound = !Object.hasOwn(request, 'block');
  return { op: 'rq', request, sig: rules.signRequest('rq', network, request, secret), receiver,
    evidence: { context: { deployment: { id: rules.hash('deployment') + 'i0', kind: compound ? 'compound' : 'dmt', tick: compound ? 'dmwc1' : 'dmwtest',
      active: true, privilegePublicKey: publicKey, decimals: 0, remaining: '1000', limit: '0' },
      find: compound ? null : { block: request.block, asset: request.asset, count: 3, finder: owner, findHeight: 90 }, link: null },
      bitmap: null, minted: false, hold: null, balance: '30', nonceUsed: false } };
}
