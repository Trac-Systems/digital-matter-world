import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { splitFee, feeFor } from '../../../rules/src/fees.js';
import { feePrice } from '../js/money.js';
import { formatTap } from '../js/amount-format.js';
import { MINT_DEFAULTS } from '../../../rules/src/mint-rights.js';
import { PATTERN_LIMITS, TIER_THRESHOLDS, tierFor } from '../../../rules/src/patterns.js';
import { compound as makeCompound } from '../../../rules/src/compounds.js';

const markdown = await readFile(new URL('../content/about.md', import.meta.url), 'utf8');
const numbers = text => [...text.matchAll(/\b\d[\d,]*\b/g)].map(m => Number(m[0].replaceAll(',', '')));

test('live displayed prices match feeFor for every tier and operator setting', () => {
  const policies = [
    { baseFee: '22600000000000000000', feeSettings: { tierMultipliers: [1, 3, 10, 30, 100], compoundMinimum: 1, link: 1 } },
    { baseFee: '1234567890123456789', feeSettings: { tierMultipliers: [2, 4, 7, 11, 17], compoundMinimum: 9, link: 6 } },
    { baseFee: '90071992547409931234567890', feeSettings: { tierMultipliers: [8, 2, 5, 3, 9], compoundMinimum: 1, link: 4 } },
  ];
  for (const policy of policies) {
    policy.unit = { currency: 'TAP', denomination: 'atomic', decimals: 18 };
    const compounds = [];
    for (const kind of ['find', 'compound', 'link']) for (let tier = 1; tier <= 5; tier++) {
      const atoms = feeFor(kind, policy.baseFee, tier, policy.feeSettings);
      assert.equal(feePrice(policy, kind, tier), formatTap(atoms, policy.unit.decimals));
      if (kind === 'compound') compounds.push(BigInt(atoms));
    }
    const minimum = compounds.reduce((a, b) => a < b ? a : b);
    assert.equal(feePrice(policy, 'compound-minimum'), formatTap(minimum.toString(), policy.unit.decimals));
  }
  assert.equal(feePrice(policies[0], 'find', 2), '67.8 TAP');
  assert.equal(feePrice(policies[0], 'compound-minimum'), '22.6 TAP');
  assert.equal(feePrice(policies[0], 'link'), '22.6 TAP');
  for (const policy of [null, {}, { baseFee: '1' }, { ...policies[0], baseFee: '22.6' },
    { ...policies[0], feeSettings: { ...policies[0].feeSettings, link: undefined } }]) {
    for (const kind of ['find', 'compound', 'compound-minimum', 'link']) assert.equal(feePrice(policy, kind), 'current price');
  }
});

test('every rules number in About agrees with the rules library', () => {
  const covered = [];
  function read(re, count = 1) {
    const matches = [...markdown.matchAll(new RegExp(re.source, 'g'))];
    assert.equal(matches.length, count, `Missing or repeated About statement: ${re}`);
    for (const match of matches) covered.push([match.index, match.index + match[0].length]);
    return matches.map(m => numbers(m[0]));
  }
  function check(re, expected, count = 1) {
    for (const actual of read(re, count)) assert.deepEqual(actual, expected, `About disagrees with the rules: ${re}`);
  }
  const tiers = [tierFor(Number.MAX_SAFE_INTEGER), tierFor(0)];
  check(/\| Make a found pattern real \|[^\n]+/, [1, 2, 3, 4, 5, ...tiers]);
  check(/\| Make a compound real \|[^\n]+/, []);
  check(/\| Link a Bitmap \|[^\n]+/, []);
  check(/\| Bitmap link \| The Bitmap holder \|[^\n]+/, []);
  check(/from \d+ \(common\) to \d+ \(rarest\)/, tiers);
  check(/must match at least \d+ blocks in history/, [PATTERN_LIMITS.minMatchingBlocks]);
  check(/First [\d,]+ blocks \(about a week\) after the find/, [MINT_DEFAULTS.finderWindow]);

  const share = re => {
    const [values] = read(re);
    assert.equal(values.length, 1);
    return values[0];
  };
  const finder = share(/\| \d+ % \| The finder of that block \|/);
  const landowner = share(/\| \d+ % \| The linked Bitmap's holder[^\n]+/);
  const discoverer = share(/\| \d+ % \| The pattern's discoverer \|/);
  const burn = share(/\| \d+ % \| Burned \|/);
  const [compound] = read(/\| Making a compound real \|[^\n]+/);
  const [link] = read(/\| Bitmap link \| – \|[^\n]+/);
  assert.equal(compound.length, 3);
  assert.equal(link.length, 2);

  // Text supplies the expected shares. Exercise all flags for every fee kind,
  // including unclaimed finds and the absent-recipient treasury/burn rules.
  // Charters are gone from the game (no opening schedule); the text must not mention them.
  assert.doesNotMatch(markdown, /charter/i);
  for (const kind of ['find', 'compound', 'link']) {
    for (const linked of [false, true]) {
      for (const discovered of [false, true]) for (const found of [true]) {
        const flags = { kind, linked, discovered, found };
        const expected = { firstMaker: 0, finder: 0, landowner: 0, burn: 0, treasury: 0, discoverer: 0 };
        if (kind === 'find') {
          Object.assign(expected, { finder: found ? finder : 0, landowner: linked ? landowner : 0,
            discoverer: discovered ? discoverer : 0,
            burn: burn + (linked ? 0 : landowner) + (found ? 0 : finder) });
          expected.treasury = 100 - Object.values(expected).reduce((a, b) => a + b, 0);
        } else if (kind === 'compound') {
          [expected.firstMaker, expected.burn, expected.treasury] = compound;
        } else [expected.burn, expected.treasury] = link;
        assert.deepEqual(splitFee('100', flags), Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, String(v)])),
          `About fee split disagrees with splitFee: ${JSON.stringify(flags)}`);
        assert.equal(Object.values(expected).reduce((a, b) => a + b, 0), 100);
      }
    }
  }

  // Each repeated percentage is checked independently, including prose and the
  // recipient summary; matching the first table alone would miss later drift.
  check(/earn \d+ % of every mint from it/, [landowner]);
  check(/earns \d+ % of every mint of that pattern/, [discoverer]);
  check(/together with the \d+ % royalty/, [discoverer]);
  check(/\| Finder \|[^\n]+/, [finder]);
  check(/\| Discoverer \|[^\n]+/, [discoverer]);
  check(/\| First maker \| \d+ %[^\n]+/, [compound[0]]);
  check(/\| Bitmap holder \|[^\n]+/, [landowner]);

  // Tier table: each row's block bound is the last count that still earns that tier.
  for (const tier of [5, 4, 3, 2]) {
    const bound = TIER_THRESHOLDS[5 - tier];
    assert.equal(tierFor(bound), tier); assert.equal(tierFor(bound + 1), tier - 1);
    check(new RegExp(`\\| ${tier}( \\(rarest\\))? \\| up to [\\d,]+ blocks \\|[^\\n]+`), [tier, bound, tier]);
  }
  check(/\| 1 \(common\) \| more than [\d,]+ blocks \|[^\n]+/, [1, TIER_THRESHOLDS[3], 1]);
  assert.equal(tierFor(TIER_THRESHOLDS[3] + 1), 1);
  const dummy = n => Array.from({ length: n }, (_, i) => ({ asset: `p${i}`, amount: '1' }));
  for (const n of [1, 9]) assert.throws(() => makeCompound('fusion', dummy(n), 1), /recipe/);
  for (const n of [2, 8]) assert.throws(() => makeCompound('fusion', dummy(n), 1), e => !/recipe/.test(e.message));
  check(/Combining \d+ to \d+ different kinds of units/, [2, 8]);

  // Written-out rule quantities also have a check where the library defines them.
  assert.match(markdown, /is open from day one/);
  assert.doesNotMatch(markdown, /opened block|three older/);
  assert.match(markdown, /one week of exclusive mint rights/);
  assert.equal(MINT_DEFAULTS.finderWindow, 7 * 24 * 6, 'About describes the window as about one week');

  // These numbers are not rules constants: historical context, an example,
  // section labels, and deployment committee size/quorum. Account for each
  // explicitly so a new or changed number cannot silently escape this audit.
  check(/since block \d+/, [0]);
  check(/all the way back to block \d+/, [0]);
  check(/from block \d+ to the newest one/, [0]);
  check(/\d+ to \d+ agents at a time/, [500, 600]);
  check(/More than [\d,]+ blocks so far/, [970000]);
  check(/Units are fungible: \d+ units of a pattern/, [5]);
  check(/if it appears \d+ times, you need \d+ units/, [3, 3]);
  check(/\d+ units out on Trac, \d+ tokens in on Bitcoin/, [3, 3]);
  check(/Five committee signers[^\n]+?\d+ matching counts accept it/, [3]);
  check(/signed off by \d+ of \d+ committee signers/, [3, 5]);
  assert.deepEqual(read(/### \d+\./, 7).flat(), [1, 2, 3, 4, 5, 6, 7]);
  const unchecked = [...markdown.matchAll(/\b\d[\d,]*\b/g)].filter(m => !covered.some(([start, end]) => m.index >= start && m.index < end));
  assert.deepEqual(unchecked.map(m => ({ number: m[0], line: markdown.slice(0, m.index).split('\n').length })), [],
    'Every numeric literal must have a rules comparison or an explicit non-rule explanation');
});
