import { Protocol } from 'trac-peer';
import { StateTransition, FUNCTIONS, exactKeys, ADDRESS } from './state.js';
import { MAX_WIRE_BYTES } from './settings.js';
import { parseJSON } from './json.js';
import { jsonBytes } from './signing.js';

export default class MatterProtocol extends Protocol {
  msgMaxBytes() { return MAX_WIRE_BYTES; }
  txMaxBytes() { return MAX_WIRE_BYTES; }
  async withView(fn) {
    const view = this.base.view.checkout(this.base.view.version);
    try { return await fn(new StateTransition(async key => (await view.get(key))?.value ?? null, this.config.dmw)); }
    finally { await view.close(); }
  }
  async extendApi() {
    this.api.dmwHead = () => this.withView(s => s.head());
    this.api.dmwHashAt = height => this.withView(s => Number.isSafeInteger(height) && height >= 0 ? s.beacon().hashAt(height) : null);
    this.api.dmwBatchLast = () => this.withView(s => s.batchLast());
    this.api.dmwBatchRoot = n => this.withView(s => Number.isSafeInteger(n) && n > 0 ? s.get(`bt/${n}`) : null);
    this.api.dmwBalance = (owner, asset) => this.withView(async s => s.balance(typeof owner === 'string' ? await s.agent(owner) : owner, asset));
    this.api.dmwMint = id => this.withView(s => s.mint(id));
    this.api.dmwLock = id => this.withView(s => typeof id === 'string' && ADDRESS.test(id) ? s.get(`l/${id}`) : null);
    this.api.dmwSettings = () => this.withView(s => s.settings());
    this.api.dmwPendingAdmin = () => this.withView(s => s.pending());
    this.api.dmwAgentNumber = address => this.withView(s => s.agent(address));
    this.api.dmwAgentAddress = number => this.withView(s => s.address(number));
    this.api.dmwRecord = key => this.withView(s => typeof key === 'string' && /^[a-z0-9/._-]{1,64}$/.test(key) ? s.get(`n/${key}`) : null);
    this.api.dmwAuthority = () => this.withView(async s => ({ network: s.options.network, admin: await s.admin(),
      committee: await s.committee(), epoch: await s.committeeEpoch(), paused: await s.paused(), pauseUntil: (await s.get('ad/pause'))?.until ?? null }));
  }
  mapTxCommand(command) {
    const packet = parseJSON(command, MAX_WIRE_BYTES);
    if (!exactKeys(packet, ['network', 'op', 'value']) || packet.network !== this.config.dmw.network || !FUNCTIONS.includes(packet.op)) return null;
    try { if (jsonBytes(packet) > MAX_WIRE_BYTES) return null; } catch { return null; }
    return { type: packet.op, value: packet.value };
  }
}
