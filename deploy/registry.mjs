import { privateJSON } from './target.mjs';
import { readRegistry } from '../service/src/registry.mjs';
export { registryPages } from '../service/src/registry.mjs';
// Preserve deployment's private-file checks. After migration this read is just
// the bounded marker; asset and revision checks use indexed pages.
export async function privateRegistry(path) {
  const legacy = await privateJSON(path);
  return legacy.version === 2 ? readRegistry(path) : legacy;
}
