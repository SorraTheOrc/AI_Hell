/**
 * Wormhole spawn VFX — cinematic enemy entry effect.
 *
 * Draws a neon-swirl wormhole at a world position using Phaser Graphics,
 * animating it open then closed.  The helper returns a handle so callers
 * can observe completion and chain the enemy-growth animation.
 *
 * Timeline (per the spawn-protection contract):
 *   t = 0 … 1 s — wormhole opens
 *   t = 1 … 2.5 s — enemies grow (wormhole holds open)
 *   t = 2.5 … 3 s — wormhole closes
 *
 * @module vfx/wormholeSpawn
 */

import type Phaser from 'phaser';

// ── Timing constants (seconds) ──────────────────────────────────────

/** Wormhole open duration. */
export const WORMHOLE_OPEN_DURATION = 1;

/** Wormhole close duration. */
export const WORMHOLE_CLOSE_DURATION = 0.5;

/** Enemy growth duration. */
export const ENEMY_GROWTH_DURATION = 1.5;

/** Total spawn-protection window (open + grow + close). */
export const TOTAL_SPAWN_PROTECTION_WINDOW =
  WORMHOLE_OPEN_DURATION + ENEMY_GROWTH_DURATION + WORMHOLE_CLOSE_DURATION;

// ── Visual constants ────────────────────────────────────────────────

/** Outer ring colour — deep violet. */
const OUTER_RING_COLOR = 0x8833cc;
/** Inner ring colour — bright cyan, contrasting with the violet. */
const INNER_RING_COLOR = 0x33ccff;
/** Stroke width for the outer ring. */
const OUTER_RING_LINE_WIDTH = 4;
/** Stroke width for the inner ring. */
const INNER_RING_LINE_WIDTH = 2;
/** Number of spiral arms in the wormhole swirl. */
const SPIRAL_ARM_COUNT = 3;
/** Wormhole visual radius in px (the final outer-ring radius). */
const WORMHOLE_RADIUS = 40;
/** Starting scale for the wormhole (fully closed). */
const WORMHOLE_START_SCALE = 0.01;

// ── Types ───────────────────────────────────────────────────────────

/**
 * Handle returned by {@link spawnWormholeOpen} and {@link spawnWormholeClose}.
 *
 * Time is measured in **scene-tick seconds** (the accumulated `dt` the scene
 * feeds) rather than wall-clock, so deterministic `scene.tick(dt)` tests
 * drive the animation identically to a live run.
 */
export interface WormholeHandle {
  /** The root Container (destroyed on completion). */
  readonly container: Phaser.GameObjects.Container;
  /** Mutable completion flag (set true by the close tween). */
  complete: boolean;
  /** Whether the effect has completed and been torn down. */
  isComplete(): boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────

function drawSpiralArm(
  graphics: Phaser.GameObjects.Graphics,
  armIndex: number,
  radius: number,
): void {
  const armOffset = (armIndex / SPIRAL_ARM_COUNT) * Math.PI * 2;
  const steps = 40;
  graphics.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = t * Math.PI * 2.5 + armOffset;
    const r = t * radius;
    if (i === 0) {
      graphics.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
    } else {
      graphics.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
  }
  graphics.strokePath();
}

function drawWormholeInitial(graphics: Phaser.GameObjects.Graphics): void {
  graphics.lineStyle(OUTER_RING_LINE_WIDTH, OUTER_RING_COLOR, 1);
  graphics.strokeCircle(0, 0, WORMHOLE_RADIUS);
  graphics.lineStyle(INNER_RING_LINE_WIDTH, INNER_RING_COLOR, 0.9);
  graphics.strokeCircle(0, 0, WORMHOLE_RADIUS * 0.6);
  graphics.lineStyle(1.5, INNER_RING_COLOR, 0.6);
  for (let i = 0; i < SPIRAL_ARM_COUNT; i++) {
    drawSpiralArm(graphics, i, WORMHOLE_RADIUS * 0.85);
  }
}

// ── Public API — Wormhole VFX ───────────────────────────────────────

export function spawnWormholeOpen(
  scene: Phaser.Scene,
  x: number,
  y: number,
  options: { registry?: Phaser.GameObjects.Container[] } = {},
): WormholeHandle {
  const registry = options.registry;
  const container = scene.add.container(x, y);
  container.setScale(WORMHOLE_START_SCALE);
  container.setAlpha(1);
  const draw = scene.add.graphics();
  drawWormholeInitial(draw);
  container.add(draw);
  registry?.push(container);
  const handle: WormholeHandle = {
    container,
    complete: false,
    isComplete: () => handle.complete,
  };
  scene.tweens.add({
    targets: container,
    scale: 1,
    duration: WORMHOLE_OPEN_DURATION * 1000,
    ease: 'Cubic.easeOut',
  });
  return handle;
}

export function spawnWormholeClose(
  scene: Phaser.Scene,
  handle: WormholeHandle,
  registry?: Phaser.GameObjects.Container[],
): void {
  const container = handle.container;
  scene.tweens.add({
    targets: container,
    scale: 0,
    alpha: 0,
    duration: WORMHOLE_CLOSE_DURATION * 1000,
    ease: 'Cubic.easeIn',
    onComplete: () => {
      handle.complete = true;
      if (registry) {
        const index = registry.indexOf(container);
        if (index >= 0) registry.splice(index, 1);
      }
      container.destroy();
    },
  });
}

// ── Enemy spawn animation helpers ───────────────────────────────────

const SPAWN_STATE_KEY = '__spawnState';

/**
 * Spawn-animation bookkeeping attached to a spawning entity.  All times are
 * in **scene-tick seconds** elapsed since the spawn began, so the animation
 * is driven identically by a live `update()` and by deterministic
 * `scene.tick(dt)` test steps.
 */
export interface SpawnState {
  /** Seconds elapsed since the enemy began spawning. */
  elapsed: number;
  /** Seconds to wait (wormhole opening) before growth starts. */
  delay: number;
  /** The enemy's original (full) scale — restored after animation. */
  originalScale: number;
  /** Whether growth has begun (after the wormhole-open delay). */
  growing: boolean;
}

/**
 * Minimal container-like contract required by the spawn-animation helpers:
 * any Phaser Container (or entity extending one) satisfies it.
 */
export interface SpawnAnimatable extends Phaser.GameObjects.Container {
  /** Current horizontal scale (drives the growth animation). */
  readonly scaleX: number;
}

/** Returns the spawn-state for `enemy`, or `null` if not spawning. */
export function getSpawnState(enemy: SpawnAnimatable): SpawnState | null {
  const state = enemy.getData(SPAWN_STATE_KEY);
  return (state as SpawnState) ?? null;
}

/**
 * Marks `enemy` as spawning: shrinks it to 1 px and attaches bookkeeping.
 *
 * @param enemy - The enemy to mark as spawning.
 * @param originalScale - The enemy's full scale (restored when growth ends).
 * @param delay - Seconds to wait (wormhole opening) before growth starts.
 */
export function startSpawnAnimation(
  enemy: SpawnAnimatable,
  originalScale: number,
  delay: number = WORMHOLE_OPEN_DURATION,
): void {
  enemy.setScale(0.01);
  enemy.setData(SPAWN_STATE_KEY, {
    elapsed: 0,
    delay,
    originalScale,
    growing: false,
  } satisfies SpawnState);
}

/**
 * Whether `enemy` is still in its spawn window (growing or wormhole-opening).
 * Returns `false` once the entity has no spawn state.
 */
export function isEnemySpawning(enemy: SpawnAnimatable): boolean {
  return getSpawnState(enemy) !== null;
}

/**
 * Advances the spawn animation by `dt` seconds.  During the wormhole-open
 * delay the entity holds at 1 px; afterwards it eases from 1 px to its full
 * scale over {@link ENEMY_GROWTH_DURATION} seconds.  On completion the spawn
 * state is cleared and the entity's scale is restored.
 *
 * @param enemy - The enemy to animate.
 * @param dt - Delta time in seconds (the scene tick step).
 * @returns `true` while the animation is still in progress.
 */
export function updateSpawnAnimation(
  enemy: SpawnAnimatable,
  dt: number,
): boolean {
  const state = getSpawnState(enemy);
  if (!state) return false;

  state.elapsed += dt;

  if (!state.growing) {
    if (state.elapsed < state.delay) return true;
    state.growing = true;
  }

  const growthElapsed = state.elapsed - state.delay;
  const progress = Math.max(
    0,
    Math.min(growthElapsed / ENEMY_GROWTH_DURATION, 1),
  );
  const easedProgress = easeOutCubic(progress);
  enemy.setScale(0.01 + (state.originalScale - 0.01) * easedProgress);

  if (progress >= 1) {
    enemy.setScale(state.originalScale);
    enemy.setData(SPAWN_STATE_KEY, undefined);
    return false;
  }
  return true;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
