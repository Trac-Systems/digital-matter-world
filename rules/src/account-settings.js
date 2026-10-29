import { validateSettingsDocument } from './settings-v2.js';
export function accountSettings(document) {
  const v = validateSettingsDocument(document).values;
  return { version: 2, accountLeaves: v.accountLeaves, proofNodes: v.accountProofNodes, proofBytes: v.accountProofBytes,
    paymentPage: v.paymentPage, actions: v.accountActions, recoveryHeaders: v.recoveryHeaders, lockMin: v.lockMinBlocks, lockMax: v.lockMaxBlocks,
    ...(v.publicMintActivationHeight === undefined ? {} : { publicMintActivationHeight: v.publicMintActivationHeight, publicMintPageSize: v.publicMintPageSize }),
    ...(v.claimsNeverCloseHeight === undefined ? {} : { claimsNeverCloseHeight: v.claimsNeverCloseHeight }),
    ...(v.bitmapMintOpenHeight === undefined ? {} : { bitmapMintOpenHeight: v.bitmapMintOpenHeight }) };
}
