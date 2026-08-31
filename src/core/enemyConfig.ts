/**
 * Enemy configuration module (data-driven enemy tooling, AH-0MTFP7EIC004F1MN).
 *
 * Typed, JSON-serializable enemy archetypes whose tuning is persisted as
 * JSON in the browser's localStorage (mirroring `src/core/config.ts` /
 * `ai-hell-ship-config`). Values survive reloads; corrupt/missing storage
 * falls back to built-in seed defaults. No backend is required (GDD §6.3
 * web distribution model).
 *
 * Storage model: one localStorage entry per enemy key, namespaced as
 * `ai-hell-enemy-config:<key>` (per-enemy granularity, easy Save/Save As
 * without a manifest write race). A helper manifest is not stored — the
 * set of keys is inferred by scanning localStorage for that prefix and
 * unioning with the seed registry, so new enemies become discoverable
 * without any registration.
 */

import { GAME_WIDTH, GAME_HEIGHT } from './constants';

// ── Shot-pattern / formation-kind enums ───────────────────────────

export type EnemyShotPattern =
  | 'none'
  | 'aimed'
  | 'spread'
  | 'radial'
  | 'orbital'
  | 'coordinated';

// Single source of truth for formation kinds lives in `src/utils/formations.ts`
// (`EnemyFormationKind`). Re-export it here so callers can import from either
// place without creating a circular dep (both are leaf modules).
export type EnemyFormationKind = 'v' | 'diver' | 'rect' | 'swarm' | 'orbital' | 'single';

// ── EnemyConfig shape ─────────────────────────────────────────────

/**
 * JSON-serializable enemy archetype. Only persisted fields are present
 * here; per-entity animation/runtime state (e.g. wiggle phase, dive
 * progress, return phase) is NOT serialized.
 */
export interface EnemyConfig {
  /** Stable, slug key — also the localStorage suffix (lowercase, hyphenated). */
  key: string;
  /** Human-readable name shown in the gym index / editor panel. */
  displayName: string;

  // Formation / placement
  /** Which builder to use from `src/utils/formations.ts`. */
  formationKind: EnemyFormationKind;
  /** Enemy count in the formation. */
  count: number;
  /** Horizontal spacing between formation slots (px). */
  spacingX: number;
  /** Vertical spacing between formation slots (px). */
  spacingY: number;
  /** Rightward drift speed of the formation (px/s). */
  driftSpeed: number;
  /** Initial base position (px). */
  startX: number;
  startY: number;

  // Entity visuals / motion
  /** Body radius / half-size in px (entity drawing uses diameter or radius depending on type). */
  size: number;
  /** Body colour as a 0xRRGGBB number. */
  color: number;
  /** Bullet/body details for the entity type. */
  bulletColor: number;
  bulletSize: number;

  // Shot / bullet behaviour (shared across entity seam)
  shotPattern: EnemyShotPattern;
  /** Milliseconds between volleys (entity-level fire interval). */
  fireInterval: number;
  /** Bullet speed (px/s). */
  bulletSpeed: number;
  /** Burst / radial-spoke count (e.g. Tank radial 10, Diver burst 4, Phaser radial 8). */
  burstCount: number;

  /**
   * Extensible passthrough — future tuning axes can be added here without
   * breaking JSON compatibility. Unknown fields are preserved on merge.
   * Type is open so follow-up WIPs can invent axes (wiggle, firing lead, etc.).
   */
  [extra: string]: unknown;
}

// ── Storage constants ─────────────────────────────────────────────

/** Namespace prefix for per-enemy localStorage keys. */
export const ENEMY_CONFIG_STORAGE_PREFIX = 'ai-hell-enemy-config:';

/** Validated slug pattern (lowercase, numbers, hyphens only; max 40 chars). */
const VALID_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ENEMY_CONFIG_KEY_MAX_LENGTH = 40;

// ── Seed registries (mirroring existing hard-coded constants) ─────

export const DEFAULT_ENEMY_CONFIGS: Record<string, EnemyConfig> = {
  scout: {
    key: 'scout',
    displayName: 'Scout',
    formationKind: 'v',
    count: 6,
    spacingX: 26,
    spacingY: 22,
    driftSpeed: 40,
    startX: GAME_WIDTH * 0.25,
    startY: GAME_HEIGHT * 0.5,
    size: 16,
    color: 0x00ff00,
    bulletColor: 0xff4444,
    bulletSize: 3,
    shotPattern: 'aimed',
    fireInterval: 1200,
    bulletSpeed: 200,
    burstCount: 1,
  },
  diver: {
    key: 'diver',
    displayName: 'Diver',
    formationKind: 'diver',
    count: 6,
    spacingX: 30,
    spacingY: 25,
    driftSpeed: 30,
    startX: GAME_WIDTH * 0.25,
    startY: GAME_HEIGHT * 0.45,
    size: 18,
    color: 0xffff00,
    bulletColor: 0xffee88,
    bulletSize: 3,
    shotPattern: 'spread',
    fireInterval: 1000,
    bulletSpeed: 220,
    burstCount: 4,
  },
  tank: {
    key: 'tank',
    displayName: 'Tank',
    formationKind: 'rect',
    count: 6,
    spacingX: 50,
    spacingY: 45,
    driftSpeed: 18,
    startX: GAME_WIDTH * 0.25,
    startY: GAME_HEIGHT * 0.5,
    size: 28,
    color: 0xff6600,
    bulletColor: 0xffaa00,
    bulletSize: 4,
    shotPattern: 'radial',
    fireInterval: 2400,
    bulletSpeed: 150,
    burstCount: 10,
  },
  phaser: {
    key: 'phaser',
    displayName: 'Phaser',
    formationKind: 'orbital',
    count: 4,
    spacingX: 80,
    spacingY: 80,
    driftSpeed: 30,
    startX: GAME_WIDTH * 0.35,
    startY: GAME_HEIGHT * 0.5,
    size: 14,
    color: 0xff00ff,
    bulletColor: 0xff4444,
    bulletSize: 3,
    shotPattern: 'radial',
    fireInterval: 2000,
    bulletSpeed: 180,
    burstCount: 8,
  },
  swarm: {
    key: 'swarm',
    displayName: 'Swarm',
    formationKind: 'swarm',
    count: 15,
    spacingX: 28,
    spacingY: 24,
    driftSpeed: 60,
    startX: GAME_WIDTH * 0.15,
    startY: GAME_HEIGHT * 0.3,
    size: 15,
    color: 0x0066ff,
    bulletColor: 0x00ccff,
    bulletSize: 3,
    shotPattern: 'coordinated',
    fireInterval: 900,
    bulletSpeed: 180,
    burstCount: 1,
  },
  boss: {
    key: 'boss',
    displayName: 'Boss',
    formationKind: 'single',
    count: 1,
    spacingX: 0,
    spacingY: 0,
    driftSpeed: 0,
    startX: GAME_WIDTH / 2,
    startY: GAME_HEIGHT / 2 - 30,
    size: 50,
    color: 0xff0000,
    bulletColor: 0xffffff,
    bulletSize: 4,
    shotPattern: 'radial',
    fireInterval: 1200,
    bulletSpeed: 160,
    burstCount: 8,
  },
};

export const DEFAULT_ENEMY_KEYS = Object.keys(DEFAULT_ENEMY_CONFIGS);

// ── Key helpers ───────────────────────────────────────────────────

/**
 * Returns true if the key is valid for persistence (non-empty, <= 40 chars,
 * lowercase/number/hyphen slug). Mirrors the Save As validation: keys must
 * be non-empty, unique, and sanitized; the sanitizer produces slugs in
 * this form.
 */
export function isValidEnemyKey(key: string): boolean {
  if (!key || key.length > ENEMY_CONFIG_KEY_MAX_LENGTH) return false;
  return VALID_KEY_RE.test(key);
}

/**
 * Sanitizes an arbitrary name into a slug key: lowercase, non-alphanum→hyphen,
 * collapsed hyphens, trimmed leading/trailing hyphens, truncated to 40 chars.
 * Used by the Save As flow before validation; the result must pass
 * `isValidEnemyKey`.
 */
export function sanitizeEnemyKey(name: string): string {
  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Collapse interior hyphens only after trimming, then cap length and re-trim.
  slug = slug.replace(/-{2,}/g, '-');
  if (slug.length > ENEMY_CONFIG_KEY_MAX_LENGTH) slug = slug.slice(0, ENEMY_CONFIG_KEY_MAX_LENGTH).replace(/-$/g, '');
  return slug;
}

// ── Persistence helpers (localStorage, mirroring src/core/config.ts) ──

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function storageKeyFor(key: string): string {
  return `${ENEMY_CONFIG_STORAGE_PREFIX}${key}`;
}

/**
 * Loads one enemy config by key. If no saved entry exists, returns the
 * seed default for that key (or a generic default if the key has no seed).
 * If the saved JSON is corrupt or partly missing, merges what could be
 * parsed over the seed defaults and falls back gracefully without throwing.
 */
export function loadEnemyConfig(key: string): EnemyConfig {
  const seed = DEFAULT_ENEMY_CONFIGS[key];
  const defaults: EnemyConfig = seed ?? {
    key,
    displayName: key,
    formationKind: 'v',
    count: 6,
    spacingX: 26,
    spacingY: 22,
    driftSpeed: 40,
    startX: GAME_WIDTH * 0.25,
    startY: GAME_HEIGHT * 0.5,
    size: 16,
    color: 0x00ff00,
    bulletColor: 0xff4444,
    bulletSize: 3,
    shotPattern: 'aimed',
    fireInterval: 1200,
    bulletSpeed: 200,
    burstCount: 1,
  };

  const store = storage();
  if (!store) return { ...defaults };

  const raw = store.getItem(storageKeyFor(key));
  if (!raw) return { ...defaults };

  try {
    const parsed = JSON.parse(raw) as Partial<EnemyConfig>;
    // Accept any object; merge over defaults so missing fields keep their
    // defaults and unknown forward-compatible fields are preserved. Coerce
    // back to a complete EnemyConfig by spreading defaults then parsed,
    // with key/displayName normalised to the requested key if absent.
    const merged: EnemyConfig = { ...defaults, ...parsed, key: (parsed.key as string) || defaults.key };
    return merged;
  } catch {
    return { ...defaults };
  }
}

/**
 * Persists the supplied config to localStorage under its key. No-op when
 * storage is unavailable. The entire config object is JSON-serialized;
 * runtime-only state should not be included by the caller.
 */
export function saveEnemyConfig(config: EnemyConfig): void {
  const store = storage();
  if (!store) return;
  store.setItem(storageKeyFor(config.key), JSON.stringify(config));
}

/**
 * Removes a single enemy config from storage. Used by the Save As validation
 * tests' cleanup path; not shown in the gym UI.
 */
export function deleteEnemyConfig(key: string): void {
  const store = storage();
  if (!store) return;
  store.removeItem(storageKeyFor(key));
}

/**
 * Returns every available enemy key: the union of the seed registry and any
 * keys found in localStorage under the `ENEMY_CONFIG_STORAGE_PREFIX` prefix.
 * Corrupt storage is ignored (fallback behaviour), and the result is sorted
 * alphabetically for stable index rendering.
 */
export function listEnemyConfigKeys(): string[] {
  const store = storage();
  const set = new Set<string>(DEFAULT_ENEMY_KEYS);
  if (store) {
    for (let i = 0; i < store.length; i++) {
      const storageKey = store.key(i);
      if (!storageKey || !storageKey.startsWith(ENEMY_CONFIG_STORAGE_PREFIX)) continue;
      const suffix = storageKey.slice(ENEMY_CONFIG_STORAGE_PREFIX.length);
      if (suffix) set.add(suffix);
    }
  }
  return [...set].sort();
}

/**
 * Loads all available enemy configs (seed + saved), mirroring `listEnemyConfigKeys`.
 * Each entry is `loadEnemyConfig(key)` so the same fallback/merge semantics apply.
 */
export function loadAllEnemyConfigs(): EnemyConfig[] {
  return listEnemyConfigKeys().map(loadEnemyConfig);
}
