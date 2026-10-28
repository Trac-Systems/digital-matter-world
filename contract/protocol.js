import { Protocol } from 'trac-peer';
import { StateTransition, FUNCTIONS, exactKeys, ADDRESS } from './state.js';
import { MAX_WIRE_BYTES } from './settings.js';
import { parseJSON } from './json.js';
import { jsonBytes } from './signing.js';
import { hashObject } from '../rules/src/core.js';

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
    this.api.dmwHashAt = height => this.withView(s => s.clock.valid(height) ? s.beacon().hashAt(height) : null);
    this.api.dmwBatchLast = () => this.withView(s => s.batchLast());
    this.api.dmwReceiptRenewalSlice = n => this.withView(s => s.clock.valid(n) && BigInt(n) > 0n ? s.get('v2/receipt-renewal-slice/' + n) : null);
    this.api.dmwBatchRoot = n => this.withView(s => s.clock.valid(n) && BigInt(n) > 0n ? s.get(`bt/${n}`) : null);
    this.api.dmwBalance = (owner, asset, proof) => this.withView(async s => s.balance((await s.get('s/assets'))?.version === 2 ? owner : typeof owner === 'string' ? await s.agent(owner) : owner, asset, proof));
    this.api.dmwAccountRoot = owner => this.withView(async s => s.get('ar/' + owner));
    this.api.dmwFinancialRecord = key => this.withView(s => typeof key === 'string' && /^(fc|fp|bc|dc)\/[0-9a-f]{64}$/.test(key) ? s.get(key) : null);
    this.api.dmwRulesContext = () => this.withView(async s => {
      const manifest = await s.get('v2/manifest');
      if (!manifest) return { ruleset: 'dmw-v1' };
      return { ruleset: 'dmw-v2', ready: !!await s.get('v2/ready'), manifestHash: await s.get('v2/ready'), settingsHash: hashObject(await s.get('v2/settings')), manifest, settings: await s.get('v2/settings'), scheduledSettings: await s.get('v2/settings-next'),
        last: await s.batchLast(), catalogRoot: await s.get('v2/catalog'), accountsRoot: await s.get('v2/accounts'), claimsRoot: await s.get('v2/claims'), receiptRenewal: await s.get('v2/receipt-renewal') ?? null,
        receiptProtocol: await s.get('v2/receipt-protocol') ?? null };
    });
    this.api.dmwSettingsByHash = hash => this.withView(async s => {
      return typeof hash === 'string' && ADDRESS.test(hash) ? s.get('v2/settings/' + hash) : null;
    });
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
