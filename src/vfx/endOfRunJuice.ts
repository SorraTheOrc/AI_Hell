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

import { createRng, type ExplosionHandle } from './explosionParticles';
import type { JuiceRegistry } from './playerDeathJuice';

/** Depth of the victory flash — behind the GameOverScene UI. */
export const ENDOFRUN_VICTORY_FLASH_DEPTH = -10;

/** Depth of the victory rings — above the flash, behind the confetti. */
export const ENDOFRUN_VICTORY_RING_DEPTH = -9;

/** Depth of the victory confetti — the front-most juice layer, still behind UI. */
export const ENDOFRUN_VICTORY_CONFETTI_DEPTH = -8;

/** Number of staggered celebration rings spawned by the victory treatment. */
export const ENDOFRUN_VICTORY_RING_COUNT = 2;

/** Stagger (ms) between successive victory rings. */
export const ENDOFRUN_VICTORY_RING_STAGGER_MS = 120;

/** Confetti piece width (px). */
export const ENDOFRUN_CONFETTI_WIDTH = 8;

/** Confetti piece height (px). */
export const ENDOFRUN_CONFETTI_HEIGHT = 4;

/** Confetti travel distance (px) from the burst centre. */
export const ENDOFRUN_CONFETTI_TRAVEL = 220;

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
