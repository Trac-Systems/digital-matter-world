import { Contract } from 'trac-peer';
import { StateTransition, FUNCTIONS } from './state.js';

export default class MatterContract extends Contract {
  constructor(protocol, config) {
    super(protocol, config);
    for (const type of FUNCTIONS) {
      this.addFunction(type);
      this[type] = async () => {
        const state = this.transition();
        return this.finish(state, await state.transaction(type, this.value, this.address));
      };
    }
    this.messageHandler(async () => {
      const state = this.transition();
      return this.finish(state, await state.message(this.op.msg, this.address));
    });
  }
  transition() { return new StateTransition(key => this.get(key), this.config.dmw); }
  async finish(state, error) {
    if (error) return new Error(error);
    for (const [key, value] of state.writes) {
      if (value === undefined) await this.del(key); else await this.put(key, value);
    }
    return null;
  }
}
