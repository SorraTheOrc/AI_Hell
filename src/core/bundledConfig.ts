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
 *
 * `weapons.csv` + `weapon-patterns.csv` ship the player-weapon catalogue
 * (AH-0MW0Q1EYJ007RRFI): `src/utils/weapons.ts` parses them at module load, so
 * the bundled CSV is the runtime source of truth and the TypeScript catalogue
 * is only the fallback.
 *
 * `weapon-levels.json` ships the authored per-weapon Euclidean fire-cadence
 * ladders (AH-0MW0Q1TQV009M8AO). It is nested per weapon per rung, so it is
 * JSON rather than CSV; `src/utils/weaponLevels.ts` parses it at module load
 * and falls back to the in-code ladders for a weapon whose entry is missing or
 * malformed.
 */

import bundledEnemyCsv from '../data/enemy-configs.csv?raw';
import bundledShipCsv from '../data/ship-config.csv?raw';
import bundledDifficultyCurvesCsv from '../data/difficulty-curves.csv?raw';
import bundledBotTuningJson from '../data/bot-tuning.json?raw';
import bundledWeaponsCsv from '../data/weapons.csv?raw';
import bundledWeaponPatternsCsv from '../data/weapon-patterns.csv?raw';
import bundledWeaponLevelsJson from '../data/weapon-levels.json?raw';

export {
  bundledEnemyCsv,
  bundledShipCsv,
  bundledDifficultyCurvesCsv,
  bundledBotTuningJson,
  bundledWeaponsCsv,
  bundledWeaponPatternsCsv,
  bundledWeaponLevelsJson,
};
