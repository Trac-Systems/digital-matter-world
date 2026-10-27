// Offline simulation fixtures are evaluated discoveries, never a launch catalog.
import { evaluateDiscovery, hash } from '../src/index.js';
export function discoverFixture(history, discoverer = hash('offline-fixture-discoverer')) {
  const patterns = [];
  for (const fld of [4, 10, 11]) for (let digit = 0; digit < 10; digit++) {
    const proposal = { name: `dmwfixture${fld}digit${digit}`, pat: `${digit}$`, fld, dt: 'n' };
    try {
      const { record } = evaluateDiscovery({ proposal, discoverer, history, existing: patterns, number: patterns.length });
      patterns.push(record);
    } catch (error) {
      if (!['pattern_constant', 'pattern_too_rare', 'pattern_duplicate'].includes(error.message)) throw error;
    }
  }
  return patterns;
}
