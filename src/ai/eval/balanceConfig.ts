/**
 * Resolved balance configuration for the deterministic headless arena
 * (AH-0MV81YPBG0028WNM, epic AC1 "Config-driven simulation").
 *
 * This is the single place the eval layer turns the shared CSV-backed config
 * store into the {@link ArenaBalanceConfig} the arena consumes: enemy
 * archetypes via `loadAllEnemyConfigs`, the ship via `loadShipConfig`, and
 * the campaign difficulty curves via `loadDifficultyCurves`. No stats are
 * duplicated here — the loaders are the only source of truth.
 *
 * ## SSR loading (AC5)
 *
 * `scripts/evaluate.mjs` runs the TS core through Vite's SSR module loader.
 * The dev-server CSV path (`fetch('/api/csv/...')`) needs a browser origin,
 * so under SSR (`import.meta.env.SSR`) {@link loadConfigs} reads the CSVs
 * bundled at build time instead. The Node shell awaits
 * {@link hydrateBalanceConfig} once before any evaluation so a headless run
 * serves CSV-backed values; a missing/unreadable file falls back to the
 * built-in defaults and never breaks the run.
 *
 * @module src/ai/eval/balanceConfig
 */

import {
  loadAllEnemyConfigs,
  loadConfigs,
  loadDifficultyCurves,
  loadShipConfig,
} from '../../core/configStore';
import type { ArenaBalanceConfig } from './types';

/**
 * Resolves the arena's balance configuration through the shared config
 * loaders. Synchronous and pure: it reads the in-memory registry (CSV-backed
 * after `loadConfigs` / {@link hydrateBalanceConfig}, seed defaults before
 * boot), never the wall clock or the filesystem.
 */
export function loadBalanceConfig(): ArenaBalanceConfig {
  return {
    enemies: loadAllEnemyConfigs(),
    ship: loadShipConfig(),
    difficultyCurves: loadDifficultyCurves(),
  };
}

/**
 * Boot-hydrates the shared config store so the loaders serve CSV-backed
 * values. SSR-safe: under Vite SSR (the `scripts/evaluate.mjs` shell) it
 * reads the bundled CSVs instead of fetching `/api/csv/...` from a browser
 * origin. Never throws — {@link loadConfigs} falls back to the built-in
 * defaults so an unreadable config cannot block evaluation.
 */
export async function hydrateBalanceConfig(): Promise<void> {
  await loadConfigs();
}
