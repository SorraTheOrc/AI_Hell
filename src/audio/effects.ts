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

/** Rising mechanical whine — E3 Tank firing advance cue (half volume). */
export function playTankAdvanceCue(): void {
  playCue('playTankAdvanceCue', { volume: TANK_SCOUT_FIRE_VOLUME_SCALE });
}

/**
 * Linear gain applied to the Tank/Scout enemy **fire sequence** — the
 * advance whine/blip *and* the shot cue — so enemy fire sits at half volume
 * in the mix (AH-0MV74ROYR009X8U3). The producer confirmed the advance
 * (warmup) cues are part of the reduction. A single named constant keeps
 * the trim tunable in one place (precedent: `HOLD_FULL_FIRE_VOLUME_SCALE`).
 */
export const TANK_SCOUT_FIRE_VOLUME_SCALE = 0.5;

/** Heavy low cannon thump — E3 Tank fire, scheduled at the advance cue's end. */
export function playTankFireSound(): void {
  playCue('playTankFireSound', {
    delay: TANK_ADVANCE_CUE_DURATION,
    volume: TANK_SCOUT_FIRE_VOLUME_SCALE,
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

/** Rising warning blip — E4 Phaser firing advance cue (half volume). */
export function playPhaserAdvanceCue(): void {
  playCue('playPhaserAdvanceCue', { volume: PHASER_FIRE_VOLUME_SCALE });
}

/** Short sharp blip — E4 Phaser fire, scheduled at the advance cue's end (half volume). */
export function playPhaserFireSound(): void {
  playCue('playPhaserFireSound', {
    delay: PHASER_ADVANCE_CUE_DURATION,
    volume: PHASER_FIRE_VOLUME_SCALE,
  });
}

/** Duration (seconds) of the Scout advance tell. */
export const SCOUT_ADVANCE_CUE_DURATION = 0.6;

/** Rising warning blip — E1 Scout firing advance cue (half volume). */
export function playScoutAdvanceCue(): void {
  playCue('playScoutAdvanceCue', { volume: TANK_SCOUT_FIRE_VOLUME_SCALE });
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
    volume: TANK_SCOUT_FIRE_VOLUME_SCALE,
  });
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

/** Short punchy impact — Boss hit feedback cue. */
export function playBossHitSound(): void {
  playCue('playBossHitSound');
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
 * Per-weapon impact cues, keyed by the cue export name stored in a weapon's
 * `impactFx` metadata (AH-0MV8228YW0050IXS). Grows as weapon children add
 * their own baked hit cues; dispatched by {@link playWeaponImpactCue} from
 * the shared impact seam. The registry lives here (not in a scene) so the
 * audio knowledge stays in the audio layer.
 */
const PLAYER_WEAPON_IMPACT_CUES: Record<string, () => void> = {
  playCannonImpactSound,
  playRicochetImpactSound,
  playSpreadImpactSound,
  playDualImpactSound,
  playRapidImpactSound,
  playWaveLaserImpactSound,
  playClusterImpactSound,
  playOptionsImpactSound,
  playArcImpactSound,
};

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

/** High-energy beam crack — Wave Laser fire (AH-0MV822ACO007CEZF). */
export function playWaveLaserFireSound(): void {
  playCue('playWaveLaserFireSound');
}

/** Low missile launch whoosh + click — Cluster Missile fire (AH-0MV822B1B0048UZT). */
export function playClusterFireSound(): void {
  playCue('playClusterFireSound');
}

/** Bright soft twinkle — Options pod volley fire (AH-0MV822BDN008IYL6). */
export function playOptionsFireSound(): void {
  playCue('playOptionsFireSound');
}

/** Sharp neon snap — Wave Laser bullet connects (AH-0MV822ACO007CEZF). */
export function playWaveLaserImpactSound(): void {
  playCue('playWaveLaserImpactSound');
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
      playCue('playWaveLaserFireSound', options);
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
  setThrusterBeatClock(null);
}
