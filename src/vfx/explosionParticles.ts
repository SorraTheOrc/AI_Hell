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
  const startRadius = size * EXPLOSION_RADIAL_START_RADIUS;
  const speedBase = EXPLOSION_RADIAL_SPEED_BASE + size * EXPLOSION_RADIAL_SPEED_PER_SIZE;
  const speedSpread = speedBase * EXPLOSION_RADIAL_SPEED_SPREAD;

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
  const ringRadius = size * EXPLOSION_RING_RADIUS_FACTOR;
  const speedBase = EXPLOSION_RING_SPEED_BASE + size * EXPLOSION_RING_SPEED_PER_SIZE;
  const speedTolerance = speedBase * EXPLOSION_RING_SPEED_TOLERANCE;

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
      radius: size * EXPLOSION_RING_PARTICLE_RADIUS,
      dead: false,
      fadeStep: 1 / EXPLOSION_LIFESPAN_MS,
      shrinkStep: (size * EXPLOSION_RING_PARTICLE_RADIUS) / EXPLOSION_LIFESPAN_MS,
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
  const scatterRadius = size * EXPLOSION_IMPLOSION_SCATTER_FACTOR;
  const implSpeed = EXPLOSION_IMPLOSION_SPEED_BASE + size * EXPLOSION_IMPLOSION_SPEED_PER_SIZE;
  const burstSpeedBase = EXPLOSION_BURST_SPEED_BASE + size * EXPLOSION_BURST_SPEED_PER_SIZE;
  const burstSpeedSpread = burstSpeedBase * EXPLOSION_BURST_SPEED_SPREAD;

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
    const burstAngle = angle + (rng() - 0.5) * EXPLOSION_BURST_ANGLE_SPREAD;
    const burstSpeed = burstSpeedBase + (rng() - 0.5) * 2 * burstSpeedSpread;

    const color = jitterColor(baseColor, rng);
    const startRadius = size * EXPLOSION_IMPLOSION_PARTICLE_RADIUS;

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
   * Optional Graphics registry (e.g. `playerExplosions`) — the handle's
   * Graphics is pushed here on spawn and spliced on completion, so a
   * SHUTDOWN handler can destroy leftovers exactly like the existing
   * ring/cross explosions.
   */
  registry?: { push(g: unknown): void; indexOf(g: unknown): number; splice(i: number, n: number): void };
}

/** Live handle for a spawned explosion. Test seam: `particles` is the
 * pure simulated state, `graphics` the Phaser object (destroyed on
 * completion/teardown). */
export interface ExplosionHandle {
  /** The Phaser Graphics object (destroyed on completion). */
  readonly graphics: unknown;
  /** Pure simulated particle state (positions advance with the tween). */
  readonly particles: Particle[];
  /** Total particle count at spawn (for count assertions). */
  readonly totalCount: number;
  /** Patterns assigned (one entry per particle group). */
  readonly patterns: Pattern[];
  /** Destroys the Graphics immediately (SHUTDOWN teardown path). */
  destroy(): void;
  /** Whether the explosion is still animating. */
  readonly alive: boolean;
}

/** Minimal Phaser surface needed by `spawnExplosionParticles`. Kept
 * structural (not `Phaser.Scene`) so unit tests can inject a double.
 * `tweens.add` takes `unknown` so a real `Phaser.Scene` (whose `add`
 * accepts a TweenBuilderConfig union) is structurally assignable. */
export interface ExplosionScene {
  add: { graphics(opts?: { x?: number; y?: number }): { setDepth(d: number): unknown; clear(): unknown; fillStyle(c: number, a?: number): unknown; fillCircle(x: number, y: number, r: number): unknown; destroy(): void; alpha: number } };
  tweens: { add(cfg: unknown): unknown };
}

/**
 * Spawns a particle explosion at (x, y) on the given scene.
 * This is the Phaser-side entry point called from entity death paths.
 *
 * - Count defaults to `scaledCount(size)` (size-proportional, clamped).
 * - Particles are split across `opts.patterns` via `combinePatterns`.
 * - A single Graphics is animated by one tween over `lifespan` ms:
 *   each onUpdate derives elapsed from the tweened alpha (the same
 *   pattern the existing ring/cross explosions use), advances particle
 *   positions, flips implosion→burst at 100 ms, and redraws all live
 *   particles as small filled circles that fade and shrink.
 * - On completion the Graphics is destroyed and removed from
 *   `opts.registry` (if given) — the SHUTDOWN teardown pattern.
 *
 * Returns `null` when `scene` is missing (belt-and-braces null-scene
 * guard per AH-0MTPLHLZ3006MOC4).
 *
 * @param scene  — Phaser.Scene instance (for Graphics/tweens).
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

  const patterns = opts.patterns ?? ['radial'];
  const totalCount = opts.count ?? scaledCount(size);
  const lifespan = opts.lifespan ?? EXPLOSION_LIFESPAN_MS;
  const rng = createRng(opts.seed ?? Date.now());

  // Split the count across patterns (deterministic remainder).
  const counts = totalCount > 0 ? combinePatterns(patterns, totalCount) : [];

  // Generate particles for each pattern group.
  const particles: Particle[] = [];
  for (let i = 0; i < patterns.length; i++) {
    const count = counts[i];
    if (count <= 0) continue;
    const pattern = patterns[i];
    if (pattern === 'radial') {
      particles.push(...generateRadialBurst(count, 0, 0, size, baseColor, rng));
    } else if (pattern === 'ring') {
      particles.push(...generateRingBurst(count, 0, 0, size, baseColor, rng));
    } else {
      particles.push(...generateImplosionBurst(count, 0, 0, size, baseColor, rng));
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

  // Single Graphics for the whole burst (depth above bodies).
  const gfx = scene.add.graphics({ x, y });
  (gfx as { setDepth(d: number): unknown }).setDepth(5);

  let alive = true;
  let lastElapsed = 0;
  const draw = (): void => {
    gfx.clear();
    for (const p of particles) {
      if (p.dead || p.radius <= 0) continue;
      gfx.fillStyle(p.color, Math.max(0, Math.min(1, p.alpha)));
      gfx.fillCircle(p.x, p.y, Math.max(0.5, p.radius));
    }
  };

  const finish = (): void => {
    alive = false;
    gfx.destroy();
    if (opts.registry) {
      const idx = opts.registry.indexOf(gfx);
      if (idx >= 0) opts.registry.splice(idx, 1);
    }
  };

  if (opts.registry) opts.registry.push(gfx);

  const handle: ExplosionHandle = {
    graphics: gfx,
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

  scene.tweens.add({
    targets: gfx,
    alpha: { from: 1, to: 0 },
    duration: lifespan,
    onUpdate: () => {
      // Derive elapsed from the tweened property (existing explosion
      // pattern — robust to headless timer quirks).
      const alpha = (gfx as { alpha: number }).alpha;
      const elapsed = (1 - alpha) * lifespan;
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
      draw();
    },
    onComplete: () => { finish(); },
  });

  // Expose the stepper for headless verification (not part of the VFX path).
  (handle as { _stepForTests?: (ms: number) => void })._stepForTests = stepParticles;

  return handle;
}
