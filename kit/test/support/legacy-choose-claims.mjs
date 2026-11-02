// Frozen HF1 oracle from 4fddd8b3c2ce44429974f4446b5abecdbe6ad38e.
import { patternAmount, CLAIM_DEFAULTS, MAX_CLAIMS_PER_WINDOW } from "../../../rules/src/index.js";
import { readInteger } from "../../lib/api-values.mjs";
const compareCount = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

export function legacyChooseClaims({ history, patterns = [], taken = {}, claimsPerWindow = CLAIM_DEFAULTS.claimsPerWindow, claimableHeight = history.length - 1, window = claimableHeight }) {
  const budget = Math.min(MAX_CLAIMS_PER_WINDOW, Math.max(0, claimsPerWindow)), plots = new Map();
  let selected = 0;
  for (const pattern of [...patterns].sort((a, b) => {
    const x = a.knownMatchCount ?? a.rarity, y = b.knownMatchCount ?? b.rarity;
    return (x == null ? y == null ? 0 : 1 : y == null ? -1 : compareCount(x, y)) || compareCount(a.number, b.number);
  })) {
    const excluded = taken[pattern.number] ?? new Set();
    for (let block = 0; block < history.length && selected < budget; block++) {
      if (block > claimableHeight && block !== window || excluded.has(block)) continue;
      if (patternAmount(pattern, history.get(block)) === '0') continue;
      const row = plots.get(block) ?? { block, patterns: [] };
      row.patterns.push(readInteger(pattern.number)); plots.set(block, row); selected++;
    }
    if (selected >= budget) break;
  }
  return [...plots.values()].sort((a, b) => a.block - b.block).map(row => ({ ...row, patterns: row.patterns.sort((a, b) => a - b) }));
}
