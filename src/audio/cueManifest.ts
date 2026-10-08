/**
 * Cue → ToneForge asset manifest (single source of truth).
 *
 * The data lives in `audio/toneforge/manifest.json` so that it is consumed
 * by *both* the deterministic WAV build pipeline (`scripts/build-audio.sh`,
 * plain Node) and this typed runtime/test view. Keeping one JSON file as
 * the source avoids the build and the tests drifting apart.
 *
 * Derived from `docs/AUDIO_TONEFORGE_CUE_MAPPING.md` (produced by
 * Cue-to-recipe mapping and unused-cue audit (AH-0MUTYV7SQ005HURT)).
 *
 * This manifest is the executable form of the mapping: it records, for
 * every retained cue, which ToneForge recipe produces it, how it is
 * delivered (a baked WAV, an existing ToneForge recipe, or a runtime
 * shim) and the build-time seeds rendered for it. The deterministic WAV
 * build pipeline (AH-0MUTYV8FU007X7JD) renders the baked entries and the
 * playback rewrite (AH-0MUTYV92Y000WJ8Z) consumes them at runtime.
 *
 * Every sound-producing cue exported by `src/audio/effects.ts` (and the
 * four inline Boss cues in `src/entities/Boss.ts`) MUST appear here — the
 * contract suite asserts this so a cue can never be silently dropped.
 */

import manifest from '../../audio/toneforge/manifest.json';

/** How a cue is delivered after the ToneForge migration. */
export type CueDelivery = 'existing-recipe' | 'baked' | 'runtime-shim';

/** A single cue's ToneForge mapping. */
export interface CueManifestEntry {
  /** Exported cue function name (`src/audio/effects.ts`; Boss cues live in `src/entities/Boss.ts`). */
  readonly cue: string;
  /** ToneForge recipe slug that produces the cue. */
  readonly recipe: string;
  /** Delivery mechanism (see {@link CueDelivery}). */
  readonly delivery: CueDelivery;
  /**
   * Build-time seeds rendered to WAV variants. Empty for
   * `existing-recipe` and `runtime-shim` entries. Cues that used
   * per-invocation pitch jitter are baked with a small seed range so
   * repeated kills still vary.
   */
  readonly seeds: readonly number[];
}

/**
 * Cues with no playable asset: start/stop companions that manage the
 * lifetime of a continuous cue rather than producing a sound themselves.
 */
export const CONTROL_CUES: readonly string[] = manifest.controlCues;

/**
 * Cues retired by the migration (no asset, removed from `effects.ts`).
 * See `docs/AUDIO_TONEFORGE_CUE_MAPPING.md` §"Retired cues" for the
 * consumer-analysis evidence.
 */
export const RETIRED_CUES: readonly string[] = manifest.retiredCues;

/** Every retained, sound-producing cue and its ToneForge mapping. */
export const CUE_MANIFEST: readonly CueManifestEntry[] =
  manifest.cues as readonly CueManifestEntry[];

const byCue = new Map<string, CueManifestEntry>(
  CUE_MANIFEST.map((entry) => [entry.cue, entry]),
);

/** Looks up a cue's manifest entry, or `undefined` when it is not mapped. */
export function getCueAsset(cue: string): CueManifestEntry | undefined {
  return byCue.get(cue);
}

/** Lists manifest entries, optionally filtered by delivery mechanism. */
export function listCueAssets(delivery?: CueDelivery): CueManifestEntry[] {
  return delivery === undefined
    ? [...CUE_MANIFEST]
    : CUE_MANIFEST.filter((entry) => entry.delivery === delivery);
}

/**
 * The deterministic baked WAV filenames for a manifest entry, relative to
 * `public/`. Empty for entries with no baked variants.
 */
export function bakedAssetFiles(entry: CueManifestEntry): string[] {
  return entry.seeds.map((seed) => `audio/sfx/${entry.recipe}.${seed}.wav`);
}

/**
 * Seeds rendered for each recipe, pooled across every manifest entry that
 * references it. A recipe shared by several cues (e.g. `aihell-player-hull-breach`,
 * reused by both `playPlayerDestructionSound` and `playVolumeFeedback`) is
 * rendered once, so a cue that declares no seeds of its own can still resolve
 * the asset baked for its sibling.
 */
const seedsByRecipe = new Map<string, number[]>();
for (const entry of CUE_MANIFEST) {
  if (entry.seeds.length === 0) continue;
  const existing = seedsByRecipe.get(entry.recipe) ?? [];
  const merged = [...new Set([...existing, ...entry.seeds])];
  seedsByRecipe.set(entry.recipe, merged);
}

/**
 * The seed used to render an `existing-recipe` cue that declares no seeds of
 * its own. Falls back to the sibling-rendered seed for the same recipe, then
 * to the manifest's `defaultExistingRecipeSeed`.
 */
export function defaultSeedFor(entry: CueManifestEntry): number {
  if (entry.seeds.length > 0) return entry.seeds[0];
  const shared = seedsByRecipe.get(entry.recipe);
  if (shared !== undefined && shared.length > 0) return shared[0];
  return CUE_MANIFEST_META.defaultExistingRecipeSeed;
}

/**
 * The baked WAV filename for a manifest entry, relative to `public/`.
 *
 * `seed` overrides the default (used by per-phase cues such as
 * `playBossPhaseCue`); otherwise a seed is chosen from the entry's baked
 * variants (the first of the shared pool for `existing-recipe` cues).
 */
export function assetUrlFor(entry: CueManifestEntry, seed?: number): string {
  const chosen = seed ?? defaultSeedFor(entry);
  return `audio/sfx/${entry.recipe}.${chosen}.wav`;
}

/**
 * The baked WAV filename for a cue, or `undefined` when the cue is unmapped or
 * delivered by a runtime shim (no baked asset).
 */
export function cueAssetUrl(cue: string, seed?: number): string | undefined {
  const entry = getCueAsset(cue);
  if (entry === undefined || entry.delivery === 'runtime-shim') return undefined;
  return assetUrlFor(entry, seed);
}

/** The seeds baked for a cue (empty for `existing-recipe` / `runtime-shim`). */
export function cueSeeds(cue: string): readonly number[] {
  return getCueAsset(cue)?.seeds ?? [];
}

/**
 * Every baked WAV asset URL the runtime may play, de-duplicated. Derived from
 * the manifest so the preloader can never drift from the cue→asset contract.
 * Runtime-shim entries (the thruster hum) contribute no asset.
 */
export function allSfxAssetUrls(): string[] {
  const urls = new Set<string>();
  for (const entry of CUE_MANIFEST) {
    if (entry.delivery === 'runtime-shim') continue;
    for (const url of bakedAssetFiles(entry)) urls.add(url);
    if (entry.seeds.length === 0) urls.add(assetUrlFor(entry));
  }
  return [...urls];
}

/**
 * The JSON manifest metadata (directories, seeds) shared with the build
 * pipeline. Exposed for tests so the build and the runtime agree.
 */
export const CUE_MANIFEST_META = {
  recipeDirectory: manifest.recipeDirectory,
  outputDirectory: manifest.outputDirectory,
  checksumsFile: manifest.checksumsFile,
  defaultExistingRecipeSeed: manifest.defaultExistingRecipeSeed,
} as const;
