/**
 * Config store (AH-0MTZWZ9TE009CVUA — task AH-0MUE2MGZM0016U3L).
 *
 * In-memory registry that serves typed `EnemyConfig` / `ShipConfig`
 * synchronously from data loaded out of the committed CSV files. At boot
 * {@link loadConfigs} fetches (dev) or reads the bundled (production) CSV,
 * parses and validates it with the CSV codec, and populates the registry.
 *
 * In dev mode, {@link saveEnemyConfig} / {@link saveShipConfig} write back
 * through the Vite dev-server plugin endpoint (`/api/csv/...`) and re-read
 * the CSV so the running scene reflects the persisted values. Production
 * builds are read-only: the write functions are no-ops that report
 * unavailability.
 *
 * The store deliberately has no localStorage dependency — the CSV files
 * are the single source of truth.
 */

import { GAME_WIDTH, GAME_HEIGHT } from './constants';
import { DEFAULT_ENEMY_CONFIGS, DEFAULT_CONFIG } from './configDefaults';
import type { EnemyConfig, ShipConfig } from './configTypes';
import {
  parseCsvRows,
  coerceEnemyConfig,
  coerceShipConfig,
  serializeEnemyConfigs,
  serializeShipConfigs,
} from './csv';

// Bundled CSV content — used by production/static builds (read-only).
// Imported dynamically so the Vite config loader (which transitively imports
// this module via the CSV plugin) does not have to resolve `?raw` imports.

// ── Public constants ────────────────────────────────────────────────

/** Project-relative path of the enemy-config CSV. */
export const ENEMY_CSV_PATH = 'src/data/enemy-configs.csv';
/** Project-relative path of the ship-config CSV. */
export const SHIP_CSV_PATH = 'src/data/ship-config.csv';
/** Dev-server write endpoint prefix. */
export const CSV_API_PREFIX = '/api/csv/';

/** Result of a config write attempt. */
export interface SaveResult {
  /** True when the write succeeded (or was persisted). */
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
}

// ── Registry state ──────────────────────────────────────────────────

interface Registry {
  enemies: Map<string, EnemyConfig>;
  ship: ShipConfig;
  loaded: boolean;
  source: 'csv' | 'defaults';
}

function createEmptyRegistry(): Registry {
  return {
    enemies: new Map(),
    ship: { ...DEFAULT_CONFIG },
    loaded: false,
    source: 'defaults',
  };
}

// Lazily initialised so importing modules can form a dependency cycle with
// this store without reading `DEFAULT_CONFIG` during a partial evaluation
// (the config modules re-export these accessors).
let registry: Registry | null = null;

function getRegistry(): Registry {
  if (registry === null) registry = createEmptyRegistry();
  return registry;
}

// ── Environment detection ───────────────────────────────────────────

/** True when running under the Vite dev server. */
function isDev(): boolean {
  return import.meta.env.DEV === true;
}

// ── Generic fallback for unknown keys ───────────────────────────────

function genericEnemyDefault(key: string): EnemyConfig {
  return {
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
    bulletLifetime: 1.5,
    burstCount: 1,
    shotProbability: 1.0,
  };
}

// ── Boot loader ─────────────────────────────────────────────────────

async function fetchCsv(path: string): Promise<string> {
  const res = await fetch(`/${path}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${path}: HTTP ${res.status}`);
  }
  return await res.text();
}

/**
 * Populate the registry from raw CSV text. Throws when neither file yields
 * any usable rows so the caller can fall back to defaults.
 */
function populateFromCsv(enemyCsv: string, shipCsv: string): void {
  const enemyRows = parseCsvRows(enemyCsv);
  const shipRows = parseCsvRows(shipCsv);

  const enemies = new Map<string, EnemyConfig>();
  for (const row of enemyRows) {
    const cfg = coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS);
    if (cfg.key) enemies.set(cfg.key, cfg);
  }

  if (enemies.size === 0 && shipRows.length === 0) {
    throw new Error('No usable CSV rows found');
  }

  // Enemy CSV unusable → keep the built-in enemy seeds.
  if (enemies.size === 0) {
    for (const [key, cfg] of Object.entries(DEFAULT_ENEMY_CONFIGS)) {
      enemies.set(key, { ...cfg });
    }
  }

  const ship =
    shipRows.length > 0
      ? coerceShipConfig(shipRows[0], DEFAULT_CONFIG)
      : { ...DEFAULT_CONFIG };

  registry = { enemies, ship, loaded: true, source: 'csv' };
}

function populateFromDefaults(): void {
  const enemies = new Map<string, EnemyConfig>();
  for (const [key, cfg] of Object.entries(DEFAULT_ENEMY_CONFIGS)) {
    enemies.set(key, { ...cfg });
  }
  registry = {
    enemies,
    ship: { ...DEFAULT_CONFIG },
    loaded: true,
    source: 'defaults',
  };
}

/**
 * Boot loader — reads both CSVs and populates the in-memory registry.
 * Must be awaited before scene construction so sync accessors serve the
 * CSV-backed values from the first frame. Never throws: a failed fetch
 * falls back to the built-in defaults so the game still boots.
 */
export async function loadConfigs(): Promise<void> {
  if (isDev()) {
    try {
      const [enemyCsv, shipCsv] = await Promise.all([
        fetchCsv(ENEMY_CSV_PATH),
        fetchCsv(SHIP_CSV_PATH),
      ]);
      populateFromCsv(enemyCsv, shipCsv);
      return;
    } catch {
      populateFromDefaults();
      return;
    }
  }

  // Production / static build: read the CSV bundled at build time.
  try {
    const bundled = await import('./bundledConfig');
    populateFromCsv(bundled.bundledEnemyCsv, bundled.bundledShipCsv);
  } catch {
    populateFromDefaults();
  }
}

// ── Sync accessors ──────────────────────────────────────────────────

/** Synchronous enemy-config lookup from the in-memory registry. */
export function loadEnemyConfig(key: string): EnemyConfig {
  const stored = getRegistry().enemies.get(key);
  const seed = DEFAULT_ENEMY_CONFIGS[key];
  if (stored) {
    // The seed displayName is authoritative for seed keys: a stale persisted
    // label (e.g. an older "Boss" for the renamed `boss` seed) must not
    // shadow a rename, or the gym index would show two identical labels
    // (AH-0MTV8OV9V002D8B7). Non-seed (Save As) keys keep their own label.
    return seed
      ? { ...stored, displayName: seed.displayName }
      : { ...stored };
  }
  if (seed) return { ...seed };
  return genericEnemyDefault(key);
}

/** Synchronous ship-config lookup from the in-memory registry. */
export function loadShipConfig(): ShipConfig {
  return { ...getRegistry().ship };
}

/** Sorted list of every available enemy key (seeds ∪ registry). */
export function listEnemyConfigKeys(): string[] {
  const keys = new Set<string>(Object.keys(DEFAULT_ENEMY_CONFIGS));
  for (const key of getRegistry().enemies.keys()) keys.add(key);
  return [...keys].sort();
}

/** Every available enemy config, mirroring {@link listEnemyConfigKeys}. */
export function loadAllEnemyConfigs(): EnemyConfig[] {
  return listEnemyConfigKeys().map(loadEnemyConfig);
}

// ── Dev write path ──────────────────────────────────────────────────

const WRITE_UNAVAILABLE =
  'Config writes are unavailable in production builds (read-only CSV).';

async function putCsv(path: string, body: string): Promise<SaveResult> {
  try {
    const res = await fetch(`${CSV_API_PREFIX}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body,
    });
    if (!res.ok) {
      return { ok: false, reason: `Write failed with HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'Write failed',
    };
  }
}

/** Re-read both CSVs and refresh the registry, ignoring transient failures. */
async function reReadRegistry(): Promise<void> {
  try {
    const [enemyCsv, shipCsv] = await Promise.all([
      fetchCsv(ENEMY_CSV_PATH),
      fetchCsv(SHIP_CSV_PATH),
    ]);
    populateFromCsv(enemyCsv, shipCsv);
  } catch {
    // The write already succeeded; keep the current registry.
  }
}

/**
 * Persist an enemy config through the dev-server plugin and refresh the
 * registry. No-op (reporting unavailability) outside dev mode.
 */
export async function saveEnemyConfig(config: EnemyConfig): Promise<SaveResult> {
  if (!isDev()) return { ok: false, reason: WRITE_UNAVAILABLE };

  // Build the full CSV (all configs) so the plugin can upsert the row.
  const current = getRegistry();
  const enemies = new Map(current.enemies);
  enemies.set(config.key, { ...config });
  const body = serializeEnemyConfigs([...enemies.values()]);

  const result = await putCsv(ENEMY_CSV_PATH, body);
  if (!result.ok) return result;

  // Only commit the registry change after a successful write.
  registry = { ...current, enemies, loaded: true, source: 'csv' };
  await reReadRegistry();
  return { ok: true };
}

/**
 * Persist the ship config through the dev-server plugin and refresh the
 * registry. No-op (reporting unavailability) outside dev mode.
 */
export async function saveShipConfig(config: ShipConfig): Promise<SaveResult> {
  if (!isDev()) return { ok: false, reason: WRITE_UNAVAILABLE };

  const body = serializeShipConfigs([config]);
  const result = await putCsv(SHIP_CSV_PATH, body);
  if (!result.ok) return result;

  registry = { ...getRegistry(), ship: { ...config }, loaded: true, source: 'csv' };
  await reReadRegistry();
  return { ok: true };
}

// ── Test / lifecycle helpers ────────────────────────────────────────

/** Reset the registry to its unloaded state. Intended for tests. */
export function resetConfigStore(): void {
  registry = createEmptyRegistry();
}

/**
 * Seed the in-memory registry directly (test seam / non-HTTP hydration).
 * The runtime boot path uses {@link loadConfigs}; callers that need a
 * specific registry state (e.g. scene tests) use this instead.
 */
export function seedConfigStore(
  enemies: EnemyConfig[],
  ship: ShipConfig = DEFAULT_CONFIG,
): void {
  const map = new Map<string, EnemyConfig>();
  for (const cfg of enemies) map.set(cfg.key, { ...cfg });
  registry = { enemies: map, ship: { ...ship }, loaded: true, source: 'csv' };
}
