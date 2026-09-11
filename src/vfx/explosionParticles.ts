/**
 * Shared particle explosion module (AH-0MTV6ADT4001FB2V).
 *
 * Pure-logic helpers for particle-based explosion VFX — count scaling,
 * colour jitter, geometry emitters, and pattern combination. No Phaser
 * rendering dependencies; the Phaser wiring layer lives in the caller
 * (entity/scene death paths).
 *
 * Pattern types:
 *   - `radial` — uniform random directions + speed spread.
 *   - `ring` — particles emitted on a circle at shared radius/speed.
 *   - `implosion` — drift inward for ~100 ms then burst outward.
 *
 * All helpers use a seeded PRNG for deterministic tests.
 */

// ── Tunable constants (AC2, AC4) ───────────────────────────────────

/** Base particle count for standard-sized enemies (20-40). */
export const EXPLOSION_BASE_COUNT = 30;

/** Particle count for Boss-sized entities (~50-80). */
export const EXPLOSION_BOSS_COUNT = 60;

/** Particle count for Player-sized entities (~50-80). */
export const EXPLOSION_PLAYER_COUNT = 60;

/** Particle lifespan in milliseconds (300-500). */
export const EXPLOSION_LIFESPAN_MS = 400;

/** Reference size: scaledCount(referenceSize) ≈ baseCount. */
export const EXPLOSION_REFERENCE_SIZE = 20;

/** Lower clamp for particle count. */
export const EXPLOSION_MIN_COUNT = 8;

/** Upper clamp for particle count. */
export const EXPLOSION_MAX_COUNT = 80;

/** Hue jitter range in degrees (15-20). Margin for hex↔HSL round-trip precision. */
export const EXPLOSION_HUE_JITTER_DEG = 20;

/** Saturation variance bound (0-1 scale, < 0.2). */
export const EXPLOSION_SAT_VARIANCE = 0.08;

/** Lightness variance bound (0-1 scale, < 0.2). */
export const EXPLOSION_LIGHT_VARIANCE = 0.06;

// ── Types ──────────────────────────────────────────────────────────

/** A single particle's data (pure, no Phaser types). */
export interface Particle {
  /** X position (local to explosion centre). */
  x: number;
  /** Y position (local to explosion centre). */
  y: number;
  /** X velocity (px/s). */
  vx: number;
  /** Y velocity (px/s). */
  vy: number;
  /** Colour (hex). */
  color: number;
  /** Current alpha (1 → 0 over lifespan). */
  alpha: number;
  /** Current radius/size (shrinks to 0 over lifespan). */
  radius: number;
  /** Whether the particle has finished (alpha ≤ 0 and radius ≤ 0). */
  dead: boolean;
  /** Alpha decay per millisecond. */
  fadeStep: number;
  /** Radius shrink per millisecond. */
  shrinkStep: number;
  /** Burst-phase velocity (implosion particles only). */
  burstVx?: number;
  burstVy?: number;
  /** Implosion-phase target (usually 0,0). */
  implX?: number;
  implY?: number;
  /** Current phase: 'implosion' during inward drift, 'burst' after. */
  phase?: 'implosion' | 'burst';
}

/** Explosion pattern type identifier. */
export type Pattern = 'radial' | 'ring' | 'implosion';

// ── Seeded RNG (mulberry32) ────────────────────────────────────────

/** Creates a mulberry32 PRNG from a numeric seed. */
export function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t =
      Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── AC1: Count scaling ────────────────────────────────────────────

/**
 * Returns the particle count for an entity of the given size.
 * Linear scaling: `baseCount * (size / referenceSize)`, clamped to [min, max].
 */
export function scaledCount(size: number): number {
  const raw = Math.round(EXPLOSION_BASE_COUNT * (size / EXPLOSION_REFERENCE_SIZE));
  return Math.max(EXPLOSION_MIN_COUNT, Math.min(EXPLOSION_MAX_COUNT, raw));
}

// ── AC2: Colour helpers ────────────────────────────────────────────

/**
 * Converts a 0xRRGGBB hex colour to HSL.
 * Returns { h: 0-360, s: 0-1, l: 0-1 }.
 */
export function colorToHSL(hex: number): { h: number; s: number; l: number } {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;
  if (max === r) {
    h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  } else if (max === g) {
    h = ((b - r) / d + 2) * 60;
  } else {
    h = ((r - g) / d + 4) * 60;
  }

  return { h: h % 360, s, l };
}

/**
 * Converts HSL to a 0xRRGGBB hex colour.
 * h: 0-360, s: 0-1, l: 0-1.
 */
export function hslToHex(h: number, s: number, l: number): number {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r: number, g: number, b: number;

  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }

  const ri = Math.round((r + m) * 255);
  const gi = Math.round((g + m) * 255);
  const bi = Math.round((b + m) * 255);

  return ((ri & 0xff) << 16) | ((gi & 0xff) << 8) | (bi & 0xff);
}

/**
 * Applies small HSL jitter around the base colour.
 * Uses the provided RNG for deterministic output.
 * Hue ±18°, saturation ±0.08, lightness ±0.06.
 */
export function jitterColor(baseColor: number, rng: () => number): number {
  const hsl = colorToHSL(baseColor);

  const hDelta = (rng() - 0.5) * 2 * EXPLOSION_HUE_JITTER_DEG;
  const sDelta = (rng() - 0.5) * 2 * EXPLOSION_SAT_VARIANCE;
  const lDelta = (rng() - 0.5) * 2 * EXPLOSION_LIGHT_VARIANCE;

  return hslToHex(
    hsl.h + hDelta,
    Math.max(0, Math.min(1, hsl.s + sDelta)),
    Math.max(0, Math.min(1, hsl.l + lDelta)),
  );
}

// ── AC3: Pattern emitters (pure geometry) ──────────────────────────

/**
 * Generates a radial burst: particles in uniformly random directions
 * with speed spread proportional to entity size.
 *
 * Each particle gets a colour jittered from `baseColor`.
 */
export function generateRadialBurst(
  count: number,
  baseX: number,
  baseY: number,
  size: number,
  baseColor: number,
  rng: () => number,
): Particle[] {
  const particles: Particle[] = [];
  const startRadius = size * 0.5;
  const speedBase = 60 + size * 3; // px/s, scales with size
  const speedSpread = speedBase * 0.4;

  for (let i = 0; i < count; i++) {
    const angle = rng() * Math.PI * 2;
    const speed = speedBase + (rng() - 0.5) * 2 * speedSpread;
    const color = jitterColor(baseColor, rng);

    particles.push({
      x: baseX,
      y: baseY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      color,
      alpha: 1,
      radius: startRadius,
      dead: false,
      fadeStep: 1 / EXPLOSION_LIFESPAN_MS,
      shrinkStep: startRadius / EXPLOSION_LIFESPAN_MS,
    });
  }

  return particles;
}

/**
 * Generates a ring/shell burst: all particles emitted on a circle
 * at a shared radius with similar outward speed, forming an expanding ring.
 */
export function generateRingBurst(
  count: number,
  baseX: number,
  baseY: number,
  size: number,
  baseColor: number,
  rng: () => number,
): Particle[] {
  const particles: Particle[] = [];
  const ringRadius = size * 1.2;
  const speedBase = 50 + size * 2.5;
  const speedTolerance = speedBase * 0.07; // ±7% for slight uniformity

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2; // evenly spaced on the ring
    const speed = speedBase + (rng() - 0.5) * 2 * speedTolerance;
    const color = jitterColor(baseColor, rng);

    particles.push({
      x: baseX + Math.cos(angle) * ringRadius,
      y: baseY + Math.sin(angle) * ringRadius,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      color,
      alpha: 1,
      radius: size * 0.3,
      dead: false,
      fadeStep: 1 / EXPLOSION_LIFESPAN_MS,
      shrinkStep: (size * 0.3) / EXPLOSION_LIFESPAN_MS,
    });
  }

  return particles;
}

/**
 * Generates an implosion-then-burst: particles start scattered around
 * the explosion centre, drift inward for ~100 ms, then burst outward
 * from the centre.
 */
export function generateImplosionBurst(
  count: number,
  baseX: number,
  baseY: number,
  size: number,
  baseColor: number,
  rng: () => number,
): Particle[] {
  const particles: Particle[] = [];
  const scatterRadius = size * 2;
  const implSpeed = 40 + size * 2; // inward speed
  const burstSpeedBase = 70 + size * 4;
  const burstSpeedSpread = burstSpeedBase * 0.4;
  // implDuration = 100ms — wired in Phaser layer for phase transition timing

  for (let i = 0; i < count; i++) {
    const angle = rng() * Math.PI * 2;
    const startX = baseX + Math.cos(angle) * scatterRadius;
    const startY = baseY + Math.sin(angle) * scatterRadius;

    // Inward velocity (toward centre).
    const dxIn = baseX - startX;
    const dyIn = baseY - startY;
    const distIn = Math.sqrt(dxIn * dxIn + dyIn * dyIn) || 1;
    const vxImpl = (dxIn / distIn) * implSpeed;
    const vyImpl = (dyIn / distIn) * implSpeed;

    // Outward burst velocity (opposite of starting angle).
    const burstAngle = angle + (rng() - 0.5) * 0.5; // slight random spread
    const burstSpeed = burstSpeedBase + (rng() - 0.5) * 2 * burstSpeedSpread;

    const color = jitterColor(baseColor, rng);
    const startRadius = size * 0.4;

    particles.push({
      x: startX,
      y: startY,
      vx: vxImpl,
      vy: vyImpl,
      color,
      alpha: 1,
      radius: startRadius,
      dead: false,
      fadeStep: 1 / EXPLOSION_LIFESPAN_MS,
      shrinkStep: startRadius / EXPLOSION_LIFESPAN_MS,
      burstVx: Math.cos(burstAngle) * burstSpeed,
      burstVy: Math.sin(burstAngle) * burstSpeed,
      implX: baseX,
      implY: baseY,
      phase: 'implosion',
    });
  }

  return particles;
}

// ── AC4: Pattern combinator ────────────────────────────────────────

/**
 * Splits a total particle count evenly across the given pattern types.
 * Single pattern → full count; two patterns → half each; three → third each.
 * Remainders are distributed to earlier patterns (deterministic).
 *
 * Returns an array of counts, one per pattern, summing to `total`.
 */
export function combinePatterns(patterns: Pattern[], total: number): number[] {
  if (patterns.length === 0) return [];
  if (patterns.length === 1) return [total];

  const perPattern = Math.floor(total / patterns.length);
  const remainder = total % patterns.length;
  const counts: number[] = [];

  for (let i = 0; i < patterns.length; i++) {
    counts.push(perPattern + (i < remainder ? 1 : 0));
  }

  return counts;
}

// ── Phaser integration (thin layer — implemented in later children) ─

/**
 * Spawns a particle explosion at (x, y) on the given scene.
 * This is the Phaser-side entry point called from entity death paths.
 *
 * @param scene  — Phaser.Scene instance (for Graphics/tweens).
 * @param x      — X coordinate of the explosion centre.
 * @param y      — Y coordinate of the explosion centre.
 * @param baseColor — Hex colour of the exploding entity.
 * @param size   — Size of the exploding entity (affects count).
 * @param opts   — Optional overrides (patterns, custom count, etc.).
 */
// NOTE: The Phaser Graphics + tween wiring is implemented in child AH-0MTVID8RQ002DJ0J.
// This stub allows the pure-logic tests to pass today.
export function spawnExplosionParticles(
  _scene: unknown,
  _x: number,
  _y: number,
  _baseColor: number,
  _size: number,
  _opts?: Record<string, unknown>,
): void {
  // Stub — the real implementation (Graphics + tween loop) lands in
  // the wiring child (AH-0MTVID8RQ002DJ0J). Pure tests don't need it.
}
