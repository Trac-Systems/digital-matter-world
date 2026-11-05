// Admission lookahead is a local capacity setting, not a receipt wire change.
export function receiptAdmissionSettings({ futureBatches = 1, ...unknown } = {}) {
  if (Object.keys(unknown).length || !Number.isSafeInteger(futureBatches) || futureBatches < 0 || futureBatches > 1)
    throw Error('receipt_admission_setting');
  return { futureBatches };
}
