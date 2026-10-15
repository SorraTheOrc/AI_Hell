/**
 * Bundled design data for production/static builds.
 *
 * Kept in a separate module and imported dynamically by `configStore.ts`
 * so the Vite config loader (which imports the plugin → CSV codec →
 * `enemyConfig` → `configStore`) never has to resolve the `?raw` imports.
 * Vite resolves them during the application build instead.
 *
 * The CSV files ship the enemy/ship/difficulty configs (AH-0MTZWZ9TE009CVUA).
 * `bot-tuning.json` ships the Git-tracked bot-tuning baseline so every build —
 * including one checked out or served on another machine — flies the tuned
 * Bot definitions instead of the built-in factory defaults
 * (AH-0MV9GZD2C005IIU3).
 */

import bundledEnemyCsv from '../data/enemy-configs.csv?raw';
import bundledShipCsv from '../data/ship-config.csv?raw';
import bundledDifficultyCurvesCsv from '../data/difficulty-curves.csv?raw';
import bundledBotTuningJson from '../data/bot-tuning.json?raw';

export {
  bundledEnemyCsv,
  bundledShipCsv,
  bundledDifficultyCurvesCsv,
  bundledBotTuningJson,
};
