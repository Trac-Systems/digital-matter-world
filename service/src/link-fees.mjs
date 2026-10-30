import { rules } from './rules.mjs';
import { check } from './util.mjs';

// The height on an execution view takes precedence over the snapshot's count.
// Settings are fetched by the signed terms hash, never from a current default.
export async function linkFeePolicy(reads, terms, at) {
  const executionHeight = at?.executionHeight ?? at?.height ?? at?.counted ?? await reads.counted();
  if (!rules.multiTickerActive(executionHeight)) return { executionHeight };
  check(rules.hex(terms.settingsHash, 32), 'link_settings');
  const document = await (reads.financialSettings ? reads.financialSettings(terms.settingsHash) : reads.settingsByHash?.(terms.settingsHash));
  check(document && rules.hashObject(document) === terms.settingsHash, 'link_settings');
  rules.validateSettingsDocument(document);
  return { executionHeight, document };
}
export async function linkFeePlan(reads, terms, at) {
  const policy = await linkFeePolicy(reads, terms, at), price = rules.feeFor('link', terms.baseFee, 1, terms.feeSettings);
  return { ...policy, price, split: rules.linkPaymentSplit(price, policy.document, policy.executionHeight) };
}
