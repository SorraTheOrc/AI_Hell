/**
 * Shared particle explosion module (AH-0MTV6ADT4001FB2V).
 *
 * Pure-logic helpers for particle-based explosion VFX — count scaling,
 * colour jitter, per-particle size/position jitter, geometry emitters, and
 * pattern combination — plus the thin Phaser rendering layer
 * (`spawnExplosionParticles`).
 *
 * Pattern types:
 *   - `radial` — uniform random directions + speed spread.
 *   - `ring` — particles emitted on a circle at shared radius/speed.
 *   - `implosion` — drift inward for ~100 ms then burst outward.
 *
 * Randomisation (`EXPLOSION_SIZE_JITTER`, `EXPLOSION_POSITION_JITTER`) is
 * layered on top of the pattern geometry so repeated kills look different
 * without changing each pattern's identity (a ring still reads as a ring).
 *
 * Which entity uses which patterns lives in `EXPLOSION_PATTERNS_BY_TYPE`;
 * death paths resolve it via `resolvePatterns(type)`. All tuning values
 * (counts, lifespan, jitter, speeds/radii) are exported constants below.
 *
 * All pure helpers use a seeded PRNG for deterministic tests.
 *
 * ## Image-based explosion frames (AH-0MVJ8TB610098DSY)
 *
 * Particles are no longer drawn as filled circles. Each one is an **image**
 * whose texture is a procedurally generated explosion frame (see
 * `./explosionTextures`), and the frame index is a function of the particle's
 * normalised age only, so the silhouette morphs from a hot dense core through
 * ragged flame lobes into a thin ember as the particle shrinks and fades.
 *
 * ## Two-zone colour model (AC3)
 *
 * Every burst carries two colour zones:
 *
 *   - **core** — the inner `EXPLOSION_CORE_FRACTION` of each pattern group,
 *     coloured from the exported warm red/orange → white-hot palette below, so
 *     the blast has a fire core;
 *   - **lobe/ember** — every remaining particle, which keeps the exploding
 *     entity's palette hue with the existing seeded HSL jitter
 *     (`EXPLOSION_HUE_JITTER_DEG`), so per-entity identity survives
 *     (AH-0MTVID3I1001Y034 stays in force).
 *
 * The renderer creates the burst once as a container of frame images (shared
 * textures, one generated set per game) and re-tints/morphs them per frame; it
 * degrades to a display-free burst when the scene exposes no texture support
 * (headless stub scenes), keeping the counters and teardown contract intact.
 */

import {
  EXPLOSION_TEXTURE_SIZE,
  ensureExplosionFrameTextures,
  explosionFrameKey,
  explosionFramesAvailable,
  frameIndexFor,
  type ExplosionTextureProvider,
} from './explosionTextures';

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

/**
 * Per-particle size jitter as a fraction of the pattern's base radius.
 * Each particle's base radius is multiplied by a uniform factor in
 * `[1 - EXPLOSION_SIZE_JITTER, 1 + EXPLOSION_SIZE_JITTER]` (±30 % default)
 * so repeated explosions no longer look identical. Applies to every pattern
 * and entity type; counts, colours, speeds and lifespans are unchanged.
 */
export const EXPLOSION_SIZE_JITTER = 0.3;

/**
 * Per-particle position jitter as a fraction of the effective particle size
 * (in px). Each particle's emitted start position is offset on both axes by
 * up to ±(EXPLOSION_POSITION_JITTER × size) — ±15 % of the entity size by
 * default — including the otherwise evenly-spaced `ring` particles. Applied
 * before velocity is computed so the drift/implosion directions stay coherent.
 */
export const EXPLOSION_POSITION_JITTER = 0.15;

/**
 * Returns `baseRadius` multiplied by a uniform factor in
 * `[1 - EXPLOSION_SIZE_JITTER, 1 + EXPLOSION_SIZE_JITTER]`. Draws exactly one
 * value from `rng` so the seeded sequence stays stable and deterministic.
 */
function jitterSize(baseRadius: number, rng: () => number): number {
  return baseRadius * (1 + (rng() - 0.5) * 2 * EXPLOSION_SIZE_JITTER);
}

/**
 * Offsets an emitted axis value by a uniform amount in
 * `[-(EXPLOSION_POSITION_JITTER × size), +(EXPLOSION_POSITION_JITTER × size)]`.
 * Draws exactly one value from `rng` so the seeded sequence stays stable.
 */
function jitterPosition(base: number, size: number, rng: () => number): number {
  return base + (rng() - 0.5) * 2 * EXPLOSION_POSITION_JITTER * size;
}

// ── Pattern speed/radius tuning (AC5) ─────────────────────────────

/** Radial burst: base speed in px/s (plus per-size term). */
export const EXPLOSION_RADIAL_SPEED_BASE = 60;
/** Radial burst: additional speed per px of entity size. */
export const EXPLOSION_RADIAL_SPEED_PER_SIZE = 3;
/** Radial burst: speed spread as a fraction of the base speed (±). */
export const EXPLOSION_RADIAL_SPEED_SPREAD = 0.4;
/** Radial burst: starting particle radius as a fraction of entity size. */
export const EXPLOSION_RADIAL_START_RADIUS = 0.5;

/** Ring burst: ring radius as a multiple of entity size. */
export const EXPLOSION_RING_RADIUS_FACTOR = 1.2;
/** Ring burst: base speed in px/s (plus per-size term). */
export const EXPLOSION_RING_SPEED_BASE = 50;
/** Ring burst: additional speed per px of entity size. */
export const EXPLOSION_RING_SPEED_PER_SIZE = 2.5;
/** Ring burst: speed tolerance as a fraction (±7% keeps the ring coherent). */
export const EXPLOSION_RING_SPEED_TOLERANCE = 0.07;
/** Ring burst: particle radius as a fraction of entity size. */
export const EXPLOSION_RING_PARTICLE_RADIUS = 0.3;

/** Implosion: scatter radius as a multiple of entity size. */
export const EXPLOSION_IMPLOSION_SCATTER_FACTOR = 2;
/** Implosion: inward drift base speed in px/s (plus per-size term). */
export const EXPLOSION_IMPLOSION_SPEED_BASE = 40;
/** Implosion: additional inward speed per px of entity size. */
export const EXPLOSION_IMPLOSION_SPEED_PER_SIZE = 2;
/** Burst phase: base outward speed in px/s (plus per-size term). */
export const EXPLOSION_BURST_SPEED_BASE = 70;
/** Burst phase: additional outward speed per px of entity size. */
export const EXPLOSION_BURST_SPEED_PER_SIZE = 4;
/** Burst phase: speed spread as a fraction of the base speed (±). */
export const EXPLOSION_BURST_SPEED_SPREAD = 0.4;
/** Burst phase: angular jitter in radians around the scatter angle. */
export const EXPLOSION_BURST_ANGLE_SPREAD = 0.5;
/** Implosion: particle radius as a fraction of entity size. */
export const EXPLOSION_IMPLOSION_PARTICLE_RADIUS = 0.4;

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
  /**
   * Colour zone: `core` particles use the warm fire palette, `lobe` particles
   * keep the exploding entity's hue with the seeded HSL jitter (AC3).
   */
  zone: ParticleZone;
  /**
   * Seeded silhouette-frame phase offset in [0, 1). Shifts where in the
   * particle's life the explosion frame morphs (AC2), while the frame index
   * itself stays a pure function of the normalised age.
   */
  frameOffset: number;
  /** Seeded start rotation in radians, so lobe silhouettes never align. */
  rotation: number;
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

/** Colour zone of a particle (AC3). */
export type ParticleZone = 'core' | 'lobe';

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
 * Hue ±EXPLOSION_HUE_JITTER_DEG, saturation ±EXPLOSION_SAT_VARIANCE,
 * lightness ±EXPLOSION_LIGHT_VARIANCE (tunable constants above).
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

// ── AC3: Warm fire core palette ───────────────────────────────────

/**
 * Fraction of each pattern group rendered as the warm fire **core**. The
 * remainder are lobe/ember particles that keep the entity hue, so a burst
 * always has both colour zones.
 */
export const EXPLOSION_CORE_FRACTION = 0.35;

/** Lower bound of the documented core hue band (degrees) — deep red. */
export const EXPLOSION_CORE_HUE_MIN_DEG = 0;

/** Upper bound of the documented core hue band (degrees) — orange. */
export const EXPLOSION_CORE_HUE_MAX_DEG = 34;

/** Lower bound of the core saturation band (0-1) — fully saturated fire. */
export const EXPLOSION_CORE_SAT_MIN = 0.85;

/** Upper bound of the core saturation band (0-1). */
export const EXPLOSION_CORE_SAT_MAX = 1;

/** Lower bound of the core lightness band (0-1) — deep red fire. */
export const EXPLOSION_CORE_LIGHT_MIN = 0.42;

/** Upper bound of the core lightness band (0-1) — white-hot. */
export const EXPLOSION_CORE_LIGHT_MAX = 0.74;

/** Hue of the white-hot centre particle (degrees) — amber-orange. */
export const EXPLOSION_CORE_CENTRE_HUE_DEG = 28;

/**
 * Allowed hue error (degrees) when a band guard reads an emitted colour back
 * through `colorToHSL`. 0xRRGGBB quantisation moves a hue by well under 1°.
 */
export const EXPLOSION_CORE_HUE_TOLERANCE_DEG = 1;

/**
 * The single white-hot centre colour every pattern group opens with — the
 * brightest point of the burst, drawn from the top of the core lightness band.
 */
export const EXPLOSION_CORE_CENTRE_COLOR = hslToHex(
  EXPLOSION_CORE_CENTRE_HUE_DEG,
  1,
  EXPLOSION_CORE_LIGHT_MAX,
);

/**
 * Draws one warm core colour from the seeded PRNG: hue inside
 * [`EXPLOSION_CORE_HUE_MIN_DEG`, `EXPLOSION_CORE_HUE_MAX_DEG`], saturation
 * inside [`EXPLOSION_CORE_SAT_MIN`, `EXPLOSION_CORE_SAT_MAX`] and lightness
 * inside [`EXPLOSION_CORE_LIGHT_MIN`, `EXPLOSION_CORE_LIGHT_MAX`]. Draws
 * exactly three values so the seeded sequence stays stable.
 */
export function resolveCoreColor(rng: () => number): number {
  const h =
    EXPLOSION_CORE_HUE_MIN_DEG +
    rng() * (EXPLOSION_CORE_HUE_MAX_DEG - EXPLOSION_CORE_HUE_MIN_DEG);
  const s =
    EXPLOSION_CORE_SAT_MIN +
    rng() * (EXPLOSION_CORE_SAT_MAX - EXPLOSION_CORE_SAT_MIN);
  const l =
    EXPLOSION_CORE_LIGHT_MIN +
    rng() * (EXPLOSION_CORE_LIGHT_MAX - EXPLOSION_CORE_LIGHT_MIN);
  return hslToHex(h, s, l);
}

/**
 * Resolves one particle's colour: warm core colours for the fire core (with
 * the group's first particle always white-hot), entity-hue jitter for lobes.
 */
export function pickParticleColor(
  baseColor: number,
  isCore: boolean,
  isCentre: boolean,
  rng: () => number,
): number {
  if (!isCore) return jitterColor(baseColor, rng);
  if (isCentre) return EXPLOSION_CORE_CENTRE_COLOR;
  return resolveCoreColor(rng);
}

/**
 * Number of core particles in a pattern group of `count` particles — at least
 * one (so a burst always has a fire core) and never all of a group of two or
 * more (so lobes and embers carry the entity hue).
 */
export function coreCountFor(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  return Math.max(
    1,
    Math.min(count - 1, Math.round(count * EXPLOSION_CORE_FRACTION)),
  );
}

// ── AC3: Pattern emitters (pure geometry) ──────────────────────────

/**
 * Generates a radial burst: particles in uniformly random directions
 * with speed spread proportional to entity size.
 *
 * Each particle gets a colour from its zone (warm core or entity-hued lobe,
 * AC3), its radius jittered by ±{@link EXPLOSION_SIZE_JITTER}, and its start
 * position offset by ±({@link EXPLOSION_POSITION_JITTER} × size) on each axis.
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
  const startRadius = size * EXPLOSION_RADIAL_START_RADIUS;
  const speedBase = EXPLOSION_RADIAL_SPEED_BASE + size * EXPLOSION_RADIAL_SPEED_PER_SIZE;
  const speedSpread = speedBase * EXPLOSION_RADIAL_SPEED_SPREAD;
  const coreCount = coreCountFor(count);

  for (let i = 0; i < count; i++) {
    const angle = rng() * Math.PI * 2;
    const speed = speedBase + (rng() - 0.5) * 2 * speedSpread;
    const isCore = i < coreCount;
    const color = pickParticleColor(baseColor, isCore, i === 0, rng);
    const frameOffset = rng();
    const rotation = rng() * Math.PI * 2;
    const jitteredRadius = jitterSize(startRadius, rng);
    const x = jitterPosition(baseX, size, rng);
    const y = jitterPosition(baseY, size, rng);

    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      color,
      zone: isCore ? 'core' : 'lobe',
      frameOffset,
      rotation,
      alpha: 1,
      radius: jitteredRadius,
      dead: false,
      fadeStep: 1 / EXPLOSION_LIFESPAN_MS,
      // Derived from the jittered radius so the particle still shrinks to 0.
      shrinkStep: jitteredRadius / EXPLOSION_LIFESPAN_MS,
    });
  }

  return particles;
}

/**
 * Generates a ring/shell burst: all particles emitted on a circle
 * at a shared radius with similar outward speed, forming an expanding ring.
 *
 * Particle radii are size-jittered and start positions position-jittered
 * (AC1/AC2), so the ring keeps its identity but stops being perfectly even.
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
  const ringRadius = size * EXPLOSION_RING_RADIUS_FACTOR;
  const speedBase = EXPLOSION_RING_SPEED_BASE + size * EXPLOSION_RING_SPEED_PER_SIZE;
  const speedTolerance = speedBase * EXPLOSION_RING_SPEED_TOLERANCE;
  const coreCount = coreCountFor(count);

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2; // evenly spaced on the ring
    const speed = speedBase + (rng() - 0.5) * 2 * speedTolerance;
    const isCore = i < coreCount;
    const color = pickParticleColor(baseColor, isCore, i === 0, rng);
    const frameOffset = rng();
    const rotation = rng() * Math.PI * 2;
    const jitteredRadius = jitterSize(size * EXPLOSION_RING_PARTICLE_RADIUS, rng);
    // Position jitter (AC2) also applies to the evenly-spaced ring particles.
    const x = jitterPosition(baseX + Math.cos(angle) * ringRadius, size, rng);
    const y = jitterPosition(baseY + Math.sin(angle) * ringRadius, size, rng);

    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      color,
      zone: isCore ? 'core' : 'lobe',
      frameOffset,
      rotation,
      alpha: 1,
      radius: jitteredRadius,
      dead: false,
      fadeStep: 1 / EXPLOSION_LIFESPAN_MS,
      // Derived from the jittered radius so the particle still shrinks to 0.
      shrinkStep: jitteredRadius / EXPLOSION_LIFESPAN_MS,
    });
  }

  return particles;
}

/**
 * Generates an implosion-then-burst: particles start scattered around
 * the explosion centre, drift inward for ~100 ms, then burst outward
 * from the centre.
 *
 * Start positions are jittered before the inward velocity is derived, and
 * particle radii are size-jittered (AC1/AC2).
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
  const scatterRadius = size * EXPLOSION_IMPLOSION_SCATTER_FACTOR;
  const implSpeed = EXPLOSION_IMPLOSION_SPEED_BASE + size * EXPLOSION_IMPLOSION_SPEED_PER_SIZE;
  const burstSpeedBase = EXPLOSION_BURST_SPEED_BASE + size * EXPLOSION_BURST_SPEED_PER_SIZE;
  const burstSpeedSpread = burstSpeedBase * EXPLOSION_BURST_SPEED_SPREAD;
  const coreCount = coreCountFor(count);

  for (let i = 0; i < count; i++) {
    const angle = rng() * Math.PI * 2;
    // Position jitter is applied before velocity so the inward/outward
    // directions stay coherent with the jittered start point.
    const startX = jitterPosition(baseX + Math.cos(angle) * scatterRadius, size, rng);
    const startY = jitterPosition(baseY + Math.sin(angle) * scatterRadius, size, rng);

    // Inward velocity (toward centre).
    const dxIn = baseX - startX;
    const dyIn = baseY - startY;
    const distIn = Math.sqrt(dxIn * dxIn + dyIn * dyIn) || 1;
    const vxImpl = (dxIn / distIn) * implSpeed;
    const vyImpl = (dyIn / distIn) * implSpeed;

    // Outward burst velocity (opposite of starting angle).
    const burstAngle = angle + (rng() - 0.5) * EXPLOSION_BURST_ANGLE_SPREAD;
    const burstSpeed = burstSpeedBase + (rng() - 0.5) * 2 * burstSpeedSpread;

    const color = pickParticleColor(baseColor, i < coreCount, i === 0, rng);
    const frameOffset = rng();
    const rotation = rng() * Math.PI * 2;
    const startRadius = jitterSize(size * EXPLOSION_IMPLOSION_PARTICLE_RADIUS, rng);

    particles.push({
      x: startX,
      y: startY,
      vx: vxImpl,
      vy: vyImpl,
      color,
      zone: i < coreCount ? 'core' : 'lobe',
      frameOffset,
      rotation,
      alpha: 1,
      radius: startRadius,
      dead: false,
      fadeStep: 1 / EXPLOSION_LIFESPAN_MS,
      // Derived from the jittered radius so the particle still shrinks to 0.
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

// ── AC5: Per-type pattern assignment ─────────────────────────────

/** Entity type key for pattern assignment (matches entity module names). */
export type ExplosionEntityType =
  | 'scout'
  | 'diver'
  | 'tank'
  | 'phaser'
  | 'swarm'
  | 'boss'
  | 'player';

/**
 * Per-type pattern assignment — the single source of truth for which
 * explosion feel each entity gets. Single pattern = full count, two =
 * half each, three = third each (via `combinePatterns`).
 *
 * Tune the feel per enemy here; death paths only pass their type key.
 * Documented in GDD §7.2.
 */
export const EXPLOSION_PATTERNS_BY_TYPE: Record<ExplosionEntityType, Pattern[]> = {
  scout: ['radial'],
  diver: ['radial'],
  swarm: ['radial'],
  tank: ['radial', 'ring'],
  player: ['radial', 'ring'],
  phaser: ['ring', 'implosion'],
  boss: ['radial', 'ring', 'implosion'],
};

/**
 * Returns the assigned `Pattern[]` for an entity type from
 * `EXPLOSION_PATTERNS_BY_TYPE`. Unknown keys fall back to `['radial']`
 * (never throws — a missing entry must not break a death path).
 */
export function resolvePatterns(type: string): Pattern[] {
  const patterns = (EXPLOSION_PATTERNS_BY_TYPE as Record<string, Pattern[]>)[type];
  return patterns ? [...patterns] : ['radial'];
}

// ── Phaser integration (thin rendering layer) ────────────────────

/**
 * Implosion phase duration in ms — particles drift inward for this long
 * before switching to outward burst velocity.
 */
export const EXPLOSION_IMPLOSION_MS = 100;

/** The kind of entity a burst belongs to, for the shared live-counter registry. */
export type ExplosionVfxKind = 'enemy' | 'boss' | 'player';

/** Live per-kind explosion-VFX counts (the single registry of §8.5). */
export interface ExplosionVfxCounts {
  readonly enemy: number;
  readonly boss: number;
  readonly player: number;
}

/** Module-level live counts, shared by the game and every gym. */
const EXPLOSION_VFX_COUNTS: { enemy: number; boss: number; player: number } = {
  enemy: 0,
  boss: 0,
  player: 0,
};

/**
 * Returns a snapshot of the live per-kind explosion-VFX counts.
 *
 * This is the **single** count-able registry for enemy/boss/player explosion
 * VFX (§8.5): every burst spawned through {@link spawnExplosionParticles} with
 * a `kind` increments the matching counter and decrements it when the burst
 * finishes, so a category can never be double-counted. Consumers (the
 * action-intensity metric) read it instead of re-counting VFX objects.
 */
export function getExplosionVfxCounts(): ExplosionVfxCounts {
  return { ...EXPLOSION_VFX_COUNTS };
}

/** Resets the shared explosion-VFX counts (run-scope reset / test seam). */
export function resetExplosionVfxCounts(): void {
  EXPLOSION_VFX_COUNTS.enemy = 0;
  EXPLOSION_VFX_COUNTS.boss = 0;
  EXPLOSION_VFX_COUNTS.player = 0;
}

/** Optional overrides for `spawnExplosionParticles`. */
export interface SpawnExplosionOptions {
  /** Which patterns to emit (default `['radial']`). */
  patterns?: Pattern[];
  /** Particle-count override (default `scaledCount(size)`). */
  count?: number;
  /** Lifespan override in ms (default `EXPLOSION_LIFESPAN_MS`). */
  lifespan?: number;
  /** PRNG seed override (default `Date.now()`-derived). */
  seed?: number;
  /**
   * Scale factor applied to the explosion geometry (particle radius,
   * speed, and count). Defaults to 1. A value of e.g. 10 produces the
   * "10x-scale" detonation used by the wave time-limit penalty
   * (AH-0MU7JTG9R002ZWA6).
   */
  scale?: number;
  /**
   * Delay (ms) before the burst starts animating. Defaults to 0. Used by
   * staggered firework sequences (`spawnVictoryFireworks`) and the mini-boss
   * death sweep so a whole multi-burst display can be scheduled up front with
   * deterministic timing, without per-burst timers.
   *
   * A delayed burst is **invisible until the delay elapses**: its display
   * container is created hidden and revealed by the tween's `onStart` (which
   * Phaser fires exactly when the delay expires and the animation begins), so
   * a burst never sits on screen fully-formed before it animates (producer
   * review AH-0MVVEI7FD004TR2M — "shown and then, after a delay, they
   * animate").
   */
  delay?: number;
  /**
   * Render depth of the burst display container. Defaults to 5 (above world
   * bodies, below the HUD). Firework sequences pass a UI-relative depth so the
   * burst can sit behind a screen's UI (negative) or below its HUD.
   */
  depth?: number;
  /**
   * Optional entity kind for the shared per-kind explosion-VFX counter
   * (§8.5). When set, the burst increments the matching counter on spawn and
   * decrements it on completion, so the metric reads a single source rather
   * than re-counting VFX objects.
   */
  kind?: ExplosionVfxKind;
  /**
   * Optional display registry (e.g. `playerExplosions`) — the handle's display
   * container is pushed here on spawn and spliced on completion, so a
   * SHUTDOWN handler can destroy leftovers exactly like the existing
   * ring/cross explosions.
   */
  registry?: { push(g: unknown): void; indexOf(g: unknown): number; splice(i: number, n: number): void };
  /**
   * Optional completion callback — fires exactly once, only when the burst
   * has finished animating (its tween `onComplete`), never on the spawn
   * frame and never on an explicit {@link ExplosionHandle.destroy} teardown.
   * Used by the mini-boss death sweep so the reward overlay waits for the
   * last burst (AH-0MVROEKMT005RVML).
   */
  onComplete?: () => void;
  /**
   * Optional texture provider for the procedural explosion frames. Defaults
   * to the scene's own texture manager (`scene.textures`). Unit tests inject a
   * recording double so frame generation stays headless and deterministic
   * (AC6).
   */
  textureProvider?: ExplosionTextureProvider;
}

/**
 * Live handle for a spawned explosion. Test seam: `particles` is the
 * pure simulated state, `graphics` the burst display container (a Phaser
 * `Container` of frame images) — destroyed on completion/teardown, and
 * `null` when the scene exposes no texture support (headless stub scene).
 */
export interface ExplosionHandle {
  /** The burst display container (destroyed on completion), or `null`. */
  readonly graphics: unknown;
  /** Pure simulated particle state (positions advance with the tween). */
  readonly particles: Particle[];
  /** Total particle count at spawn (for count assertions). */
  readonly totalCount: number;
  /** Patterns assigned (one entry per particle group). */
  readonly patterns: Pattern[];
  /** Destroys the burst display immediately (SHUTDOWN teardown path). */
  destroy(): void;
  /** Whether the explosion is still animating. */
  readonly alive: boolean;
}

/** A burst frame image (a `Phaser.GameObjects.Image` subset). */
export interface ExplosionFrameImage {
  setTexture(key: string): unknown;
  setPosition(x: number, y: number): unknown;
  setAlpha(alpha: number): unknown;
  setScale(scale: number): unknown;
  setRotation(rotation: number): unknown;
  setTint(color: number): unknown;
  destroy(): void;
}

/** The burst display container (a `Phaser.GameObjects.Container` subset). */
export interface ExplosionDisplayContainer {
  setDepth(depth: number): unknown;
  /** Container visibility — used to keep a delayed burst hidden until its animation starts. */
  setVisible?(visible: boolean): unknown;
  add(child: unknown): unknown;
  destroy(): void;
}

/**
 * Minimal Phaser surface needed by `spawnExplosionParticles`. Kept structural
 * (not `Phaser.Scene`) so unit tests can inject a double.
 *
 * `container` / `image` / `textures` are optional: a scene that exposes none of
 * them (a headless stub) still gets the full particle simulation, colour
 * zones, counters and teardown contract — it simply renders no display
 * objects. `tweens.add` takes `unknown` so a real `Phaser.Scene` (whose `add`
 * accepts a TweenBuilderConfig union) is structurally assignable.
 */
export interface ExplosionScene {
  add: {
    container?(x?: number, y?: number): ExplosionDisplayContainer;
    image?(x: number, y: number, texture: string): ExplosionFrameImage;
  };
  textures?: ExplosionTextureProvider;
  tweens: { add(cfg: unknown): unknown };
}

/**
 * Scale that maps a particle radius (px) onto the frame texture's edge, so a
 * particle image is exactly as wide as the particle's diameter.
 */
function imageScaleForRadius(radius: number): number {
  return (Math.max(0, radius) * 2) / EXPLOSION_TEXTURE_SIZE;
}

/**
 * Spawns a particle explosion at (x, y) on the given scene.
 * This is the Phaser-side entry point called from entity death paths.
 *
 * - Count defaults to `scaledCount(size)` (size-proportional, clamped).
 * - Particles are split across `opts.patterns` via `combinePatterns`.
 * - Each particle is an **image** of a procedurally generated explosion frame
 *   (see `./explosionTextures`), tinted with the particle colour from its
 *   colour zone (warm red/orange core vs entity-hued lobe, AC3), rotated by
 *   its seeded rotation and scaled to its (shrinking) radius.
 * - One tween over `lifespan` ms drives the burst: each onUpdate derives
 *   elapsed from a tweened clock (the same pattern the existing ring/cross
 *   explosions use), advances particle positions, flips implosion→burst at
 *   100 ms, and morphs every particle image's frame as a function of its
 *   normalised age (AC2) while it fades and shrinks.
 * - On completion the display container is destroyed and removed from
 *   `opts.registry` (if given) — the SHUTDOWN teardown pattern.
 *
 * Returns `null` when `scene` is missing (belt-and-braces null-scene
 * guard per AH-0MTPLHLZ3006MOC4).
 *
 * @param scene  — Phaser.Scene instance (for display objects/textures/tweens).
 * @param x      — X coordinate of the explosion centre.
 * @param y      — Y coordinate of the explosion centre.
 * @param baseColor — Hex colour of the exploding entity.
 * @param size   — Size of the exploding entity (affects count).
 * @param opts   — Optional overrides (patterns, count, lifespan, seed, registry).
 */
export function spawnExplosionParticles(
  scene: ExplosionScene | null | undefined,
  x: number,
  y: number,
  baseColor: number,
  size: number,
  opts: SpawnExplosionOptions = {},
): ExplosionHandle | null {
  if (!scene) return null;

  const kind = opts.kind;
  if (kind) EXPLOSION_VFX_COUNTS[kind] += 1;

  const patterns = opts.patterns ?? ['radial'];
  const scale = opts.scale ?? 1;
  const effSize = size * scale;
  const totalCount = opts.count ?? scaledCount(effSize);
  const lifespan = opts.lifespan ?? EXPLOSION_LIFESPAN_MS;
  const rng = createRng(opts.seed ?? Date.now());

  // Split the count across patterns (deterministic remainder).
  const counts = totalCount > 0 ? combinePatterns(patterns, totalCount) : [];

  // Generate particles for each pattern group (geometry scaled by `scale`).
  const particles: Particle[] = [];
  for (let i = 0; i < patterns.length; i++) {
    const count = counts[i];
    if (count <= 0) continue;
    const pattern = patterns[i];
    if (pattern === 'radial') {
      particles.push(...generateRadialBurst(count, 0, 0, effSize, baseColor, rng));
    } else if (pattern === 'ring') {
      particles.push(...generateRingBurst(count, 0, 0, effSize, baseColor, rng));
    } else {
      particles.push(...generateImplosionBurst(count, 0, 0, effSize, baseColor, rng));
    }
  }

  // Advance a particle group by `elapsedMs` (pure, exported for tests).
  const stepParticles = (elapsedMs: number): void => {
    const dt = elapsedMs / 1000;
    for (const p of particles) {
      // Implosion particles drift inward, then switch to burst velocity.
      if (p.phase === 'implosion' && elapsedMs >= EXPLOSION_IMPLOSION_MS) {
        p.phase = 'burst';
        p.vx = p.burstVx ?? p.vx;
        p.vy = p.burstVy ?? p.vy;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.alpha = Math.max(0, 1 - p.fadeStep * elapsedMs);
      const startRadius = p.fadeStep > 0 ? p.shrinkStep / p.fadeStep : p.radius;
      p.radius = Math.max(0, startRadius - p.shrinkStep * elapsedMs);
      p.dead = p.alpha <= 0 && p.radius <= 0;
    }
  };

  // ── Frame-textured display (AC1, AC2, AC7) ─────────────────────
  //
  // The frame family is generated once per game and shared by every burst
  // (never per particle). A scene without texture support keeps the pure
  // simulation but renders nothing (headless seam).
  const provider = opts.textureProvider ?? scene.textures;
  const display =
    typeof scene.add.container === 'function' ? scene.add.container(x, y) : null;
  display?.setDepth(opts.depth ?? 5);
  // A delayed burst must not sit on screen before its tween starts: the
  // defeat sweep and firework cascades schedule bursts up front at their own
  // `delay`, and a burst that appears fully-formed before animating reads as
  // "shown then animated" (producer review AH-0MVVEI7FD004TR2M). The display
  // stays hidden until the tween's `onStart`, which Phaser fires exactly when
  // the delay expires and the animation begins (`TweenBuilderConfig.onStart`:
  // a callback "when the tween starts playback, after any delays have
  // expired"). An immediate burst (delay 0) is unchanged: visible from spawn.
  const delayMs = opts.delay ?? 0;
  const hiddenUntilStart = display !== null && delayMs > 0;
  if (hiddenUntilStart) display?.setVisible?.(false);
  ensureExplosionFrameTextures(provider);
  const framesReady =
    display !== null &&
    typeof scene.add.image === 'function' &&
    explosionFramesAvailable(provider);

  const images: ExplosionFrameImage[] = [];
  const lastFrame: number[] = [];
  if (display && framesReady) {
    for (const p of particles) {
      const frame = frameIndexFor(0, p.frameOffset);
      const image = scene.add.image!(p.x, p.y, explosionFrameKey(frame));
      image.setTint(p.color);
      image.setAlpha(p.alpha);
      image.setScale(imageScaleForRadius(p.radius));
      image.setRotation(p.rotation);
      display.add(image);
      images.push(image);
      lastFrame.push(frame);
    }
  }

  let alive = true;
  let lastElapsed = 0;
  /** The driving tween, so teardown can stop it (see `finish`). */
  let tween: { stop?: () => void } | undefined;

  /** Morphs, tints and positions every particle image for `elapsed` ms. */
  const draw = (elapsed: number): void => {
    // A destroyed burst has no display objects left to touch; its tween is
    // removed in `finish`, but a frame may already be in flight.
    if (!alive || images.length === 0) return;
    const age = lifespan > 0 ? elapsed / lifespan : 1;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const image = images[i];
      const frame = frameIndexFor(age, p.frameOffset);
      if (frame !== lastFrame[i]) {
        image.setTexture(explosionFrameKey(frame));
        lastFrame[i] = frame;
      }
      image.setPosition(p.x, p.y);
      image.setAlpha(p.alpha);
      image.setScale(imageScaleForRadius(p.radius));
    }
  };

  const finish = (): void => {
    if (!alive) return;
    alive = false;
    // Stop the driver before the display objects go away: an onUpdate that
    // lands after teardown would otherwise touch destroyed images.
    tween?.stop?.();
    display?.destroy();
    if (display && opts.registry) {
      const idx = opts.registry.indexOf(display);
      if (idx >= 0) opts.registry.splice(idx, 1);
    }
    if (kind && EXPLOSION_VFX_COUNTS[kind] > 0) {
      EXPLOSION_VFX_COUNTS[kind] -= 1;
    }
  };

  // Natural-completion seam: fires exactly once, only when the burst
  // animates to the end. An explicit `destroy()` teardown (SHUTDOWN path)
  // must never notify a waiting caller.
  let notified = false;
  const notifyComplete = (): void => {
    if (notified) return;
    notified = true;
    opts.onComplete?.();
  };

  if (display && opts.registry) opts.registry.push(display);

  const handle: ExplosionHandle = {
    graphics: display,
    particles,
    totalCount: particles.length,
    patterns: [...patterns],
    destroy: () => { if (alive) finish(); },
    get alive(): boolean { return alive; },
  };

  if (particles.length === 0) {
    // Nothing to animate — clean up immediately.
    finish();
    return handle;
  }

  // The tween clock: `alpha` walks 1 → 0 over the lifespan and elapsed is
  // derived from it (robust to headless timer quirks). Kept separate from the
  // display so the per-particle alpha fade is the only fade applied.
  const clock = { alpha: 1 };
  tween = scene.tweens.add({
    targets: clock,
    alpha: { from: 1, to: 0 },
    duration: lifespan,
    delay: delayMs,
    onStart: hiddenUntilStart
      ? () => {
          // Reveal exactly when the animation begins. A burst destroyed during
          // its delay (scene teardown) must never be re-shown by a late
          // `onStart` — the alive guard keeps the teardown contract intact.
          if (alive && display) display.setVisible?.(true);
        }
      : undefined,
    onUpdate: () => {
      const elapsed = (1 - clock.alpha) * lifespan;
      // Incremental stepping keeps velocities linear in wall-clock time.
      const step = Math.max(0, elapsed - lastElapsed);
      if (step > 0) {
        const dt = step / 1000;
        for (const p of particles) {
          if (p.phase === 'implosion' && elapsed >= EXPLOSION_IMPLOSION_MS) {
            p.phase = 'burst';
            p.vx = p.burstVx ?? p.vx;
            p.vy = p.burstVy ?? p.vy;
          }
          p.x += p.vx * dt;
          p.y += p.vy * dt;
        }
        // Alpha/radius are absolute functions of elapsed (not incremental).
        for (const p of particles) {
          p.alpha = Math.max(0, 1 - p.fadeStep * elapsed);
          const startRadius = p.fadeStep > 0 ? p.shrinkStep / p.fadeStep : p.radius;
          p.radius = Math.max(0, startRadius - p.shrinkStep * elapsed);
          p.dead = p.alpha <= 0 && p.radius <= 0;
        }
        lastElapsed = elapsed;
      }
      draw(elapsed);
    },
    onComplete: () => {
      const finishedAnimating = alive;
      finish();
      if (finishedAnimating) notifyComplete();
    },
  }) as { stop?: () => void } | undefined;

  // Expose the stepper for headless verification (not part of the VFX path).
  (handle as { _stepForTests?: (ms: number) => void })._stepForTests = stepParticles;

  return handle;
}
