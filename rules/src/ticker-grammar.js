// ord-tap FullTicker grammar (tap/mod.rs and tap/ops/dmt_deploy.rs), with no
// dependencies so the site loads the same check the gateway uses.
// This is the inscription's bare tick, not the indexed "dmt-" name. Do not
// trim, restrict to ASCII, or normalize Unicode: those change TAP identity.
export function validateChosenTicker(tick) {
  const fail = () => { throw new Error('ticker_invalid'); };
  if (typeof tick !== 'string' || !tick.isWellFormed()) fail();
  const normalized = tick.toLowerCase();
  if (normalized.startsWith('-') || normalized.startsWith('dmt-')) fail();
  let length = 0;
  for (const _ of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(tick)) if (++length > 32) fail();
  if (!length) fail();
  return normalized;
}

// A compound's official ticker, chosen by its first maker. Signers rebuild official
// deployment mint permits with the original grammar (tap.js ticker()), so the
// choice must pass both. Additional tickers keep the full grammar above.
export function validateOfficialTicker(tick) {
  const normalized = validateChosenTicker(tick);
  if (!/^[a-z0-9]{3,32}$/.test(normalized)) throw new Error('ticker_official_grammar');
  return normalized;
}
// What the first maker's agent or bound TAP Wallet signs to choose that ticker.
// revision is the current choice's revision plus one, so an older choice cannot be replayed.
export function compoundTickerMessage({ network, asset, ticker, revision, expiry, firstMaker }) {
  if (typeof network !== 'string' || !/^c(?:2:[0-9a-f]{64}|[0-9a-z]{1,23})$/.test(asset ?? '') || typeof ticker !== 'string' ||
    !Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(expiry) || expiry < 1 || expiry > 8.64e15 || !/^trac1[a-z0-9]+$/.test(firstMaker ?? ''))
    throw new Error('ticker_choice_request');
  return ['Digital Matter World: choose the official TAP ticker of a compound', 'version: dmw-compound-ticker-v1',
    'network: ' + network, 'compound: ' + asset, 'ticker: ' + ticker, 'revision: ' + revision, 'first maker: ' + firstMaker,
    'valid until: ' + new Date(expiry).toISOString()].join('\n');
}
