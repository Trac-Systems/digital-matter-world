import { readFile } from 'node:fs/promises';
import { HeaderHistory, verifyHistory } from '../src/headers.js';
export async function loadHeaders(path, { verify = true } = {}) {
  const history = new HeaderHistory(await readFile(path));
  if (verify) verifyHistory(history);
  return history;
}
