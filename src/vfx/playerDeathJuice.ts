/**
 * Player-death juice — parameter model and tunables
 * (parent AH-0MUAYB4R3002ZIZY, feature F1).
 *
 * The player's destruction is the most consequential event in the game, so it
 * gets a layered "juice" response rather than a single particle puff: camera
 * shake, a dedicated hull-breach SFX, a larger particle burst, a screen flash,
 * debris shards and an expanding shockwave ring.
 *
 * This module is the **single source of truth** for that effect:
 *   - `resolveJuiceParams(severity)` is the pure, total, deterministic
 *     severity→parameter mapping. It has **no Phaser import** and no side
 *     effects, so it is trivially unit-testable.
 *   - All tunables are exported constants below, so a designer/developer can
 *     retune shake strength, flash alpha, debris/shockwave counts and the
 *     per-severity multipliers in one place without touching scene code.
 *
 * Severity model (`[ASSUMPTION]`, producer-validatable — parent intake Q2):
 *   - `'respawn'` — a mid-run life lost; the effect plays at base strength.
 *   - `'fatal'`   — the final life / game-over; every magnitude is scaled up
 *     so the run-ending death reads heavier without becoming disorienting.
 *
 * The Phaser rendering layers (shake, flash, debris, shockwave) and the
 * `spawnPlayerDeathJuice` composition entry point are added by features F3–F5
 * and live in this same module so the layer set stays in one place.
 */

import { SHIP_COLOR } from '../core/constants';
import { createRng } from './explosionParticles';
import Phaser from 'phaser';

// ── Severity ────────────────────────────────────────────────────────

/** Player-death severity: a mid-run respawn vs. a run-ending (fatal) death. */
export type PlayerDeathSeverity = 'respawn' | 'fatal';

/** Severity used when an unknown/invalid value is supplied (never throws). */
export const PLAYER_DEATH_DEFAULT_SEVERITY: PlayerDeathSeverity = 'respawn';

// ── Shake tunables ──────────────────────────────────────────────────

/**
 * Base scene-camera shake intensity for a `'respawn'` death (Phaser
 * `camera.shake` intensity: fraction of viewport shaken). Within the intake
 * assumption range 0.008–0.02.
 */
export const PLAYER_DEATH_SHAKE_INTENSITY = 0.012;

/**
 * Base scene-camera shake duration in milliseconds for a `'respawn'` death.
 * Within the intake assumption range 250–400 ms; kept short to avoid motion
 * discomfort.
 */
export const PLAYER_DEATH_SHAKE_DURATION_MS = 320;

/** Whether the camera-shake layer is enabled (per-layer toggle). */
export const PLAYER_DEATH_ENABLE_SHAKE = true;

// ── Flash tunables ──────────────────────────────────────────────────

/**
 * Base full-screen flash peak alpha for a `'respawn'` death (1 → 0 fade).
 * The flash is non-interactive and cosmetic only.
 */
export const PLAYER_DEATH_FLASH_ALPHA = 0.5;

/**
 * Base flash fade duration in milliseconds. Within the intake assumption
 * range 120–200 ms.
 */
export const PLAYER_DEATH_FLASH_DURATION_MS = 160;

/** Flash/particle colour — neon cyan, matching the player ship (GDD §7.1). */
export const PLAYER_DEATH_FLASH_COLOR = SHIP_COLOR;

/** Whether the screen-flash layer is enabled (per-layer toggle). */
export const PLAYER_DEATH_ENABLE_FLASH = true;

// ── Particle tunables (delegated to `spawnExplosionParticles`) ─────

/** Base particle count for the player-death burst (base layer). */
export const PLAYER_DEATH_PARTICLE_COUNT = 60;

/** Particle burst lifespan in milliseconds. */
export const PLAYER_DEATH_PARTICLE_LIFESPAN_MS = 400;

/** Extra geometry scale applied to the player-death particle burst. */
export const PLAYER_DEATH_PARTICLE_SCALE = 1.15;

/** Whether the particle-burst layer is enabled (per-layer toggle). */
export const PLAYER_DEATH_ENABLE_PARTICLES = true;

// ── Debris tunables ────────────────────────────────────────────────

/** Base number of debris shards flung outward on a `'respawn'` death. */
export const PLAYER_DEATH_DEBRIS_COUNT = 10;

/** Debris shard lifespan in milliseconds (outlives the particle burst). */
export const PLAYER_DEATH_DEBRIS_LIFESPAN_MS = 520;

/** Whether the debris-shard layer is enabled (per-layer toggle). */
export const PLAYER_DEATH_ENABLE_DEBRIS = true;

// ── Shockwave tunables ─────────────────────────────────────────────

/** Base radius (px) the shockwave ring expands to for a `'respawn'` death. */
export const PLAYER_DEATH_SHOCKWAVE_RADIUS = 95;

/** Shockwave ring expansion duration in milliseconds. */
export const PLAYER_DEATH_SHOCKWAVE_DURATION_MS = 380;

/** Whether the shockwave-ring layer is enabled (per-layer toggle). */
export const PLAYER_DEATH_ENABLE_SHOCKWAVE = true;

// ── Sound tunable ──────────────────────────────────────────────────

/** Whether the dedicated player-destruction SFX layer is enabled. */
export const PLAYER_DEATH_ENABLE_SOUND = true;

// ── Severity multipliers ('fatal' scales every magnitude up) ───────

/** Multiplier applied to shake intensity for a `'fatal'` death. */
export const PLAYER_DEATH_SEVERITY_FATAL_SHAKE_INTENSITY_MULT = 1.6;

/** Multiplier applied to shake duration for a `'fatal'` death. */
export const PLAYER_DEATH_SEVERITY_FATAL_SHAKE_DURATION_MULT = 1.25;

/** Multiplier applied to flash alpha for a `'fatal'` death. */
export const PLAYER_DEATH_SEVERITY_FATAL_FLASH_ALPHA_MULT = 1.4;

/** Multiplier applied to debris count for a `'fatal'` death. */
export const PLAYER_DEATH_SEVERITY_FATAL_DEBRIS_COUNT_MULT = 1.6;

/** Multiplier applied to shockwave radius for a `'fatal'` death. */
export const PLAYER_DEATH_SEVERITY_FATAL_SHOCKWAVE_RADIUS_MULT = 1.5;

// ── Resolved parameter shape ───────────────────────────────────────

/**
 * Fully-resolved player-death juice parameters for a single severity.
 * Every layer reads from this shape so the rendering helpers stay thin.
 */
export interface PlayerDeathJuiceParams {
  /** Phaser `camera.shake` intensity. */
  shakeIntensity: number;
  /** Phaser `camera.shake` duration (ms). */
  shakeDurationMs: number;
  /** Whether to trigger the camera shake. */
  shakeEnabled: boolean;
  /** Peak alpha of the full-screen flash (fades 1 → 0 scaled by this). */
  flashAlpha: number;
  /** Flash fade duration (ms). */
  flashDurationMs: number;
  /** Flash/debris colour (hex). */
  flashColor: number;
  /** Whether to spawn the flash overlay. */
  flashEnabled: boolean;
  /** Particle count for the delegated particle burst. */
  particleCount: number;
  /** Particle burst lifespan (ms). */
  particleLifespanMs: number;
  /** Geometry scale applied to the delegated particle burst. */
  particleScale: number;
  /** Whether to spawn the particle burst. */
  particlesEnabled: boolean;
  /** Number of debris shards. */
  debrisCount: number;
  /** Debris shard lifespan (ms). */
  debrisLifespanMs: number;
  /** Whether to spawn debris shards. */
  debrisEnabled: boolean;
  /** Maximum shockwave ring radius (px). */
  shockwaveRadius: number;
  /** Shockwave expansion duration (ms). */
  shockwaveDurationMs: number;
  /** Whether to spawn the shockwave ring. */
  shockwaveEnabled: boolean;
  /** Whether to play the dedicated player-destruction SFX. */
  soundEnabled: boolean;
}

/** Rounds a scaled count to a whole number of shards/particles. */
function scaleCount(base: number, mult: number): number {
  return Math.max(0, Math.round(base * mult));
}
/**
 * Resolves the complete player-death juice parameters for `severity`.
 *
 * Pure, total and deterministic: an unknown/invalid severity falls back to
 * `'respawn'` and the function never throws. `'fatal'` scales every magnitude
 * (shake intensity/duration, flash alpha, debris count, shockwave radius) up
 * by the exported `PLAYER_DEATH_SEVERITY_FATAL_*_MULT` constants.
 *
 * @param severity — `'respawn'` or `'fatal'`; anything else → `'respawn'`.
 */
export function resolveJuiceParams(
  severity: PlayerDeathSeverity | string | null | undefined,
): PlayerDeathJuiceParams {
  const resolved: PlayerDeathSeverity =
    severity === 'fatal' ? 'fatal' : PLAYER_DEATH_DEFAULT_SEVERITY;

  const fatal = resolved === 'fatal';

  return {
    shakeIntensity: fatal
      ? PLAYER_DEATH_SHAKE_INTENSITY * PLAYER_DEATH_SEVERITY_FATAL_SHAKE_INTENSITY_MULT
      : PLAYER_DEATH_SHAKE_INTENSITY,
    shakeDurationMs: fatal
      ? PLAYER_DEATH_SHAKE_DURATION_MS * PLAYER_DEATH_SEVERITY_FATAL_SHAKE_DURATION_MULT
      : PLAYER_DEATH_SHAKE_DURATION_MS,
    shakeEnabled: PLAYER_DEATH_ENABLE_SHAKE,
    flashAlpha: fatal
      ? PLAYER_DEATH_FLASH_ALPHA * PLAYER_DEATH_SEVERITY_FATAL_FLASH_ALPHA_MULT
      : PLAYER_DEATH_FLASH_ALPHA,
    flashDurationMs: PLAYER_DEATH_FLASH_DURATION_MS,
    flashColor: PLAYER_DEATH_FLASH_COLOR,
    flashEnabled: PLAYER_DEATH_ENABLE_FLASH,
    particleCount: PLAYER_DEATH_PARTICLE_COUNT,
    particleLifespanMs: PLAYER_DEATH_PARTICLE_LIFESPAN_MS,
    particleScale: PLAYER_DEATH_PARTICLE_SCALE,
    particlesEnabled: PLAYER_DEATH_ENABLE_PARTICLES,
    debrisCount: fatal
      ? scaleCount(PLAYER_DEATH_DEBRIS_COUNT, PLAYER_DEATH_SEVERITY_FATAL_DEBRIS_COUNT_MULT)
      : PLAYER_DEATH_DEBRIS_COUNT,
    debrisLifespanMs: PLAYER_DEATH_DEBRIS_LIFESPAN_MS,
    debrisEnabled: PLAYER_DEATH_ENABLE_DEBRIS,
    shockwaveRadius: fatal
      ? PLAYER_DEATH_SHOCKWAVE_RADIUS * PLAYER_DEATH_SEVERITY_FATAL_SHOCKWAVE_RADIUS_MULT
      : PLAYER_DEATH_SHOCKWAVE_RADIUS,
    shockwaveDurationMs: PLAYER_DEATH_SHOCKWAVE_DURATION_MS,
    shockwaveEnabled: PLAYER_DEATH_ENABLE_SHOCKWAVE,
    soundEnabled: PLAYER_DEATH_ENABLE_SOUND,
  };
}

// ── Teardown registry contract (shared by every juice layer) ───────

/**
 * Minimal registry contract for juice-owned display objects. Any array of
 * Phaser display objects satisfies it (the scenes pass a
 * `Phaser.GameObjects.GameObject[]`), and it is also structurally compatible
 * with the `registry` option accepted by `spawnExplosionParticles`.
 *
 * Layers `push` their handle on spawn and `splice` it out on completion, so a
 * scene's `SHUTDOWN` handler can destroy any leftovers exactly like the
 * existing `playerExplosions` pattern (parent AC6).
 */
export interface JuiceRegistry {
  push(...items: unknown[]): number;
  indexOf(item: unknown): number;
  splice(start: number, deleteCount: number): unknown[];
}

/** Depth for the full-screen flash — above the world and HUD. */
export const PLAYER_DEATH_FLASH_DEPTH = 900;

/**
 * Triggers the scene-camera shake for a player death (parent AC2).
 *
 * Full-2D, single shake: Phaser `camera.shake(duration, intensity)` with the
 * severity-resolved duration/intensity. Cosmetic only — it never moves the
 * player, reads gameplay state or blocks input. No-op when the shake toggle is
 * off or the scene has no main camera.
 *
 * @returns `true` when a shake was triggered, `false` on the no-op paths.
 */
export function applyShake(scene: Phaser.Scene, params: PlayerDeathJuiceParams): boolean {
  if (!params.shakeEnabled) return false;
  const camera = scene.cameras?.main;
  if (!camera || typeof camera.shake !== 'function') return false;
  camera.shake(params.shakeDurationMs, params.shakeIntensity);
  return true;
}

/**
 * Spawns the brief full-screen player-death flash (parent AC4).
 *
 * A non-interactive full-screen rectangle in the player colour, fixed to the
 * camera (scroll factor 0) at {@link PLAYER_DEATH_FLASH_DEPTH}, fading from
 * the resolved alpha to 0 over the resolved duration. On completion it is
 * destroyed and removed from `registry` (parent AC6).
 *
 * No-op (`null`) when the flash toggle is off.
 *
 * @returns The flash rectangle, or `null` when disabled.
 */
export function spawnDeathFlash(
  scene: Phaser.Scene,
  params: PlayerDeathJuiceParams,
  registry?: JuiceRegistry,
): Phaser.GameObjects.Rectangle | null {
  if (!params.flashEnabled) return null;

  const width = scene.scale?.width ?? 0;
  const height = scene.scale?.height ?? 0;
  const flash = scene.add.rectangle(
    width / 2,
    height / 2,
    width,
    height,
    params.flashColor,
    params.flashAlpha,
  );
  flash.setDepth(PLAYER_DEATH_FLASH_DEPTH);
  flash.setScrollFactor(0);
  flash.setData('juiceLayer', 'flash');
  registry?.push(flash);

  scene.tweens.add({
    targets: flash,
    alpha: 0,
    duration: params.flashDurationMs,
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

// ── F4: debris shards and shockwave ring ───────────────────────────

/** Distance (px) a debris shard travels outward from the death point. */
export const PLAYER_DEATH_DEBRIS_TRAVEL = 74;

/** Debris shard radius (px). */
export const PLAYER_DEATH_DEBRIS_RADIUS = 3;

/** Depth for debris shards — above the world, below the flash. */
export const PLAYER_DEATH_DEBRIS_DEPTH = 6;

/**
 * Fraction of its final radius the shockwave ring starts at, so it visibly
 * expands outward rather than popping in at full size.
 */
export const PLAYER_DEATH_SHOCKWAVE_START_SCALE = 0.15;

/** Stroke width (px) of the shockwave ring. */
export const PLAYER_DEATH_SHOCKWAVE_LINE_WIDTH = 4;

/** Depth for the shockwave ring — just above the debris. */
export const PLAYER_DEATH_SHOCKWAVE_DEPTH = 7;

/** Optional overrides for the deterministic debris test seam. */
export interface DeathDebrisOptions {
  /** PRNG seed — defaults to a `Date.now()`-derived seed. */
  seed?: number;
  /** PRNG override taking precedence over `seed`. */
  rng?: () => number;
}

/**
 * Spawns `params.debrisCount` debris shards at (x, y) that fly outward in
 * random directions, shrinking and fading over `params.debrisLifespanMs`
 * (parent AC4).
 *
 * Each shard is an individual small filled Graphics so it can follow its own
 * direction and be torn down independently. Every shard is pushed to
 * `registry` on spawn and spliced out when its tween completes — the same
 * contract as the flash/particle layers (parent AC6). A seeded RNG keeps the
 * directions deterministic for tests.
 *
 * No-op (`[]`) when the debris toggle is off.
 *
 * @returns The spawned shard Graphics (empty when disabled).
 */
export function spawnDeathDebris(
  scene: Phaser.Scene,
  x: number,
  y: number,
  params: PlayerDeathJuiceParams,
  registry?: JuiceRegistry,
  options: DeathDebrisOptions = {},
): Phaser.GameObjects.Graphics[] {
  if (!params.debrisEnabled || params.debrisCount <= 0) return [];

  const rng = options.rng ?? createRng(options.seed ?? Date.now());
  const shards: Phaser.GameObjects.Graphics[] = [];

  for (let i = 0; i < params.debrisCount; i++) {
    const angle = rng() * Math.PI * 2;
    const travel = PLAYER_DEATH_DEBRIS_TRAVEL * (0.6 + rng() * 0.4);
    const dx = Math.cos(angle) * travel;
    const dy = Math.sin(angle) * travel;

    const shard = scene.add.graphics({ x, y });
    shard.setDepth(PLAYER_DEATH_DEBRIS_DEPTH);
    shard.fillStyle(params.flashColor, 1);
    shard.fillCircle(0, 0, PLAYER_DEATH_DEBRIS_RADIUS);
    shard.setData('juiceLayer', 'debris');
    registry?.push(shard);
    shards.push(shard);

    scene.tweens.add({
      targets: shard,
      x: x + dx,
      y: y + dy,
      alpha: 0,
      scale: 0.2,
      duration: params.debrisLifespanMs,
      ease: 'Power2',
      onComplete: () => {
        if (registry) {
          const index = registry.indexOf(shard);
          if (index >= 0) registry.splice(index, 1);
        }
        shard.destroy();
      },
    });
  }

  return shards;
}

/**
 * Spawns an expanding stroked shockwave ring at (x, y) (parent AC4).
 *
 * A single Graphics draws a ring at `params.shockwaveRadius` and starts at
 * {@link PLAYER_DEATH_SHOCKWAVE_START_SCALE}, tweening to full scale while
 * fading to 0 over `params.shockwaveDurationMs`. On completion it is destroyed
 * and removed from `registry` (parent AC6).
 *
 * No-op (`null`) when the shockwave toggle is off.
 *
 * @returns The shockwave Graphics, or `null` when disabled.
 */
export function spawnDeathShockwave(
  scene: Phaser.Scene,
  x: number,
  y: number,
  params: PlayerDeathJuiceParams,
  registry?: JuiceRegistry,
): Phaser.GameObjects.Graphics | null {
  if (!params.shockwaveEnabled) return null;

  const ring = scene.add.graphics({ x, y });
  ring.setDepth(PLAYER_DEATH_SHOCKWAVE_DEPTH);
  ring.lineStyle(PLAYER_DEATH_SHOCKWAVE_LINE_WIDTH, params.flashColor, 1);
  ring.strokeCircle(0, 0, params.shockwaveRadius);
  ring.setScale(PLAYER_DEATH_SHOCKWAVE_START_SCALE);
  ring.setData('juiceLayer', 'shockwave');
  ring.setData('shockwaveRadius', params.shockwaveRadius);
  registry?.push(ring);

  scene.tweens.add({
    targets: ring,
    scale: 1,
    alpha: 0,
    duration: params.shockwaveDurationMs,
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
