/**
 * Cue → ToneForge asset manifest (single source of truth).
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
export const CONTROL_CUES = ['stopDiveSound', 'stopThrusterSound'] as const;

/**
 * Cues retired by the migration (no asset, removed from `effects.ts`).
 * See `docs/AUDIO_TONEFORGE_CUE_MAPPING.md` §"Retired cues" for the
 * consumer-analysis evidence.
 */
export const RETIRED_CUES = [
  'playMajorExplosionSound',
  'playTankDestructionSound',
  'playWeaponChangeSound',
] as const;

/** Every retained, sound-producing cue and its ToneForge mapping. */
export const CUE_MANIFEST: readonly CueManifestEntry[] = [
  // ── Existing ToneForge recipes (reused unchanged) ──────────────────
  { cue: 'playPowerUpCollectSound', recipe: 'card-token-earn', delivery: 'existing-recipe', seeds: [] },
  { cue: 'playScoutFireSound', recipe: 'weapon-laser-zap', delivery: 'existing-recipe', seeds: [] },
  { cue: 'playVolumeFeedback', recipe: 'aihell-player-hull-breach', delivery: 'existing-recipe', seeds: [] },

  // ── Baked game-specific recipes (seed block 32100–32199) ───────────
  { cue: 'playSpawnSound', recipe: 'aihell-enemy-spawn', delivery: 'baked', seeds: [32101] },
  { cue: 'playDestructionSound', recipe: 'aihell-enemy-destruction', delivery: 'baked', seeds: [32110, 32111, 32112] },
  { cue: 'playPlayerDestructionSound', recipe: 'aihell-player-hull-breach', delivery: 'baked', seeds: [32120] },
  { cue: 'playBulletDestructionSound', recipe: 'aihell-bullet-destruction', delivery: 'baked', seeds: [32130] },
  { cue: 'playTankAdvanceCue', recipe: 'aihell-tank-advance', delivery: 'baked', seeds: [32140] },
  { cue: 'playTankFireSound', recipe: 'aihell-tank-fire', delivery: 'baked', seeds: [32141] },
  { cue: 'playPowerUpSpawnSound', recipe: 'aihell-pickup-spawn', delivery: 'baked', seeds: [32150] },
  { cue: 'playPowerUpDespawnSound', recipe: 'aihell-pickup-despawn', delivery: 'baked', seeds: [32151] },
  { cue: 'playPowerUpCollectPopSound', recipe: 'aihell-pickup-pop', delivery: 'baked', seeds: [32152] },
  { cue: 'playSwarmBurstSound', recipe: 'aihell-swarm-burst', delivery: 'baked', seeds: [32160] },
  { cue: 'playPhaserAdvanceCue', recipe: 'aihell-phaser-advance', delivery: 'baked', seeds: [32170] },
  { cue: 'playPhaserFireSound', recipe: 'aihell-phaser-fire', delivery: 'baked', seeds: [32171] },
  { cue: 'playScoutAdvanceCue', recipe: 'aihell-scout-advance', delivery: 'baked', seeds: [32180] },
  { cue: 'playDiverDiveStartSound', recipe: 'aihell-diver-dive-start', delivery: 'baked', seeds: [32190] },
  { cue: 'playDiveSound', recipe: 'aihell-diver-dive-loop', delivery: 'baked', seeds: [32191] },
  { cue: 'playDiverFireSound', recipe: 'aihell-diver-fire', delivery: 'baked', seeds: [32192] },
  { cue: 'playDiverDestructionSound', recipe: 'aihell-diver-destruction', delivery: 'baked', seeds: [32193, 32194, 32195] },
  { cue: 'playBossFireSound', recipe: 'aihell-boss-fire', delivery: 'baked', seeds: [32200] },
  { cue: 'playCannonFireSound', recipe: 'aihell-cannon-fire', delivery: 'baked', seeds: [32210] },
  { cue: 'playSpreadFireSound', recipe: 'aihell-spread-fire', delivery: 'baked', seeds: [32211] },
  { cue: 'playDualFireSound', recipe: 'aihell-dual-fire', delivery: 'baked', seeds: [32212] },
  { cue: 'playRapidFireSound', recipe: 'aihell-rapid-fire', delivery: 'baked', seeds: [32213] },
  { cue: 'playNovaFireSound', recipe: 'aihell-nova-fire', delivery: 'baked', seeds: [32214] },
  { cue: 'playMortarFireSound', recipe: 'aihell-mortar-fire', delivery: 'baked', seeds: [32215] },
  { cue: 'playMortarDetonationSound', recipe: 'aihell-mortar-detonation', delivery: 'baked', seeds: [32216] },
  { cue: 'playArcFireSound', recipe: 'aihell-arc-fire', delivery: 'baked', seeds: [32217] },
  { cue: 'playSpreadPickupSound', recipe: 'aihell-pickup-spread', delivery: 'baked', seeds: [32220] },
  { cue: 'playDualPickupSound', recipe: 'aihell-pickup-dual', delivery: 'baked', seeds: [32221] },
  { cue: 'playRapidPickupSound', recipe: 'aihell-pickup-rapid', delivery: 'baked', seeds: [32222] },
  { cue: 'playResetPickupSound', recipe: 'aihell-pickup-reset', delivery: 'baked', seeds: [32223] },
  { cue: 'playSpeedBoostCollectSound', recipe: 'aihell-pickup-speed', delivery: 'baked', seeds: [32224] },
  { cue: 'playExtraLifeCollectSound', recipe: 'aihell-pickup-extralife', delivery: 'baked', seeds: [32225] },
  { cue: 'playMagnetCollectSound', recipe: 'aihell-pickup-magnet', delivery: 'baked', seeds: [32226] },
  { cue: 'playPhaseShiftSound', recipe: 'aihell-phase-shift', delivery: 'baked', seeds: [32230] },
  { cue: 'playVictoryFanfareSound', recipe: 'aihell-victory-fanfare', delivery: 'baked', seeds: [32240] },
  { cue: 'playDefeatStingSound', recipe: 'aihell-defeat-sting', delivery: 'baked', seeds: [32241] },

  // ── Boss cues authored inline in src/entities/Boss.ts ──────────────
  { cue: 'playBossSpawnSound', recipe: 'aihell-boss-spawn', delivery: 'baked', seeds: [32201] },
  { cue: 'playBossPhaseTransitionSound', recipe: 'aihell-boss-phase-transition', delivery: 'baked', seeds: [32202] },
  { cue: 'playBossDestructionSound', recipe: 'aihell-boss-destruction', delivery: 'baked', seeds: [32203] },
  { cue: 'playBossPhaseCue', recipe: 'aihell-boss-phase-cue', delivery: 'baked', seeds: [32204, 32205, 32206, 32207] },

  // ── Continuous thruster hum (runtime Tone.js shim, not baked) ──────
  { cue: 'updateThrusterSound', recipe: 'aihell-thruster-hum', delivery: 'runtime-shim', seeds: [] },
];

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
