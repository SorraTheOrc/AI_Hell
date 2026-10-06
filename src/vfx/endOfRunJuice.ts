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
 * to punctuate the moment of victory. Raised from 0.45 after the producer
 * audit asked for a more emphatic celebration (AH-0MUTV7632000ZWCB).
 */
export const ENDOFRUN_VICTORY_FLASH_ALPHA = 0.55;

/** Victory flash fade duration (ms) — longer, so the punch reads. */
export const ENDOFRUN_VICTORY_FLASH_DURATION_MS = 320;

/** Whether the victory flash layer is enabled (per-layer toggle). */
export const ENDOFRUN_ENABLE_VICTORY_FLASH = true;

// ── Particle / confetti tunables (victory) ──────────────────────────

/** Base particle count for the victory confetti burst. */
export const ENDOFRUN_VICTORY_PARTICLE_COUNT = 140;

/** Victory particle lifespan (ms) — long enough to fill the screen. */
export const ENDOFRUN_VICTORY_PARTICLE_LIFESPAN_MS = 2200;

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

// ── Victory fireworks sequence tunables (AH-0MUWZ5HCV0034H44) ───────
//
// A sustained, boss-position-anchored firework display that replaces the
// brief screen-centred in-run burst. A pure, seeded planner
// (`planVictoryFireworks`) decides *how many* bursts fire, *where* around the
// death point and *when*; the Phaser renderer (`spawnVictoryFireworks`)
// dispatches each planned burst to `spawnExplosionParticles` with a tween
// delay. Every value below is an exported tunable.

/** Whether the sustained victory fireworks sequence is enabled (layer toggle). */
export const ENDOFRUN_ENABLE_VICTORY_FIREWORKS = true;

/**
 * Total in-run fireworks duration (ms). The operator asked for 3–5 s of
 * explosions at the boss's death location before the victory screen
 * (work-item AH-0MUWZ5HCV0034H44); `PlayScene`'s
 * `VICTORY_TRANSITION_HOLD_MS` is derived from this so the scene does not
 * transition until the display has played.
 */
export const ENDOFRUN_VICTORY_FIREWORKS_DURATION_MS = 3500;

/**
 * Shorter fireworks duration (ms) used by the `GameOverScene` victory
 * branch, which continues the celebration for an additional 1–2 s on top of
 * the existing screen-centred confetti burst.
 */
export const ENDOFRUN_VICTORY_SCREEN_FIREWORKS_DURATION_MS = 1500;

/** Minimum stagger (ms) between successive firework bursts. */
export const ENDOFRUN_VICTORY_FIREWORKS_INTERVAL_MIN_MS = 200;

/** Maximum stagger (ms) between successive firework bursts. */
export const ENDOFRUN_VICTORY_FIREWORKS_INTERVAL_MAX_MS = 800;

/** Radius (px) around the anchor within which bursts are placed at random. */
export const ENDOFRUN_VICTORY_FIREWORKS_SPREAD_RADIUS = 240;

/** Particles per firework burst (before pattern splitting). */
export const ENDOFRUN_VICTORY_FIREWORKS_PARTICLE_COUNT = 26;

/**
 * Base entity size handed to `spawnExplosionParticles` for a firework —
 * together with {@link ENDOFRUN_VICTORY_FIREWORKS_SCALE} it sets the particle
 * radius and speed (the count is passed explicitly per burst).
 */
export const ENDOFRUN_VICTORY_FIREWORKS_SIZE = 16;

/** Geometry scale applied to each firework burst. */
export const ENDOFRUN_VICTORY_FIREWORKS_SCALE = 1.6;

/**
 * Hard cap on the number of bursts in one sequence. Bounds the particle
 * budget for a sustained 3–5 s display (performance mitigation from the
 * work item's risk list).
 */
export const ENDOFRUN_VICTORY_FIREWORKS_MAX_BURSTS = 14;

/**
 * The per-burst firework effect types. Each maps to a distinct
 * `spawnExplosionParticles` pattern set so at least three visually distinct
 * firework types appear in a sequence (AC1).
 */
export type VictoryFireworkKind = 'burst' | 'ring' | 'implosion';

/** Cycle of firework kinds; consecutive bursts cycle through all three. */
export const ENDOFRUN_VICTORY_FIREWORK_KINDS: readonly VictoryFireworkKind[] = [
  'burst',
  'ring',
  'implosion',
];

/** Particle pattern set for each firework kind. */
export const ENDOFRUN_VICTORY_FIREWORK_PATTERNS: Record<VictoryFireworkKind, Pattern[]> = {
  burst: ['radial'],
  ring: ['ring'],
  implosion: ['implosion'],
};

/**
 * Render depth of a `GameOverScene` firework — front-most juice layer, still
 * behind the default-depth-0 UI (see the depth convention above).
 */
export const ENDOFRUN_VICTORY_FIREWORK_DEPTH = -7;

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
  /** Whether to spawn the sustained victory fireworks sequence. */
  victoryFireworksEnabled: boolean;
  /** Total in-run fireworks duration (ms). */
  victoryFireworksDurationMs: number;
  /** Shorter `GameOverScene` fireworks duration (ms). */
  victoryScreenFireworksDurationMs: number;
  /** Minimum stagger (ms) between firework bursts. */
  victoryFireworksIntervalMinMs: number;
  /** Maximum stagger (ms) between firework bursts. */
  victoryFireworksIntervalMaxMs: number;
  /** Radius (px) around the anchor for random burst positions. */
  victoryFireworksSpreadRadius: number;
  /** Particles per firework burst. */
  victoryFireworksParticleCount: number;
  /** Geometry scale applied to each firework burst. */
  victoryFireworksScale: number;
  /** Hard cap on bursts in one sequence. */
  victoryFireworksMaxBursts: number;
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
    victoryFlashEnabled: isVictory && ENDOFRUN_ENABLE_VICTORY_FLASH,
    victoryFlashAlpha: isVictory ? ENDOFRUN_VICTORY_FLASH_ALPHA : 0,
    victoryFlashDurationMs: ENDOFRUN_VICTORY_FLASH_DURATION_MS,
    victoryColor: ENDOFRUN_VICTORY_COLOR,
    victoryGreen: ENDOFRUN_VICTORY_GREEN,
    victorySparkle: ENDOFRUN_VICTORY_SPARKLE,

    // ── Victory particles ────────────────────────────────────────
    victoryParticleCount: isVictory ? ENDOFRUN_VICTORY_PARTICLE_COUNT : 0,
    victoryParticleLifespanMs: ENDOFRUN_VICTORY_PARTICLE_LIFESPAN_MS,
    victoryParticleVelocity: isVictory ? ENDOFRUN_VICTORY_PARTICLE_VELOCITY : 0,
    victoryParticleScale: ENDOFRUN_VICTORY_PARTICLE_SCALE,
    victoryParticlesEnabled: isVictory && ENDOFRUN_ENABLE_VICTORY_PARTICLES,

    // ── Victory ring ─────────────────────────────────────────────
    victoryRingRadius: isVictory ? ENDOFRUN_VICTORY_RING_RADIUS : 0,
    victoryRingEnabled: isVictory && ENDOFRUN_ENABLE_VICTORY_RING,

    // ── Victory fireworks ───────────────────────────────────────
    victoryFireworksEnabled: isVictory && ENDOFRUN_ENABLE_VICTORY_FIREWORKS,
    victoryFireworksDurationMs: ENDOFRUN_VICTORY_FIREWORKS_DURATION_MS,
    victoryScreenFireworksDurationMs: ENDOFRUN_VICTORY_SCREEN_FIREWORKS_DURATION_MS,
    victoryFireworksIntervalMinMs: ENDOFRUN_VICTORY_FIREWORKS_INTERVAL_MIN_MS,
    victoryFireworksIntervalMaxMs: ENDOFRUN_VICTORY_FIREWORKS_INTERVAL_MAX_MS,
    victoryFireworksSpreadRadius: ENDOFRUN_VICTORY_FIREWORKS_SPREAD_RADIUS,
    victoryFireworksParticleCount: isVictory ? ENDOFRUN_VICTORY_FIREWORKS_PARTICLE_COUNT : 0,
    victoryFireworksScale: ENDOFRUN_VICTORY_FIREWORKS_SCALE,
    victoryFireworksMaxBursts: ENDOFRUN_VICTORY_FIREWORKS_MAX_BURSTS,

    // ── Shared ring params ───────────────────────────────────────
    ringDurationMs: ENDOFRUN_RING_DURATION_MS,
    ringStartScale: ENDOFRUN_RING_START_SCALE,
    ringLineWidth: ENDOFRUN_RING_LINE_WIDTH,

    // ── Defeat colours ───────────────────────────────────────────
    defeatColor: ENDOFRUN_DEFEAT_COLOR,
    defeatRed: ENDOFRUN_DEFEAT_RED,
    defeatGray: ENDOFRUN_DEFEAT_GRAY,

    // ── Defeat vignette ──────────────────────────────────────────
    defeatVignetteAlpha: isVictory ? 0 : ENDOFRUN_DEFEAT_VIGNETTE_ALPHA,
    defeatVignetteDurationMs: ENDOFRUN_DEFEAT_VIGNETTE_DURATION_MS,
    defeatVignetteEnabled: !isVictory && ENDOFRUN_ENABLE_DEFEAT_VIGNETTE,

    // ── Defeat glitch ────────────────────────────────────────────
    defeatGlitchSteps: isVictory ? 0 : ENDOFRUN_DEFEAT_GLITCH_STEPS,
    defeatGlitchStepDurationMs: ENDOFRUN_DEFEAT_GLITCH_STEP_DURATION_MS,
    defeatGlitchAlpha: isVictory ? 0 : ENDOFRUN_DEFEAT_GLITCH_ALPHA,
    defeatGlitchEnabled: !isVictory && ENDOFRUN_ENABLE_DEFEAT_GLITCH,

    // ── Defeat ring ──────────────────────────────────────────────
    defeatRingEnabled: !isVictory && ENDOFRUN_ENABLE_DEFEAT_RING,
    defeatRingRadius: isVictory ? 0 : ENDOFRUN_DEFEAT_RING_RADIUS,

    // ── Sound ────────────────────────────────────────────────────
    soundEnabled: ENDOFRUN_ENABLE_SOUND,
  };
}

// ── Rendering layers (F2 victory celebration) ──────────────────────
//
// The layers below are the Phaser rendering half of the module; the pure
// parameter model above stays free of any Phaser dependency.  They mirror
// the `playerDeathJuice.ts` layer contract: each layer reads its values from
// the resolved params, is individually switchable via an `ENDOFRUN_ENABLE_*`
// toggle, pushes every display object into a caller-owned registry and
// removes it on completion so `SHUTDOWN` teardown can destroy leftovers.
//
// Depth note: juice layers render at negative depth so they sit *above* the
// GameOverScene background (which F5 gives a lower negative depth) but
// *behind* the default-depth (0) score / initials / leaderboard UI.  This is
// what keeps the treatment non-blocking — it can never occlude the UI or
// intercept a pointer.

import Phaser from 'phaser';

import {
  createRng,
  spawnExplosionParticles,
  type ExplosionHandle,
  type Pattern,
} from './explosionParticles';
import type { JuiceRegistry } from './playerDeathJuice';

/** Depth of the victory flash — behind the GameOverScene UI. */
export const ENDOFRUN_VICTORY_FLASH_DEPTH = -10;

/** Depth of the victory rings — above the flash, behind the confetti. */
export const ENDOFRUN_VICTORY_RING_DEPTH = -9;

/** Depth of the victory confetti — the front-most juice layer, still behind UI. */
export const ENDOFRUN_VICTORY_CONFETTI_DEPTH = -8;

/** Number of staggered celebration rings spawned by the victory treatment. */
export const ENDOFRUN_VICTORY_RING_COUNT = 3;

/** Stagger (ms) between successive victory rings. */
export const ENDOFRUN_VICTORY_RING_STAGGER_MS = 180;

/** Confetti piece width (px). */
export const ENDOFRUN_CONFETTI_WIDTH = 8;

/** Confetti piece height (px). */
export const ENDOFRUN_CONFETTI_HEIGHT = 4;

/** Confetti travel distance (px) from the burst centre. */
export const ENDOFRUN_CONFETTI_TRAVEL = 260;

/** Confetti angular spin per tween (degrees). */
export const ENDOFRUN_CONFETTI_SPIN = 540;

/** Number of distinct victory palette colours cycled across confetti pieces. */
export const ENDOFRUN_VICTORY_PALETTE_SIZE = 3;

/** Optional overrides for the victory celebration layers. */
export interface VictoryJuiceOptions {
  /**
   * Caller-owned registry every juice display object is added to and removed
   * from on completion. Defaults to a fresh array. Scenes pass their
   * `endOfRunEffects` array so `SHUTDOWN` can destroy any leftovers.
   */
  registry?: JuiceRegistry;
  /** PRNG seed for deterministic confetti layout in tests. */
  seed?: number;
  /** X origin of the celebration (defaults to the scene centre). */
  x?: number;
  /** Y origin of the celebration (defaults to the scene centre). */
  y?: number;
}

/** Handle returned by {@link spawnVictoryJuice}. */
export interface VictoryJuiceHandle {
  /** The resolved victory parameters the effect ran with. */
  params: EndOfRunJuiceParams;
  /** Every juice-owned display object (flash, rings, confetti). */
  registry: JuiceRegistry;
  /** The flash rectangle (or `null` when the flash toggle is off). */
  flash: Phaser.GameObjects.Rectangle | null;
  /** The spawned celebration rings (empty when the ring toggle is off). */
  rings: Phaser.GameObjects.Graphics[];
  /** The spawned confetti pieces (empty when the particle toggle is off). */
  confetti: Phaser.GameObjects.Rectangle[];
  /** Reserved for a future delegated particle burst (always `null` today). */
  particles: ExplosionHandle | null;
}

/** Picks the victory cycle colour for confetti index `i`. */
function victoryPaletteColor(params: EndOfRunJuiceParams, i: number): number {
  const palette = [params.victoryColor, params.victoryGreen, params.victorySparkle];
  return palette[i % palette.length];
}

/**
 * Spawns the bright victory flash/glow overlay (F2 layer 1).
 *
 * A non-interactive full-screen rectangle in the victory colour, fixed to the
 * camera (scroll factor 0) behind the UI, fading from the resolved alpha to 0
 * over the resolved duration. On completion it is destroyed and removed from
 * `registry`.
 *
 * No-op (`null`) when the flash toggle is off or the scene lacks an `add`
 * facility.
 */
export function spawnVictoryFlash(
  scene: Phaser.Scene,
  params: EndOfRunJuiceParams,
  registry?: JuiceRegistry,
): Phaser.GameObjects.Rectangle | null {
  if (!params.victoryFlashEnabled) return null;
  const sceneAdd = scene?.add as
    | { rectangle?: (...args: unknown[]) => Phaser.GameObjects.Rectangle }
    | undefined;
  if (!sceneAdd || typeof sceneAdd.rectangle !== 'function') return null;

  const width = scene.scale?.width ?? 0;
  const height = scene.scale?.height ?? 0;
  const flash = sceneAdd.rectangle(
    width / 2,
    height / 2,
    width,
    height,
    params.victoryColor,
    params.victoryFlashAlpha,
  );
  flash.setDepth(ENDOFRUN_VICTORY_FLASH_DEPTH);
  flash.setScrollFactor(0);
  flash.setData('juiceLayer', 'victoryFlash');
  registry?.push(flash);

  scene.tweens.add({
    targets: flash,
    alpha: 0,
    duration: params.victoryFlashDurationMs,
    ease: 'Power2',
    onComplete: () => {
      if (registry) {
        const index = registry.indexOf(flash);
        if (index >= 0) registry.splice(index, 1);
      }
      flash.destroy();
    },
  });

  return flash;
}

/**
 * Spawns the victory celebration rings (F2 layer 2).
 *
 * {@link ENDOFRUN_VICTORY_RING_COUNT} stroked rings expand outward from (x, y)
 * over the resolved duration, staggered by
 * {@link ENDOFRUN_VICTORY_RING_STAGGER_MS}. Each ring is its own Graphics so
 * it can be torn down independently; every ring is pushed to `registry` on
 * spawn and spliced out when its tween completes.
 *
 * No-op (`[]`) when the ring toggle is off.
 */
export function spawnVictoryRings(
  scene: Phaser.Scene,
  x: number,
  y: number,
  params: EndOfRunJuiceParams,
  registry?: JuiceRegistry,
): Phaser.GameObjects.Graphics[] {
  if (!params.victoryRingEnabled || params.victoryRingRadius <= 0) return [];

  const rings: Phaser.GameObjects.Graphics[] = [];
  for (let i = 0; i < ENDOFRUN_VICTORY_RING_COUNT; i++) {
    const ring = scene.add.graphics({ x, y });
    ring.setDepth(ENDOFRUN_VICTORY_RING_DEPTH);
    const color = i % 2 === 0 ? params.victoryColor : params.victoryGreen;
    ring.lineStyle(params.ringLineWidth, color, 1);
    ring.strokeCircle(0, 0, params.victoryRingRadius);
    ring.setScale(params.ringStartScale);
    ring.setData('juiceLayer', 'victoryRing');
    ring.setData('ringIndex', i);
    registry?.push(ring);
    rings.push(ring);

    scene.tweens.add({
      targets: ring,
      scale: 1,
      alpha: 0,
      delay: i * ENDOFRUN_VICTORY_RING_STAGGER_MS,
      duration: params.ringDurationMs,
      ease: 'Power2',
      onComplete: () => {
        if (registry) {
          const index = registry.indexOf(ring);
          if (index >= 0) registry.splice(index, 1);
        }
        ring.destroy();
      },
    });
  }

  return rings;
}

/**
 * Spawns the victory confetti burst (F2 layer 3).
 *
 * `params.victoryParticleCount` small confetti rectangles fly outward from
 * (x, y), spinning and fading over `params.victoryParticleLifespanMs`. Each
 * piece cycles through the victory palette so the burst reads as multi-colour
 * celebration. Every piece is an individual Rectangle with its own tween, so
 * it can be torn down independently; each is pushed to `registry` on spawn
 * and spliced out on completion. A seeded RNG keeps the layout deterministic
 * for tests.
 *
 * No-op (`[]`) when the particle toggle is off or the count is zero.
 */
export function spawnVictoryConfetti(
  scene: Phaser.Scene,
  x: number,
  y: number,
  params: EndOfRunJuiceParams,
  registry?: JuiceRegistry,
  options: { seed?: number } = {},
): Phaser.GameObjects.Rectangle[] {
  if (!params.victoryParticlesEnabled || params.victoryParticleCount <= 0) return [];

  const rng = createRng(options.seed ?? Date.now());
  const confetti: Phaser.GameObjects.Rectangle[] = [];

  for (let i = 0; i < params.victoryParticleCount; i++) {
    const angle = rng() * Math.PI * 2;
    const travel = ENDOFRUN_CONFETTI_TRAVEL * (0.5 + rng() * 0.5);
    const dx = Math.cos(angle) * travel;
    const dy = Math.sin(angle) * travel;
    const spin = (rng() - 0.5) * 2 * ENDOFRUN_CONFETTI_SPIN;

    const piece = scene.add.rectangle(
      x,
      y,
      ENDOFRUN_CONFETTI_WIDTH,
      ENDOFRUN_CONFETTI_HEIGHT,
      victoryPaletteColor(params, i),
      1,
    );
    piece.setDepth(ENDOFRUN_VICTORY_CONFETTI_DEPTH);
    piece.setData('juiceLayer', 'victoryConfetti');
    registry?.push(piece);
    confetti.push(piece);

    scene.tweens.add({
      targets: piece,
      x: x + dx,
      y: y + dy,
      angle: spin,
      alpha: 0,
      scale: 0.4,
      duration: params.victoryParticleLifespanMs,
      ease: 'Power1',
      onComplete: () => {
        if (registry) {
          const index = registry.indexOf(piece);
          if (index >= 0) registry.splice(index, 1);
        }
        piece.destroy();
      },
    });
  }

  return confetti;
}

/**
 * Composes and plays the full victory celebration (F2, parent AC2).
 *
 * The single shared entry point for the victory end-of-run treatment: it
 * resolves the victory parameters, then spawns the flash, one or more rings
 * and the confetti burst — each layer self-guarded by its `ENDOFRUN_ENABLE_*`
 * toggle. Every spawned display object is added to `options.registry` (or a
 * fresh array) so `SHUTDOWN` teardown can destroy them. Purely cosmetic: it
 * never reads or writes gameplay state and never intercepts input.
 *
 * @param scene   — the scene to render into.
 * @param options — registry, seed and origin injection (tests / teardown).
 */
export function spawnVictoryJuice(
  scene: Phaser.Scene,
  options: VictoryJuiceOptions = {},
): VictoryJuiceHandle {
  const params = resolveEndOfRunJuiceParams('victory');
  const registry: JuiceRegistry = options.registry ?? [];
  const width = scene.scale?.width ?? 0;
  const height = scene.scale?.height ?? 0;
  const x = options.x ?? width / 2;
  const y = options.y ?? height / 2;

  const flash = spawnVictoryFlash(scene, params, registry);
  const rings = spawnVictoryRings(scene, x, y, params, registry);
  const confetti = spawnVictoryConfetti(scene, x, y, params, registry, {
    seed: options.seed,
  });

  return { params, registry, flash, rings, confetti, particles: null };
}

// ── Victory fireworks sequence (AH-0MUWZ5HCV0034H44) ────────────────
//
// The sustained celebration the operator asked for: a 3–5 s sequence of
// explosions/fireworks at random positions around the boss's death point,
// continuing for a shorter burst on `GameOverScene`. The split mirrors the
// rest of the module — a pure, seeded planner (`planVictoryFireworks`) and a
// thin Phaser renderer (`spawnVictoryFireworks`) that delegates each burst to
// the shared `spawnExplosionParticles` helper.

/** One planned firework burst (pure, no Phaser types). */
export interface VictoryFireworkBurst {
  /** Which firework effect type to render. */
  kind: VictoryFireworkKind;
  /** Delay (ms) from sequence start before the burst animates. */
  delayMs: number;
  /** World X of the burst centre. */
  x: number;
  /** World Y of the burst centre. */
  y: number;
  /** Burst colour (from the victory palette). */
  color: number;
  /** Particles in the burst. */
  particleCount: number;
  /** Geometry scale for the burst. */
  scale: number;
}

/** Optional overrides for {@link planVictoryFireworks}. */
export interface VictoryFireworksPlanOptions {
  /** PRNG seed (default `Date.now()`). */
  seed?: number;
  /** Total sequence duration (ms). */
  durationMs?: number;
  /** Minimum stagger between bursts (ms). */
  intervalMinMs?: number;
  /** Maximum stagger between bursts (ms). */
  intervalMaxMs?: number;
  /** Random-position spread radius (px). */
  spreadRadius?: number;
  /** Particles per burst. */
  particleCount?: number;
  /** Geometry scale per burst. */
  scale?: number;
  /** Hard cap on bursts. */
  maxBursts?: number;
  /** Colours cycled across bursts (defaults to the victory palette). */
  colors?: readonly number[];
  /** Kinds cycled across bursts (defaults to the three firework kinds). */
  kinds?: readonly VictoryFireworkKind[];
}

/**
 * Plans a sustained firework sequence around `(originX, originY)`.
 *
 * Pure, total and deterministic for a fixed seed: bursts are placed at
 * uniformly-distributed random positions within `spreadRadius` of the origin
 * (a `sqrt` radius keeps the disc scatter even) and scheduled at staggered
 * `[intervalMinMs, intervalMaxMs]` intervals until `durationMs` elapses or
 * `maxBursts` is reached. Kinds and colours cycle, so a sequence of three or
 * more bursts uses every firework type. Returns `[]` for a non-positive
 * duration.
 *
 * @param originX — anchor X (the boss's death position in-run).
 * @param originY — anchor Y.
 * @param options — seed, duration, interval, spread and per-burst tunables.
 */
export function planVictoryFireworks(
  originX: number,
  originY: number,
  options: VictoryFireworksPlanOptions = {},
): VictoryFireworkBurst[] {
  const durationMs = options.durationMs ?? ENDOFRUN_VICTORY_FIREWORKS_DURATION_MS;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];

  const rawMin = options.intervalMinMs ?? ENDOFRUN_VICTORY_FIREWORKS_INTERVAL_MIN_MS;
  const rawMax = options.intervalMaxMs ?? ENDOFRUN_VICTORY_FIREWORKS_INTERVAL_MAX_MS;
  const intervalMinMs = Math.max(1, Math.min(rawMin, rawMax));
  const intervalMaxMs = Math.max(intervalMinMs, rawMax);

  const spreadRadius = Math.max(
    0,
    options.spreadRadius ?? ENDOFRUN_VICTORY_FIREWORKS_SPREAD_RADIUS,
  );
  const particleCount = Math.max(
    1,
    Math.round(options.particleCount ?? ENDOFRUN_VICTORY_FIREWORKS_PARTICLE_COUNT),
  );
  const scale = options.scale ?? ENDOFRUN_VICTORY_FIREWORKS_SCALE;
  const maxBursts = Math.max(
    1,
    Math.floor(options.maxBursts ?? ENDOFRUN_VICTORY_FIREWORKS_MAX_BURSTS),
  );
  const colors =
    options.colors && options.colors.length > 0
      ? [...options.colors]
      : [ENDOFRUN_VICTORY_COLOR, ENDOFRUN_VICTORY_GREEN, ENDOFRUN_VICTORY_SPARKLE];
  const kinds =
    options.kinds && options.kinds.length > 0
      ? [...options.kinds]
      : [...ENDOFRUN_VICTORY_FIREWORK_KINDS];

  const rng = createRng(options.seed ?? Date.now());
  const bursts: VictoryFireworkBurst[] = [];
  let delayMs = 0;

  while (delayMs < durationMs && bursts.length < maxBursts) {
    const angle = rng() * Math.PI * 2;
    const radius = spreadRadius * Math.sqrt(rng());
    bursts.push({
      kind: kinds[bursts.length % kinds.length],
      delayMs,
      x: originX + Math.cos(angle) * radius,
      y: originY + Math.sin(angle) * radius,
      color: colors[bursts.length % colors.length],
      particleCount,
      scale,
    });
    delayMs += intervalMinMs + rng() * (intervalMaxMs - intervalMinMs);
  }

  return bursts;
}

/** Optional overrides for {@link spawnVictoryFireworks}. */
export interface VictoryFireworksOptions extends VictoryFireworksPlanOptions {
  /** Caller-owned registry every burst is added to / removed from. */
  registry?: JuiceRegistry;
  /** Resolved-parameter override (test seam / partial disable). */
  params?: EndOfRunJuiceParams;
  /**
   * Render depth for the burst Graphics. Defaults to the GameOverScene juice
   * depth ({@link ENDOFRUN_VICTORY_FIREWORK_DEPTH}, behind the UI); the in-run
   * `PlayScene` passes a HUD-relative positive depth so the display is visible
   * above the gameplay layer.
   */
  depth?: number;
}

/** Handle returned by {@link spawnVictoryFireworks}. */
export interface VictoryFireworksHandle {
  /** The resolved victory parameters the sequence ran with. */
  params: EndOfRunJuiceParams;
  /** Every firework-owned display object (one Graphics per burst). */
  registry: JuiceRegistry;
  /** The planned bursts (delays, positions, kinds). */
  bursts: VictoryFireworkBurst[];
  /** The spawned explosion handles (one per burst, in plan order). */
  explosions: ExplosionHandle[];
}

/**
 * Spawns the sustained victory fireworks sequence around `(x, y)`.
 *
 * Plans the bursts with {@link planVictoryFireworks} (pure/seeded) then
 * dispatches each to `spawnExplosionParticles` with its planned delay,
 * colour, count, pattern set and scale. Every burst Graphics is pushed to
 * `options.registry` (or a fresh array) and removes itself on completion, so
 * a `SHUTDOWN` teardown destroys any leftovers. Purely cosmetic and
 * non-interactive — it can never occlude or intercept input.
 *
 * No-op (empty `bursts` / `explosions`) when
 * `ENDOFRUN_ENABLE_VICTORY_FIREWORKS` is off in the resolved params, or when
 * the duration is non-positive.
 *
 * @param scene   — the scene to render into.
 * @param x       — anchor X (the boss's death position in-run).
 * @param y       — anchor Y.
 * @param options — registry, seed, depth and per-burst plan overrides.
 */
export function spawnVictoryFireworks(
  scene: Phaser.Scene,
  x: number,
  y: number,
  options: VictoryFireworksOptions = {},
): VictoryFireworksHandle {
  const params = options.params ?? resolveEndOfRunJuiceParams('victory');
  const registry: JuiceRegistry = options.registry ?? [];
  const depth = options.depth ?? ENDOFRUN_VICTORY_FIREWORK_DEPTH;

  if (!params.victoryFireworksEnabled) {
    return { params, registry, bursts: [], explosions: [] };
  }

  const seed = options.seed ?? Date.now();
  const bursts = planVictoryFireworks(x, y, {
    seed,
    durationMs: options.durationMs ?? params.victoryFireworksDurationMs,
    intervalMinMs: options.intervalMinMs ?? params.victoryFireworksIntervalMinMs,
    intervalMaxMs: options.intervalMaxMs ?? params.victoryFireworksIntervalMaxMs,
    spreadRadius: options.spreadRadius ?? params.victoryFireworksSpreadRadius,
    particleCount: options.particleCount ?? params.victoryFireworksParticleCount,
    scale: options.scale ?? params.victoryFireworksScale,
    maxBursts: options.maxBursts ?? params.victoryFireworksMaxBursts,
    colors: options.colors,
    kinds: options.kinds,
  });

  const explosions: ExplosionHandle[] = [];
  for (let i = 0; i < bursts.length; i++) {
    const burst = bursts[i];
    const handle = spawnExplosionParticles(
      scene,
      burst.x,
      burst.y,
      burst.color,
      ENDOFRUN_VICTORY_FIREWORKS_SIZE,
      {
        patterns: ENDOFRUN_VICTORY_FIREWORK_PATTERNS[burst.kind],
        count: burst.particleCount,
        lifespan: params.victoryParticleLifespanMs,
        scale: burst.scale,
        delay: burst.delayMs,
        depth,
        seed: seed + i + 1,
        registry,
      },
    );
    if (!handle) continue;
    // Tag the burst so registry tooling can identify a fireworks layer.
    const tagged = handle.graphics as
      | { setData?: (key: string, value: unknown) => unknown }
      | null;
    tagged?.setData?.('juiceLayer', 'victoryFirework');
    explosions.push(handle);
  }

  return { params, registry, bursts, explosions };
}

// ── Rendering layers (F3 defeat screen treatment) ──────────────────
//
// The defeat treatment is deliberately *distinct* from both the victory
// celebration (bright, warm, expanding) and the in-run fatal death juice
// (`playerDeathJuice.ts` — cyan flash/shake/shockwave at the death point).
// It is sombre and screen-centred: a red edge vignette, a desaturated grey
// glitch flicker and a slow, dim red ring.  Like every other layer it reads
// its values from the pure parameter model, honours its `ENDOFRUN_ENABLE_*`
// toggle, and pushes each display object into the caller-owned registry so
// `SHUTDOWN` can tear it down.
//
// Depth note (same contract as the victory layers): negative depth keeps the
// treatment above the GameOverScene background and behind the default-depth
// (0) UI, so it never occludes the score / initials / leaderboard or blocks a
// pointer.

/** Depth of the defeat vignette — behind the GameOverScene UI. */
export const ENDOFRUN_DEFEAT_VIGNETTE_DEPTH = -10;

/** Depth of the defeat ring — above the vignette, behind the glitch. */
export const ENDOFRUN_DEFEAT_RING_DEPTH = -9;

/** Depth of the defeat glitch flicker — front-most juice layer, behind UI. */
export const ENDOFRUN_DEFEAT_GLITCH_DEPTH = -8;

/** Number of vignette bands drawn from the screen edge inward. */
export const ENDOFRUN_DEFEAT_VIGNETTE_BANDS = 12;

/** Width (px) of each vignette band. */
export const ENDOFRUN_DEFEAT_VIGNETTE_BAND_WIDTH = 18;

/** Optional overrides for the defeat screen treatment layers. */
export interface DefeatJuiceOptions {
  /**
   * Caller-owned registry every treatment display object is added to and
   * removed from on completion. Defaults to a fresh array.
   */
  registry?: JuiceRegistry;
  /** X origin of the defeat ring (defaults to the scene centre). */
  x?: number;
  /** Y origin of the defeat ring (defaults to the scene centre). */
  y?: number;
}

/** Handle returned by {@link spawnDefeatScreenJuice}. */
export interface DefeatJuiceHandle {
  /** The resolved defeat parameters the treatment ran with. */
  params: EndOfRunJuiceParams;
  /** Every treatment-owned display object (vignette, ring, glitch). */
  registry: JuiceRegistry;
  /** The vignette Graphics (or `null` when the vignette toggle is off). */
  vignette: Phaser.GameObjects.Graphics | null;
  /** The defeat ring Graphics (or `null` when the ring toggle is off). */
  ring: Phaser.GameObjects.Graphics | null;
  /** The glitch flicker rectangle (or `null` when the glitch toggle is off). */
  glitch: Phaser.GameObjects.Rectangle | null;
}

/**
 * Spawns the sombre red edge vignette (F3 layer 1).
 *
 * A single Graphics draws {@link ENDOFRUN_DEFEAT_VIGNETTE_BANDS} stroked
 * rectangles inward from the screen edge, each in the defeat colour with a
 * band-dependent alpha so the screen edges darken into a red frame. Fixed to
 * the camera (scroll factor 0) behind the UI; it fades out over
 * `params.defeatVignetteDurationMs` and is destroyed / de-registered on
 * completion.
 *
 * No-op (`null`) when the vignette toggle is off.
 */
export function spawnDefeatVignette(
  scene: Phaser.Scene,
  params: EndOfRunJuiceParams,
  registry?: JuiceRegistry,
): Phaser.GameObjects.Graphics | null {
  if (!params.defeatVignetteEnabled) return null;
  const sceneAdd = scene?.add as
    | { graphics?: (...args: unknown[]) => Phaser.GameObjects.Graphics }
    | undefined;
  if (!sceneAdd || typeof sceneAdd.graphics !== 'function') return null;

  const width = scene.scale?.width ?? 0;
  const height = scene.scale?.height ?? 0;
  const vignette = scene.add.graphics({ x: 0, y: 0 });
  vignette.setDepth(ENDOFRUN_DEFEAT_VIGNETTE_DEPTH);
  vignette.setScrollFactor(0);
  vignette.setData('juiceLayer', 'defeatVignette');

  // Draw bands from the edge inward: the outermost band is brightest and
  // each inner band fades, producing a red vignette frame.
  for (let i = 0; i < ENDOFRUN_DEFEAT_VIGNETTE_BANDS; i++) {
    const inset = i * ENDOFRUN_DEFEAT_VIGNETTE_BAND_WIDTH;
    const alpha =
      params.defeatVignetteAlpha *
      (1 - i / ENDOFRUN_DEFEAT_VIGNETTE_BANDS);
    vignette.lineStyle(ENDOFRUN_DEFEAT_VIGNETTE_BAND_WIDTH, params.defeatRed, alpha);
    vignette.strokeRect(
      inset,
      inset,
      Math.max(0, width - inset * 2),
      Math.max(0, height - inset * 2),
    );
  }

  registry?.push(vignette);

  scene.tweens.add({
    targets: vignette,
    alpha: 0,
    duration: params.defeatVignetteDurationMs,
    ease: 'Power2',
    onComplete: () => {
      if (registry) {
        const index = registry.indexOf(vignette);
        if (index >= 0) registry.splice(index, 1);
      }
      vignette.destroy();
    },
  });

  return vignette;
}

/**
 * Spawns the desaturated grey glitch flicker overlay (F3 layer 2).
 *
 * A full-screen grey rectangle fixed to the camera, flashing between 0 and
 * `params.defeatGlitchAlpha` for `params.defeatGlitchSteps` flickers of
 * `params.defeatGlitchStepDurationMs`, then destroyed / de-registered on
 * completion. The grey wash reads as the screen desaturating and glitching
 * out — the visual counterpart to the descending defeat sting.
 *
 * No-op (`null`) when the glitch toggle is off or there are no steps.
 */
export function spawnDefeatGlitch(
  scene: Phaser.Scene,
  params: EndOfRunJuiceParams,
  registry?: JuiceRegistry,
): Phaser.GameObjects.Rectangle | null {
  if (!params.defeatGlitchEnabled || params.defeatGlitchSteps <= 0) return null;
  const sceneAdd = scene?.add as
    | { rectangle?: (...args: unknown[]) => Phaser.GameObjects.Rectangle }
    | undefined;
  if (!sceneAdd || typeof sceneAdd.rectangle !== 'function') return null;

  const width = scene.scale?.width ?? 0;
  const height = scene.scale?.height ?? 0;
  const glitch = sceneAdd.rectangle(
    width / 2,
    height / 2,
    width,
    height,
    params.defeatGray,
    0,
  );
  glitch.setDepth(ENDOFRUN_DEFEAT_GLITCH_DEPTH);
  glitch.setScrollFactor(0);
  glitch.setData('juiceLayer', 'defeatGlitch');
  registry?.push(glitch);

  scene.tweens.add({
    targets: glitch,
    alpha: { from: 0, to: params.defeatGlitchAlpha },
    duration: params.defeatGlitchStepDurationMs,
    yoyo: true,
    repeat: params.defeatGlitchSteps - 1,
    ease: 'Stepped',
    onComplete: () => {
      if (registry) {
        const index = registry.indexOf(glitch);
        if (index >= 0) registry.splice(index, 1);
      }
      glitch.destroy();
    },
  });

  return glitch;
}

/**
 * Spawns the slow, dim red defeat ring (F3 layer 3).
 *
 * A single stroked Graphics expands from `params.ringStartScale` to full
 * `params.defeatRingRadius` over `params.ringDurationMs`, fading as it goes.
 * Red and screen-centred, it is visually distinct from the cyan death
 * shockwave (`playerDeathJuice.ts`) and the bright victory rings. Tracked in
 * `registry` and torn down on completion.
 *
 * No-op (`null`) when the defeat ring toggle is off.
 */
export function spawnDefeatRing(
  scene: Phaser.Scene,
  x: number,
  y: number,
  params: EndOfRunJuiceParams,
  registry?: JuiceRegistry,
): Phaser.GameObjects.Graphics | null {
  if (!params.defeatRingEnabled || params.defeatRingRadius <= 0) return null;

  const ring = scene.add.graphics({ x, y });
  ring.setDepth(ENDOFRUN_DEFEAT_RING_DEPTH);
  ring.lineStyle(params.ringLineWidth, params.defeatColor, 1);
  ring.strokeCircle(0, 0, params.defeatRingRadius);
  ring.setScale(params.ringStartScale);
  ring.setData('juiceLayer', 'defeatRing');
  registry?.push(ring);

  scene.tweens.add({
    targets: ring,
    scale: 1,
    alpha: 0,
    duration: params.ringDurationMs,
    ease: 'Power2',
    onComplete: () => {
      if (registry) {
        const index = registry.indexOf(ring);
        if (index >= 0) registry.splice(index, 1);
      }
      ring.destroy();
    },
  });

  return ring;
}

/**
 * Composes and plays the full defeat screen treatment (F3, parent AC3).
 *
 * The single shared entry point for the defeat end-of-run treatment: it
 * resolves the defeat parameters, then spawns the red vignette, the dim red
 * ring and the desaturated glitch flicker — each layer self-guarded by its
 * `ENDOFRUN_ENABLE_*` toggle. Every display object is added to
 * `options.registry` (or a fresh array) so `SHUTDOWN` teardown can destroy
 * them. Purely cosmetic: it never reads or writes gameplay state and never
 * intercepts input.
 *
 * The defeat **sting** (audio) is deliberately not triggered here — the
 * screen owns that one-shot (F5), so it fires exactly once per defeat.
 *
 * @param scene   — the scene to render into.
 * @param options — registry and origin injection (tests / teardown).
 */
export function spawnDefeatScreenJuice(
  scene: Phaser.Scene,
  options: DefeatJuiceOptions = {},
): DefeatJuiceHandle {
  const params = resolveEndOfRunJuiceParams('defeat');
  const registry: JuiceRegistry = options.registry ?? [];
  const width = scene.scale?.width ?? 0;
  const height = scene.scale?.height ?? 0;
  const x = options.x ?? width / 2;
  const y = options.y ?? height / 2;

  const vignette = spawnDefeatVignette(scene, params, registry);
  const ring = spawnDefeatRing(scene, x, y, params, registry);
  const glitch = spawnDefeatGlitch(scene, params, registry);

  return { params, registry, vignette, ring, glitch };
}
