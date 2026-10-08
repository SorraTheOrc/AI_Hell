/**
 * Game SFX cues (GDD §7.3) — ToneForge baked-asset playback.
 *
 * Every sound-producing cue here is a thin wrapper that looks up its
 * ToneForge recipe in the cue manifest (`audio/toneforge/manifest.json`) and
 * plays the corresponding build-time baked WAV through the shared playback
 * layer ({@link module:audio/sfxPlayback}). The procedural Web Audio synthesis
 * this module used to contain was replaced by the migration tracked by
 * Switch game audio from procedural Web Audio to ToneForge (AH-0MUTUOB7X007PR9J);
 * the authoritative cue→recipe catalogue is
 * `docs/AUDIO_TONEFORGE_CUE_MAPPING.md`.
 *
 * The export surface is intentionally unchanged: cue names, argument
 * signatures, `setSfxVolume`/`setSfxMuted`, `getAudioContext`, the advance-cue
 * duration constants and the `_*ForTests` accessors are all preserved, so
 * consumers (`Player`, `CombatScene`, entity modules, `SettingsScene`) did not
 * change.
 *
 * Guarantees:
 * - **Exactly one shared `AudioContext`** — owned by the playback provider,
 *   pinned to Phaser's context at boot; a new scene/cue never constructs one
 *   (parent AC6).
 * - **Safe no-op without audio** — in headless tests and autoplay-blocked
 *   browsers every cue degrades to a no-op and never throws (parent AC7).
 * - **Gap-free advance cues** — the fire cue is scheduled at the advance
 *   cue's end so the two flow together with no gap (parent AC8).
 *
 * The continuous thruster hum is the single runtime-synthesised exception and
 * lives in `./thrusterShim`; `effects.ts` only delegates to it.
 */

import {
  allSfxAssetUrls,
  cueAssetUrl,
  cueSeeds,
} from './cueManifest';
import {
  WebAudioSfxProvider,
  webAudioSfxProvider,
  type SfxPlayOptions,
  type SfxSoundHandle,
  type SfxSoundProvider,
} from './sfxPlayback';
import {
  configureThrusterShim,
  resetThrusterHumForTests,
  stopThrusterHum,
  updateThrusterHum,
} from './thrusterShim';
import type { BeatClock } from '../utils/beat';

// Re-exported thruster-hum reference constants + test seams (moved to the shim
// module, kept exported from here so consumers/tests are unchanged).
export {
  THRUSTER_HUM_BASE_FREQ,
  THRUSTER_HUM_GROWTH_TIME,
  THRUSTER_HUM_MAX_VOLUME,
  THRUSTER_HUM_NOISE_FILTER_MAX,
  THRUSTER_HUM_NOISE_FILTER_MIN,
  THRUSTER_HUM_SHRINK_MULTIPLIER,
  THRUSTER_HUM_UNDERTONE_FREQ,
  _getThrusterHumStateForTests,
  _resetThrusterHumForTests,
} from './thrusterShim';

// ── Playback provider seam ──────────────────────────────────────────

let provider: SfxSoundProvider = webAudioSfxProvider;

configureThrusterShim({
  getContext: () => provider.getAudioContext(),
  getMasterGain: () =>
    provider instanceof WebAudioSfxProvider ? provider.getMasterGain() : null,
});

/**
 * Replaces the playback provider. `null` restores the default Web Audio
 * provider. Exposed so a scene can route playback onto Phaser's audio system
 * and so tests can inject a recording provider.
 */
export function setSfxSoundProvider(next: SfxSoundProvider | null): void {
  provider = next ?? webAudioSfxProvider;
}

/**
 * Boot-time wiring: pin the shared playback layer to the given Phaser sound
 * manager's context (when it exposes one) and warm the baked-asset cache.
 * Called from `MenuScene.create` so audio is ready before gameplay cues fire.
 */
export function installGameAudio(sound: unknown): void {
  const context =
    (sound as { context?: AudioContext | null } | null | undefined)?.context ??
    null;
  if (context !== null) provider.useAudioContext(context);
  void preloadSfxAssets();
}

/** Warms the decoded-buffer cache for every baked asset. Best-effort. */
export async function preloadSfxAssets(): Promise<void> {
  const active = provider;
  if (!(active instanceof WebAudioSfxProvider)) return;
  const context = active.getAudioContext();
  if (context === null) return;
  await Promise.all(
    allSfxAssetUrls().map((url) => active.loadAsset(context, url)),
  );
}

// ── Master volume / mute (parent AC5) ───────────────────────────────

/**
 * Sets the master SFX volume (0–1, clamped). Live: immediately affects
 * currently playing cues because all playback routes through the shared
 * master gain.
 */
export function setSfxVolume(value: number): void {
  provider.setVolume(value);
}

/**
 * Mutes/unmutes all SFX. `false` restores the last volume level. Live: the
 * master gain is updated immediately so playing cues are affected.
 */
export function setSfxMuted(on: boolean): void {
  provider.setMuted(on);
}

/** The shared `AudioContext`, or null when audio is unavailable. */
export function getAudioContext(): AudioContext | null {
  return provider.getAudioContext();
}

// ── Cue dispatch ────────────────────────────────────────────────────

/**
 * Resolves and plays a cue's baked asset. A multi-seed cue (baked pitch-jitter
 * variants) picks a variant at random so repeated kills still vary; a
 * single-seed or shared-recipe cue uses its resolved seed.
 */
function playCue(
  cue: string,
  options: SfxPlayOptions & { seed?: number } = {},
): SfxSoundHandle | null {
  const seed = options.seed ?? pickCueSeed(cue);
  const url = cueAssetUrl(cue, seed);
  if (url === undefined) return null;
  return provider.play(url, options);
}

/** Picks a baked seed variant for a cue (random when several are baked). */
function pickCueSeed(cue: string): number | undefined {
  const seeds = cueSeeds(cue);
  if (seeds.length === 0) return undefined;
  if (seeds.length === 1) return seeds[0];
  return seeds[Math.floor(Math.random() * seeds.length)];
}

// ── Beat-synchronised explosion accents (AH-0MV01HNLU008S5E3) ────────
//
// Player weapon fire is already phase-locked to a silent beat grid
// (`utils/beat`). The non-weapon destruction booms used to fire on the
// exact kill frame, so they landed at arbitrary offsets against that grid.
// These cues are instead scheduled onto the next **16th note** of the
// current tempo, giving a burst of kills one rhythmic accent. The
// quantisation lives here, once, so the game and every gym behave
// identically; VFX stays on the death frame (audio only).

/**
 * Subdivisions per beat for the explosion accent grid: a **16th note**
 * (4 per beat). At the default 80 BPM that is 187.5 ms.
 */
export const EXPLOSION_ACCENT_SUBDIVISIONS = 4;

/**
 * Maximum number of explosion cues allowed to land on one accent tick.
 * Several kills inside a single 16th-note window stack into one rhythmic
 * accent; this caps the stack so a mass kill cannot clip the mix. Tunable
 * in one place (AC4).
 */
export const EXPLOSION_PER_TICK_CAP = 4;

/** Epsilon (ms) for grouping requests into the same accent tick. */
const ACCENT_TICK_EPSILON = 1e-6;

let accentClock: BeatClock | null = null;
let accentTickMs: number | null = null;
let accentCount = 0;

/**
 * Registers the scene's shared beat clock so the non-weapon destruction
 * cues ({@link playDestructionSound}, {@link playDiverDestructionSound},
 * {@link playPlayerDestructionSound}) are scheduled onto the next 16th note
 * of the current tempo. Pass `null` to detach (scene teardown) and restore
 * immediate playback.
 *
 * This is the single shared audio seam: `CombatCoreScene` registers its one
 * clock on reset and detaches it on teardown, so the game and every gym
 * quantise identically with no per-scene copy (AGENTS.md gym↔game parity).
 * A (re)registered clock also opens a fresh accent window, so a scene
 * restart resets the grid to origin without inheriting the previous run's
 * per-tick count (AC6).
 */
export function setExplosionBeatClock(clock: BeatClock | null): void {
  accentClock = clock;
  accentTickMs = null;
  accentCount = 0;
}

/**
 * Resolves the `delay` (seconds) for an explosion cue: the **game-time**
 * distance to the next 16th-note tick. Returns `0` when no clock is
 * registered or the request is already on a tick, and `null` when the
 * per-tick cap is exhausted (the cue is dropped).
 *
 * The delay is derived from the game-time distance to the tick
 * (`nextTick(now) - now`), never a wall-clock read, so a paused scene whose
 * clock does not advance cannot queue audio into the future.
 */
function nextExplosionAccentDelaySeconds(): number | null {
  const clock = accentClock;
  if (clock === null) return 0;
  const nowMs = clock.now();
  const delayMs = clock.nextSubdivisionDelayMs(EXPLOSION_ACCENT_SUBDIVISIONS);
  const tickMs = nowMs + delayMs;
  if (accentTickMs === null || Math.abs(tickMs - accentTickMs) > ACCENT_TICK_EPSILON) {
    accentTickMs = tickMs;
    accentCount = 0;
  }
  if (accentCount >= EXPLOSION_PER_TICK_CAP) return null;
  accentCount += 1;
  return Math.max(0, delayMs / 1000);
}

/**
 * Plays an explosion cue on the next accent tick, dropping it when the
 * per-tick cap is already reached. `options` carry the cue's own settings
 * (e.g. volume); the accent `delay` is always applied on top.
 */
function playExplosionCue(cue: string, options: SfxPlayOptions = {}): void {
  const delay = nextExplosionAccentDelaySeconds();
  if (delay === null) return;
  playCue(cue, { ...options, delay });
}

// ── Advance cues (parent AC8: ≥ 500 ms, gap-free) ───────────────────

/**
 * Duration (seconds) of the Tank advance whine. The fire cue is scheduled at
 * this offset so the whine flows into the cannon thump with no dead gap.
 */
export const TANK_ADVANCE_CUE_DURATION = 0.6;

/** Rising mechanical whine — E3 Tank firing advance cue. */
export function playTankAdvanceCue(): void {
  playCue('playTankAdvanceCue');
}

/** Heavy low cannon thump — E3 Tank fire, scheduled at the advance cue's end. */
export function playTankFireSound(): void {
  playCue('playTankFireSound', { delay: TANK_ADVANCE_CUE_DURATION });
}

/** Duration (seconds) of the Phaser advance tell. */
export const PHASER_ADVANCE_CUE_DURATION = 0.6;

/** Rising warning blip — E4 Phaser firing advance cue. */
export function playPhaserAdvanceCue(): void {
  playCue('playPhaserAdvanceCue');
}

/** Short sharp blip — E4 Phaser fire, scheduled at the advance cue's end. */
export function playPhaserFireSound(): void {
  playCue('playPhaserFireSound', { delay: PHASER_ADVANCE_CUE_DURATION });
}

/** Duration (seconds) of the Scout advance tell. */
export const SCOUT_ADVANCE_CUE_DURATION = 0.6;

/** Rising warning blip — E1 Scout firing advance cue. */
export function playScoutAdvanceCue(): void {
  playCue('playScoutAdvanceCue');
}

/** Sharp laser blip — E1 Scout fire, scheduled at the advance cue's end. */
export function playScoutFireSound(): void {
  playCue('playScoutFireSound', { delay: SCOUT_ADVANCE_CUE_DURATION });
}

// ── Enemy cues ──────────────────────────────────────────────────────

/** Rising square blip — enemy spawn cue. */
export function playSpawnSound(): void {
  playCue('playSpawnSound');
}

/** Descending saw burst — enemy destruction cue (multi-seed jitter). */
export function playDestructionSound(): void {
  playExplosionCue('playDestructionSound');
}

/** Heavier layered "hull breach" boom — player destruction (volume-scaled). */
export function playPlayerDestructionSound(volumeScale = 1): void {
  playExplosionCue('playPlayerDestructionSound', { volume: volumeScale });
}

/** Short high tick — player bullet destroys an enemy bullet. */
export function playBulletDestructionSound(): void {
  playCue('playBulletDestructionSound');
}

/** Buzzing whoosh — Swarm coordinated-burst volley. */
export function playSwarmBurstSound(): void {
  playCue('playSwarmBurstSound');
}

/** Rising whoosh — Diver dive-start cue. */
export function playDiverDiveStartSound(): void {
  playCue('playDiverDiveStartSound');
}

/** Duration (seconds) of the sustained dive sound (matches the ~2 s dive). */
export const DIVER_DIVE_SOUND_DURATION = 2;

/** Shared continuous dive whoosh. Concurrent dives reuse one playback. */
let diveSound: SfxSoundHandle | null = null;

/** Starts (or shares) the sustained dive whoosh — ~2 s. */
export function playDiveSound(): void {
  if (diveSound !== null) return;
  diveSound = playCue('playDiveSound');
}

/** Releases the sustained dive whoosh. Safe no-op when none is active. */
export function stopDiveSound(): void {
  if (diveSound === null) return;
  diveSound.stop();
  diveSound = null;
}

/** For tests: the active dive-sound state, or null when not playing. */
export function _getDiverDiveSoundStateForTests(): { active: boolean } | null {
  return diveSound === null ? null : { active: true };
}

/** Short low crack — Diver fire cue. */
export function playDiverFireSound(): void {
  playCue('playDiverFireSound');
}

/** Deep resonant fall — Diver destruction cue (multi-seed jitter). */
export function playDiverDestructionSound(): void {
  playExplosionCue('playDiverDestructionSound');
}

/** Deep resonant boom — Boss fire cue. */
export function playBossFireSound(): void {
  playCue('playBossFireSound');
}

// ── Player weapon fire cues ─────────────────────────────────────────

/** Solid medium blip — Cannon fire. */
export function playCannonFireSound(): void {
  playCue('playCannonFireSound');
}

/** Wide multi-tone sweep — Spread fire. */
export function playSpreadFireSound(): void {
  playCue('playSpreadFireSound');
}

/** Sharp crack — Dual fire. */
export function playDualFireSound(): void {
  playCue('playDualFireSound');
}

/** Tight staccato blip — Rapid fire. */
export function playRapidFireSound(): void {
  playCue('playRapidFireSound');
}

/** Deep expanding thump + rising ring — Nova fire. */
export function playNovaFireSound(): void {
  playCue('playNovaFireSound');
}

/** Muffled launch thump — Mortar fire. */
export function playMortarFireSound(): void {
  playCue('playMortarFireSound');
}

/** Heavy blast — Mortar detonation. */
export function playMortarDetonationSound(): void {
  playCue('playMortarDetonationSound');
}

/** Bright electric zap — Arc fire. */
export function playArcFireSound(): void {
  playCue('playArcFireSound');
}

// ── Pickup activation cues ──────────────────────────────────────────

/** Cheerful two-tone chime — power-up collection. */
export function playPowerUpCollectSound(): void {
  playCue('playPowerUpCollectSound');
}

/** Bright ascending blip — power-up spawn. */
export function playPowerUpSpawnSound(): void {
  playCue('playPowerUpSpawnSound');
}

/** Quick descending blip — power-up despawn. */
export function playPowerUpDespawnSound(): void {
  playCue('playPowerUpDespawnSound');
}

/** Short percussive pop — power-up collection tactile feedback. */
export function playPowerUpCollectPopSound(): void {
  playCue('playPowerUpCollectPopSound');
}

/** Widening fan sweep — Spread pickup activation. */
export function playSpreadPickupSound(): void {
  playCue('playSpreadPickupSound');
}

/** Crisp two-note crack — Dual pickup activation. */
export function playDualPickupSound(): void {
  playCue('playDualPickupSound');
}

/** Accelerating rise — Rapid pickup activation. */
export function playRapidPickupSound(): void {
  playCue('playRapidPickupSound');
}

/** Gentle unwind to baseline — Reset (back to Cannon) activation. */
export function playResetPickupSound(): void {
  playCue('playResetPickupSound');
}

/** Quick ascending zip — Speed Boost activation. */
export function playSpeedBoostCollectSound(): void {
  playCue('playSpeedBoostCollectSound');
}

/** Warm two-note chime — Extra Life activation. */
export function playExtraLifeCollectSound(): void {
  playCue('playExtraLifeCollectSound');
}

/** Magnetic pulse-hum — Magnet activation. */
export function playMagnetCollectSound(): void {
  playCue('playMagnetCollectSound');
}

/** Rising chirp + whoosh — Phase Shift activation. */
export function playPhaseShiftSound(): void {
  playCue('playPhaseShiftSound');
}

// ── End-of-run cues ─────────────────────────────────────────────────

/** Two-phrase fanfare — run victory. */
export function playVictoryFanfareSound(): void {
  playCue('playVictoryFanfareSound');
}

/** Descending sombre sting — run defeat. */
export function playDefeatStingSound(): void {
  playCue('playDefeatStingSound');
}

// ── Victory firework cues (AH-0MUWZ5HCV0034H44) ────────────────────
//
// The sustained victory celebration layers exploded/firework SFX on top of
// the fanfare. Each cue is a baked asset with per-burst pitch-jitter variants
// so a long sequence does not sound like one repeated sample. `options.delay`
// (seconds) lets `spawnVictoryFireworks` schedule a cue to land with its
// matching visual burst without per-burst timers.

/** Explosive boom — grand victory firework burst (multi-seed jitter). */
export function playVictoryExplosionSound(
  options: SfxPlayOptions & { seed?: number } = {},
): void {
  playCue('playVictoryExplosionSound', options);
}

/** Sharp crack — mid-size victory firework (multi-seed jitter). */
export function playVictoryCrackSound(
  options: SfxPlayOptions & { seed?: number } = {},
): void {
  playCue('playVictoryCrackSound', options);
}

/** Soft pop — small victory firework / spark burst (multi-seed jitter). */
export function playVictoryPopSound(
  options: SfxPlayOptions & { seed?: number } = {},
): void {
  playCue('playVictoryPopSound', options);
}

/** Bright shimmer — victory sparkle / spark trail (multi-seed jitter). */
export function playVictorySparkleSound(
  options: SfxPlayOptions & { seed?: number } = {},
): void {
  playCue('playVictorySparkleSound', options);
}

// ── Boss cues (migrated from Boss.ts inline `blip` synthesis) ────────

/** Low rumble — Boss spawn. */
export function playBossSpawnSound(): void {
  playCue('playBossSpawnSound');
}

/** Rising tone — Boss phase transition. */
export function playBossPhaseTransitionSound(): void {
  playCue('playBossPhaseTransitionSound');
}

/** Heavy deep fall — Boss destruction. */
export function playBossDestructionSound(): void {
  playCue('playBossDestructionSound');
}

/**
 * Per-phase Boss attack telegraph audio. Each of the four phases maps to its
 * own baked variant (seeds 32204–32207), so the tell is distinct per phase.
 */
export function playBossPhaseCue(phase: number): void {
  const seeds = cueSeeds('playBossPhaseCue');
  const index =
    seeds.length === 0
      ? -1
      : Math.min(Math.max(Math.floor(phase) - 1, 0), seeds.length - 1);
  playCue('playBossPhaseCue', index < 0 ? {} : { seed: seeds[index] });
}

// ── Thruster hum (runtime shim delegation) ──────────────────────────

/** Sustained thrust-driven hum. Delegates to the runtime shim (no-op headless). */
export function updateThrusterSound(level: number): void {
  updateThrusterHum(level);
}

/** Stops and frees the thruster hum. Delegates to the runtime shim. */
export function stopThrusterSound(): void {
  stopThrusterHum();
}

// ── Volume-change feedback ──────────────────────────────────────────

/**
 * Plays the player-destruction cue at the selected gain as volume feedback
 * (AH-0MUADK77K008RBMB). Pitch is unchanged; `volume` in [0, 1] scales every
 * layer and is clamped. Volume 0 plays nothing. Routed through the master
 * gain so it respects mute/volume.
 */
export function playVolumeFeedback(volume: number): void {
  // Volume-preview feedback is UI, not a gameplay explosion: play the cue
  // immediately so a registered gameplay beat clock never delays it.
  playCue('playPlayerDestructionSound', { volume });
}

// ── Test seams ──────────────────────────────────────────────────────

/**
 * Resets the playback layer: restores the default provider, forgets the
 * context/master gain/decoded buffers and clears the runtime-shim voices.
 * Production code never calls this; tests swap `window.AudioContext` between
 * the recording double and the absence case.
 */
export function _resetAudioContextForTests(): void {
  provider = webAudioSfxProvider;
  webAudioSfxProvider.reset();
  resetThrusterHumForTests();
  diveSound = null;
  accentClock = null;
  accentTickMs = null;
  accentCount = 0;
}
