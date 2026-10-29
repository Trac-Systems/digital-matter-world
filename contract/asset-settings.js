// R4-owned consensus settings, to be included in R1's activation manifest.
// Defaults never activate a new consensus path on a legacy deployment.
export const ASSET_V2_DEFAULTS = Object.freeze({
  version: 2, accountLeaves: 4096, proofNodes: 65536, proofBytes: 98304,
  paymentPage: 32, actions: 512, recoveryHeaders: 20,
  lockMin: 6, lockMax: 2016,
});
export function assetSettings(value = {}) {
  const result = { ...ASSET_V2_DEFAULTS, ...value };
  if (result.version !== 2 || Object.keys(result).some(k => !Object.hasOwn(ASSET_V2_DEFAULTS, k) && !['publicMintActivationHeight', 'publicMintPageSize', 'claimsNeverCloseHeight'].includes(k))) throw Error('asset_settings');
  if (Object.hasOwn(result, 'publicMintActivationHeight') !== Object.hasOwn(result, 'publicMintPageSize')) throw Error('asset_settings');
  for (const [k, n] of Object.entries(result)) if (['publicMintActivationHeight', 'claimsNeverCloseHeight'].includes(k) ? typeof n !== 'string' || !/^(0|[1-9][0-9]*)$/.test(n) : !Number.isSafeInteger(n) || n < 1) throw Error('asset_settings');
  if (result.claimsNeverCloseHeight !== undefined && (result.publicMintActivationHeight === undefined || BigInt(result.claimsNeverCloseHeight) < BigInt(result.publicMintActivationHeight))) throw Error('asset_settings');
  if (result.lockMin > result.lockMax) throw Error('asset_settings');
  return result;
}
