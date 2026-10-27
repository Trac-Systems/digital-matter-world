import { pathToFileURL } from 'node:url';
import { loadTarget } from './target.mjs';
export { productionLaunch } from './production-launch.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--execute')) {
    if (args.length !== 3 || args[0] !== '--execute' || args[1] !== '--target') throw Error('Usage: node deploy/launch.mjs --execute --target PRIVATE_TARGET');
    const { productionLaunch } = await import('./production-launch.mjs');
    await productionLaunch(await loadTarget(args[2]));
  } else throw Error('Use --execute --target PRIVATE_TARGET for owner launch, or deploy/launch-inscriptions.mjs for offline inscription texts. See deploy/REHEARSAL.md for pay-first tests.');
}
