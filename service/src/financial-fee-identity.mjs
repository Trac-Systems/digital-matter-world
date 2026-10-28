import { rules } from './rules.mjs';
import { check } from './util.mjs';

// New obligations can reuse an identically denominated fee credit. Legacy
// keys remain unchanged, and canonical receipt verification still binds dta
// to the original request before any allocation or credit is accepted.
export function identifyFinancialFees(fees, { network, rail, bitcoinNetwork, escrow, custody = [] }) {
  check(rail === 'tap' || rail === 'ethereum' && escrow?.chainId && escrow.token, 'financial_fee_domain');
  const domain = rail === 'tap' ? ['tap', bitcoinNetwork, 'tap'] : ['ethereum', escrow.chainId, escrow.token.toLowerCase()];
  return fees.map(f => ({ ...f, financialIdentity: { version: 3, network, domain, role: f.role,
    to: f.to, ticker: f.ticker, tt: f.tt, beneficiary: custody.find(c => c.role === f.role)?.owner ?? null } }));
}

export function financialFeeKey(f) {
  if (!f.financialIdentity) return rules.hashObject(['dmw-financial-fee-v2', f.role, f.to, f.ticker, f.tt, f.dta]);
  const i = f.financialIdentity;
  check(i.version === 3 && i.role === f.role && i.to === f.to && i.ticker === f.ticker && i.tt === f.tt &&
    typeof i.network === 'string' && Array.isArray(i.domain) && i.domain.length === 3 &&
    (i.beneficiary === null || rules.hex(i.beneficiary, 32)), 'financial_fee_identity');
  return rules.hashObject(['dmw-financial-fee-v3', i]);
}
