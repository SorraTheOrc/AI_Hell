/**
 * Dev-gated gameplay scenarios for the automated recorder
 * (AH-0MUWZ5HCV0034H44 producer-audit follow-up).
 *
 * The victory-fireworks display is anchored to the Central AI boss, but a
 * real run requires 400 hits (4 phases × 100) to reach it, so the recorder
 * (`npm run capture`) — and a human reviewer — cannot practically observe the
 * celebration. A **dev scenario** is a small, additive, dev-only shortcut that
 * drops the run straight into the boss encounter with a chosen number of hits
 * remaining.
 *
 * The scenario is selected by a URL query parameter on the game URL, e.g.
 * `/?scenario=boss-four-hits`, so the recorder only has to load a different
 * URL — no reach into Phaser internals. The parser here is pure and
 * hermetic; the caller ({@link ../scenes/PlayScene.PlayScene}) applies the
 * scenario only when {@link isDevScenarioEnabled} is true, so a production
 * build ignores the query parameter entirely and the shipped bundle stays
 * inert.
 *
 * Supported values of the `scenario` parameter:
 *
 * - `boss-four-hits` — jump to the boss with
 *   {@link DEV_BOSS_DEFAULT_HITS} hits remaining (the recorded demo).
 * - `boss` — the same jump, with the hit count tunable via the
 *   `bossHits` parameter (e.g. `?scenario=boss&bossHits=12`).
 *
 * Any other value resolves to `null` (no scenario), so a typo can never
 * silently change a normal run.
 */

/** URL query parameter that selects a dev scenario. */
export const DEV_SCENARIO_PARAM = 'scenario';

/** Value of the `scenario` parameter that jumps straight to the boss. */
export const DEV_SCENARIO_BOSS = 'boss';

/** Value of the `scenario` parameter for the recorded four-hit boss demo. */
export const DEV_SCENARIO_BOSS_FOUR_HITS = 'boss-four-hits';

/** Query parameter that tunes the boss scenario's remaining hits. */
export const DEV_BOSS_HITS_PARAM = 'bossHits';

/** Hits remaining in the recorded `boss-four-hits` scenario. */
export const DEV_BOSS_DEFAULT_HITS = 4;

/** A resolved dev scenario. Currently only the boss shortcut exists. */
export interface DevBossScenario {
  /** Discriminant so future scenarios can extend the union. */
  readonly kind: 'boss';
  /** Number of further boss hits before the run is won. */
  readonly bossHitsRemaining: number;
}

/** The resolved dev-scenario union (one member today). */
export type DevScenario = DevBossScenario;

/** True when dev scenarios should be honoured (dev builds only). */
export function isDevScenarioEnabled(): boolean {
  return import.meta.env.DEV === true;
}

/**
 * The page-side handle a running dev scenario exposes so the recorder can
 * release it deterministically (instead of simulating the pause key).
 */
export interface DevScenarioHandle {
  /** Hits remaining that the scenario configured. */
  readonly hitsRemaining: number;
  /** Resumes the frozen run so the short fight begins. */
  resume(): void;
}

declare global {
  interface Window {
    /**
     * Dev-gated active-scenario handle (AH-0MUWZ5HCV0034H44). Set by
     * `PlayScene.startDevBossScenario`, removed on scene SHUTDOWN, and called
     * by `npm run capture` to release the frozen run. Absent in production and
     * whenever no scenario is active.
     */
    __aiHellScenario?: DevScenarioHandle;
  }
}

/**
 * Registers the active scenario handle on `window` (dev builds only). No-op
 * in production, so the shipped bundle never writes the global.
 */
export function installDevScenarioHandle(handle: DevScenarioHandle): void {
  if (!isDevScenarioEnabled() || typeof window === 'undefined') return;
  window.__aiHellScenario = handle;
}

/** Removes the active scenario handle, if any. */
export function clearDevScenarioHandle(): void {
  if (typeof window === 'undefined') return;
  delete window.__aiHellScenario;
}

/**
 * Parses the `bossHits` request value into a usable hit count.
 *
 * Falls back to {@link DEV_BOSS_DEFAULT_HITS} for a missing/non-finite value
 * and clamps to at least one hit, so a scenario can never be created in an
 * already-dead state.
 */
function resolveBossHits(raw: string | null): number {
  if (raw === null) return DEV_BOSS_DEFAULT_HITS;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEV_BOSS_DEFAULT_HITS;
  return Math.max(1, Math.floor(value));
}

/**
 * Resolves the dev scenario encoded in a URL search string (with or without a
 * leading `?`). Pure and total: an absent/unknown scenario, or a malformed
 * query, returns `null`.
 *
 * @param search — a `location.search` string or bare query string.
 * @returns the resolved scenario, or `null` when none is requested.
 */
export function resolveDevScenario(search: string): DevScenario | null {
  const params = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  const name = params.get(DEV_SCENARIO_PARAM);
  if (name === null) return null;

  const normalised = name.trim().toLowerCase();
  if (normalised === DEV_SCENARIO_BOSS_FOUR_HITS) {
    return { kind: 'boss', bossHitsRemaining: DEV_BOSS_DEFAULT_HITS };
  }
  if (normalised === DEV_SCENARIO_BOSS) {
    return {
      kind: 'boss',
      bossHitsRemaining: resolveBossHits(params.get(DEV_BOSS_HITS_PARAM)),
    };
  }
  return null;
}
