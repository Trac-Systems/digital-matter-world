export const ADMIN_DELAY = 432;
export const PAUSE_MAX = 144;
export const PAUSE_COOLDOWN = 144;
export const MAX_ASSETS = 16;
export const MAX_AMOUNT_DIGITS = 78;
export const MAX_WIRE_BYTES = 131072;
export const MAX_BATCH_HORIZON = 36;
export const SETTING_BOUNDS = Object.freeze({
  batch_bytes: Object.freeze([1024, 120000]),
  batch_ops: Object.freeze([1, 512]),
  batch_assets: Object.freeze([1, 8192]),
  batch_kv: Object.freeze([0, 64]),
  pending_blocks: Object.freeze([6, 2016]),
  lock_min: Object.freeze([1, 144]),
  lock_max: Object.freeze([144, 52560])
});
export const DEFAULT_SETTINGS = Object.freeze({ batch_bytes: 98304, batch_ops: 512, batch_assets: 4096,
  batch_kv: 16, pending_blocks: 432, lock_min: 6, lock_max: 2016 });
export function validSetting(key, value) {
  const bounds = Object.hasOwn(SETTING_BOUNDS, key) && SETTING_BOUNDS[key];
  return !!bounds && Number.isSafeInteger(value) && value >= bounds[0] && value <= bounds[1];
}
