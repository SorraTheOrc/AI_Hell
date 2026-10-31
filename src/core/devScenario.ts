/**
 * Dev-gated gameplay scenarios for the automated recorder
 * (AH-0MUWZ5HCV0034H44 producer-audit follow-up).
 *
 * The victory-fireworks display is anchored to the Central AI boss, but a
 * real run requires 200 hits (4 phases × 50) to reach it, so the recorder
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
 * - `defeat` — clear the wave and end the run in defeat on release (the
 *   recorded defeat-path demo for full-run capture verification).
 *
 * Any other value resolves to `null` (no scenario), so a typo can never
 * silently change a normal run.
 *
 * ## Promo scenarios (AH-0MVSDM4ED003C8ZC, child of AH-0MVI5XI73000ZVYA)
 *
 * A registry entry with `kind: 'promo'` resolves to a {@link DevPromoScenario}
 * carrying the bot-tuning `preset`, the `promoLevel` reference, the editorial
 * `categories` it evidences and, when the entry declares one, the
 * deterministic `seed`. Promo entries are resolved **from the registry entry
 * itself** rather than from a hardcoded name list, so registering a scenario
 * in `scripts/capture-scenarios.mjs` is enough to make it resolvable and the
 * two sides cannot drift.
 *
 * Every registry entry is validated against the shared schema
 * (`scripts/capture-scenario-schema.mjs`) as this module loads, so a promo
 * entry with a missing/blank preset or promo level, an empty or unknown
 * category set, or a non-uint32 seed fails fast here — the same contract the
 * registry enforces for the capture CLI.
 *
 * {@link resolveEnabledDevScenario} is the **single runtime gate**: it returns
 * a resolved scenario only in a dev build, so a promo URL (like the boss and
 * defeat URLs before it) is inert in production.
 *
 * The supported names are derived from {@link CAPTURE_SCENARIOS}, the shared
 * browser-free registry (`scripts/capture-scenarios.mjs`) the capture CLI also
 * reads (AH-0MV6JGE9R005YOL1). That keeps the game resolver and the CLI list /
 * docs table in parity, and a resolver value that is no longer registered
 * fails fast at module load rather than silently accepting a stale name.
 */

import {
  CAPTURE_SCENARIOS,
  type CaptureScenario,
} from '../../scripts/capture-scenarios.mjs';
import { assertCaptureScenarioEntry } from '../../scripts/capture-scenario-schema.mjs';

// Validate the registry as this module loads (the shared schema is the runtime
// source of truth for the enriched entry contract; see
// `scripts/capture-scenario-schema.mjs`). The registry validates its own
// entries when it is imported too, but this guard also holds a substituted
// registry (tests replace the module) to the same contract.
for (const [index, scenario] of CAPTURE_SCENARIOS.entries()) {
  assertCaptureScenarioEntry(
    scenario,
    `devScenario: CAPTURE_SCENARIOS[${index}]`,
  );
}

/** URL query parameter that selects a dev scenario. */
export const DEV_SCENARIO_PARAM = 'scenario';

/**
 * Returns the registry's own name for a scenario the resolver supports,
 * throwing at module load if the registry and resolver have drifted (a name
 * the resolver still branches on but that is no longer registered). The
 * returned value comes from the registry entry, so the exported constant is
 * genuinely sourced from — not duplicated outside — the single source of
 * truth.
 */
function registeredScenarioName(name: string): string {
  const normalised = name.trim().toLowerCase();
  const registered = CAPTURE_SCENARIOS.find(
    (scenario) => scenario.name === normalised,
  );
  if (registered === undefined) {
    throw new Error(
      `devScenario: "${name}" is not in CAPTURE_SCENARIOS `
        + `(${CAPTURE_SCENARIOS.length} registered scenario(s))`,
    );
  }
  return registered.name;
}

/** Value of the `scenario` parameter that jumps straight to the boss. */
export const DEV_SCENARIO_BOSS = registeredScenarioName('boss');

/** Value of the `scenario` parameter for the recorded four-hit boss demo. */
export const DEV_SCENARIO_BOSS_FOUR_HITS =
  registeredScenarioName('boss-four-hits');

/** Value of the `scenario` parameter for the recorded defeat-path demo. */
export const DEV_SCENARIO_DEFEAT = registeredScenarioName('defeat');

/** Query parameter that tunes the boss scenario's remaining hits. */
export const DEV_BOSS_HITS_PARAM = 'bossHits';

/**
 * URL query parameter that forces a deterministic run seed in a dev build
 * (AH-0MUY08W7Y004GATZ). It lets the dev recorder record a human run and a
 * bot run on the **same** seed for the replay/ghost comparison, without
 * reaching into Phaser internals.
 */
export const DEV_SEED_PARAM = 'seed';

/** Hits remaining in the recorded `boss-four-hits` scenario. */
export const DEV_BOSS_DEFAULT_HITS = 4;

/** A resolved dev scenario. */
export interface DevBossScenario {
  /** Discriminant so future scenarios can extend the union. */
  readonly kind: 'boss';
  /** Number of further boss hits before the run is won. */
  readonly bossHitsRemaining: number;
}

/**
 * A resolved defeat dev scenario (AH-0MUX2K8U7000GFNU producer-audit
 * follow-up): the run is cleared and frozen, then ends in defeat when the
 * recorder releases it, so the defeat end-of-run signal is verifiable in a
 * real browser.
 */
export interface DevDefeatScenario {
  /** Discriminant so future scenarios can extend the union. */
  readonly kind: 'defeat';
}

/**
 * A resolved promo dev scenario (AH-0MVSDM4ED003C8ZC): a curated
 * promo-video scenario resolved from its registry entry.
 */
export interface DevPromoScenario {
  /** Discriminant so consumers can branch on the scenario family. */
  readonly kind: 'promo';
  /** Bot-tuning preset name the run should fly. */
  readonly preset: string;
  /** Level reference into the promo wave module. */
  readonly promoLevel: string;
  /** Editorial categories this scenario evidences (never empty). */
  readonly categories: readonly string[];
  /** Deterministic run seed, when the registry entry declares one. */
  readonly seed?: number;
}

/** The resolved dev-scenario union. */
export type DevScenario =
  | DevBossScenario
  | DevDefeatScenario
  | DevPromoScenario;

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
 * Resolves a registry entry into the scenario the game should apply.
 *
 * `entry` is a validated {@link CaptureScenario} (the module-load guard above
 * guarantees its shape); `params` supplies the boss-only tuning so a boss
 * entry can honour `&bossHits=N`.
 */
function resolveRegisteredScenario(
  entry: CaptureScenario,
  params: URLSearchParams,
): DevScenario {
  switch (entry.kind) {
    case 'boss':
      // The recorded four-hit demo deliberately ignores `bossHits`, exactly as
      // before, so the recorded URL cannot be retuned by accident.
      return {
        kind: 'boss',
        bossHitsRemaining: entry.name === DEV_SCENARIO_BOSS_FOUR_HITS
          ? DEV_BOSS_DEFAULT_HITS
          : resolveBossHits(params.get(DEV_BOSS_HITS_PARAM)),
      };
    case 'defeat':
      return { kind: 'defeat' };
    case 'promo':
      return {
        kind: 'promo',
        preset: entry.preset,
        promoLevel: entry.promoLevel,
        categories: entry.categories,
        ...(entry.seed === undefined ? {} : { seed: entry.seed }),
      };
  }
}

/**
 * Resolves the dev scenario encoded in a URL search string (with or without a
 * leading `?`). Pure and total: an absent/unknown scenario, or a malformed
 * query, returns `null`.
 *
 * The scenario is looked up in {@link CAPTURE_SCENARIOS} and resolved from the
 * entry's `kind`, so the registry is the single source of truth for which
 * scenarios exist and what each one carries.
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
  const entry = CAPTURE_SCENARIOS.find(
    (scenario) => scenario.name === normalised,
  );
  if (entry === undefined) return null;
  return resolveRegisteredScenario(entry, params);
}

/**
 * Resolves the dev scenario only when the build is a dev build — the single
 * runtime gate for every scenario kind (boss, defeat and promo alike).
 *
 * Callers that apply a scenario at run start (the recorder handle, the
 * PlayScene seam) use this instead of pairing {@link isDevScenarioEnabled}
 * with {@link resolveDevScenario}, so a production build can never apply one
 * even if a new scenario kind is added later.
 *
 * @param search — a `location.search` string or bare query string.
 * @returns the resolved scenario in a dev build, otherwise `null`.
 */
export function resolveEnabledDevScenario(
  search: string,
): DevScenario | null {
  return isDevScenarioEnabled() ? resolveDevScenario(search) : null;
}

/**
 * Resolves the deterministic dev seed encoded in a URL search string, if any
 * (AH-0MUY08W7Y004GATZ). Pure and total: an absent, blank or non-finite seed
 * returns `null`, and a valid seed is normalised to a 32-bit unsigned integer
 * (matching the run-seed contract).
 *
 * @param search — a `location.search` string or bare query string.
 * @returns the normalised seed, or `null` when none is requested.
 */
export function resolveDevSeed(search: string): number | null {
  const params = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  const raw = params.get(DEV_SEED_PARAM);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return value >>> 0;
}
