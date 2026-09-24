/**
 * Enemy configuration module (data-driven enemy tooling, AH-0MTFP7EIC004F1MN).
 *
 * Types and seed defaults live in the leaf modules `configTypes.ts` /
 * `configDefaults.ts`; the CSV-backed config store (`configStore.ts`) is the
 * runtime source of truth. The loaders below delegate to the store, so
 * callers keep their synchronous signatures while the data comes from
 * `src/data/enemy-configs.csv` (loaded at boot). No localStorage is used.
 */

import {
  loadEnemyConfig as storeLoadEnemyConfig,
  saveEnemyConfig as storeSaveEnemyConfig,
  listEnemyConfigKeys as storeListEnemyConfigKeys,
  loadAllEnemyConfigs as storeLoadAllEnemyConfigs,
  type SaveResult,
} from './configStore';

// Re-export the shared types and seed defaults (leaf modules) so existing
// importers keep working unchanged.
export type {
  EnemyConfig,
  EnemyFormationKind,
  EnemyShotPattern,
} from './configTypes';
export {
  DEFAULT_ENEMY_CONFIGS,
  DEFAULT_ENEMY_KEYS,
} from './configDefaults';

// ── Key helpers ─────────────────────────────────────────────────────

/** Validated slug pattern (lowercase, numbers, hyphens only; max 40 chars). */
const VALID_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ENEMY_CONFIG_KEY_MAX_LENGTH = 40;

/**
 * Returns true if the key is valid for persistence (non-empty, <= 40 chars,
 * lowercase/number/hyphen slug). Mirrors the Save As validation.
 */
export function isValidEnemyKey(key: string): boolean {
  if (!key || key.length > ENEMY_CONFIG_KEY_MAX_LENGTH) return false;
  return VALID_KEY_RE.test(key);
}

/**
 * Sanitizes an arbitrary name into a slug key: lowercase, non-alphanum→hyphen,
 * collapsed hyphens, trimmed leading/trailing hyphens, truncated to 40 chars.
 */
export function sanitizeEnemyKey(name: string): string {
  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  slug = slug.replace(/-{2,}/g, '-');
  if (slug.length > ENEMY_CONFIG_KEY_MAX_LENGTH) {
    slug = slug.slice(0, ENEMY_CONFIG_KEY_MAX_LENGTH).replace(/-$/g, '');
  }
  return slug;
}

// ── Store-backed loaders ────────────────────────────────────────────

/**
 * Loads one enemy config by key from the CSV-backed registry. Falls back to
 * the seed defaults when the boot loader has not run or the key is unknown.
 */
export function loadEnemyConfig(key: string): import('./configTypes').EnemyConfig {
  return storeLoadEnemyConfig(key);
}

/**
 * Persists the supplied enemy config through the dev-server CSV plugin and
 * refreshes the registry. Returns a status object; writes are unavailable in
 * production builds.
 */
export function saveEnemyConfig(
  config: import('./configTypes').EnemyConfig,
): Promise<SaveResult> {
  return storeSaveEnemyConfig(config);
}

/** Every available enemy key (seeds ∪ CSV registry), sorted. */
export function listEnemyConfigKeys(): string[] {
  return storeListEnemyConfigKeys();
}

/** Every available enemy config, mirroring `listEnemyConfigKeys`. */
export function loadAllEnemyConfigs(): import('./configTypes').EnemyConfig[] {
  return storeLoadAllEnemyConfigs();
}

export type { SaveResult };
