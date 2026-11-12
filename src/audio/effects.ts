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
import { cueVoiceLimiter } from './cueVoiceLimiter';
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
  setThrusterBeatClock,
  stopThrusterHum,
  updateThrusterHum,
} from './thrusterShim';
import type { BeatClock } from '../utils/beat';
import type { ThrusterHumProfile } from '../utils/thrusterProfile';
import type { WeaponId } from '../utils/weapons';

// Re-exported thruster-hum reference constants + test seams (moved to the shim
// module, kept exported from here so consumers/tests are unchanged).
export {
  THRUSTER_HUM_AMPLITUDE_MODULATION_DEPTH,
  THRUSTER_HUM_BASE_FREQ,
  THRUSTER_HUM_CANNON_SUBDIVISIONS,
  THRUSTER_HUM_GROWTH_TIME,
  THRUSTER_HUM_MAX_VOLUME,
  THRUSTER_HUM_NOISE_FILTER_MAX,
  THRUSTER_HUM_NOISE_FILTER_MIN,
  THRUSTER_HUM_SHRINK_MULTIPLIER,
  THRUSTER_HUM_SIDE_PITCH_SCALE,
  THRUSTER_HUM_SIDE_VOLUME_SCALE,
  THRUSTER_HUM_UNDERTONE_FREQ,
  _getThrusterHumStateForTests,
  _resetThrusterHumForTests,
} from './thrusterShim';

export type { ThrusterHumProfile } from '../utils/thrusterProfile';

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
  // Per-cue concurrent-voice cap (AH-0MVH8RQR7007QG8E): a dense firefight or
  // mass kill can dispatch dozens of identical cues in one instant, which
  // clips the mix. Requests beyond the cap are dropped here, at the single
  // funnel every cue uses, so the game and every gym are limited identically.
  // Beat-scheduled accents (`delay`) are exempt: they are already capped per
  // accent tick (`EXPLOSION_PER_TICK_CAP`) and are dispatched together, so
  // applying the concurrency window would drop the tail of a valid accent.
  if (!options.delay && !cueVoiceLimiter.allow(cue)) return null;
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

// ── Family mix trims (AH-0MVZVMZOQ00076QF) ──────────────────────────
//
// The producer asked for "the audio for explosions and enemy weapons" to come
// down by around 40%. The trim is a **runtime** mix change (linear ×0.6) so the
// baked WAVs, ToneForge recipes and `public/audio/sfx/checksums.json` stay
// untouched and the amplitude-tier / A-minor balance guards remain green — the
// same mechanism as the earlier per-sequence trims
// (`TANK_SCOUT_FIRE_VOLUME_SCALE`, `PHASER_FIRE_VOLUME_SCALE`,
// `HOLD_FULL_FIRE_VOLUME_SCALE`).
//
// One named tunable per family keeps the whole trim retunable in one place.
// Both **compose multiplicatively** with the existing per-cue scales and any
// caller-supplied `volume` — they never replace them — so the relative balance
// between cues (and every scripted caller trim) is preserved.

/**
 * Linear gain applied to the **enemy weapon fire family** — Tank/Scout/Phaser
 * advance+fire, Diver fire, Boss fire and the Swarm burst — on top of the
 * existing per-sequence scales (`TANK_SCOUT_FIRE_VOLUME_SCALE` /
 * `PHASER_FIRE_VOLUME_SCALE`), so the family sits 40% lower than before
 * (AH-0MVZVMZOQ00076QF). The advance (warmup) tells are part of the same
 * audible fire sequence and are trimmed with it, matching the earlier
 * Tank/Scout decision (AH-0MV74ROYR009X8U3).
 *
 * `playSwarmBurstSound` belongs to both the enemy-fire and explosion families
 * by producer definition; it is scaled **exactly once**, here.
 */
export const ENEMY_WEAPON_FIRE_VOLUME_SCALE = 0.6;

/**
 * Linear gain applied to the **explosion / destruction family** — enemy,
 * Diver, Boss and player destruction, the victory-explosion boom, the
 * bullet-destruction tick (and its enemy-force-field-break alias) and the Boss
 * hit cue — so the family sits 40% lower than before (AH-0MVZVMZOQ00076QF).
 *
 * Composes multiplicatively with a caller-supplied `volume` (the mini-boss
 * death sweep's per-role trims, the victory firework volume and the player
 * death `volumeScale`), never replacing it.
 */
export const EXPLOSION_VOLUME_SCALE = 0.6;

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
 *
 * Deliberately unchanged by the Euclidean fire scheduler
 * (AH-0MVYA1V8Z009SHMR): weapon fire moved from interval scheduling to
 * pattern onsets, but the non-weapon destruction accent keeps its shipped
 * snap-to-next-16th behaviour and per-tick cap (regression-guarded in
 * `src/audio/effects.test.ts` §6). Weapon-kill impacts are off-grid by
 * construction (fire time + flight time), so this accent is the one place the
 * audio deliberately re-aligns a gameplay event to the bar.
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

// ── Thruster-hum beat pulse (AH-0MV01G4NL009JK92) ───────────────────
//
// The player thruster hum is phase-locked to the same shared beat clock and
// modulated on the cannon cadence (2 subdivisions/beat) while thrusting: an
// amplitude tremolo (the loudness "beat") plus a counter-phase band-pass
// sweep on the noise filter. The clock is forwarded unchanged to the runtime
// shim (see the re-exported {@link setThrusterBeatClock}), so the game and
// every gym pulse identically with no per-scene copy (AGENTS.md gym↔game
// parity). `CombatCoreScene` registers/detaches it in the same lifecycle
// calls as {@link setExplosionBeatClock}. No clock registered ⇒ the shim
// skips modulation (flat level-scaled hum) and stays a safe no-op.

/**
 * Forwards the scene's shared beat clock to the thruster-hum shim so the
 * hum pulses on the cannon cadence (`THRUSTER_HUM_CANNON_SUBDIVISIONS`
 * subdivisions per beat = 375 ms at the default 80 BPM) while thrusting:
 * an amplitude tremolo plus a counter-phase band-pass sweep on the same
 * grid. Pass `null` to detach (scene teardown) and restore the plain
 * level-scaled hum. Safe no-op in both directions (AC4).
 */
export { setThrusterBeatClock };

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
 *
 * An **explicit** `options.delay` marks a scripted, caller-scheduled display
 * (the mini-boss death sweep): it is played at exactly that offset instead of
 * being snapped to the beat grid, and it never spends the per-tick accent
 * budget (that budget exists to cap a mass kill, not a pre-planned cascade).
 */
function playExplosionCue(cue: string, options: SfxPlayOptions = {}): void {
  if (options.delay !== undefined) {
    playCue(cue, options);
    return;
  }
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

/** Rising mechanical whine — E3 Tank firing advance cue (runtime-trimmed). */
export function playTankAdvanceCue(): void {
  playCue('playTankAdvanceCue', {
    volume: TANK_SCOUT_FIRE_VOLUME_SCALE * ENEMY_WEAPON_FIRE_VOLUME_SCALE,
  });
}

/**
 * Linear gain applied to the Tank/Scout enemy **fire sequence** — the
 * advance whine/blip *and* the shot cue — so enemy fire sits at half volume
 * in the mix (AH-0MV74ROYR009X8U3). It composes with the enemy-weapon family
 * trim (`ENEMY_WEAPON_FIRE_VOLUME_SCALE` ×0.6, AH-0MVZVMZOQ00076QF) for an
 * effective 0.30. The producer confirmed the advance
 * (warmup) cues are part of the reduction. A single named constant keeps
 * the trim tunable in one place (precedent: `HOLD_FULL_FIRE_VOLUME_SCALE`).
 */
export const TANK_SCOUT_FIRE_VOLUME_SCALE = 0.5;

/** Heavy low cannon thump — E3 Tank fire, scheduled at the advance cue's end. */
export function playTankFireSound(): void {
  playCue('playTankFireSound', {
    delay: TANK_ADVANCE_CUE_DURATION,
    volume: TANK_SCOUT_FIRE_VOLUME_SCALE * ENEMY_WEAPON_FIRE_VOLUME_SCALE,
  });
}

/** Duration (seconds) of the Phaser advance tell. */
export const PHASER_ADVANCE_CUE_DURATION = 0.6;

/**
 * Linear gain applied to the Phaser **fire sequence** — the advance tell *and*
 * the shot cue — so it sits level with the Tank/Scout advance+fire pairs in
 * the mix (AH-0MVFHE6VP006GEX0). Those pairs already run through
 * `TANK_SCOUT_FIRE_VOLUME_SCALE` (0.5×), so an unscaled Phaser sequence read
 * ~6 dB louder by ear even though its baked assets sit inside the AC2 Subtle
 * amplitude tier. This is a deliberate runtime-trim deviation from the parent
 * constraint that prefers baked-asset balance: the baked Phaser assets are
 * already correctly tiered and pinned by the balance guard, so the audible
 * defect is the missing playback trim, expressed through the same named-constant
 * mechanism as `TANK_SCOUT_FIRE_VOLUME_SCALE` and `HOLD_FULL_FIRE_VOLUME_SCALE`.
 */
export const PHASER_FIRE_VOLUME_SCALE = 0.5;

/** Rising warning blip — E4 Phaser firing advance cue (runtime-trimmed). */
export function playPhaserAdvanceCue(): void {
  playCue('playPhaserAdvanceCue', {
    volume: PHASER_FIRE_VOLUME_SCALE * ENEMY_WEAPON_FIRE_VOLUME_SCALE,
  });
}

/** Short sharp blip — E4 Phaser fire, scheduled at the advance cue's end (runtime-trimmed). */
export function playPhaserFireSound(): void {
  playCue('playPhaserFireSound', {
    delay: PHASER_ADVANCE_CUE_DURATION,
    volume: PHASER_FIRE_VOLUME_SCALE * ENEMY_WEAPON_FIRE_VOLUME_SCALE,
  });
}

/** Duration (seconds) of the Scout advance tell. */
export const SCOUT_ADVANCE_CUE_DURATION = 0.6;

/** Rising warning blip — E1 Scout firing advance cue (runtime-trimmed). */
export function playScoutAdvanceCue(): void {
  playCue('playScoutAdvanceCue', {
    volume: TANK_SCOUT_FIRE_VOLUME_SCALE * ENEMY_WEAPON_FIRE_VOLUME_SCALE,
  });
}

/**
 * High square laser sweep (baked `aihell-scout-fire`, seed 32181) — E1 Scout
 * fire, scheduled at the advance cue's end. AC4 (AH-0MVCRR2H2007VPDU)
 * swapped the near-clipping existing-recipe `weapon-laser-zap` for this
 * in-repo recipe; runtime volume scaling is unchanged.
 */
export function playScoutFireSound(): void {
  playCue('playScoutFireSound', {
    delay: SCOUT_ADVANCE_CUE_DURATION,
    volume: TANK_SCOUT_FIRE_VOLUME_SCALE * ENEMY_WEAPON_FIRE_VOLUME_SCALE,
  });
}

// ── Enemy cues ──────────────────────────────────────────────────────

/** Rising square blip — enemy spawn cue. */
export function playSpawnSound(): void {
  playCue('playSpawnSound');
}

/**
 * Descending saw burst — enemy destruction cue (multi-seed jitter).
 *
 * Accepts per-play {@link SfxPlayOptions}; an explicit `delay` (seconds) is
 * honoured verbatim for caller-scheduled displays such as the mini-boss death
 * sweep, otherwise the cue is quantised onto the shared beat grid. An explicit
 * `seed` pins one of the three baked variants (the sweep draws it from the run
 * seed so a seed replays the same audio); without one a variant is picked at
 * random per play, as before.
 */
export function playDestructionSound(
  options: SfxPlayOptions & { seed?: number } = {},
): void {
  playExplosionCue('playDestructionSound', {
    ...options,
    // Compose the family trim with any caller volume instead of replacing it.
    volume: (options.volume ?? 1) * EXPLOSION_VOLUME_SCALE,
  });
}

/** Heavier layered "hull breach" boom — player destruction (volume-scaled). */
export function playPlayerDestructionSound(volumeScale = 1): void {
  playExplosionCue('playPlayerDestructionSound', {
    volume: volumeScale * EXPLOSION_VOLUME_SCALE,
  });
}

/** Short high tick — player bullet destroys an enemy bullet. */
export function playBulletDestructionSound(): void {
  playCue('playBulletDestructionSound', { volume: EXPLOSION_VOLUME_SCALE });
}

/** Buzzing whoosh — Swarm coordinated-burst volley. */
export function playSwarmBurstSound(): void {
  // Swarm burst is in both the enemy-fire and explosion families by producer
  // definition; scaling it exactly once (here) keeps it at 0.6, not 0.36.
  playCue('playSwarmBurstSound', { volume: ENEMY_WEAPON_FIRE_VOLUME_SCALE });
}

/** Rising whoosh — Diver dive-start cue. */
export function playDiverDiveStartSound(): void {
  playCue('playDiverDiveStartSound');
}

/**
 * Advisory duration (seconds) of the sustained dive sound loop. The loop is
 * explicitly stopped at dive end/destroy, so this constant is documentation
 * only — the dive duration itself is variable (fixed-speed model,
 * AH-0MW0TY1AY003TDFC: `max(pathLength / diveSpeed, MIN_DIVE_DURATION)`),
 * not a fixed 2 s dive. No runtime behaviour depends on this value.
 */
export const DIVER_DIVE_SOUND_DURATION = 2;

/** Shared continuous dive whoosh. Concurrent dives reuse one playback. */
let diveSound: SfxSoundHandle | null = null;

/** Starts (or shares) the sustained dive whoosh — stopped at dive end. */
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
  playCue('playDiverFireSound', { volume: ENEMY_WEAPON_FIRE_VOLUME_SCALE });
}

/** Deep resonant fall — Diver destruction cue (multi-seed jitter). */
export function playDiverDestructionSound(): void {
  playExplosionCue('playDiverDestructionSound', {
    volume: EXPLOSION_VOLUME_SCALE,
  });
}

// ── Mystery UFO feel cues (AH-0MVSAJMLL00835T8) ────────────────────
//
// The Mystery UFO collector drone's juice runs through the same baked-asset
// pipeline as every other cue. Only the wrappers ship here; the feel slices
// (warble lifecycle, terminal reward/destruction feedback) call them from the
// shared core. The warble is a **looping** continuous cue with a stop
// companion, mirroring `playDiveSound`/`stopDiveSound`.

/** Shared looping UFO warble voice. Concurrent calls reuse one playback. */
let mysteryUfoWarbleSound: SfxSoundHandle | null = null;

/**
 * Starts (or shares) the looping "woo-woo-woo" Mystery UFO warble.
 *
 * The baked asset is looped for the whole sortie (seek + collect), so the
 * caller starts it once at spawn and releases it with
 * {@link stopMysteryUfoWarbleSound} on every terminal path (return, payout,
 * destruction, teardown). Repeated calls are a safe no-op that keeps the one
 * voice, so a re-entered tick cannot stack warbles.
 */
export function playMysteryUfoWarbleSound(): void {
  if (mysteryUfoWarbleSound !== null) return;
  mysteryUfoWarbleSound = playCue('playMysteryUfoWarbleSound', { loop: true });
}

/**
 * Releases the looping Mystery UFO warble. Safe no-op when none is active.
 * Control companion to {@link playMysteryUfoWarbleSound}; listed in the
 * manifest's `controlCues` so it owns no asset of its own.
 */
export function stopMysteryUfoWarbleSound(): void {
  if (mysteryUfoWarbleSound === null) return;
  mysteryUfoWarbleSound.stop();
  mysteryUfoWarbleSound = null;
}

/** For tests: the active warble state, or null when not playing. */
export function _getMysteryUfoWarbleSoundStateForTests(): {
  active: boolean;
} | null {
  return mysteryUfoWarbleSound === null ? null : { active: true };
}

/**
 * Reward fanfare — plays on arrival at the player, synchronised with the hold
 * pay-in. Immediate (not beat-quantised): it is payout feedback, not a combat
 * accent.
 */
export function playMysteryUfoRewardSound(): void {
  playCue('playMysteryUfoRewardSound');
}

/**
 * Explosion cue for the drone's destruction, fired with the crash-site
 * particle VFX. Immediate so it stays in sync with the mineral tinkle and the
 * spill it accompanies.
 */
export function playMysteryUfoDestroySound(): void {
  playCue('playMysteryUfoDestroySound');
}

/**
 * Mineral "tinkle" — fired in sync with the spilled resource drops when the
 * drone is destroyed. Immediate so it lands with the spill and the
 * destruction cue.
 */
export function playMineralTinkleSound(): void {
  playCue('playMineralTinkleSound');
}

/** Deep resonant boom — Boss fire cue. */
export function playBossFireSound(): void {
  playCue('playBossFireSound', { volume: ENEMY_WEAPON_FIRE_VOLUME_SCALE });
}

/** Short punchy impact — Boss hit feedback cue. */
export function playBossHitSound(): void {
  playCue('playBossHitSound', { volume: EXPLOSION_VOLUME_SCALE });
}

/**
 * Crisp energy shatter — an **enemy force field** breaks (epic
 * AH-0MVJ8W4GE007OMNT AC3, AH-0MVM8GW7W004SI0E).
 *
 * Decision (recorded here so the audio knowledge stays in the audio layer):
 * this reuses the existing baked bullet-destruction tick instead of shipping a
 * new ToneForge recipe. It already reads as a short, bright shatter, it is
 * distinct from the hull-destruction boom (`playDestructionSound`) so "barrier
 * down" never sounds like "enemy killed", and it is distinct from the
 * per-weapon impact cues that absorbed hits keep using — so absorb and break
 * never sound the same. No unrendered audio asset is introduced.
 *
 * Dispatched through {@link playBulletDestructionSound} (not `playCue`
 * directly) so the explosion family trim (AH-0MVZVMZOQ00076QF) is applied
 * exactly once on this alias path too.
 */
export function playEnemyForceFieldBreakSound(): void {
  playBulletDestructionSound();
}

/**
 * Bright rising bounce — the player Force Field **reflects** an enemy bullet
 * (AH-0MVRDMMYO002SC5V, producer decision Q2 = c on AH-0MVBKT2WO001AR14).
 *
 * Decision (recorded here so the audio knowledge stays in the audio layer):
 * this is a **dedicated baked cue**, not an alias like
 * {@link playEnemyForceFieldBreakSound}. A reflection must read as its own
 * event — distinct from the bullet-destruction tick
 * (`playBulletDestructionSound`, a falling square), the ricochet tick
 * (`playRicochetImpactSound`, a falling triangle with a noise smack) and an
 * enemy force-field break. `aihell-forcefield-reflect` **rises**
 * (880 → 1320 Hz) with a short sine sparkle, so "bounced back at the enemy"
 * never sounds like "shot destroyed".
 */
export function playForceFieldReflectSound(): void {
  playCue('playForceFieldReflectSound');
}

// ── Player weapon fire cues ─────────────────────────────────────────

/** Solid medium blip — Cannon fire. */
export function playCannonFireSound(): void {
  playCue('playCannonFireSound');
}

/** Punchy hit thump — Cannon bullet connects (AH-0MV8228YW0050IXS). */
export function playCannonImpactSound(): void {
  playCue('playCannonImpactSound');
}

/** Bright green ricochet shot — fires (AH-0MV822AP1006W2F9). */
export function playRicochetFireSound(): void {
  playCue('playRicochetFireSound');
}

/** Soft ping — Ricochet bullet connects on wall bounce or enemy hit (AH-0MV822AP1006W2F9). */
export function playRicochetImpactSound(): void {
  playCue('playRicochetImpactSound');
}

/** Heavy missile detonation thump — Cluster Missile shell/warhead connects (AH-0MV822B1B0048UZT). */
export function playClusterImpactSound(): void {
  playCue('playClusterImpactSound');
}

/** Soft bright aqua pop — Options pod shot connects (AH-0MV822BDN008IYL6). */
export function playOptionsImpactSound(): void {
  playCue('playOptionsImpactSound');
}

/**
 * Bright expanding ring hit — Nova shockwave connects
 * (AH-0MV822BPT002GF17). Plays through the shared onFire AOE VFX seam
 * (`CombatScene.spawnAoeEffectVfx`) the instant the Nova ring expands, so the
 * game and every gym sound the identical shockwave hit. Baked via the
 * ToneForge pipeline (`aihell-nova-impact`, seed 32273).
 */
export function playNovaImpactSound(): void {
  playCue('playNovaImpactSound');
}

/** Soft warm amber hit — Spread bullet connects (AH-0MV8229B9009DQGA). */
export function playSpreadImpactSound(): void {
  playCue('playSpreadImpactSound');
}

/** Bright twin square snap — Dual bullet connects (AH-0MV8229NM009CZOA). */
export function playDualImpactSound(): void {
  playCue('playDualImpactSound');
}

/** Tight staccato yellow tick — Rapid bullet connects (AH-0MV822A03006UT2P). */
export function playRapidImpactSound(): void {
  playCue('playRapidImpactSound');
}

/**
 * Short metallic crack with a brief ring — a Railgun tracer connects
 * (AH-0MVMIGVCE004VSNA). Plays through the shared impact seam
 * (`CombatScene.resolveWeaponImpactFx`) alongside the sky-blue impact flash,
 * so the game and every gym connect identically. Kept short (~0.14 s) so a
 * five-target pierce chain reads as one crisp salvo rather than a
 * machine-gun stutter. Baked via the ToneForge pipeline
 * (`aihell-railgun-impact`, seed 32278).
 */
export function playRailgunImpactSound(): void {
  playCue('playRailgunImpactSound');
}

/**
 * Bright glassy lime tink — a Shard Swarm shard connects
 * (AH-0MVV0WMTE0007NGS). Plays through the shared impact seam
 * (`CombatScene.resolveWeaponImpactFx`) alongside the lime impact flash, so
 * the game and every gym connect identically instead of falling back to the
 * generic warm-white flash with no hit cue. Kept to ~0.10 s so a five-shard
 * volley connecting in one frame reads as a single shimmering lime hit — the
 * shipped per-cue voice limiter (4 voices / 150 ms) bounds the overlap with no
 * added throttle. Baked via the ToneForge pipeline
 * (`aihell-shard-swarm-impact`, seed 32280).
 */
export function playShardSwarmImpactSound(): void {
  playCue('playShardSwarmImpactSound');
}

/**
 * Soft rose pop — a Rear Guard pellet connects (AH-0MVV0WN96007TU9J). Plays
 * through the shared impact seam (`CombatScene.resolveWeaponImpactFx`)
 * alongside the rose impact flash, so the game and every gym connect
 * identically instead of falling back to the generic warm-white flash with no
 * hit cue. Kept to ~0.12 s and deliberately softer than the Cannon's crack,
 * because the Rear Guard is a single compact rearward shot. Baked via the
 * ToneForge pipeline (`aihell-rear-guard-impact`, seed 32282).
 */
export function playRearGuardImpactSound(): void {
  playCue('playRearGuardImpactSound');
}

/**
 * Short teal dart tick — a Broadside dart connects (AH-0MVV0WNOX0078G9G). Plays
 * through the shared impact seam (`CombatScene.resolveWeaponImpactFx`)
 * alongside the teal impact flash, so the game and every gym connect
 * identically instead of falling back to the generic warm-white flash with no
 * hit cue. Kept to ~0.10 s so a left/right pair connecting in the same frame
 * reads as one crisp teal tick — the shipped per-cue voice limiter (4 voices /
 * 150 ms) bounds the overlap with no added throttle. Baked via the ToneForge
 * pipeline (`aihell-broadside-impact`, seed 32284).
 */
export function playBroadsideImpactSound(): void {
  playCue('playBroadsideImpactSound');
}

/**
 * Dull red thud with debris — a Heavy Slug connects (AH-0MVV0WO4M001KEDG).
 * Plays through the shared impact seam (`CombatScene.resolveWeaponImpactFx`)
 * alongside the deep-red impact flash, so the game and every gym connect
 * identically instead of falling back to the generic warm-white flash with no
 * hit cue. Kept to ~0.15 s (inside the 0.16 s ceiling) so the slow single
 * round reads as one heavy impact. Deliberately duller and lower than the
 * Mortar's bright dry shell crack, so the two heaviest weapons never alias
 * (`aihell-heavy-slug-impact`, seed 32286) — see the recipe comment.
 */
export function playHeavySlugImpactSound(): void {
  playCue('playHeavySlugImpactSound');
}

/**
 * Per-weapon impact cues, keyed by the cue export name stored in a weapon's
 * `impactFx` metadata (AH-0MV8228YW0050IXS). Grows as weapon children add
 * their own baked hit cues; dispatched by {@link playWeaponImpactCue} from
 * the shared impact seam. The registry lives here (not in a scene) so the
 * audio knowledge stays in the audio layer.
 *
 * Exported so the catalogue-wide feel guard
 * (`src/utils/weaponFeelRoster.test.ts`, AH-0MVV0WMD8007LOVT AC5) can assert
 * membership without duplicating the list. The AOE family (`nova`, `mortar`)
 * is deliberately absent: it has no per-shot `impactFx` and its connect cues
 * are played by the shared AOE seam instead.
 */
export const PLAYER_WEAPON_IMPACT_CUES: Readonly<Record<string, () => void>> = {
  playCannonImpactSound,
  playRicochetImpactSound,
  playSpreadImpactSound,
  playDualImpactSound,
  playRapidImpactSound,
  playWaveLaserImpactSound,
  playClusterImpactSound,
  playOptionsImpactSound,
  playArcImpactSound,
  playRailgunImpactSound,
  playShardSwarmImpactSound,
  playRearGuardImpactSound,
  playBroadsideImpactSound,
  playHeavySlugImpactSound,
};

/**
 * Whether `cue` is a registered per-weapon impact cue — the predicate the
 * catalogue-wide feel guard uses to verify a weapon's `impactFx` resolves
 * without duplicating {@link PLAYER_WEAPON_IMPACT_CUES}
 * (AH-0MVV0WMD8007LOVT AC5).
 */
export function isPlayerWeaponImpactCue(cue: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLAYER_WEAPON_IMPACT_CUES, cue);
}

/**
 * Plays the baked impact cue named by a weapon's `impactFx` metadata.
 * Unknown cue names are a safe no-op (a weapon never falls silent — the
 * visual impact flash still plays through the shared impact seam).
 */
export function playWeaponImpactCue(cue: string): void {
  PLAYER_WEAPON_IMPACT_CUES[cue]?.();
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

/**
 * Heavy electromagnetic discharge — Railgun fire (AH-0MVMIGVCE004VSNA). A deep
 * sawtooth slam with a metallic snap and a high-pass noise crack, routed
 * through the one shared player-fire dispatcher ({@link playWeaponFireSound})
 * so live fire, the reduced-volume hold-full metronome and every gym fire
 * sound identical. Baked via the ToneForge pipeline (`aihell-railgun-fire`,
 * seed 32277).
 */
export function playRailgunFireSound(): void {
  playCue('playRailgunFireSound');
}

/**
 * Tight multi-shard *chk* burst — Shard Swarm fire (AH-0MVV0WMTE0007NGS).
 * Three short high-passed noise ticks over a bright glassy triangle and a
 * brittle square edge, so the five-shard fan leaving the hull reads as a
 * percussive lime burst rather than a blunt cannon thump. Routed through the
 * one shared player-fire dispatcher ({@link playWeaponFireSound}) so live
 * fire, the reduced-volume hold-full metronome and every gym fire sound
 * identical. Baked via the ToneForge pipeline (`aihell-shard-swarm-fire`,
 * seed 32279).
 */
export function playShardSwarmFireSound(): void {
  playCue('playShardSwarmFireSound');
}

/**
 * Muted rearward *thup* — Rear Guard fire (AH-0MVV0WN96007TU9J). A low-passed
 * sawtooth body with no square click, darker and more muffled than the
 * Cannon's forward thump so the backward shot is identifiable by ear. Routed
 * through the one shared player-fire dispatcher ({@link playWeaponFireSound})
 * so live fire, the reduced-volume hold-full metronome and every gym fire
 * sound identical. Baked via the ToneForge pipeline
 * (`aihell-rear-guard-fire`, seed 32281).
 */
export function playRearGuardFireSound(): void {
  playCue('playRearGuardFireSound');
}

/**
 * Wide two-sided swish — Broadside fire (AH-0MVV0WNOX0078G9G). The Broadside
 * fires a perpendicular teal dart pair (one shot to each side, no forward
 * shot), so one baked cue carries **two** short band-passed noise sweeps 40 ms
 * apart — the first rising (left dart leaving) and the second falling (right
 * dart leaving) — over a short glassy teal-toned tail. The opposing sweeps and
 * the documented 35–50 ms inter-onset window make the pair audible on a mono
 * speaker, so it reads as a wide two-sided launch rather than a second Cannon.
 * Routed through the one shared player-fire dispatcher
 * ({@link playWeaponFireSound}) so live fire, the reduced-volume hold-full
 * metronome and every gym fire sound identical. Baked via the ToneForge
 * pipeline (`aihell-broadside-fire`, seed 32283).
 */
export function playBroadsideFireSound(): void {
  playCue('playBroadsideFireSound');
}

/**
 * The heaviest single shot in the game — Heavy Slug fire
 * (AH-0MVV0WO4M001KEDG). One low 110 → 55 Hz saw boom with a metallic square
 * clank transient and the longest decay of the packaged weapons (~0.26 s),
 * so firing the huge slow deep-red shell reads as an event on its own.
 * Routed through the one shared player-fire dispatcher
 * ({@link playWeaponFireSound}) so live fire, the reduced-volume hold-full
 * metronome and every gym fire sound identical. Must **never alias the Mortar
 * detonation**: this cue differentiates with the metallic clank transient, a
 * shorter sustain than the 0.32 s detonation boom and a different thump
 * contour — documented in the recipe comment (`aihell-heavy-slug-fire`, seed
 * 32285).
 */
export function playHeavySlugFireSound(): void {
  playCue('playHeavySlugFireSound');
}

/** Deep expanding thump + rising ring — Nova fire. */
export function playNovaFireSound(): void {
  playCue('playNovaFireSound');
}

/** Muffled launch thump — Mortar fire. */
export function playMortarFireSound(): void {
  playCue('playMortarFireSound');
}

/**
 * Sharp dry shell-impact crack — the Mortar blast connects
 * (AH-0MV822C250051OVN). Plays through the shared AOE detonation VFX seam
 * (`CombatScene.spawnAoeDetonationVfx`) the instant a Mortar blast resolves,
 * layered under the heavy `playMortarDetonationSound` boom so the impact
 * reads as a shell landing then detonating. The game and every gym sound the
 * identical connect. Baked via the ToneForge pipeline (`aihell-mortar-impact`,
 * seed 32274).
 */
export function playMortarImpactSound(): void {
  playCue('playMortarImpactSound');
}

/** Heavy blast — Mortar detonation. */
export function playMortarDetonationSound(): void {
  playCue('playMortarDetonationSound');
}

/**
 * Falling bolt from orbit into a low detonation thump plus a bright crack —
 * the **Orbital Strike power-up's** impact cue
 * (AH-0MVS2SZBY004HJ2D).
 *
 * A dedicated ToneForge recipe (`aihell-orbital-strike`, seed 32195) rather
 * than a reused cue: the strike is a signature event and must not alias the
 * Smart Bomb / Nova ring ping (`playNovaImpactSound`, a 0.16 s bright ring
 * with no descent) or the Mortar detonation wash
 * (`playMortarDetonationSound`, a sustained 0.32 s low boom). This cue is
 * composed in two acts — a pitched + filtered-noise descent from orbit into a
 * low saw thump and a short highpass crack — so the strike is unmistakable by
 * ear even when the player is not looking at the target.
 *
 * Plays through the shared one-shot cue funnel like every other cue, so the
 * global volume/mute, voice limiter and single shared `AudioContext` apply.
 */
export function playOrbitalStrikeSound(): void {
  playCue('playOrbitalStrikeSound');
}

/**
 * Linear gain applied to the **Mining Laser** fire cue
 * (AH-0MW9QMQ7B005WFH9, parent **Mining laser** AH-0MW81181P007BDRU).
 *
 * The laser is the game's most rapid fire cue — up to one shot per sixteenth
 * note of the shared beat grid (0.1875 s at the floor level) — so its tick is
 * trimmed to 60% of the baked asset's level. The asset itself is already the
 * quietest fire cue in the palette (peak 0.12, RMS 0.032 against the cannon's
 * 0.15 / 0.084), which keeps a sustained mining run under the player-weapon
 * mix instead of turning into a buzz that masks the enemy-fire telegraphs.
 * One named tunable, like the other family trims
 * (`ENEMY_WEAPON_FIRE_VOLUME_SCALE`, `EXPLOSION_VOLUME_SCALE`), so retuning is
 * a one-line change that needs no new bake.
 */
export const MINING_LASER_FIRE_VOLUME_SCALE = 0.6;

/**
 * Short amber "cutting" tick — the **Mining Laser** fires at an asteroid
 * (AH-0MW9QMQ7B005WFH9, parent **Mining laser** AH-0MW81181P007BDRU).
 *
 * A dedicated ToneForge recipe (`aihell-mining-laser-fire`, seed 32291) rather
 * than a reused cue: the laser fires constantly while it is owned, so it must
 * (a) stay distinct by ear from the player cannon's square 800 → 400 Hz tick
 * and the wave laser's long beam, and (b) stay short and mid-bright so a rapid
 * cadence never smears into the enemy-fire telegraphs. The recipe is a 0.07 s
 * saw chirp 1320 → 660 Hz with a high-passed noise bite — a cutting tick, not
 * a weapon boom.
 *
 * Played by `vfx/miningLaserBeam.ts` (not by the call site), so every consumer
 * of the shared firing seam gets the sound exactly once per shot and no scene
 * can forget it — the `vfx/orbitalStrike.ts` and `vfx/thornsAbsorb.ts`
 * precedent. It routes through the shared one-shot cue funnel like every other
 * cue, so the global volume/mute, the per-cue voice limiter and the single
 * shared `AudioContext` apply, and the sound rate can never outrun the shot
 * cadence.
 */
export function playMiningLaserFireSound(): void {
  playCue('playMiningLaserFireSound', {
    volume: MINING_LASER_FIRE_VOLUME_SCALE,
  });
}

/** Bright electric zap — Arc fire. */
export function playArcFireSound(): void {
  playCue('playArcFireSound');
}

/**
 * Sharp electric crack — the Arc chaining bolt connects
 * (AH-0MV822CE7004MQ14). Plays through the shared AOE chain seam
 * (`CombatScene.resolveChainImpactFx`) the instant the bolt lands on its
 * nearest target and chains onward, so the game and every gym sound the
 * identical connect. Baked via the ToneForge pipeline (`aihell-arc-impact`,
 * seed 32275).
 */
export function playArcImpactSound(): void {
  playCue('playArcImpactSound');
}

// ── Wave laser level (AH-0MW10K39E006CG0A) ──────────────────────────
//
// The producer asked for the wave laser to sit 1.5× louder than before, so
// the long red screen-spanning beam reads with the prominence its visual
// impact has. The boost rides the same named-constant runtime mechanism as the
// family trims (`TANK_SCOUT_FIRE_VOLUME_SCALE`, `PHASER_FIRE_VOLUME_SCALE`),
// so the baked WAVs, ToneForge recipes and the checksum/amplitude-tier guards
// stay untouched.

/**
 * Linear gain applied to the **wave laser** fire and impact cues — a ×1.5
 * boost, one named tunable for both cues (AH-0MW10K39E006CG0A).
 *
 * Unlike the enemy/explosion family trims this **amplifies** (×1.5 > unity),
 * which is why the per-play cue gain allows values above 1 up to
 * `MAX_CUE_GAIN` (`src/audio/sfxPlayback.ts`) instead of clamping them back to
 * 1. No clipping risk: the baked assets peak at 0.20 (fire) and 0.32
 * (impact), so 1.5× peaks at ~0.30 / ~0.48, far below full scale. If the
 * producer ever hears distortion, lower this constant rather than editing the
 * recipes.
 *
 * Composes **multiplicatively** with a caller-supplied `volume` — the hold-full
 * metronome's `HOLD_FULL_FIRE_VOLUME_SCALE` (0.3) plays at 0.45 — so it never
 * replaces a caller trim.
 */
export const WAVE_LASER_VOLUME_SCALE = 1.5;

/**
 * High-energy beam crack — Wave Laser fire (AH-0MV822ACO007CEZF). Carries the
 * wave laser's own level ({@link WAVE_LASER_VOLUME_SCALE}).
 */
export function playWaveLaserFireSound(): void {
  playCue('playWaveLaserFireSound', { volume: WAVE_LASER_VOLUME_SCALE });
}

/** Low missile launch whoosh + click — Cluster Missile fire (AH-0MV822B1B0048UZT). */
export function playClusterFireSound(): void {
  playCue('playClusterFireSound');
}

/** Bright soft twinkle — Options pod volley fire (AH-0MV822BDN008IYL6). */
export function playOptionsFireSound(): void {
  playCue('playOptionsFireSound');
}

/**
 * Sharp neon snap — Wave Laser bullet connects (AH-0MV822ACO007CEZF). Reached
 * at runtime through {@link playWeaponImpactCue}, so it carries the wave
 * laser's level ({@link WAVE_LASER_VOLUME_SCALE}) for live impacts too.
 */
export function playWaveLaserImpactSound(): void {
  playCue('playWaveLaserImpactSound', { volume: WAVE_LASER_VOLUME_SCALE });
}

/**
 * The per-weapon fire cue for a player weapon id, routed through the one
 * shared player-fire path (AH-0MV55O9R5005W6J0 · AC1/AC2).
 *
 * Every player weapon's fire cue (cannon, spread, dual, rapid, nova,
 * mortar, arc) resolves through this single switch, so live fire
 * (`_playShootCue` in `PlayScene`/gyms) and the reduced-volume hold-full
 * metronome play the **same** cue through the **same** code path — the
 * metronome passes `options.volume` (see `HOLD_FULL_FIRE_VOLUME_SCALE`)
 * while live fire relies on the default.
 *
 * The AOE-family cues are intentionally included: they are active player
 * weapons and their metronomic ghosts must sound identical to live fire
 * (AC2 — *every* active player weapon). A weapon id without a baked fire
 * cue (e.g. catalogue-only ids) degrades to a no-op, matching the existing
 * `_playShootCue` switch.
 *
 * @param weaponId - The firing weapon id.
 * @param options - Per-play options (e.g. `{ volume }` for the metronome).
 *
 * The wave laser also applies its own {@link WAVE_LASER_VOLUME_SCALE} boost on
 * this path (AH-0MW10K39E006CG0A) — composed multiplicatively with `options.volume`,
 * never replacing it, so the metronome ghost stays quieter than live fire.
 */
export function playWeaponFireSound(
  weaponId: WeaponId,
  options: SfxPlayOptions = {},
): void {
  switch (weaponId) {
    case 'cannon':
      playCue('playCannonFireSound', options);
      break;
    case 'spread':
      playCue('playSpreadFireSound', options);
      break;
    case 'dual':
      playCue('playDualFireSound', options);
      break;
    case 'rapid':
      playCue('playRapidFireSound', options);
      break;
    case 'nova':
      playCue('playNovaFireSound', options);
      break;
    case 'mortar':
      playCue('playMortarFireSound', options);
      break;
    case 'arc':
      playCue('playArcFireSound', options);
      break;
    case 'wave_laser':
      // The wave laser carries its own level on top of any caller volume
      // (AH-0MW10K39E006CG0A); the scales multiply so the hold-full metronome
      // ghost stays proportionally quieter than live fire.
      playCue('playWaveLaserFireSound', {
        ...options,
        volume: (options.volume ?? 1) * WAVE_LASER_VOLUME_SCALE,
      });
      break;
    case 'ricochet':
      playCue('playRicochetFireSound', options);
      break;
    case 'cluster':
      playCue('playClusterFireSound', options);
      break;
    case 'options':
      playCue('playOptionsFireSound', options);
      break;
    case 'railgun':
      playCue('playRailgunFireSound', options);
      break;
    case 'shard_swarm':
      playCue('playShardSwarmFireSound', options);
      break;
    case 'rear_guard':
      playCue('playRearGuardFireSound', options);
      break;
    case 'broadside':
      playCue('playBroadsideFireSound', options);
      break;
    case 'heavy_slug':
      playCue('playHeavySlugFireSound', options);
      break;
    default:
      // Catalogue-only weapon ids with no baked fire cue — no-op (matches
      // the per-weapon `_playShootCue` switch behaviour).
      break;
  }
}

/**
 * Short bright two-note blip — one beat of the 3-2-1 restart countdown
 * (AH-0MV55OA93008OUL1). Each count of the hold-full restart plays one
 * distinct tick on a beat, so the player hears the beat they will resume
 * on underneath the reduced-volume metronomic fire. Baked via the ToneForge
 * pipeline (`aihell-countdown-tick`, seed 32264).
 *
 * The tone **rises with each beat** (AH-0MV722WJS0075UTZ): the single baked
 * asset is played at a rising playback rate so count 3 is the base pitch,
 * count 2 a major third above and count 1 a perfect fifth above (a C6→E6→G6
 * major-triad rise). `step` is the 0-based countdown step (0 = first count);
 * out-of-range steps clamp to the highest baked step so a bad value can
 * never fall silent.
 *
 * @param step - 0-based countdown step (0, 1, 2, …); defaults to 0.
 */
export function playCountdownTickSound(step = 0): void {
  playCue('playCountdownTickSound', { rate: countdownTickRate(step) });
}

/**
 * Semitone offsets above the base countdown tick, one per countdown step:
 * count 3 = 0 (base), count 2 = +4 (major third), count 1 = +7 (perfect
 * fifth) — a rising major-triad cue. Tunable in one place.
 */
export const COUNTDOWN_TICK_SEMITONES: readonly number[] = [0, 4, 7];

/**
 * The playback rate for countdown `step`: `2^(semitones/12)` from
 * {@link COUNTDOWN_TICK_SEMITONES}. A negative/out-of-range step clamps to
 * the highest step; a non-integer step floors.
 */
export function countdownTickRate(step: number): number {
  const index = Number.isFinite(step)
    ? Math.min(Math.max(Math.floor(step), 0), COUNTDOWN_TICK_SEMITONES.length - 1)
    : 0;
  return 2 ** (COUNTDOWN_TICK_SEMITONES[index] / 12);
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

/**
 * Low two-step "denied" buzz — the six-slot pool is full and this drop cannot
 * be collected (parent AH-0MVLIJT3M005HPHF, producer Q5b). Deliberately lower
 * and shorter than the pickup cues so a refused pickup is audibly distinct
 * from a successful one.
 */
export function playPowerUpBlockedSound(): void {
  playCue('playPowerUpBlockedSound');
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

/** Piercing shimmer — Wave Laser activation. */
export function playWaveLaserPickupSound(): void {
  playCue('playWaveLaserPickupSound');
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

// ── Mini-boss death sweep cue dispatcher (AH-0MVVEI7FD004TR2M) ──────
//
// The mini-boss defeat sweep (`src/scenes/core/miniBossDeathSweep.ts`) turns
// its display into audio through this **one** dispatcher, so the game and
// every gym route the cascade identically (AGENTS.md gym↔game parity).
//
// The palette is **reuse-only** (producer decision Q1 = a on
// AH-0MVVEI7FD004TR2M): no new ToneForge recipe, no new baked asset and no
// manifest change. The sweep's own planner names the cue per burst role and
// the per-role mix trim; this function only resolves the baked variant and
// hands the request to the shipped cue wrappers.

/** Cues the mini-boss death sweep may dispatch (reuse-only palette, Q1 = a). */
export type MiniBossSweepSoundCueName =
  | 'playBossDestructionSound'
  | 'playDestructionSound'
  | 'playVictoryExplosionSound';

/** Per-play options for {@link playMiniBossSweepSound}. */
export interface MiniBossSweepSoundOptions {
  /** Seconds from now to schedule the cue (the burst's own `delayMs`). */
  readonly delay?: number;
  /** Per-play mix trim supplied by the sweep's per-role volume scale. */
  readonly volume?: number;
  /**
   * Run-seeded draw in `[0, 1)` choosing one of the cue's baked variants
   * (AC5). The planner draws it from the run-seeded RNG, so the same run seed
   * replays the same variant — no `Math.random()` in this path.
   */
  readonly variantPick?: number;
}

/**
 * Resolves a sweep cue's baked variant seed from a run-seeded draw.
 *
 * A single-variant or shared-recipe cue has one seed, so the draw is a no-op;
 * a multi-variant cue (`playDestructionSound` ×3, `playVictoryExplosionSound`
 * ×5) is picked deterministically from `variantPick`, never at random.
 */
function sweepVariantSeed(
  cue: MiniBossSweepSoundCueName,
  variantPick: number | undefined,
): number | undefined {
  const seeds = cueSeeds(cue);
  if (seeds.length === 0) return undefined;
  if (variantPick === undefined) return seeds[0];
  const pick = Number.isFinite(variantPick) ? variantPick : 0;
  // Clamp defensively: a widening variant range must never index out of bounds.
  const index = Math.min(
    seeds.length - 1,
    Math.max(0, Math.floor(pick * seeds.length)),
  );
  return seeds[index];
}

/**
 * Plays one mini-boss death-sweep cue at its burst's own delay (producer
 * decision Q3 = a — **visual-timed**, never snapped to the 16th-note accent
 * grid, and never spending the mass-kill per-tick accent budget).
 *
 * A safe no-op without an `AudioContext` (headless tests, muted SFX, volume 0,
 * autoplay-blocked browsers) and never throws, like every cue.
 *
 * @param cue - The cue the sweep's planner assigned to the burst / body.
 * @param options - Scheduled delay, per-role mix trim and baked-variant draw.
 */
export function playMiniBossSweepSound(
  cue: MiniBossSweepSoundCueName,
  options: MiniBossSweepSoundOptions = {},
): void {
  const seed = sweepVariantSeed(cue, options.variantPick);
  const play: SfxPlayOptions & { seed?: number } = {
    delay: options.delay,
    volume: options.volume,
    seed,
  };
  switch (cue) {
    case 'playBossDestructionSound':
      playBossDestructionSound(play);
      return;
    case 'playVictoryExplosionSound':
      playVictoryExplosionSound(play);
      return;
    default:
      playDestructionSound(play);
  }
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
  playCue('playVictoryExplosionSound', {
    ...options,
    // Compose the family trim with the caller's firework volume.
    volume: (options.volume ?? 1) * EXPLOSION_VOLUME_SCALE,
  });
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

/**
 * Heavy deep fall — Boss destruction. Accepts per-play {@link SfxPlayOptions}
 * so a scripted display (the mini-boss death sweep) can schedule its boom with
 * an explicit `delay` and a mix-trimming `volume`.
 */
export function playBossDestructionSound(
  options: SfxPlayOptions & { seed?: number } = {},
): void {
  playCue('playBossDestructionSound', {
    ...options,
    // Compose the family trim with the caller's mix trim (mini-boss sweep).
    volume: (options.volume ?? 1) * EXPLOSION_VOLUME_SCALE,
  });
}

/**
 * Per-phase Boss attack telegraph audio. Each of the four phases maps to its
 * own baked variant (seeds 32242/32227/32207/32204 — distinct A-minor square
 * rises, AC3 AH-0MVCRR203005HKVZ), so the tell is distinct per phase.
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

/**
 * Sustained thrust-driven hum. Delegates to the runtime shim (no-op headless).
 *
 * `profile` selects the forward/default voice or the **side** variant
 * (quieter + one semitone higher; AH-0MV78QUIX001EZN2); it defaults to
 * `'forward'` so existing callers are unchanged.
 */
export function updateThrusterSound(
  level: number,
  profile: ThrusterHumProfile = 'forward',
): void {
  updateThrusterHum(level, profile);
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
 *
 * Deliberately bypasses {@link playPlayerDestructionSound} and therefore the
 * gameplay explosion family trim (AH-0MVZVMZOQ00076QF): this is a settings-UI
 * preview of the *master* gain, not a gameplay explosion, so it keeps its
 * pre-trim behaviour (and is never delayed by the beat clock).
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
  cueVoiceLimiter.reset();
  webAudioSfxProvider.reset();
  resetThrusterHumForTests();
  diveSound = null;
  mysteryUfoWarbleSound = null;
  accentClock = null;
  accentTickMs = null;
  accentCount = 0;
  setThrusterBeatClock(null);
}
