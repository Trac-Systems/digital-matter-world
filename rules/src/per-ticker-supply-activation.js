// Live from this execution height (owner rule: every ticker mints the full supply).
import { decimalV2 } from './integers-v2.js';
export const PER_TICKER_SUPPLY_HEIGHT = '974074';
export const perTickerSupplyActive = height => BigInt(decimalV2(height)) >= BigInt(PER_TICKER_SUPPLY_HEIGHT);
// Callers resolve the selected deployment independently. Official deployments
// deliberately retain their historic keys, including imported plot markers.
export const tickerSupplyScope = (deployment, height) => perTickerSupplyActive(height) &&
  (deployment?.officialDeployment || deployment?.official) ? deployment.id ?? deployment.deployment : null;
export const mintPlotKey = (asset, block, scope = null) => `${asset}/${block}${scope ? '/' + scope : ''}`;
export const capacityPlotKey = (asset, block, scope = null) => 'dc/plot/' + mintPlotKey(asset, block, scope);
export const compoundSupplyCapped = (deployment, height) => !!tickerSupplyScope(deployment, height) &&
  /^(?:c[0-9a-z]{1,23}|c2:[0-9a-f]{64})$/.test(deployment.asset);
// A compound snapshot also pins the hold rule at admission. Old reservations
// without that authenticated cap keep burning even if consumed after activation.
export const mintRetainsUnits = capacity => !!capacity?.supplyScope &&
  (capacity.plot !== null || typeof capacity.supplyIssued === 'string');
