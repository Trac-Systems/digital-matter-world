import { capacityPlotKey, mintPlotKey } from '../../rules/src/per-ticker-supply-activation.js';
import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { NodeEvidence } from './node-evidence.mjs';
import { readPublicWinners } from '../../committee/signer/public-claims.mjs';

export const readPublicWinnerBatch = ({ store, reads, at }, pairs) => readPublicWinners(reads, pairs, at, store?.hasOverlay ? store : undefined);

// A round closure asks for one plot at a time while it walks a pattern's claims
// in block order. One point-read page costs about the same for 1 or 64 keys, so
// fill each page with the pattern's next claimed blocks from the local claim
// index and keep the answers for this draft. Answers come from the same reads at
// the same clock; only failed or unrequested rows are left out of the cache.
export function prefetchingWinnerBatch({ store, reads, at, claims, page = 64 }) {
  const answers = new Map(), key = pair => pair.join('/');
  return async pairs => {
    const missing = pairs.filter(pair => !answers.has(key(pair)));
    if (missing.length) {
      const ask = [...missing], seen = new Set(missing.map(key)), [asset, block] = missing[0];
      if (claims && missing.every(pair => pair.length === 2) && typeof asset === 'string' && asset.startsWith('p2:') && rules.decimalV2(block)) {
        for (const { value } of claims.list('claimed2/' + asset, { after: rules.uintKeyV2(rules.decimalV2(block)), limit: page })) {
          if (ask.length >= page) break;
          const next = [asset, String(value?.height ?? '')];
          if (/^(0|[1-9][0-9]*)$/.test(next[1]) && !seen.has(key(next)) && !answers.has(key(next))) { seen.add(key(next)); ask.push(next); }
        }
      }
      const rows = await readPublicWinnerBatch({ store, reads, at }, ask);
      ask.forEach((pair, i) => { if (rows[i] && !rows[i].error) answers.set(key(pair), rows[i]); });
      const demanded = new Map(missing.map(pair => [key(pair), rows[ask.indexOf(pair)]]));
      return pairs.map(pair => answers.get(key(pair)) ?? demanded.get(key(pair)));
    }
    return pairs.map(pair => answers.get(key(pair)));
  };
}

// Predecessor point reads are independently checked by signers. Earlier
// observations in this draft may already have written the same financial keys.
export async function readPublicWinner({ store, reads, at }, asset, block, deployment = null) {
  check(typeof reads.financialRecord === 'function', 'public_mint_evidence_missing');
  const read = key => store.hasOverlay?.('accountRecords', key)
    ? store.get('accountRecords', key) : reads.financialRecord(key, at);
  const id = await read(capacityPlotKey(asset, block, deployment));
  if (id === null || id === undefined) return null;
  check(rules.hex(id, 32), 'public_mint_evidence');
  const funding = await read('fp/' + id);
  check(funding, 'public_mint_evidence_missing');
  return funding.publicMint === true && funding.owner === null ? id : null;
}

export function publicClaimReaders({ input, store, claimNodes, publicMintRead }) {
  const document = input.settings.document;
  const claims = new NodeEvidence(document.values.auditTotalBytes, input.claimEvidence);
  const named = new NodeEvidence(document.values.proofBytes, input.namedEvidence);
  const winners = new Map((input.publicMintEvidence ?? []).map(row => [mintPlotKey(row.asset, row.block, row.deployment), row.id]));
  const readers = {
    claimNodeGet(id) { const row = claimNodes.get(id) ?? store.get('claimNodes', id); claims.add(id, row); return row; },
    namedNodeGet(id) { const row = store.get('namedNodes', id); named.add(id, row); return row; },
    publicMintGet(asset, block, deployment = null) {
      const key = mintPlotKey(asset, block, deployment);
      check(winners.has(key), 'public_mint_evidence_missing'); return winners.get(key);
    }
  };
  return { readers,
    async prepare(asset, block, deployment = null) {
      const key = mintPlotKey(asset, block, deployment);
      if (!winners.has(key)) winners.set(key, await publicMintRead(asset, block, deployment));
    },
    collect() {
      input.claimEvidence = claims.value();
      input.namedEvidence = { ...input.namedEvidence, ...named.value() };
    }
  };
}
