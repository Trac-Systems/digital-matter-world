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
