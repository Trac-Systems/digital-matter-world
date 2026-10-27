import { readFile } from 'node:fs/promises';
import { rules } from '../src/rules.mjs';
// Explicit local integration fixture: each signer loads its own configured file
// and rebuilds the rules result. This is not a production chain read adapter.
export async function createReads({ file, headers }) {
  return {
    async authority() { return JSON.parse(await readFile(file, 'utf8')).authority; },
    async batchContext(sequence) {
      const context = JSON.parse(await readFile(file, 'utf8'));
      if (context.last.n + 1 !== sequence) throw Error('batch_sequence');
      const history = new rules.HeaderHistory(await readFile(headers));
      return { ...context, history, hashAt: h => h < history.length ? history.get(h).hash : null };
    }
  };
}
