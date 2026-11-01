import { capacityPlotKey, mintPlotKey } from '../../rules/src/per-ticker-supply-activation.js';
import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { NodeEvidence } from './node-evidence.mjs';
import { readPublicWinners } from '../../committee/signer/public-claims.mjs';

export const readPublicWinnerBatch = ({ store, reads, at }, pairs) => readPublicWinners(reads, pairs, at, store?.hasOverlay ? store : undefined);

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
