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

import Phaser from 'phaser';

import { SHIP_SIZE } from '../core/constants';

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

// ── Wormhole glow/pulse ring tunables (AH-0MVD2N6AW0073X5M) ─────────
//
// While a wormhole is open for a wave it gets a subtle glow/pulse ring at the
// wormhole position (epic AH-0MV8BUKFK003Z23S AC4). It is drawn **once per
// wormhole** as a child of the wormhole container, so it is tracked by the
// caller's existing `wormholeEffects` registry for free and is destroyed with
// the container when the close tween completes (no separate teardown path to
// leak). Pure Graphics — no new assets — and visually distinct from both the
// phase-shift chromatic split and the player-death palette.

/**
 * Whether the wormhole glow/pulse ring layer is enabled. Off ⇒ the wormhole
 * renders exactly as before (no ring child, no extra tween).
 */
export const WORMHOLE_RING_ENABLE = true;

/**
 * Ring colour — a soft violet-white that reads as glow against the dark
 * playfield. Deliberately distinct from the phase-shift cyan/red split
 * (`PHASE_SHIFT_SPLIT_COLOR_*`) and the player-death palette.
 */
export const WORMHOLE_RING_COLOR = 0xd9b3ff;

/** Ring radius (px) at its neutral pulse position. */
export const WORMHOLE_RING_RADIUS = 52;

/** Ring stroke width (px). */
export const WORMHOLE_RING_LINE_WIDTH = 3;

/**
 * Radius pulse multipliers `[min, max]` — the ring "breathes" around its
 * neutral radius rather than sitting static. Applied as a scale tween on the
 * ring graphics (a yoyo repeat), so no per-frame work is needed.
 */
export const WORMHOLE_RING_PULSE_RANGE: readonly [number, number] = [0.9, 1.15] as const;

/** Duration (ms) of one pulse direction (min → max); the yoyo makes a full breath twice this. */
export const WORMHOLE_RING_PULSE_DURATION_MS = 900;

/** Soft glow alpha of the ring, within (0, 1]. */
export const WORMHOLE_RING_GLOW_ALPHA = 0.45;

/** Data key marking the ring graphics inside the wormhole container. */
const WORMHOLE_RING_DATA_KEY = 'wormholeRing';

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

/**
 * Adds the glow/pulse ring to an open wormhole container and starts its
 * breathing pulse. A no-op when the layer is disabled or the scene exposes no
 * tween manager (headless stub) — the wormhole itself is unaffected.
 *
 * @param scene - The wormhole's scene (owns the tween manager).
 * @param container - The wormhole container the ring is parented to.
 */
function attachWormholeRing(
  scene: Phaser.Scene,
  container: Phaser.GameObjects.Container,
): void {
  if (!WORMHOLE_RING_ENABLE) return;
  const add = scene?.add as
    | { graphics?: () => Phaser.GameObjects.Graphics }
    | undefined;
  if (!add || typeof add.graphics !== 'function') return;

  const ring = add.graphics();
  ring.lineStyle(WORMHOLE_RING_LINE_WIDTH, WORMHOLE_RING_COLOR, WORMHOLE_RING_GLOW_ALPHA);
  ring.strokeCircle(0, 0, WORMHOLE_RING_RADIUS);
  // A wider, fainter second pass reads as the soft glow halo without a new
  // texture or a second game object.
  ring.lineStyle(WORMHOLE_RING_LINE_WIDTH * 3, WORMHOLE_RING_COLOR, WORMHOLE_RING_GLOW_ALPHA * 0.35);
  ring.strokeCircle(0, 0, WORMHOLE_RING_RADIUS);
  ring.setData(WORMHOLE_RING_DATA_KEY, true);
  container.add(ring);

  const tweens = scene?.tweens as
    | { add?: (...args: unknown[]) => unknown }
    | undefined;
  if (!tweens || typeof tweens.add !== 'function') return;
  const [pulseMin, pulseMax] = WORMHOLE_RING_PULSE_RANGE;
  tweens.add({
    targets: ring,
    scale: { from: pulseMin, to: pulseMax },
    duration: WORMHOLE_RING_PULSE_DURATION_MS,
    ease: 'Sine.easeInOut',
    yoyo: true,
    repeat: -1,
  });
}

/**
 * Opens the wormhole VFX at (x, y): a neon swirl that scales up over
 * {@link WORMHOLE_OPEN_DURATION}, plus the glow/pulse ring
 * ({@link WORMHOLE_RING_ENABLE}) tracked as a child of the container.
 *
 * @param scene - The owning scene (add factory + tween manager).
 * @param x - World x position of the wormhole.
 * @param y - World y position of the wormhole.
 * @param options.registry - Optional caller-owned container registry (the
 *   scenes' `wormholeEffects`), so scene teardown can destroy any leftovers.
 * @returns The handle used to close the wormhole and observe completion.
 */
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
  // The glow/pulse ring is layered on after the open tween so the wormhole's
  // own open animation remains the first tween registered for the container.
  attachWormholeRing(scene, container);
  return handle;
}

/**
 * Closes the wormhole: scales and fades it out over
 * {@link WORMHOLE_CLOSE_DURATION}, then — on tween completion — stops the
 * ring's looping pulse, removes the container from the registry and destroys
 * it exactly once. Idempotent: a second close on the same handle is a no-op.
 *
 * @param scene - The owning scene (tween manager).
 * @param handle - The handle returned by {@link spawnWormholeOpen}.
 * @param registry - Optional container registry to remove the wormhole from.
 */
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
      // Stop the ring's infinite pulse tween before destroying the container:
      // a looping tween left pointing at a destroyed child would keep ticking
      // against a dead object (the same hazard `WormholeController.reset`
      // documents). `killTweensOf` is feature-detected so headless stubs and
      // scene-less callers stay safe.
      const tweens = scene?.tweens as
        | { killTweensOf?: (target: unknown) => unknown }
        | undefined;
      const ring = container.list?.find(
        (child) => child.getData?.(WORMHOLE_RING_DATA_KEY) === true,
      );
      if (ring && typeof tweens?.killTweensOf === 'function') {
        tweens.killTweensOf(ring);
      }
      container.destroy();
    },
  });
}

// ── Single-live wormhole lifecycle controller ──────────────────────

/**
 * Single-live-wormhole lifecycle controller shared by `PlayScene` and every
 * formation gym (AH-0MV9KHLV8006GMX6).
 *
 * Enforces the invariant that **at most one wormhole is live at a time**:
 * {@link WormholeController.open} first closes any still-open wormhole, so no
 * path can overwrite a live one, and {@link WormholeController.close} is
 * idempotent so transition / timeout / respawn / reset paths may safely call
 * it whether or not a wormhole happens to be live.
 */
export class WormholeController {
  private handle: WormholeHandle | null = null;

  constructor(private readonly scene: Phaser.Scene) {}

  /** True while a wormhole is live (open, awaiting close). */
  get isOpen(): boolean {
    return this.handle !== null;
  }

  /**
   * Closes any still-open wormhole, then opens a fresh one at (x, y) and
   * returns its handle. Never overwrites a live wormhole.
   */
  open(
    x: number,
    y: number,
    registry?: Phaser.GameObjects.Container[],
  ): WormholeHandle {
    this.close(registry);
    this.handle = spawnWormholeOpen(this.scene, x, y, registry ? { registry } : {});
    return this.handle;
  }

  /**
   * Closes the live wormhole (scale→0, alpha→0, registry removal and destroy
   * once the close animation completes) and clears the slot. A no-op when no
   * wormhole is live.
   */
  close(registry?: Phaser.GameObjects.Container[]): void {
    if (!this.handle) return;
    spawnWormholeClose(this.scene, this.handle, registry);
    this.handle = null;
  }

  /**
   * Clears the live-handle slot **without** animating. Use on scene
   * reset/teardown, where the scene owns the container's destruction anyway:
   * animating a close against an already-destroyed target would leave a tween
   * pointing at a dead object on the next scene start.
   */
  reset(): void {
    this.handle = null;
  }
}

// ── Enemy spawn animation helpers ───────────────────────────────────

const SPAWN_STATE_KEY = '__spawnState';

/**
 * Destination position for the wormhole-to-formation transit movement
 * (AH-0MV8BSMXC0097KLW). Omit it from {@link startSpawnAnimation} to keep the
 * enemy in place (legacy callers that do not need movement are unchanged).
 *
 * A plain `{x, y}` pins the destination once. A **function** re-resolves the
 * destination every frame so a scene can track the live formation slot (e.g.
 * under drift/march) — the enemy straight-line transits toward the moving
 * target and lands exactly on it, with no position pop when the spawn window
 * ends.
 */
export type SpawnDestination =
  | { readonly x: number; readonly y: number }
  | (() => { x: number; y: number });

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
  /**
   * The absolute growth scale the spawn animation last wrote (the un-shimmered
   * scale). The shimmer layers its pulse on top of this value instead of
   * dividing the live scale by a stale per-entity factor, so the real
   * spawn→shimmer call pattern can never compound or drift the scale
   * (AH-0MVNTXXTA0081S38).
   */
  growthScale: number;
  /** Whether growth has begun (after the wormhole-open delay). */
  growing: boolean;
  /** World position where the enemy emerged (the wormhole origin). */
  originX: number;
  /** World position where the enemy emerged (the wormhole origin). */
  originY: number;
  /** Formation position at spawn time (the transition target snapshot). */
  destX: number;
  /** Formation position at spawn time (the transition target snapshot). */
  destY: number;
  /** Whether the entity transits from the origin to the destination. */
  moves: boolean;
  /**
   * Optional per-frame destination resolver (drift/march tracking). When
   * absent the fixed {@link destX}/{@link destY} snapshot is used.
   */
  destFn?: () => { x: number; y: number };
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
 * @param destination - Optional formation position to travel to. When
 *   supplied, the enemy also moves from its current (wormhole) position to
 *   the destination in lock-step with the growth animation, completing by
 *   the end of the growth phase (within the spawn-protection window). When
 *   omitted the enemy stays in place (no movement).
 */
export function startSpawnAnimation(
  enemy: SpawnAnimatable,
  originalScale: number,
  delay: number = WORMHOLE_OPEN_DURATION,
  destination?: SpawnDestination,
): void {
  enemy.setScale(0.01);
  const moves = destination !== undefined;
  const snapshot =
    typeof destination === 'function' ? destination() : destination;
  enemy.setData(SPAWN_STATE_KEY, {
    elapsed: 0,
    delay,
    originalScale,
    growthScale: 0.01,
    growing: false,
    originX: enemy.x,
    originY: enemy.y,
    destX: snapshot?.x ?? enemy.x,
    destY: snapshot?.y ?? enemy.y,
    moves,
    destFn: typeof destination === 'function' ? destination : undefined,
  } satisfies SpawnState);
}

/**
 * Whether `enemy` is still in its spawn window (growing or wormhole-opening).
 * Returns `false` once the entity has no spawn state.
 */
export function isEnemySpawning(enemy: SpawnAnimatable): boolean {
  return getSpawnState(enemy) !== null;
}

/** Resolves the current transit target (live resolver when one is set). */
function resolveSpawnDestination(state: SpawnState): { x: number; y: number } {
  if (state.destFn) {
    const live = state.destFn();
    state.destX = live.x;
    state.destY = live.y;
  }
  return { x: state.destX, y: state.destY };
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
    if (state.elapsed < state.delay) {
      // Wormhole still opening: the enemy holds at its emergence point so a
      // scene-level formation pass cannot park it at its slot mid-entry
      // (AH-0MV8BSMXC0097KLW).
      if (state.moves) enemy.setPosition(state.originX, state.originY);
      return true;
    }
    state.growing = true;
  }

  const growthElapsed = state.elapsed - state.delay;
  const progress = Math.max(
    0,
    Math.min(growthElapsed / ENEMY_GROWTH_DURATION, 1),
  );
  const easedProgress = easeOutCubic(progress);
  const growthScale = 0.01 + (state.originalScale - 0.01) * easedProgress;
  // Record the absolute growth scale; the per-entity shimmer layers its pulse
  // on top of THIS value (never on its own previous output), so the shared
  // `updateSpawnAnimation` → `updateEnemyShimmer` call pattern stays drift-free.
  state.growthScale = growthScale;
  enemy.setScale(growthScale);
  if (state.moves) {
    // Wormhole-to-formation transit (AH-0MV8BSMXC0097KLW): travel from the
    // emergence point to the formation position in lock-step with the growth
    // animation, so the enemy is fully arrived before it becomes collidable.
    // The target resolves every frame so drift/march motion of the live slot
    // is tracked and the enemy lands exactly on it (no position pop).
    const dest = resolveSpawnDestination(state);
    enemy.setPosition(
      state.originX + (dest.x - state.originX) * easedProgress,
      state.originY + (dest.y - state.originY) * easedProgress,
    );
  }

  if (progress >= 1) {
    state.growthScale = state.originalScale;
    enemy.setScale(state.originalScale);
    if (state.moves) {
      const dest = resolveSpawnDestination(state);
      enemy.setPosition(dest.x, dest.y);
    }
    enemy.setData(SPAWN_STATE_KEY, undefined);
    // The spawn window is the shimmer's lifetime: release it here so every
    // caller — the live scene tick and the `finishSpawnAnimations()` test
    // seam alike — leaves a fully-emerged enemy with its own alpha and blend
    // mode back (no residual tint/bloom).
    releaseShimmerIfAny(enemy);
    return false;
  }
  return true;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// ── Enemy emergence shimmer (per-entity, wormhole spawn path) ────────
//
// Per producer decision Q1/Q2 the emergence path gets a **per-entity**
// shimmer/glitch and **no screen-wide overlay** (AH-0MV8BUKFK003Z23S AC3).
// The treatment is driven entirely from the spawn-state window above, so
// `PlayScene` and every combat gym get identical behaviour by calling the one
// shared helper — there is no per-scene copy to drift.
//
// Every magnitude below is an exported tunable with a per-layer toggle,
// mirroring the `phaseShiftJuice` pattern. Magnitudes are deliberately small
// (sub-second burst, gentle ≈2–4 Hz flicker, a scale pulse well under the
// growth curve's own motion) so the effect reads as "not solid yet" without
// becoming a strobe (seizure-safety note in the epic's risk register).

/**
 * Lifetime (ms) of the ripple burst that fires as an enemy starts to
 * materialise — the leading edge of the growth window. ~150–250 ms reads as
 * a glitch hit without dragging on. Toggle: {@link ENEMY_SHIMMER_ENABLE_BURST}.
 */
export const ENEMY_SHIMMER_BURST_DURATION_MS = 240;

/**
 * Extra alpha added at the start of the burst, decaying linearly to zero over
 * {@link ENEMY_SHIMMER_BURST_DURATION_MS}. Raised from the original subtle
 * 0.15 to an unmistakable magnitude (AH-0MVNTXXTA0081S38) and applied as a
 * *toward-opaque* lift — `alpha += (1 - alpha) * boost * remaining` — so the
 * leading edge flashes hard without ever pinning the flicker at a saturated 1.
 */
export const ENEMY_SHIMMER_BURST_ALPHA_BOOST = 0.45;

/**
 * Extra scale (fraction of the growth scale) added at the start of the burst,
 * decaying to zero over {@link ENEMY_SHIMMER_BURST_DURATION_MS} — the "ripple".
 * Raised from the original subtle 0.06 to an unmistakable 0.18
 * (AH-0MVNTXXTA0081S38); it stays layered on the absolute growth scale so it
 * never compounds with the growth curve.
 */
export const ENEMY_SHIMMER_BURST_SCALE_BOOST = 0.18;

/**
 * Alpha-flicker rate (Hz) of the sustained shimmer. 2–4 Hz is a gentle pulse,
 * never a rapid strobe (seizure-safety). Toggle: {@link ENEMY_SHIMMER_ENABLE_SHIMMER}.
 */
export const ENEMY_SHIMMER_FLICKER_HZ = 3;

/** Lowest alpha the shimmer flickers to (must stay > 0 so the enemy never vanishes). */
export const ENEMY_SHIMMER_ALPHA_MIN = 0.25;

/** Highest alpha the shimmer flickers to (must stay <= 1). */
export const ENEMY_SHIMMER_ALPHA_MAX = 1;

/**
 * Amplitude of the sustained scale pulse, as a fraction of the current growth
 * scale. Deliberately tiny (< 0.1) so it never fights the growth curve.
 */
export const ENEMY_SHIMMER_SCALE_AMOUNT = 0.04;

/**
 * Soft colour-pulse range `[min, max]` (0..1) driven by the slow shimmer
 * oscillation. Phaser 4 `Container`/`Graphics` expose no tint API (only
 * `AlphaSingle`/`BlendMode`), so the pulse is expressed as a soft **additive
 * bloom**: when the pulse is in its upper half the entity renders with
 * `BlendModes.ADD` (brighter, colour-washed), in the lower half normally.
 * The rate is far below the flicker so it reads as a colour breath, not a
 * strobe. Toggle: {@link ENEMY_SHIMMER_ENABLE_COLOUR_PULSE}.
 */
export const ENEMY_SHIMMER_COLOUR_PULSE_RANGE: readonly [number, number] = [0.25, 0.75] as const;

/** Slow colour-pulse period (seconds) — one full breath per cycle. */
export const ENEMY_SHIMMER_COLOUR_PULSE_PERIOD = 1.6;

/** Whether the leading ripple burst layer is enabled. */
export const ENEMY_SHIMMER_ENABLE_BURST = true;

/** Whether the sustained shimmer layers (alpha/scale flicker) are enabled. */
export const ENEMY_SHIMMER_ENABLE_SHIMMER = true;

/** Whether the soft additive colour-pulse layer is enabled. */
export const ENEMY_SHIMMER_ENABLE_COLOUR_PULSE = true;

// ── Outline / silhouette layer (AH-0MVNTXXTA0081S38) ─────────────────
//
// One pulsing stroked ring parented to the emerging entity — never a
// scene-wide overlay — so each enemy carries its own "not solid yet"
// silhouette for the whole growth window. Created once on the first growing
// frame and destroyed on the falling edge.

/** Whether the per-entity outline/silhouette layer is enabled (default on). */
export const ENEMY_SHIMMER_ENABLE_OUTLINE = true;

/** Data key marking the outline child on an emerging entity. */
export const ENEMY_SHIMMER_OUTLINE_DATA_KEY = '__shimmerOutline';

/** Outline ring radius (px) around the entity at full growth scale. */
export const ENEMY_SHIMMER_OUTLINE_RADIUS = 30;

/** Outline ring stroke width (px). */
export const ENEMY_SHIMMER_OUTLINE_LINE_WIDTH = 4;

/**
 * Outline ring colour. Pale violet, matching the wormhole's own palette so the
 * emergence reads as coming from the portal; deliberately distinct from the
 * Phase Shift split and the player-death flash palettes.
 */
export const ENEMY_SHIMMER_OUTLINE_COLOR = 0xd9b3ff;

/** Alpha pulse rate (Hz) of the outline ring — slow and breathing, not a strobe. */
export const ENEMY_SHIMMER_OUTLINE_PULSE_HZ = 2;

/** Lowest alpha of the pulsing outline ring. */
export const ENEMY_SHIMMER_OUTLINE_ALPHA_MIN = 0.45;

/** Highest alpha of the pulsing outline ring (must stay <= 1). */
export const ENEMY_SHIMMER_OUTLINE_ALPHA_MAX = 0.95;

/** Data key holding the per-entity shimmer clock (created lazily, reused). */
const SHIMMER_STATE_KEY = '__shimmerState';

/**
 * Per-entity shimmer bookkeeping. Created once per enemy (on its first
 * shimmering frame) and reused for every later frame — no per-frame
 * allocations.
 */
interface ShimmerState {
  /** Seconds since the shimmer started (its own clock, advanced by `dt`). */
  elapsed: number;
  /**
   * Scale factor this helper applied on the previous frame. Used only as a
   * fallback recovery path (and to keep the recorded state inspectable); the
   * authoritative growth scale comes from `SpawnState.growthScale`.
   */
  lastScaleFactor: number;
  /**
   * The entity's own alpha before the shimmer took it over, restored when the
   * spawn window ends so no residual tint survives (teardown-clean).
   */
  baseAlpha: number;
  /**
   * The entity's own blend mode before the shimmer took it over, restored on
   * teardown so the additive bloom leaves no residual state.
   */
  baseBlendMode: number | undefined;
  /**
   * The pulsing outline/silhouette ring parented to the entity, created once on
   * the first growing frame and destroyed on the falling edge. `null` when the
   * layer is disabled or the entity cannot host it (headless stub).
   */
  outline: Phaser.GameObjects.Graphics | null;
}

/** Returns the shimmer clock for `enemy`, creating it on first use. */
function ensureShimmerState(enemy: SpawnAnimatable): ShimmerState | null {
  const existing = getShimmerState(enemy);
  if (existing) return existing;
  const setData = (enemy as { setData?: (key: string, value: unknown) => unknown }).setData;
  if (typeof setData !== 'function') return null;
  const created: ShimmerState = {
    elapsed: 0,
    lastScaleFactor: 1,
    baseAlpha: enemy.alpha,
    baseBlendMode: (enemy as { blendMode?: number }).blendMode,
    outline: ENEMY_SHIMMER_ENABLE_OUTLINE ? createShimmerOutline(enemy) : null,
  };
  setData.call(enemy, SHIMMER_STATE_KEY, created);
  return created;
}

/**
 * Creates the per-entity outline/silhouette ring and parents it to `enemy`.
 *
 * Headless-safe: an entity without a live scene/`add`/graphics factory (or a
 * stub without the drawing calls) simply gets no outline and no error, so the
 * shimmer still runs its alpha/scale layers.
 */
function createShimmerOutline(enemy: SpawnAnimatable): Phaser.GameObjects.Graphics | null {
  const scene = (enemy as { scene?: Phaser.Scene }).scene;
  const addToEntity = (enemy as { add?: (child: unknown) => unknown }).add;
  const graphicsFactory = (
    scene as unknown as { add?: { graphics?: () => Phaser.GameObjects.Graphics } } | undefined
  )?.add?.graphics;
  if (!scene || typeof addToEntity !== 'function' || typeof graphicsFactory !== 'function') {
    return null;
  }
  let outline: Phaser.GameObjects.Graphics | null = null;
  try {
    outline = graphicsFactory.call(scene.add);
    outline.lineStyle(
      ENEMY_SHIMMER_OUTLINE_LINE_WIDTH,
      ENEMY_SHIMMER_OUTLINE_COLOR,
      ENEMY_SHIMMER_OUTLINE_ALPHA_MAX,
    );
    outline.strokeCircle(0, 0, ENEMY_SHIMMER_OUTLINE_RADIUS);
    outline.setData(ENEMY_SHIMMER_OUTLINE_DATA_KEY, true);
    addToEntity.call(enemy, outline);
    return outline;
  } catch {
    outline?.destroy();
    return null;
  }
}

/** Returns the existing shimmer clock for `enemy`, or `undefined` if inert. */
function getShimmerState(enemy: SpawnAnimatable): ShimmerState | undefined {
  const getData = (enemy as { getData?: (key: string) => unknown }).getData;
  if (typeof getData !== 'function') return undefined;
  return getData.call(enemy, SHIMMER_STATE_KEY) as ShimmerState | undefined;
}

/**
 * Restores the entity's own alpha and blend mode and drops the shimmer clock
 * when one is present. A no-op for an entity that never shimmered.
 */
function releaseShimmerIfAny(enemy: SpawnAnimatable): void {
  const state = getShimmerState(enemy);
  if (state) releaseShimmer(enemy, state);
}

/**
 * Restores the entity's own alpha and blend mode and drops the shimmer clock.
 * Called when the spawn window closes, so the shimmer is teardown-clean and
 * leaves no residual tint/bloom on a fully-emerged enemy.
 */
function releaseShimmer(enemy: SpawnAnimatable, state: ShimmerState): void {
  enemy.setAlpha(state.baseAlpha);
  restoreEnemyBlendMode(enemy, state.baseBlendMode);
  state.outline?.destroy();
  state.outline = null;
  const setData = (enemy as { setData?: (key: string, value: unknown) => unknown }).setData;
  if (typeof setData === 'function') {
    setData.call(enemy, SHIMMER_STATE_KEY, undefined);
  }
}

/**
 * Restores the entity's own blend mode, falling back to `NORMAL` when the
 * pre-shimmer value is unknown (headless stub) or the entity cannot blend.
 */
function restoreEnemyBlendMode(
  enemy: SpawnAnimatable,
  blendMode: number | undefined,
): void {
  if (blendMode === undefined) {
    setEnemyBloom(enemy, false);
    return;
  }
  const setBlendMode = (
    enemy as { setBlendMode?: (mode: unknown) => unknown }
  ).setBlendMode;
  if (typeof setBlendMode !== 'function') return;
  setBlendMode.call(enemy, blendMode);
}

/**
 * Advances the per-entity emergence shimmer by `dt` seconds.
 *
 * The treatment is driven from the shared spawn state: it is inert until the
 * enemy actually starts **growing** (`SpawnState.growing`, set by
 * {@link updateSpawnAnimation}), sustains while the growth window is open, and
 * stops the moment the spawn state is cleared. An enemy with no spawn state —
 * or one still held at the wormhole-open delay — is left completely untouched,
 * so this is a safe no-op for every non-emerging entity (and for headless test
 * stubs, which never have spawn state).
 *
 * Layers (each with its own toggle):
 *   - **outline** — one pulsing stroked ring parented to the entity for the
 *     whole growth window (`ENEMY_SHIMMER_ENABLE_OUTLINE`), created on the
 *     first growing frame and destroyed when growth ends;
 *   - **burst** — a brief ripple (extra scale + a toward-opaque alpha lift)
 *     decaying over {@link ENEMY_SHIMMER_BURST_DURATION_MS};
 *   - **shimmer** — widened alpha flicker (`ENEMY_SHIMMER_FLICKER_HZ`) plus a
 *     tiny scale pulse;
 *   - **colour pulse** — soft additive bloom breathing at
 *     {@link ENEMY_SHIMMER_COLOUR_PULSE_PERIOD}.
 *
 * Call it immediately **after** {@link updateSpawnAnimation} for the same
 * entity each frame: the spawn animation writes the absolute growth scale and
 * this helper layers its pulse on top without compounding.
 *
 * @param enemy - The emerging enemy (any container-like spawn entity).
 * @param dt - Delta time in seconds (the scene tick step).
 * @returns `true` while the shimmer is active (i.e. while the enemy is
 *   growing), `false` when the entity is not emerging.
 */
export function updateEnemyShimmer(
  enemy: SpawnAnimatable,
  dt: number,
): boolean {
  const spawn = getSpawnState(enemy);
  const prior = getShimmerState(enemy);
  if (!spawn || !spawn.growing) {
    // The spawn window never opened, or has just closed: restore the entity's
    // own rendering state and drop the clock, so the shimmer leaves no
    // residual alpha tint or additive bloom behind. An entity that was never
    // shimmering is completely untouched.
    if (prior) releaseShimmer(enemy, prior);
    return false;
  }

  const state = ensureShimmerState(enemy);
  if (!state) return false;
  state.elapsed += Math.max(0, dt);
  const t = state.elapsed;

  // Shimmer layers: alpha flicker + a tiny scale pulse.
  let alpha = ENEMY_SHIMMER_ALPHA_MAX;
  let scaleFactor = 1;
  if (ENEMY_SHIMMER_ENABLE_SHIMMER) {
    const flickerPhase = Math.PI * 2 * ENEMY_SHIMMER_FLICKER_HZ * t;
    // u ∈ [0,1]: 0 at the flicker trough, 1 at the crest.
    const u = 0.5 + 0.5 * Math.sin(flickerPhase);
    alpha =
      ENEMY_SHIMMER_ALPHA_MIN +
      (ENEMY_SHIMMER_ALPHA_MAX - ENEMY_SHIMMER_ALPHA_MIN) * u;
    scaleFactor = 1 + ENEMY_SHIMMER_SCALE_AMOUNT * (u * 2 - 1);
  }

  // Burst layer: a decaying, toward-opaque lift on the leading edge of the
  // growth window. Composing it as `alpha += (1 - alpha) * boost * remaining`
  // keeps the flash strong without pinning consecutive frames at a saturated
  // alpha of 1 (which would read as a flat hold rather than a flash).
  if (ENEMY_SHIMMER_ENABLE_BURST) {
    const burstDuration = ENEMY_SHIMMER_BURST_DURATION_MS / 1000;
    if (t < burstDuration) {
      const remaining = 1 - t / burstDuration;
      alpha += (1 - alpha) * ENEMY_SHIMMER_BURST_ALPHA_BOOST * remaining;
      scaleFactor += ENEMY_SHIMMER_BURST_SCALE_BOOST * remaining;
    }
  }
  enemy.setAlpha(Math.min(1, Math.max(0.01, alpha)));

  // Scale: layer the pulse on the ABSOLUTE growth scale the spawn animation
  // last wrote (never on this helper's own previous output), so every
  // spawn→shimmer frame stays drift-free and a double tick equals one long
  // tick. The division fallback covers entities whose spawn state predates
  // `growthScale` (e.g. an externally seeded state).
  const previousFactor = state.lastScaleFactor || 1;
  const growthScale =
    typeof spawn.growthScale === 'number'
      ? spawn.growthScale
      : enemy.scaleX / previousFactor;
  enemy.setScale(growthScale * scaleFactor);
  state.lastScaleFactor = scaleFactor;

  // Outline layer: one pulsing ring around the entity's own silhouette.
  if (state.outline) {
    const [outlineMin, outlineMax] = [
      ENEMY_SHIMMER_OUTLINE_ALPHA_MIN,
      ENEMY_SHIMMER_OUTLINE_ALPHA_MAX,
    ];
    const outlineWave =
      0.5 +
      0.5 * Math.sin(Math.PI * 2 * ENEMY_SHIMMER_OUTLINE_PULSE_HZ * t);
    state.outline.setAlpha(outlineMin + (outlineMax - outlineMin) * outlineWave);
  }

  // Colour pulse: soft additive bloom breathing far below the flicker rate.
  if (ENEMY_SHIMMER_ENABLE_COLOUR_PULSE) {
    const [pulseMin, pulseMax] = ENEMY_SHIMMER_COLOUR_PULSE_RANGE;
    const breath =
      0.5 +
      0.5 *
        Math.sin((Math.PI * 2 * t) / ENEMY_SHIMMER_COLOUR_PULSE_PERIOD);
    const pulse = pulseMin + (pulseMax - pulseMin) * breath;
    setEnemyBloom(enemy, pulse > (pulseMin + pulseMax) / 2);
  }

  return true;
}

/**
 * Applies (or clears) the shimmer's additive bloom on `enemy`, when the
 * entity supports `setBlendMode` (every Phaser 4 Container/Graphics does via
 * the BlendMode component). Silently skipped otherwise, so a headless stub or
 * a plain object never throws.
 */
function setEnemyBloom(enemy: SpawnAnimatable, bloom: boolean): void {
  const setBlendMode = (
    enemy as { setBlendMode?: (mode: unknown) => unknown }
  ).setBlendMode;
  if (typeof setBlendMode !== 'function') return;
  const modes = (Phaser as unknown as { BlendModes?: Record<string, number> })
    .BlendModes;
  if (!modes) return;
  setBlendMode.call(enemy, bloom ? modes.ADD : modes.NORMAL);
}

// ── Wave portal placement (AH-0MV8BR9Y70079TKC) ─────────────────────

/**
 * Seconds ahead along the player's current velocity vector at which the
 * wave portal must also be `D_MIN` away (AC2). Matches the wormhole
 * open+growth window (1 s + 1.5 s) so a moving player does not run into a
 * freshly opened wormhole.
 */
export const WAVE_PORTAL_TRAJECTORY_HORIZON_SECONDS = 2;

/** Distance (px) the portal keeps from the playfield edge (AC4). */
export const WAVE_PORTAL_EDGE_MARGIN = 20;

/**
 * Additional clearance (px) beyond the player's hull radius that the portal
 * never enters, even in the no-safe-candidate fallback (AC4).
 */
export const WAVE_PORTAL_PLAYER_SAFETY_MARGIN = 8;

/**
 * Lattice steps per axis scanned when the planned formation anchor is too
 * close to the player. Higher = finer candidate coverage.
 */
export const WAVE_PORTAL_CANDIDATE_STEPS = 12;

/** Directions sampled around each forbidden circle (radial candidates). */
const WAVE_PORTAL_RING_DIRECTIONS = 12;

/** A 2D position (px). */
export interface PortalPoint {
  x: number;
  y: number;
}

/**
 * The space a planned formation occupies: the width/height of its bounding
 * box (px). `D_MIN = max(width, height)` per the producer decision (Q2).
 */
export interface PortalFormationExtents {
  width: number;
  height: number;
}

/** Player motion at wave-spawn time (position + optional velocity). */
export interface PortalPlayerMotion extends PortalPoint {
  /** Horizontal velocity (px/s); defaults to 0. */
  vx?: number;
  /** Vertical velocity (px/s); defaults to 0. */
  vy?: number;
}

/** Playfield bounds (px). */
export interface PortalPlayfield {
  width: number;
  height: number;
}

/** Everything `placeWavePortal` needs to choose the portal position. */
export interface PlaceWavePortalRequest {
  /** Bounding-box extents of the planned formation (drives `D_MIN`). */
  formation: PortalFormationExtents;
  /**
   * The formation's planned anchor (its bounding-box centre in the game, or
   * the formation base in a gym). Returned unchanged when it is already far
   * enough from the player, or when no player is supplied.
   */
  anchor: PortalPoint;
  /** Playfield bounds (px). */
  playfield: PortalPlayfield;
  /**
   * The player's live position + velocity. When absent (gyms have no ship),
   * the portal stays at `anchor` and the formation is already base-relative.
   */
  player?: PortalPlayerMotion | null;
  /**
   * Injected RNG returning a fraction in `[0, 1)`; used only to break exact
   * ties (equal candidate distances), never to influence conforming
   * thresholds. Defaults to `Math.random`.
   */
  rng?: () => number;
}

/**
 * Bounding-box centre of a set of planned spawn points (px). Pure.
 */
export function formationCentre(points: readonly PortalPoint[]): PortalPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * Bounding-box extents of a set of planned spawn points (px) — the single
 * source for `D_MIN = max(width, height)` derived from the planned wave.
 * Pure.
 */
export function formationExtents(points: readonly PortalPoint[]): PortalFormationExtents {
  if (points.length === 0) return { width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { width: maxX - minX, height: maxY - minY };
}

/** Axis range that keeps the whole formation on screen (px). */
function portalAxisBounds(size: number, formationSpan: number): [number, number] {
  const min = WAVE_PORTAL_EDGE_MARGIN + formationSpan / 2;
  const max = size - WAVE_PORTAL_EDGE_MARGIN - formationSpan / 2;
  if (max < min) {
    const mid = size / 2;
    return [mid, mid]; // Formation wider/taller than the playfield: centre it.
  }
  return [min, max];
}

function clampPoint(
  p: PortalPoint,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): PortalPoint {
  return {
    x: Math.min(Math.max(p.x, minX), maxX),
    y: Math.min(Math.max(p.y, minY), maxY),
  };
}

/** All candidate portal positions: anchor, lattice, and radial ring points. */
function portalCandidates(
  anchor: PortalPoint,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  keepers: readonly PortalPoint[],
  safeRadius: number,
): PortalPoint[] {
  const candidates: PortalPoint[] = [anchor];
  for (let iy = 0; iy <= WAVE_PORTAL_CANDIDATE_STEPS; iy += 1) {
    for (let ix = 0; ix <= WAVE_PORTAL_CANDIDATE_STEPS; ix += 1) {
      candidates.push({
        x: minX + ((maxX - minX) * ix) / WAVE_PORTAL_CANDIDATE_STEPS,
        y: minY + ((maxY - minY) * iy) / WAVE_PORTAL_CANDIDATE_STEPS,
      });
    }
  }
  // Points on the safety circle around each keeper (clamped in-bounds)
  // guarantee a boundary-near candidate whenever a conforming spot exists.
  for (const keeper of keepers) {
    for (let i = 0; i < WAVE_PORTAL_RING_DIRECTIONS; i += 1) {
      const angle = (i / WAVE_PORTAL_RING_DIRECTIONS) * Math.PI * 2;
      candidates.push(
        clampPoint(
          {
            x: keeper.x + Math.cos(angle) * safeRadius,
            y: keeper.y + Math.sin(angle) * safeRadius,
          },
          minX,
          maxX,
          minY,
          maxY,
        ),
      );
    }
  }
  return candidates;
}

/** Fraction index in `[0, n)` from an injected RNG, clamped to a valid range. */
function rngIndex(rng: () => number, n: number): number {
  if (n <= 1) return 0;
  const r = Math.min(Math.max(rng(), 0), 1 - Number.EPSILON);
  return Math.min(Math.floor(r * n), n - 1);
}

/** Candidate with the smallest distance to `target` (exact ties → RNG). */
function pickNearest(
  candidates: readonly PortalPoint[],
  target: PortalPoint,
  rng: () => number,
): PortalPoint {
  let bestDistance = Infinity;
  let best: PortalPoint[] = [];
  for (const c of candidates) {
    const d = Math.hypot(c.x - target.x, c.y - target.y);
    if (d < bestDistance - 1e-9) {
      bestDistance = d;
      best = [c];
    } else if (Math.abs(d - bestDistance) <= 1e-9) {
      best.push(c);
    }
  }
  return best[rngIndex(rng, best.length)];
}

/** Candidate with the largest `clearance` (exact ties → RNG). */
function pickFurthest(
  candidates: readonly PortalPoint[],
  clearance: (p: PortalPoint) => number,
  rng: () => number,
): PortalPoint {
  let bestClearance = -Infinity;
  let best: PortalPoint[] = [];
  for (const c of candidates) {
    const d = clearance(c);
    if (d > bestClearance + 1e-9) {
      bestClearance = d;
      best = [c];
    } else if (Math.abs(d - bestClearance) <= 1e-9) {
      best.push(c);
    }
  }
  return best[rngIndex(rng, best.length)];
}

/**
 * Nudges `p` outside the player's hull safety radius when it is inside it.
 * Uses the full playfield (formation fit is given up) so the portal is never
 * placed inside the hull + margin (AC4), whenever the playfield has room.
 */
function pushClearOfPlayer(
  p: PortalPoint,
  player: PortalPoint,
  hullSafeRadius: number,
  fieldMinX: number,
  fieldMaxX: number,
  fieldMinY: number,
  fieldMaxY: number,
): PortalPoint {
  const dx = p.x - player.x;
  const dy = p.y - player.y;
  const d = Math.hypot(dx, dy);
  if (d >= hullSafeRadius) return p;
  let ux: number;
  let uy: number;
  if (d > 1e-6) {
    ux = dx / d;
    uy = dy / d;
  } else {
    // Coincident with the player: fall back to a fixed direction (down).
    ux = 0;
    uy = 1;
  }
  return clampPoint(
    { x: player.x + ux * hullSafeRadius, y: player.y + uy * hullSafeRadius },
    fieldMinX,
    fieldMaxX,
    fieldMinY,
    fieldMaxY,
  );
}

/**
 * Chooses where the wave's wormhole opens (AC1–AC5).
 *
 * The portal is placed at the formation's planned anchor when that anchor is
 * already at least `D_MIN = max(formation height, width)` from the player's
 * live position **and** from its position projected `WAVE_PORTAL_TRAJECTORY_HORIZON_SECONDS`
 * along its velocity (AC1/AC2). Otherwise the conforming candidate nearest
 * the planned anchor is chosen — a pure function of (formation geometry,
 * playfield bounds, player state) with an injected RNG used only for exact
 * distance ties. When no in-bounds candidate meets `D_MIN`, the furthest
 * available candidate is used and the position is still never placed inside
 * the player's hull radius + a safety margin (AC4).
 *
 * With no `player` (a formation gym has no ship), the portal stays at
 * `anchor` — the formation base — and the formation is already laid out
 * relative to it, so gym behaviour is unchanged (AC5).
 */
export function placeWavePortal(request: PlaceWavePortalRequest): PortalPoint {
  const { formation, anchor, playfield } = request;
  if (!request.player) {
    return { x: anchor.x, y: anchor.y };
  }
  const player: PortalPlayerMotion = request.player;
  const dMin = Math.max(formation.width, formation.height);
  const hullSafeRadius =
    SHIP_SIZE / 2 + WAVE_PORTAL_PLAYER_SAFETY_MARGIN;
  const safeRadius = Math.max(dMin, hullSafeRadius);
  const projected: PortalPoint = {
    x: player.x + (player.vx ?? 0) * WAVE_PORTAL_TRAJECTORY_HORIZON_SECONDS,
    y: player.y + (player.vy ?? 0) * WAVE_PORTAL_TRAJECTORY_HORIZON_SECONDS,
  };
  const keepers = [player, projected] as const;
  const clearance = (p: PortalPoint): number =>
    Math.min(...keepers.map((k) => Math.hypot(k.x - p.x, k.y - p.y)));

  // Keep the whole formation on screen when placing the portal.
  const [minX, maxX] = portalAxisBounds(playfield.width, formation.width);
  const [minY, maxY] = portalAxisBounds(playfield.height, formation.height);
  // The hull safety radius uses the full playfield (formation fit is given
  // up rather than ever placing the portal inside the hull).
  const fieldMinX = WAVE_PORTAL_EDGE_MARGIN;
  const fieldMaxX = playfield.width - WAVE_PORTAL_EDGE_MARGIN;
  const fieldMinY = WAVE_PORTAL_EDGE_MARGIN;
  const fieldMaxY = playfield.height - WAVE_PORTAL_EDGE_MARGIN;
  const inBounds = (p: PortalPoint): PortalPoint =>
    clampPoint(p, minX, maxX, minY, maxY);
  const plannedAnchor = inBounds(anchor);

  // 1. The planned anchor is already well away — keep it untouched.
  if (clearance(plannedAnchor) >= safeRadius) {
    return plannedAnchor;
  }

  const rng = request.rng ?? Math.random;

  // 2. Nearest conforming candidate to the planned anchor (minimal, smooth
  //    displacement of the formation; the portal itself is what moves).
  const candidates = portalCandidates(
    plannedAnchor,
    minX,
    maxX,
    minY,
    maxY,
    keepers,
    safeRadius,
  );
  const conforming = candidates.filter((p) => clearance(p) >= safeRadius);
  if (conforming.length > 0) {
    return pickNearest(conforming, plannedAnchor, rng);
  }

  // 3. No conforming candidate: furthest available, still never inside the
  //    hull + safety margin.
  const furthest = pickFurthest(candidates, clearance, rng);
  return pushClearOfPlayer(
    furthest,
    player,
    hullSafeRadius,
    fieldMinX,
    fieldMaxX,
    fieldMinY,
    fieldMaxY,
  );
}

/** A planned enemy spawn the portal anchoring may translate. */
export interface PortalAnchorable {
  /** Absolute spawn x (px). */
  x: number;
  /** Absolute spawn y (px). */
  y: number;
  /** Formation base x (px) — kept in step with `x`. */
  startX: number;
  /** Formation base y (px) — kept in step with `y`. */
  startY: number;
}

/**
 * Anchors every planned spawn relative to the portal (AC3): translates the
 * whole formation so its bounding-box centre sits exactly on `portal`
 * (portal-relative offsets instead of screen coordinates). Spacing, offsets,
 * counts and wave pacing are unchanged — a moved portal moves the whole
 * formation with it. Pure — returns translated copies.
 */
export function anchorSpawnsToPortal<T extends PortalAnchorable>(
  spawns: readonly T[],
  portal: PortalPoint,
): T[] {
  if (spawns.length === 0) return [];
  const centre = formationCentre(spawns);
  const dx = portal.x - centre.x;
  const dy = portal.y - centre.y;
  return spawns.map((spawn) => ({
    ...spawn,
    x: spawn.x + dx,
    y: spawn.y + dy,
    startX: spawn.startX + dx,
    startY: spawn.startY + dy,
  }));
}
