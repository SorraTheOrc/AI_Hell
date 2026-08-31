/**
 * Enemy gym discovery — data-driven per-config index entries.
 *
 * Mirrors `src/utils/gymDiscovery.ts` but for enemy archetypes persisted
 * in localStorage. No glob — reads the seed + localStorage registry via
 * `loadAllEnemyConfigs()`, so a new Save As entry appears without code
 * changes. Resilient: corrupt entries fall back via `loadEnemyConfig`.
 */

import { loadAllEnemyConfigs } from '../core/enemyConfig';

export interface EnemyGymEntry {
  /** Composite key used in the index list, e.g. `GymEnemies:scout`. */
  key: string;
  /** Human label shown on the index (displayName). */
  label: string;
  /** The enemy config key routed as `{ enemyKey }` to GymEnemies. */
  enemyKey: string;
}

/**
 * Discovers one index entry per available enemy config. Sorted
 * alphabetically by label, then by enemyKey for stability when displayNames
 * collide. Never throws — falls back to an empty list when storage is
 * unavailable (mirrors `loadAllEnemyConfigs` fallback).
 */
export function discoverEnemyGymEntries(): EnemyGymEntry[] {
  try {
    const configs = loadAllEnemyConfigs();
    const entries: EnemyGymEntry[] = configs.map((cfg) => ({
      key: `GymEnemies:${cfg.key}`,
      label: cfg.displayName,
      enemyKey: cfg.key,
    }));
    entries.sort((a, b) => a.label.localeCompare(b.label) || a.enemyKey.localeCompare(b.enemyKey));
    return entries;
  } catch {
    return [];
  }
}
