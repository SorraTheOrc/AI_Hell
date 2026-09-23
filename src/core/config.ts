/**
 * Ship configuration module (GDD §2.2 Newtonian movement model).
 *
 * Types and defaults live in the leaf modules `configTypes.ts` /
 * `configDefaults.ts`; the CSV-backed config store (`configStore.ts`) is the
 * persistence layer. The loaders below delegate to the store, so callers keep
 * their synchronous signatures while the data comes from
 * `src/data/ship-config.csv` (loaded at boot). No localStorage is used.
 */

import {
  loadShipConfig as storeLoadShipConfig,
  saveShipConfig as storeSaveShipConfig,
  type SaveResult,
} from './configStore';
import type { ShipConfig } from './configTypes';

export type { ControlScheme, ShipConfig } from './configTypes';
export { DEFAULT_CONFIG } from './configDefaults';

/**
 * Loads the ship config from the CSV-backed registry, or the defaults when
 * the boot loader has not run.
 */
export function loadShipConfig(): ShipConfig {
  return storeLoadShipConfig();
}

/**
 * Persists the supplied values through the dev-server CSV plugin and
 * refreshes the registry. Returns a status object; writes are unavailable in
 * production builds.
 */
export function saveShipConfig(values: ShipConfig): Promise<SaveResult> {
  return storeSaveShipConfig(values);
}

export type { SaveResult };
