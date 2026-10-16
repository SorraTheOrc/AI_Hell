/**
 * Area-of-effect weapon VFX helpers (parent AH-0MUOOB3OR001V8CD).
 *
 * Distinct, code-drawn neon-vector effects for the AOE weapon family, built
 * on the shared Phaser Graphics + tween pattern (`spawnBulletImpact`). The
 * game and every gym spawn these through the shared `CombatScene` dispatch
 * hook, so the feedback cannot drift between scenes.
 *
 * Each helper returns an {@link AoeEffectHandle} exposing the effect's
 * Graphics and a completion flag, and appends the Graphics to an optional
 * caller-owned registry (removed on completion) so tests can observe the
 * effect without pixel assertions — matching the shared teardown pattern.
 *
 * F2 ships the Nova expanding ring; F3/F4 add the Mortar detonation and Arc
 * chain helpers alongside it.
 *
 * @module vfx/aoeEffect
 */

import type Phaser from 'phaser';

/** Nova ring colour — pale cyan, matching the Nova bullet colour. */
export const NOVA_RING_COLOR = 0x66ffff;
/** Nova ring total expansion/fade duration (seconds). */
export const NOVA_RING_DURATION = 0.5;

/** Nova ring stroke width (px) for the outer ring. */
export const NOVA_RING_LINE_WIDTH = 3;

/** Nova ring starting scale (fraction of the final radius) — grows outward. */
export const NOVA_RING_START_SCALE = 0.15;

/** Options common to the AOE VFX helpers. */
export interface AoeEffectOptions {
  /**
   * Optional registry the spawned Graphics is added to while alive and
   * removed from on completion — lets scenes clean up on shutdown and tests
   * observe the effect without pixel assertions.
   */
  registry?: Phaser.GameObjects.Graphics[];
  /** Effect duration override (seconds). */
  duration?: number;
  /** Effect colour override (Phaser integer). */
  color?: number;
  /**
   * Optional launch-origin point (the ship at fire time) used to draw the
   * Mortar's inbound arcing shell trail from the launcher to the blast point
   * (AH-0MV822C250051OVN). Absent → no trail (the generic burst only).
   */
  origin?: { x: number; y: number };
}

/** Handle returned by the AOE VFX helpers. */
export interface AoeEffectHandle {
  /** The effect Graphics (destroyed when the effect completes). */
  readonly graphics: Phaser.GameObjects.Graphics;
  /** The effect radius in px (the drawn ring's un-scaled radius). */
  readonly radius: number;
  /** True once the effect has finished and been torn down. */
  isComplete(): boolean;
}

/**
 * Spawns the Nova expanding ring at (x, y): two concentric neon rings that
 * grow from the ship position outward to `radius` while fading out. The
 * damage/clear resolves instantly at trigger time — the ring is purely
 * cosmetic feedback that reads as "a pulse expanded from the ship".
 *
 * @param scene - The owning scene (tween owner).
 * @param x - Ring centre x (the ship position at fire time).
 * @param y - Ring centre y.
 * @param radius - Final ring radius in px (the AOE effect radius).
 * @param options - Optional registry/duration/colour overrides.
 * @returns An {@link AoeEffectHandle} for observation/teardown.
 */
export function spawnNovaRing(
  scene: Phaser.Scene,
  x: number,
  y: number,
  radius: number,
  options: AoeEffectOptions = {},
): AoeEffectHandle {
  const duration = options.duration ?? NOVA_RING_DURATION;
  const color = options.color ?? NOVA_RING_COLOR;
  const registry = options.registry;

  const graphics = scene.add.graphics();
  graphics.setPosition(x, y);
  graphics.setScale(NOVA_RING_START_SCALE);
  // Bright white-hot flash core (AH-0MV822BPT002GF17) — a filled flash at the
  // ring's origin so the shot reads as a bright ring flash, not a hairline
  // outline. It expands with the ring and fades with the same tween.
  graphics.fillStyle(0xffffff, 0.55);
  graphics.fillCircle(0, 0, radius * 0.34);
  // Outer ring — the primary pulse edge.
  graphics.lineStyle(NOVA_RING_LINE_WIDTH, color, 1);
  graphics.strokeCircle(0, 0, radius);
  // Inner ring — a fainter echo for depth, expanding with the outer ring.
  graphics.lineStyle(1, color, 0.5);
  graphics.strokeCircle(0, 0, radius * 0.72);

  registry?.push(graphics);

  let complete = false;
  scene.tweens.add({
    targets: graphics,
    scale: 1,
    alpha: 0,
    duration: duration * 1000,
    ease: 'Cubic.easeOut',
    onComplete: () => {
      complete = true;
      if (registry) {
        const index = registry.indexOf(graphics);
        if (index >= 0) registry.splice(index, 1);
      }
      graphics.destroy();
    },
  });

  return {
    graphics,
    radius,
    isComplete: () => complete,
  };
}

// ── Mortar detonation burst (F3) ────────────────────────────────────

/** Mortar burst colour — deep orange, matching the Mortar shell colour. */
export const MORTAR_BURST_COLOR = 0xff6600;

/** Mortar burst expansion/fade duration (seconds). */
export const MORTAR_BURST_DURATION = 0.4;

/** Mortar burst starting scale (fraction of the final radius). */
export const MORTAR_BURST_START_SCALE = 0.3;

/** Number of radiating spikes in the Mortar burst. */
export const MORTAR_BURST_SPIKE_COUNT = 8;

/** Number of segments along the Mortar's inbound arcing trail. */
export const MORTAR_TRAIL_SEGMENTS = 8;

/**
 * Spawns the Mortar detonation burst at (x, y): a bright blast flash core
 * ringed by radiating spikes, expanding to `radius` while fading. When an
 * `origin` (the ship's fire position) is supplied, an inbound **arcing shell
 * trail** — a tapering ballistic arc from the launcher to the blast point —
 * is drawn with the burst, so the detonation reads as a shell landing
 * (AH-0MV822C250051OVN). Visually distinct from the Nova concentric rings
 * and from the Bomb bomb icon.
 *
 * The burst's damage/clear resolves before this is called — the burst is the
 * impact-point feedback.
 *
 * @param scene - The owning scene (tween owner).
 * @param x - Detonation centre x (the projectile's impact/expiry point).
 * @param y - Detonation centre y.
 * @param radius - Final burst radius in px (the AOE effect radius).
 * @param options - Optional registry/duration/colour/origin overrides.
 * @returns An {@link AoeEffectHandle} for observation/teardown.
 */
export function spawnMortarBurst(
  scene: Phaser.Scene,
  x: number,
  y: number,
  radius: number,
  options: AoeEffectOptions = {},
): AoeEffectHandle {
  const duration = options.duration ?? MORTAR_BURST_DURATION;
  const color = options.color ?? MORTAR_BURST_COLOR;
  const registry = options.registry;

  const graphics = scene.add.graphics();
  graphics.setPosition(x, y);
  graphics.setScale(MORTAR_BURST_START_SCALE);

  // Inbound arcing shell trail (AH-0MV822C250051OVN): a tapering ballistic
  // quadratic arc drawn from the launcher origin into the blast point, so the
  // random onRandom detonation reads as an arcing shell landing rather than a
  // point flash. The control point bows the path perpendicular to the shot.
  const origin = options.origin;
  if (origin) {
    const ox = origin.x - x;
    const oy = origin.y - y;
    const dist = Math.hypot(ox, oy);
    if (dist > 4) {
      // Perpendicular unit so the apex bows to one side of the line of fire.
      const nx = -oy / dist;
      const ny = ox / dist;
      const bow = Math.min(dist * 0.3, radius * 1.6);
      const cx = ox * 0.5 + nx * bow;
      const cy = oy * 0.5 + ny * bow;
      // Wispy taper: three fading strokes over the same arc, each thinner and
      // shorter than the last so the trail reads as a drifting smoke wake.
      for (let w = 0; w < 3; w++) {
        const width = 2 - w * 0.6;
        const alpha = 0.55 - w * 0.15;
        graphics.lineStyle(width, color, alpha);
        graphics.beginPath();
        // Start partway along the arc so only the outermost wisps reach back
        // to the launcher; the head of the trail is at the blast point.
        const startT = 0.15 + w * 0.06;
        for (let s = 0; s <= MORTAR_TRAIL_SEGMENTS; s++) {
          const t = startT + ((1 - startT) * s) / MORTAR_TRAIL_SEGMENTS;
          const mt = 1 - t;
          const px = mt * mt * ox + 2 * mt * t * cx;
          const py = mt * mt * oy + 2 * mt * t * cy;
          if (s === 0) graphics.moveTo(px, py);
          else graphics.lineTo(px, py);
        }
        graphics.strokePath();
      }
    }
  }

  // Flash core — the bright blast centre (white-hot inner flash over the
  // weapon-coloured fill so the detonation reads as a shell landing).
  graphics.fillStyle(0xffffff, 0.75);
  graphics.fillCircle(0, 0, radius * 0.22);
  graphics.fillStyle(color, 0.35);
  graphics.fillCircle(0, 0, radius);
  // Radiating spikes — the explosion-burst signature (distinct from a ring).
  graphics.lineStyle(2, color, 1);
  const inner = radius * 0.5;
  for (let i = 0; i < MORTAR_BURST_SPIKE_COUNT; i++) {
    const angle = (i / MORTAR_BURST_SPIKE_COUNT) * Math.PI * 2;
    graphics.beginPath();
    graphics.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    graphics.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    graphics.strokePath();
  }

  registry?.push(graphics);

  let complete = false;
  scene.tweens.add({
    targets: graphics,
    scale: 1,
    alpha: 0,
    duration: duration * 1000,
    ease: 'Cubic.easeOut',
    onComplete: () => {
      complete = true;
      if (registry) {
        const index = registry.indexOf(graphics);
        if (index >= 0) registry.splice(index, 1);
      }
      graphics.destroy();
    },
  });

  return {
    graphics,
    radius,
    isComplete: () => complete,
  };
}

// ── Arc chaining bolt (F4) ──────────────────────────────────────────

/** Arc chain colour — electric purple, matching the Arc weapon colour. */
export const ARC_CHAIN_COLOR = 0xcc66ff;

/** Arc chain fade duration (seconds). */
export const ARC_CHAIN_DURATION = 0.3;

/** Maximum perpendicular jitter (px) applied to each zigzag step. */
export const ARC_CHAIN_JITTER = 6;

/** Number of steps per chain segment (higher = smoother zigzag). */
export const ARC_CHAIN_SEGMENTS = 5;

/** A world-space vertex of the Arc chain path (origin → target → …). */
export interface ArcChainPoint {
  x: number;
  y: number;
}

/**
 * Spawns the Arc chaining-bolt VFX: a zigzag neon bolt drawn through each
 * consecutive pair of `points` (ship → primary → chained targets …), fading
 * out. Distinct from the Nova rings and the Mortar burst by its jagged
 * segment geometry.
 *
 * The chain's damage/clear resolves before this is called — this is the
 * path feedback.
 *
 * @param scene - The owning scene (tween owner).
 * @param points - The chain vertices in order (at least two for a bolt).
 * @param options - Optional registry/duration/colour overrides.
 * @returns An {@link AoeEffectHandle} (its radius is the chain's reach).
 */
export function spawnArcChain(
  scene: Phaser.Scene,
  points: readonly ArcChainPoint[],
  options: AoeEffectOptions = {},
): AoeEffectHandle {
  const duration = options.duration ?? ARC_CHAIN_DURATION;
  const color = options.color ?? ARC_CHAIN_COLOR;
  const registry = options.registry;

  const graphics = scene.add.graphics();
  graphics.lineStyle(2, color, 1);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    // Perpendicular unit vector for the zigzag displacement.
    const nx = -dy / length;
    const ny = dx / length;
    graphics.beginPath();
    graphics.moveTo(a.x, a.y);
    for (let step = 1; step <= ARC_CHAIN_SEGMENTS; step++) {
      const t = step / ARC_CHAIN_SEGMENTS;
      let px = a.x + dx * t;
      let py = a.y + dy * t;
      if (step < ARC_CHAIN_SEGMENTS) {
        const jitter = (Math.random() * 2 - 1) * ARC_CHAIN_JITTER;
        px += nx * jitter;
        py += ny * jitter;
      }
      graphics.lineTo(px, py);
    }
    graphics.strokePath();
  }

  // Reach = farthest vertex from the origin, exposed on the handle.
  const origin = points[0];
  let reach = 0;
  for (const point of points) {
    reach = Math.max(reach, Math.hypot(point.x - origin.x, point.y - origin.y));
  }

  registry?.push(graphics);

  let complete = false;
  scene.tweens.add({
    targets: graphics,
    alpha: 0,
    duration: duration * 1000,
    ease: 'Cubic.easeOut',
    onComplete: () => {
      complete = true;
      if (registry) {
        const index = registry.indexOf(graphics);
        if (index >= 0) registry.splice(index, 1);
      }
      graphics.destroy();
    },
  });

  return {
    graphics,
    radius: reach,
    isComplete: () => complete,
  };
}
