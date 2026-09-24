/**
 * Bundled CSV content for production/static builds (AH-0MTZWZ9TE009CVUA).
 *
 * Kept in a separate module and imported dynamically by `configStore.ts`
 * so the Vite config loader (which imports the plugin → CSV codec →
 * `enemyConfig` → `configStore`) never has to resolve the `?raw` imports.
 * Vite resolves them during the application build instead.
 */

import bundledEnemyCsv from '../data/enemy-configs.csv?raw';
import bundledShipCsv from '../data/ship-config.csv?raw';

export { bundledEnemyCsv, bundledShipCsv };
