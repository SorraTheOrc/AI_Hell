/**
 * End-of-run juice — parameter model, tunables and toggles
 * (parent AH-0MUTV7632000ZWCB, feature F1).
 *
 * The end-of-run juice is the visual celebration (victory) or sombre signal
 * (defeat) that accompanies the game-over screen.  This module is the
 * **single source of truth** for that effect:
 *   - `resolveEndOfRunJuiceParams(outcome)` is the pure, total, deterministic
 *     outcome→parameter mapping. It has **no Phaser import** and no side
 *     effects, so it is trivially unit-testable.
 *   - All tunables are exported constants, so a designer/developer can retune
 *     counts, durations, colours and alpha values in one place without
 *     touching scene code.
 *
 * Outcome model:
 *   - `'victory'` — the boss was defeated; bright cyan/green celebration.
 *   - `'defeat'`  — the player ran out of lives; red desaturated treatment.
 *
 * The Phaser rendering layers (flash, particles/confetti, rings, vignette,
 * glitch) and the `spawnVictoryJuice` / `spawnDefeatScreenJuice` composition
 * entry points are added by features F2–F4 and live in this same module so
 * the layer set stays in one place.
 *
 * The two new audio cues live in `src/audio/effects.ts` (`playVictoryFanfareSound`
 * and `playDefeatStingSound`), whose tunables are documented there.  This
 * module's `*_ENABLE_SOUND` toggles exist so the VFX composition can
 * gate-sound-together with the visual layers even though the actual
 * scheduling is done by the audio module.
 *
 * Parity note: `GameOverScene` is reached only from `PlayScene`; no gym
 * scene has a run-end screen.  The shared helpers in this module are
 * imported by `GameOverScene` (game path only).  This decision is
 * documented in GDD §7.2 / §7.3 and on the parent work item.
 */

// ── Outcome ─────────────────────────────────────────────────────────

/** Game-over outcome: a victory celebration or a defeat signal. */
export type EndOfRunOutcome = 'victory' | 'defeat';

/** Outcome used when an unknown/invalid value is supplied (never throws). */
export const ENDOFRUN_DEFAULT_OUTCOME: EndOfRunOutcome = 'victory';

// ── Victory palette colours ─────────────────────────────────────────

/** Bright cyan — primary victory colour, the player's ship colour (GDD §7.1). */
export const ENDOFRUN_VICTORY_COLOR = 0x00ffff;

/** Neon green — secondary victory accent (confetti / rings). */
export const ENDOFRUN_VICTORY_GREEN = 0x88ff00;

/** Warm white-gold — sparkle / highlight tint. */
export const ENDOFRUN_VICTORY_SPARKLE = 0xffffcc;

// ── Defeat palette colours ──────────────────────────────────────────

/** Red — primary defeat colour. */
export const ENDOFRUN_DEFEAT_COLOR = 0xff4444;

/** Dark red — vignette and body colour. */
export const ENDOFRUN_DEFEAT_RED = 0x880000;

/** Desaturated dark grey — glitch overlay tint. */
export const ENDOFRUN_DEFEAT_GRAY = 0x444444;

// ── Flash / glow tunables (victory) ─────────────────────────────────

/**
 * Peak alpha of the victory flash (fades 1 → 0). A bright, brief flash
 * to punctuate the moment of victory.
 */
export const ENDOFRUN_VICTORY_FLASH_ALPHA = 0.45;

/** Victory flash fade duration (ms). */
export const ENDOFRUN_VICTORY_FLASH_DURATION_MS = 200;

/** Whether the victory flash layer is enabled (per-layer toggle). */
export const ENDOFRUN_ENABLE_VICTORY_FLASH = true;

// ── Particle / confetti tunables (victory) ──────────────────────────

/** Base particle count for the victory confetti burst. */
export const ENDOFRUN_VICTORY_PARTICLE_COUNT = 80;

/** Victory particle lifespan (ms) — long enough to fill the screen. */
export const ENDOFRUN_VICTORY_PARTICLE_LIFESPAN_MS = 1200;

/** Velocity spread for confetti particles (px per frame, scaled by Phaser). */
export const ENDOFRUN_VICTORY_PARTICLE_VELOCITY = 180;

/** Geometry scale applied to the victory confetti particles. */
export const ENDOFRUN_VICTORY_PARTICLE_SCALE = 1.0;

/** Whether the victory confetti layer is enabled (per-layer toggle). */
export const ENDOFRUN_ENABLE_VICTORY_PARTICLES = true;

// ── Shockwave ring tunables (both outcomes) ─────────────────────────

/** Base radius (px) the victory celebration ring expands to. */
export const ENDOFRUN_VICTORY_RING_RADIUS = 120;

/** Base radius (px) the defeat ring expands to. */
export const ENDOFRUN_DEFEAT_RING_RADIUS = 80;

/** Shockwave ring expansion duration (ms). */
export const ENDOFRUN_RING_DURATION_MS = 500;

/** Fraction of its final radius the shockwave ring starts at. */
export const ENDOFRUN_RING_START_SCALE = 0.1;

/** Stroke width (px) of the shockwave ring. */
export const ENDOFRUN_RING_LINE_WIDTH = 3;

/** Whether the victory ring layer is enabled (per-layer toggle). */
export const ENDOFRUN_ENABLE_VICTORY_RING = true;

/** Whether the defeat ring layer is enabled (per-layer toggle). */
export const ENDOFRUN_ENABLE_DEFEAT_RING = true;

// ── Vignette tunables (defeat) ──────────────────────────────────────

/** Peak alpha of the defeat vignette (full-screen darkening at edges). */
export const ENDOFRUN_DEFEAT_VIGNETTE_ALPHA = 0.6;

/** Vignette fade-out duration (ms). */
export const ENDOFRUN_DEFEAT_VIGNETTE_DURATION_MS = 1500;

/** Whether the defeat vignette layer is enabled (per-layer toggle). */
export const ENDOFRUN_ENABLE_DEFEAT_VIGNETTE = true;

// ── Glitch flicker tunables (defeat) ────────────────────────────────

/** Number of glitch flicker steps (each step is a brief frame overlay). */
export const ENDOFRUN_DEFEAT_GLITCH_STEPS = 5;

/** Duration of each glitch flicker step (ms). */
export const ENDOFRUN_DEFEAT_GLITCH_STEP_DURATION_MS = 40;

/** Alpha of each glitch flicker frame. */
export const ENDOFRUN_DEFEAT_GLITCH_ALPHA = 0.15;

/** Whether the defeat glitch layer is enabled (per-layer toggle). */
export const ENDOFRUN_ENABLE_DEFEAT_GLITCH = true;

// ── Sound tunable (both outcomes) ───────────────────────────────────

/** Whether the end-of-run SFX layer (victory fanfare / defeat sting) is enabled. */
export const ENDOFRUN_ENABLE_SOUND = true;

// ── Resolved parameter shape ────────────────────────────────────────

/**
 * Fully-resolved end-of-run juice parameters for a single outcome.
 * Every layer reads from this shape so the rendering helpers stay thin.
 */
export interface EndOfRunJuiceParams {
  /** Whether to show the victory flash overlay. */
  victoryFlashEnabled: boolean;
  /** Peak alpha of the victory flash. */
  victoryFlashAlpha: number;
  /** Victory flash fade duration (ms). */
  victoryFlashDurationMs: number;
  /** Victory palette colour for flash / particles. */
  victoryColor: number;
  /** Victory accent green colour. */
  victoryGreen: number;
  /** Victory sparkle colour. */
  victorySparkle: number;
  /** Number of confetti particles for victory. */
  victoryParticleCount: number;
  /** Victory particle lifespan (ms). */
  victoryParticleLifespanMs: number;
  /** Victory particle velocity scale. */
  victoryParticleVelocity: number;
  /** Victory particle scale factor. */
  victoryParticleScale: number;
  /** Whether to spawn victory confetti. */
  victoryParticlesEnabled: boolean;
  /** Radius (px) the victory ring expands to. */
  victoryRingRadius: number;
  /** Whether to spawn the victory ring. */
  victoryRingEnabled: boolean;
  /** Ring expansion duration (ms). */
  ringDurationMs: number;
  /** Fraction of final radius to start from. */
  ringStartScale: number;
  /** Stroke width (px) for rings. */
  ringLineWidth: number;
  /** Red defeat colour. */
  defeatColor: number;
  /** Dark red vignette colour. */
  defeatRed: number;
  /** Desaturated grey for glitch. */
  defeatGray: number;
  /** Peak alpha of the defeat vignette overlay. */
  defeatVignetteAlpha: number;
  /** Vignette fade duration (ms). */
  defeatVignetteDurationMs: number;
  /** Whether to spawn the defeat vignette. */
  defeatVignetteEnabled: boolean;
  /** Number of glitch flicker steps. */
  defeatGlitchSteps: number;
  /** Duration of each glitch step (ms). */
  defeatGlitchStepDurationMs: number;
  /** Alpha per glitch flicker frame. */
  defeatGlitchAlpha: number;
  /** Whether to spawn the defeat glitch layer. */
  defeatGlitchEnabled: boolean;
  /** Whether to spawn the defeat ring. */
  defeatRingEnabled: boolean;
  /** Radius (px) the defeat ring expands to. */
  defeatRingRadius: number;
  /** Whether to play the end-of-run SFX (fanfare or sting). */
  soundEnabled: boolean;
}

/**
 * Resolves the complete end-of-run juice parameters for `outcome`.
 *
 * Pure, total and deterministic: an unknown/invalid outcome falls back to
 * `'victory'` and the function never throws. Victory returns a bright
 * cyan/green celebration parameter set; defeat returns a red/desaturated
 * treatment parameter set.
 *
 * @param outcome — `'victory'` or `'defeat'`; anything else → `'victory'`.
 */
export function resolveEndOfRunJuiceParams(
  outcome: EndOfRunOutcome | string | null | undefined,
): EndOfRunJuiceParams {
  const resolved: EndOfRunOutcome =
    outcome === 'defeat' ? 'defeat' : ENDOFRUN_DEFAULT_OUTCOME;
  const isVictory = resolved === 'victory';

  return {
    // ── Victory flash ────────────────────────────────────────────
    victoryFlashEnabled: ENDOFRUN_ENABLE_VICTORY_FLASH,
    victoryFlashAlpha: ENDOFRUN_VICTORY_FLASH_ALPHA,
    victoryFlashDurationMs: ENDOFRUN_VICTORY_FLASH_DURATION_MS,
    victoryColor: ENDOFRUN_VICTORY_COLOR,
    victoryGreen: ENDOFRUN_VICTORY_GREEN,
    victorySparkle: ENDOFRUN_VICTORY_SPARKLE,

    // ── Victory particles ────────────────────────────────────────
    victoryParticleCount: ENDOFRUN_VICTORY_PARTICLE_COUNT,
    victoryParticleLifespanMs: ENDOFRUN_VICTORY_PARTICLE_LIFESPAN_MS,
    victoryParticleVelocity: ENDOFRUN_VICTORY_PARTICLE_VELOCITY,
    victoryParticleScale: ENDOFRUN_VICTORY_PARTICLE_SCALE,
    victoryParticlesEnabled: ENDOFRUN_ENABLE_VICTORY_PARTICLES,

    // ── Victory ring ─────────────────────────────────────────────
    victoryRingRadius: ENDOFRUN_VICTORY_RING_RADIUS,
    victoryRingEnabled: ENDOFRUN_ENABLE_VICTORY_RING,

    // ── Shared ring params ───────────────────────────────────────
    ringDurationMs: ENDOFRUN_RING_DURATION_MS,
    ringStartScale: ENDOFRUN_RING_START_SCALE,
    ringLineWidth: ENDOFRUN_RING_LINE_WIDTH,

    // ── Defeat colours ───────────────────────────────────────────
    defeatColor: ENDOFRUN_DEFEAT_COLOR,
    defeatRed: ENDOFRUN_DEFEAT_RED,
    defeatGray: ENDOFRUN_DEFEAT_GRAY,

    // ── Defeat vignette ──────────────────────────────────────────
    defeatVignetteAlpha: ENDOFRUN_DEFEAT_VIGNETTE_ALPHA,
    defeatVignetteDurationMs: ENDOFRUN_DEFEAT_VIGNETTE_DURATION_MS,
    defeatVignetteEnabled: ENDOFRUN_ENABLE_DEFEAT_VIGNETTE,

    // ── Defeat glitch ────────────────────────────────────────────
    defeatGlitchSteps: ENDOFRUN_DEFEAT_GLITCH_STEPS,
    defeatGlitchStepDurationMs: ENDOFRUN_DEFEAT_GLITCH_STEP_DURATION_MS,
    defeatGlitchAlpha: ENDOFRUN_DEFEAT_GLITCH_ALPHA,
    defeatGlitchEnabled: ENDOFRUN_ENABLE_DEFEAT_GLITCH,

    // ── Defeat ring ──────────────────────────────────────────────
    defeatRingEnabled: ENDOFRUN_ENABLE_DEFEAT_RING,
    defeatRingRadius: ENDOFRUN_DEFEAT_RING_RADIUS,

    // ── Sound ────────────────────────────────────────────────────
    soundEnabled: ENDOFRUN_ENABLE_SOUND,
  };
}
