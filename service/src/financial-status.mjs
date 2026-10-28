// Public payment plans must honor the same accepted recovery fences as
// execution. The local flag also covers staging before the inventory opens.
export function financialBlock(store, keys) {
  if (store.get('meta', 'financialRecoveryActive') || store.get('accountRecords', 'fr/active')) return 'financial_recovery_active';
  return keys.some(key => store.get('accountRecords', 'fq/' + key)) ? 'financial_quarantined' : null;
}
