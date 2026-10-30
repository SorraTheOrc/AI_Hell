/**
 * Deterministic level→background manifest for the campaign
 * (parent AH-0MVIB7PD50029ZY1, slice AH-0MVSEASIM005TU95).
 *
 * Pure data + pure functions: no Phaser import, no runtime state, no
 * randomness. Every later background slice (asset bundling, the shared
 * background layer, the warp VFX and the `PlayScene` wiring) consumes this
 * module as the single source of truth for:
 *
 * - which texture keys exist ({@link BACKGROUND_TEXTURE_KEYS}),
 * - which background each campaign level shows
 *   ({@link LEVEL_BACKGROUND_MANIFEST}),
 * - how a level number resolves to a key ({@link backgroundForLevel}),
 * - what file on disk backs a key ({@link backgroundFileName} /
 *   {@link backgroundAssetPath}).
 *
 * Because the mapping is a pure function of the level number, the same level
 * always renders the same background — repeated unit-test runs, demo captures
 * and recorded videos stay stable (producer decision Q3, 2026-10-25:
 * "one distinct deterministic background per level").
 *
 * ## Determinism contract
 *
 * `backgroundForLevel(level)` is **pure**: the same level always returns the
 * same key, across repeated calls, call order and module instances. The
 * campaign part of the mapping is a curated, human-readable list
 * ({@link LEVEL_BACKGROUND_KEYS}) rather than a computed hash, so each level's
 * background intent is reviewable. {@link CAMPAIGN_LEVEL_COUNT} is derived from
 * `LEVELS` (`src/waves/Formations.ts`), so a newly added campaign level can
 * never silently leave the manifest short: levels beyond the curated list fall
 * back to a deterministic cycle through the pool.
 *
 * ## Level clamp (documented behaviour for out-of-range input)
 *
 * `backgroundForLevel` never throws. Out-of-range input is clamped into the
 * campaign range `1..LEVELS.length`:
 *
 * - finite numbers are first truncated toward zero (`2.9 → 2`, `0.5 → 0`),
 * - then clamped: `≤ 0 → 1`, `> LEVELS.length → LEVELS.length`,
 * - `NaN` resolves to level 1 (treated as "not set"),
 * - `Infinity` resolves to the final level, `-Infinity` to level 1.
 *
 * @module data/backgrounds
 */

import { LEVELS } from '../waves/Formations';

/**
 * Number of campaign levels that need a background.
 *
 * Derived from `LEVELS` rather than hard-coded so adding a campaign level
 * automatically extends the manifest (and the level-change wiring that reads
 * it) instead of leaving that level background-less.
 */
export const CAMPAIGN_LEVEL_COUNT: number = LEVELS.length;

/** Public asset directory (Vite serves `public/` from the site root). */
export const BACKGROUND_ASSET_DIR = 'assets/backgrounds';

/**
 * File extension shared by every bundled background image.
 *
 * The asset-bundling slice (`AH-0MVSEB2WZ000MZY8`) must write files with this
 * extension so the loader can derive paths from a texture key alone.
 */
export const BACKGROUND_FILE_EXTENSION = 'jpg';

/**
 * Every bundled background texture key, sorted ascending.
 *
 * A *texture key* is the Phaser texture-manager key; the file behind it is
 * derived with {@link backgroundFileName}. Keys are lowercase
 * `background-<slug>` strings so a key survives being used as a file name,
 * a URL path and a test fixture identifier without any transformation.
 *
 * The pool is larger than the campaign on purpose: surplus keys are spares /
 * alternates for future levels and for capture-pipeline variety.
 *
 * `readonly` at the type level **and** frozen at runtime so no consumer can
 * mutate the shared pool.
 */
export const BACKGROUND_TEXTURE_KEYS: readonly string[] = Object.freeze([
  'background-andromeda-galaxy',
  'background-bubble-nebula',
  'background-carina-nebula',
  'background-crab-nebula',
  'background-earthrise',
  'background-eskimo-nebula',
  'background-horsehead-nebula',
  'background-jupiter-storm',
  'background-lagoon-nebula',
  'background-mars-surface',
  'background-milky-way',
  'background-orion-nebula',
  'background-pillars-of-creation',
  'background-ring-nebula',
  'background-saturn-rings',
  'background-sombrero-galaxy',
  'background-sun-corona',
  'background-tarantula-nebula',
  'background-veil-nebula',
  'background-whirlpool-galaxy',
]);

/**
 * Curated background per campaign level, in campaign order.
 *
 * Deliberately an explicit ordered list (not a hash or modulo): the mapping is
 * the design intent — the run travels from Earth orbit through nebulae into
 * deep-space galaxies — and it must stay readable in review. Every entry must
 * be a member of {@link BACKGROUND_TEXTURE_KEYS}; the test suite enforces it.
 *
 * Levels beyond this list (only possible after the campaign grows) resolve to a
 * deterministic cycle through the pool — see {@link backgroundKeyForIndex}.
 */
export const LEVEL_BACKGROUND_KEYS: readonly string[] = Object.freeze([
  'background-earthrise', // 1 — Entry
  'background-milky-way', // 2 — Descent
  'background-sun-corona', // 3 — The Core
  'background-orion-nebula', // 4 — Firestorm
  'background-horsehead-nebula', // 5 — Predictable Death
  'background-tarantula-nebula', // 6 — Invasion
  'background-veil-nebula', // 7 — Segmented Assault
  'background-andromeda-galaxy', // 8 — Gridlock
  'background-ring-nebula', // 9 — Orbital Siege
  'background-whirlpool-galaxy', // 10 — The Gauntlet
]);

/** One campaign level's resolved background. */
export interface BackgroundManifestEntry {
  /** 1-based campaign level number (matches `LEVELS[level - 1].level`). */
  readonly level: number;
  /** Level theme name from `LEVELS` (e.g. `'Entry'`); read-only context. */
  readonly themeName: string;
  /** Phaser texture key for this level's background. */
  readonly textureKey: string;
}

/**
 * Deterministic background key for a 0-based level index.
 *
 * Uses the curated list where it has an entry and otherwise cycles through the
 * pool (`index % pool.length`). The fallback keeps the manifest complete and
 * distinct for a growing campaign without needing a code change for every new
 * level; it is only reached past the curated prefix.
 */
function backgroundKeyForIndex(index: number): string {
  const curated: string | undefined = LEVEL_BACKGROUND_KEYS[index];
  if (curated !== undefined) return curated;
  return BACKGROUND_TEXTURE_KEYS[index % BACKGROUND_TEXTURE_KEYS.length];
}

/**
 * The level→background manifest for **every** campaign level, derived from
 * `LEVELS` so the manifest can never omit a level the game plays.
 *
 * Entries are in campaign order (`entry.level === index + 1`) and carry the
 * level's theme name for traceability/debug output.
 */
export const LEVEL_BACKGROUND_MANIFEST: readonly BackgroundManifestEntry[] =
  Object.freeze(
    LEVELS.map((level, index) =>
      Object.freeze({
        level: index + 1,
        themeName: level.name,
        textureKey: backgroundKeyForIndex(index),
      }),
    ),
  );

/**
 * Resolves any level number to a campaign level in `1..CAMPAIGN_LEVEL_COUNT`.
 *
 * Non-finite input never throws: `NaN` maps to level 1 (`Infinity` clamps to
 * the final level, `-Infinity` to level 1) — see the module doc comment for the
 * full clamp contract.
 */
function clampLevel(level: number): number {
  if (Number.isNaN(level)) return 1;
  if (level === Number.POSITIVE_INFINITY) return CAMPAIGN_LEVEL_COUNT;
  if (level === Number.NEGATIVE_INFINITY) return 1;
  const truncated = Math.trunc(level);
  if (truncated < 1) return 1;
  if (truncated > CAMPAIGN_LEVEL_COUNT) return CAMPAIGN_LEVEL_COUNT;
  return truncated;
}

/**
 * The deterministic background texture key for a campaign level.
 *
 * Pure: the same level always returns the same key, independent of call order,
 * iteration order or module instance. Out-of-range input is clamped (never
 * throws) per the clamp contract in the module doc comment.
 *
 * @param level - 1-based campaign level (`1..LEVELS.length`).
 * @returns A key from {@link BACKGROUND_TEXTURE_KEYS}.
 */
export function backgroundForLevel(level: number): string {
  const entry = LEVEL_BACKGROUND_MANIFEST[clampLevel(level) - 1];
  // Defensive: the manifest is complete for the current campaign, but the
  // contract is "never throws and always returns a pool key".
  return entry?.textureKey ?? BACKGROUND_TEXTURE_KEYS[0];
}

/**
 * The image file name backing a background texture key
 * (e.g. `background-earthrise.jpg`).
 *
 * @param textureKey - A key from {@link BACKGROUND_TEXTURE_KEYS}.
 */
export function backgroundFileName(textureKey: string): string {
  return `${textureKey}.${BACKGROUND_FILE_EXTENSION}`;
}

/**
 * The site-root-relative asset path backing a background texture key
 * (e.g. `assets/backgrounds/background-earthrise.jpg`).
 *
 * The file lives in the repo at `public/<path>`; the loader (and the
 * asset-bundling slice) derive both from this single helper so the directory
 * and extension never drift.
 *
 * @param textureKey - A key from {@link BACKGROUND_TEXTURE_KEYS}.
 */
export function backgroundAssetPath(textureKey: string): string {
  return `${BACKGROUND_ASSET_DIR}/${backgroundFileName(textureKey)}`;
}
