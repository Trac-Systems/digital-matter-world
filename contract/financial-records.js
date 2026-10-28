// The complete native financial inventory includes auxiliary reservation,
// migration and plot identities as well as the main account/obligation rows.
export const FINANCIAL_PREFIXES = Object.freeze(['al/', 'ao/', 'ar/', 'bc/', 'dc/', 'fc/', 'fd/', 'fi/', 'fl/', 'fm/', 'fp/', 'k/link/']);
export const financialRecoveryKey = key => typeof key === 'string' && /^(?:(?:al|ao|ar|bc|dc|fc|fd|fi|fl|fm|fp)\/[a-z0-9:._/-]+|k\/link\/[0-9a-z]+)$/.test(key);
