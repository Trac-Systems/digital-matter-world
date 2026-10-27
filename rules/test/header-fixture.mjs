import { ed25519 } from '@noble/curves/ed25519';
import * as rules from '../src/index.js';
import { chain, checkpoint, mine } from '../../contract/tests/helpers/chain.mjs';
import { attest, receiptSigners } from './witness-fixture.mjs';
export const network = 'dmw-regtest';
export const headerAgent = n => { const secret = new Uint8Array(32).fill(n); return { secret, agent: rules.bytesToHex(ed25519.getPublicKey(secret)) }; };
export function headerFixture({ count = 3, settings = {} } = {}) {
  const raw = [mine('0'.repeat(64), 1000), ...chain(100, checkpoint)], headers = raw.map((h, i) => rules.parseHeader(h, i));
  const hashAt = h => headers[h]?.hash ?? null;
  const history = { length: headers.length, get: h => headers[h], raw: h => raw[h], field: h => String(h) };
  const patterns = Array.from({ length: count }, (_, number) => ({ number, name: `dmwtest${number}`, pat: '[0-9]', fld: 4, dt: 'n', rarity: 20, historyHeight: 19 }));
  const gateway = headerAgent(9), initialState = { lastTip: 20 - 1, counted: 14 };
  let state = initialState;
  const files = [], inputs = [], views = [], config = { puzzleBits: 0, receiptSigners, ...settings };
  const header = height => ({ height, raw: raw[height] });
  function add(tip, moves = [], overrides = {}) {
    const hashes = overrides.hashAt ?? hashAt;
    const entries = moves.map(({ who = 1, type = 'header', payload = header(20), puzzleBits = 0 }, i) => {
      const { agent, secret } = headerAgent(who), move = rules.solveMove({ v: 1, network, a: agent, t: type, b: tip, h: hashes(tip), p: payload }, secret, puzzleBits);
      return { move, receipt: rules.signReceipt(move, { tip, hash: hashes(tip), sequence: (state.lastSequence ?? -1) + 1 + i }, gateway.secret) };
    });
    const height = overrides.height ?? tip - 5, receiptRoot = rules.sealReceipts(entries.map(e => e.receipt), { network, tip, hash: hashes(tip) }, gateway.secret);
    const input = { height, blockHash: hashes(height), tip, tipHash: hashes(tip), confirmed: Math.min(height, tip - 5), entries, receiptRoot,
      rootAttestations: tip <= state.lastTip && !entries.length ? [] : attest(receiptRoot) };
    const result = rules.processBlock({ ...input, network, gateway: gateway.agent, state, patterns, history, hashAt: hashes, settings: config, ...overrides });
    state = result.state; files.push(result.file); inputs.push(input); views.push({ history, hashAt: hashes }); return result;
  }
  return { add, header, history, hashAt, patterns, files, inputs, get state() { return state; },
    context: () => ({ network, gateway: gateway.agent, state: initialState, patterns, inputs, views, settings: config, counted: state.counted, last: { n: 0, to: 14 } }),
    build: () => rules.buildBatch({ network, epoch: 0, sequence: 1, lastTo: 14, executionHeight: state.counted, files }) };
}
