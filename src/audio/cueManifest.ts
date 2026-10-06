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
 * The JSON manifest metadata (directories, seeds) shared with the build
 * pipeline. Exposed for tests so the build and the runtime agree.
 */
export const CUE_MANIFEST_META = {
  recipeDirectory: manifest.recipeDirectory,
  outputDirectory: manifest.outputDirectory,
  checksumsFile: manifest.checksumsFile,
  defaultExistingRecipeSeed: manifest.defaultExistingRecipeSeed,
} as const;
