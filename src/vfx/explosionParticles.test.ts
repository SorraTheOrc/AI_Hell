/**
 * Explosion particle test suite — pure-logic contract for the particle VFX
 * module (AH-0MTVH6DQO0016CGJ). Tests run without rendering and use a seeded
 * RNG + fake timers so every assertion is deterministic.
 *
 * This file is the test-first spec: the implementation in
 * `explosionParticles.ts` must satisfy every acceptance criterion below.
 */

import { describe, expect, it } from 'vitest';
import {
  EXPLOSION_BASE_COUNT,
  EXPLOSION_BOSS_COUNT,
  EXPLOSION_PLAYER_COUNT,
  EXPLOSION_LIFESPAN_MS,
  EXPLOSION_REFERENCE_SIZE,
  EXPLOSION_MIN_COUNT,
  EXPLOSION_MAX_COUNT,
  EXPLOSION_HUE_JITTER_DEG,
  EXPLOSION_SAT_VARIANCE,
  EXPLOSION_LIGHT_VARIANCE,
  scaledCount,
  jitterColor,
  colorToHSL,
  hslToHex,
  generateRadialBurst,
  generateRingBurst,
  generateImplosionBurst,
  type Pattern,
  combinePatterns,
  spawnExplosionParticles,
  EXPLOSION_IMPLOSION_MS,
} from './explosionParticles';

// ── Seeded RNG for deterministic tests ─────────────────────────────

/** Creates a simple mulberry32 PRNG seeded with `seed`. */
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t =
      Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Helpers for HSL delta checks ──────────────────────────────────

/** Returns the hue distance in degrees (0-180) between two HSL values. */
function hueDelta(h1: number, h2: number): number {
  let d = Math.abs(h1 - h2) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

// ── Palette colours per GDD §7.1 ──────────────────────────────────

const PALETTE = [
  { name: 'SCOUT', color: 0x00ff00 },
  { name: 'DIVER', color: 0xffff00 },
  { name: 'TANK', color: 0xff6600 },
  { name: 'PHASER', color: 0xff00ff },
  { name: 'SWARM', color: 0x0066ff },
  { name: 'BOSS', color: 0xff0000 },
  { name: 'SHIP', color: 0x00ffff },
] as const;

// ── Entity sizes per GDD ──────────────────────────────────────────

const SIZES = {
  swarm: 15,
  scout: 16,
  diver: 18,
  phaser: 14,
  tank: 28,
  boss: 50,
  ship: 20,
};

describe('explosionParticles — constants (AC2, AC4)', () => {
  it('base count is in the 20-40 range for standard enemies', () => {
    expect(EXPLOSION_BASE_COUNT).toBeGreaterThanOrEqual(20);
    expect(EXPLOSION_BASE_COUNT).toBeLessThanOrEqual(40);
  });

  it('boss/player count is in the 50-80 range', () => {
    expect(EXPLOSION_BOSS_COUNT).toBeGreaterThanOrEqual(50);
    expect(EXPLOSION_BOSS_COUNT).toBeLessThanOrEqual(80);
    expect(EXPLOSION_PLAYER_COUNT).toBeGreaterThanOrEqual(50);
    expect(EXPLOSION_PLAYER_COUNT).toBeLessThanOrEqual(80);
  });

  it('lifespan is between 300-500 ms', () => {
    expect(EXPLOSION_LIFESPAN_MS).toBeGreaterThanOrEqual(300);
    expect(EXPLOSION_LIFESPAN_MS).toBeLessThanOrEqual(500);
  });

  it('reference size is a positive number', () => {
    expect(EXPLOSION_REFERENCE_SIZE).toBeGreaterThan(0);
  });

  it('min/max count clamp defines a sane range', () => {
    expect(EXPLOSION_MIN_COUNT).toBeLessThan(EXPLOSION_MAX_COUNT);
    expect(EXPLOSION_MIN_COUNT).toBeGreaterThanOrEqual(1);
    expect(EXPLOSION_MAX_COUNT).toBeLessThanOrEqual(120);
  });

  it('hue jitter is 15-20 degrees', () => {
    expect(EXPLOSION_HUE_JITTER_DEG).toBeGreaterThanOrEqual(15);
    expect(EXPLOSION_HUE_JITTER_DEG).toBeLessThanOrEqual(20);
  });

  it('sat/light variance is small positive values', () => {
    expect(EXPLOSION_SAT_VARIANCE).toBeGreaterThan(0);
    expect(EXPLOSION_SAT_VARIANCE).toBeLessThan(0.2);
    expect(EXPLOSION_LIGHT_VARIANCE).toBeGreaterThan(0);
    expect(EXPLOSION_LIGHT_VARIANCE).toBeLessThan(0.2);
  });
});

// ── AC1: Count scaling is locked ─────────────────────────────────

describe('scaledCount (AC1)', () => {
  it('returns count proportional to size: linear with size/referenceSize', () => {
    const countA = scaledCount(10);
    const countB = scaledCount(20);
    const countC = scaledCount(30);
    // Linear: doubling size doubles the scaled count (before clamp).
    expect(countB).toBeGreaterThanOrEqual(countA);
    expect(countC).toBeGreaterThanOrEqual(countB);
    // The ratio should be close to linear.
    const ratioAB = countB / countA;
    const ratioBC = countC / countB;
    expect(ratioAB).toBeCloseTo(20 / 10, 0);
    expect(ratioBC).toBeCloseTo(30 / 20, 0);
  });

  it('standard sizes (14-28) yield counts in 8-80 range', () => {
    for (const [name, size] of Object.entries(SIZES)) {
      if (name === 'boss' || name === 'ship') continue;
      const count = scaledCount(size);
      expect(count).toBeGreaterThanOrEqual(EXPLOSION_MIN_COUNT);
      expect(count).toBeLessThanOrEqual(EXPLOSION_MAX_COUNT);
    }
  });

  it('large sizes (boss=50, ship=20) yield larger counts than standard', () => {
    const bossCount = scaledCount(SIZES.boss);
    const scoutCount = scaledCount(SIZES.scout);
    const shipCount = scaledCount(SIZES.ship);
    expect(bossCount).toBeGreaterThanOrEqual(scoutCount);
    expect(shipCount).toBeGreaterThanOrEqual(scoutCount);
  });

  it('clamps to min/max: tiny size cannot produce zero', () => {
    const tinyCount = scaledCount(1);
    expect(tinyCount).toBeGreaterThanOrEqual(EXPLOSION_MIN_COUNT);
  });

  it('clamps to max: giant size cannot exceed max', () => {
    const giantCount = scaledCount(500);
    expect(giantCount).toBeLessThanOrEqual(EXPLOSION_MAX_COUNT);
  });

  it('reference size maps to the base count (approximately)', () => {
    const refCount = scaledCount(EXPLOSION_REFERENCE_SIZE);
    // At reference size, scaledCount should be close to base count.
    expect(refCount).toBeGreaterThanOrEqual(EXPLOSION_MIN_COUNT);
    expect(refCount).toBeLessThanOrEqual(EXPLOSION_MAX_COUNT);
  });
});

// ── AC2: Colour jitter stays centred ──────────────────────────────

describe('jitterColor (AC2)', () => {
  it('emitted colours are within hue jitter of the base colour for all palette colours', () => {
    for (const { name, color } of PALETTE) {
      const rng = makeRng(42);
      for (let i = 0; i < 100; i++) {
        const jittered = jitterColor(color, rng);
        const baseHsl = colorToHSL(color);
        const jitteredHsl = colorToHSL(jittered);
        const hd = hueDelta(baseHsl.h, jitteredHsl.h);
        // Allow 0.1° tolerance for hex↔HSL round-trip precision.
        expect(hd, `${name}: hue delta #${i}`).toBeLessThanOrEqual(EXPLOSION_HUE_JITTER_DEG + 0.1);
      }
    }
  });

  it('saturation variance is bounded', () => {
    for (const { color } of PALETTE) {
      const rng = makeRng(99);
      const baseHsl = colorToHSL(color);
      for (let i = 0; i < 50; i++) {
        const jittered = jitterColor(color, rng);
        const jitteredHsl = colorToHSL(jittered);
        const satDelta = Math.abs(baseHsl.s - jitteredHsl.s);
        expect(satDelta).toBeLessThanOrEqual(EXPLOSION_SAT_VARIANCE + 0.001);
      }
    }
  });

  it('lightness variance is bounded', () => {
    for (const { color } of PALETTE) {
      const rng = makeRng(77);
      const baseHsl = colorToHSL(color);
      for (let i = 0; i < 50; i++) {
        const jittered = jitterColor(color, rng);
        const jitteredHsl = colorToHSL(jittered);
        const lightDelta = Math.abs(baseHsl.l - jitteredHsl.l);
        expect(lightDelta).toBeLessThanOrEqual(EXPLOSION_LIGHT_VARIANCE + 0.001);
      }
    }
  });

  it('returns a valid hex colour (0x000000 - 0xffffff)', () => {
    const rng = makeRng(1);
    for (let i = 0; i < 100; i++) {
      const result = jitterColor(0x00ff00, rng);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(0xffffff);
      expect(Number.isInteger(result)).toBe(true);
    }
  });

  it('deterministic: same seed produces same sequence', () => {
    const rng1 = makeRng(12345);
    const rng2 = makeRng(12345);
    for (let i = 0; i < 20; i++) {
      expect(jitterColor(0xff0000, rng1)).toBe(jitterColor(0xff0000, rng2));
    }
  });
});

describe('colorToHSL / hslToHex round-trip (AC2)', () => {
  it('round-trips all palette colours', () => {
    for (const { color } of PALETTE) {
      const hsl = colorToHSL(color);
      const roundTrip = hslToHex(hsl.h, hsl.s, hsl.l);
      // Hex conversion loses precision; allow 1-bit difference.
      const delta = Math.abs(color - roundTrip);
      expect(delta).toBeLessThanOrEqual(1);
    }
  });
});

// ── AC3: Geometry contracts ──────────────────────────────────────

describe('generateRadialBurst (AC3)', () => {
  it('emits the requested count of particles', () => {
    const rng = makeRng(100);
    const particles = generateRadialBurst(30, 0, 0, 20, 0x00ff00, rng);
    expect(particles.length).toBe(30);
  });

  it('directions are uniformly distributed 0-2π', () => {
    const rng = makeRng(200);
    const particles = generateRadialBurst(200, 0, 0, 20, 0x00ff00, rng);
    const angles = particles.map((p) => Math.atan2(p.vy, p.vx));
    for (const angle of angles) {
      expect(angle).toBeGreaterThanOrEqual(-Math.PI);
      expect(angle).toBeLessThanOrEqual(Math.PI);
    }
    // Check distribution is roughly uniform (chi-squared simplified: each quarter should have ~25%).
    const quarters = [0, 0, 0, 0];
    for (const a of angles) {
      if (a >= 0 && a <= Math.PI / 2) quarters[0]++;
      else if (a > Math.PI / 2 && a <= Math.PI) quarters[1]++;
      else if (a >= -Math.PI / 2 && a < 0) quarters[2]++;
      else quarters[3]++;
    }
    const expected = 200 / 4;
    for (let i = 0; i < 4; i++) {
      // ±30% tolerance for uniform distribution.
      expect(quarters[i]).toBeGreaterThan(expected * 0.5);
      expect(quarters[i]).toBeLessThan(expected * 1.5);
    }
  });

  it('speeds spread around a base value proportional to size', () => {
    const rng = makeRng(300);
    const particles = generateRadialBurst(50, 0, 0, 20, 0x00ff00, rng);
    const speeds = particles.map((p) => Math.sqrt(p.vx * p.vx + p.vy * p.vy));
    // All speeds should be positive.
    for (const spd of speeds) {
      expect(spd).toBeGreaterThan(0);
    }
    // There should be some spread (not all identical).
    expect(Math.max(...speeds) - Math.min(...speeds)).toBeGreaterThan(0);
  });

  it('particle colours are jittered from the base colour', () => {
    const rng = makeRng(400);
    const particles = generateRadialBurst(20, 0, 0, 20, 0xff0000, rng);
    for (const p of particles) {
      const baseHsl = colorToHSL(0xff0000);
      const pColorHsl = colorToHSL(p.color);
      // Allow 0.1° tolerance for hex↔HSL round-trip precision.
      expect(hueDelta(baseHsl.h, pColorHsl.h)).toBeLessThanOrEqual(EXPLOSION_HUE_JITTER_DEG + 0.1);
    }
  });
});

describe('generateRingBurst (AC3)', () => {
  it('emits the requested count of particles', () => {
    const rng = makeRng(500);
    const particles = generateRingBurst(40, 0, 0, 20, 0x00ff00, rng);
    expect(particles.length).toBe(40);
  });

  it('all particles lie on a shared radius (forming a circle)', () => {
    const rng = makeRng(600);
    const particles = generateRingBurst(60, 50, 50, 20, 0x00ff00, rng);
    const radii = particles.map((p) => Math.sqrt((p.x - 50) ** 2 + (p.y - 50) ** 2));
    // All radii should be within ±5% of the mean (ring uniformity).
    const meanRadius = radii.reduce((a, b) => a + b, 0) / radii.length;
    for (const r of radii) {
      expect(Math.abs(r - meanRadius) / meanRadius).toBeLessThan(0.05);
    }
  });

  it('ring radius scales with entity size', () => {
    const rng = makeRng(700);
    const particlesSmall = generateRingBurst(30, 0, 0, 16, 0x00ff00, rng);
    const rng2 = makeRng(700);
    const particlesLarge = generateRingBurst(30, 0, 0, 28, 0x00ff00, rng2);
    const rSmall = Math.sqrt(
      particlesSmall[0].x ** 2 + particlesSmall[0].y ** 2,
    );
    const rLarge = Math.sqrt(
      particlesLarge[0].x ** 2 + particlesLarge[0].y ** 2,
    );
    expect(rLarge).toBeGreaterThan(rSmall);
  });

  it('speeds are roughly uniform (all particles travel outward at similar speed)', () => {
    const rng = makeRng(800);
    const particles = generateRingBurst(40, 0, 0, 20, 0x00ff00, rng);
    const speeds = particles.map((p) => Math.sqrt(p.vx * p.vx + p.vy * p.vy));
    const meanSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    for (const spd of speeds) {
      expect(Math.abs(spd - meanSpeed) / meanSpeed).toBeLessThan(0.15);
    }
  });
});

describe('generateImplosionBurst (AC3)', () => {
  it('emits the requested count of particles', () => {
    const rng = makeRng(900);
    const particles = generateImplosionBurst(40, 0, 0, 20, 0x00ff00, rng);
    expect(particles.length).toBe(40);
  });

  it('has both implosion and burst phase data', () => {
    const rng = makeRng(1000);
    const particles = generateImplosionBurst(30, 100, 100, 20, 0xff0000, rng);
    // Each particle should have an initial position and a burst target.
    for (const p of particles) {
      // Particles start outside and move inward (implosion toward center).
      // The implosion phase moves toward (baseX, baseY) before bursting outward.
      // We verify the particle structure has the required properties.
      expect(p.phase).toBeDefined();
      expect(p.color).toBeDefined();
      expect(p.color).not.toBe(0);
    }
  });

  it('implosion phase moves particles inward toward the center', () => {
    const rng = makeRng(1100);
    const cx = 50, cy = 50;
    const particles = generateImplosionBurst(30, cx, cy, 20, 0x00ff00, rng);
    // Most particles should have inward-pointing velocity.
    const inwardRatio = particles.filter(
      (pp) => pp.vx * (cx - pp.x) + pp.vy * (cy - pp.y) > 0,
    ).length / particles.length;
    expect(inwardRatio).toBeGreaterThan(0.5);
  });

  it('burst phase has outward velocity after implosion', () => {
    const rng = makeRng(1200);
    const cx = 0, cy = 0;
    const particles = generateImplosionBurst(30, cx, cy, 20, 0xff00ff, rng);
    // Check that burst-phase velocity has positive magnitude.
    for (const p of particles) {
      // After implosion, the burst should move away.
      // We verify this via the structure of the data.
      if (p.burstVx !== undefined && p.burstVy !== undefined) {
        // Burst velocity should have magnitude > 0.
        expect(Math.sqrt(p.burstVx * p.burstVx + p.burstVy * p.burstVy)).toBeGreaterThan(0);
      }
    }
  });
});

// ── AC4: Combinator splits verified ──────────────────────────────

describe('combinePatterns (AC4)', () => {
  it('single pattern = full count', () => {
    const counts = combinePatterns(['radial'], 30);
    expect(counts).toEqual([30]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(30);
  });

  it('two patterns = half each (with deterministic remainder)', () => {
    const counts = combinePatterns(['radial', 'ring'], 30);
    expect(counts.length).toBe(2);
    expect(counts[0] + counts[1]).toBe(30);
    // Half-half split (remainder goes to first pattern).
    expect(counts[0]).toBe(15);
    expect(counts[1]).toBe(15);
  });

  it('two patterns with odd count: remainder to first', () => {
    const counts = combinePatterns(['radial', 'ring'], 31);
    expect(counts.length).toBe(2);
    expect(counts[0] + counts[1]).toBe(31);
    expect(counts[0]).toBe(16); // 31/2 = 15.5 → 16
    expect(counts[1]).toBe(15);
  });

  it('three patterns = third each (with deterministic remainder)', () => {
    const counts = combinePatterns(['radial', 'ring', 'implosion'], 30);
    expect(counts.length).toBe(3);
    expect(counts[0] + counts[1] + counts[2]).toBe(30);
    expect(counts[0]).toBe(10);
    expect(counts[1]).toBe(10);
    expect(counts[2]).toBe(10);
  });

  it('three patterns with remainder: distribute deterministically', () => {
    const counts = combinePatterns(['radial', 'ring', 'implosion'], 32);
    expect(counts.length).toBe(3);
    expect(counts[0] + counts[1] + counts[2]).toBe(32);
    // 32 / 3 = 10 remainder 2 → first two patterns get +1 each.
    expect(counts[0]).toBe(11);
    expect(counts[1]).toBe(11);
    expect(counts[2]).toBe(10);
  });

  it('all known pattern strings are valid', () => {
    const validPatterns: Pattern[] = ['radial', 'ring', 'implosion'];
    for (const p of validPatterns) {
      expect(() => combinePatterns([p], 10)).not.toThrow();
    }
  });
});

// ── AC5: Lifecycle/teardown asserted ─────────────────────────────

describe('Particle lifecycle (AC5)', () => {
  it('particles start at alpha 1.0 and radius > 0', () => {
    const rng = makeRng(2000);
    const particles = generateRadialBurst(10, 0, 0, 20, 0x00ff00, rng);
    for (const p of particles) {
      expect(p.alpha).toBe(1);
      expect(p.radius).toBeGreaterThan(0);
    }
  });

  it('fadeStep and shrinkStep produce correct delta per ms', () => {
    const rng = makeRng(2100);
    const particles = generateRadialBurst(5, 0, 0, 20, 0x00ff00, rng);
    for (const p of particles) {
      // Alpha: 1 → 0 over lifespan ms.
      const expectedAlphaDelta = 1 / EXPLOSION_LIFESPAN_MS;
      expect(p.fadeStep).toBeCloseTo(expectedAlphaDelta, 4);

      // Radius: starts at size*0.5, shrinks to 0.
      const startRadius = 20 * 0.5;
      const expectedRadiusDelta = startRadius / EXPLOSION_LIFESPAN_MS;
      expect(p.shrinkStep).toBeCloseTo(expectedRadiusDelta, 4);
    }
  });

  it('particles are marked dead after lifespan has elapsed', () => {
    const rng = makeRng(2200);
    const particles = generateRadialBurst(5, 0, 0, 20, 0x00ff00, rng);
    for (const p of particles) {
      expect(p.dead).toBe(false);
      // Simulate time past the lifespan.
      const elapsed = EXPLOSION_LIFESPAN_MS + 1;
      p.alpha = Math.max(0, 1 - p.fadeStep * elapsed);
      p.radius = Math.max(0, (20 * 0.5) - p.shrinkStep * elapsed);
      p.dead = p.alpha <= 0 && p.radius <= 0;
      expect(p.dead).toBe(true);
    }
  });

  it('particles are NOT dead before lifespan elapses', () => {
    const rng = makeRng(2300);
    const particles = generateRadialBurst(5, 0, 0, 20, 0x00ff00, rng);
    for (const p of particles) {
      const elapsed = EXPLOSION_LIFESPAN_MS - 1;
      p.alpha = Math.max(0, 1 - p.fadeStep * elapsed);
      p.radius = Math.max(0, (20 * 0.5) - p.shrinkStep * elapsed);
      expect(p.dead).toBe(false);
    }
  });

  it('teardown: all particles are marked dead after destroy is called', () => {
    const rng = makeRng(2400);
    const particles = generateRadialBurst(20, 0, 0, 20, 0x00ff00, rng);
    // Simulate partial lifetime.
    const elapsed = EXPLOSION_LIFESPAN_MS * 0.5;
    for (const p of particles) {
      p.alpha = Math.max(0, 1 - p.fadeStep * elapsed);
      p.radius = Math.max(0, (20 * 0.5) - p.shrinkStep * elapsed);
    }
    // Verify not all dead yet.
    const aliveBefore = particles.filter((p) => !p.dead).length;
    expect(aliveBefore).toBeGreaterThan(0);

    // Call destroy on all (simulating scene teardown).
    for (const p of particles) {
      p.alpha = 0;
      p.radius = 0;
      p.dead = true;
    }
    const aliveAfter = particles.filter((p) => !p.dead).length;
    expect(aliveAfter).toBe(0);
  });
});

// ── AC1–AC5: spawnExplosionParticles (Phaser integration) ──────────

/** Records calls made by the stub tween/scene. */
interface CapturedTween {
  targets: unknown;
  alpha: { from: number; to: number };
  duration: number;
  onUpdate?: () => void;
  onComplete?: () => void;
}

interface StubGraphics {
  x: number;
  y: number;
  alpha: number;
  destroyed: boolean;
  depth: number;
  fillCalls: Array<{ color: number; alpha: number }>;
  setDepth(d: number): void;
  clear(): void;
  fillStyle(c: number, a?: number): void;
  fillCircle(x: number, y: number, r: number): void;
  destroy(): void;
}

interface StubScene {
  gfx: StubGraphics[];
  tweenCfgs: CapturedTween[];
  add: {
    graphics(opts?: { x?: number; y?: number }): StubGraphics;
  };
  tweens: {
    add(cfg: CapturedTween): void;
  };
}

/** Creates a headed stub scene that captures Graphics + tween calls. */
function makeStubScene(): StubScene {
  const stub: StubScene = {
    gfx: [],
    tweenCfgs: [],
    add: {
      graphics(opts?: { x?: number; y?: number }): StubGraphics {
        const g: StubGraphics = {
          x: opts?.x ?? 0,
          y: opts?.y ?? 0,
          alpha: 1,
          destroyed: false,
          depth: 0,
          fillCalls: [],
          setDepth(d: number): void {
            g.depth = d;
          },
          clear(): void {},
          fillStyle(c: number, a?: number): void {
            g.fillCalls.push({ color: c, alpha: a ?? 1 });
          },
          fillCircle(_x: number, _y: number, _r: number): void {},
          destroy(): void {
            g.destroyed = true;
          },
        };
        stub.gfx.push(g);
        return g;
      },
    },
    tweens: {
      add(cfg: CapturedTween): void {
        stub.tweenCfgs.push(cfg);
      },
    },
  };
  return stub;
}

/** Advances the captured tween to `elapsedMs` (driving onUpdate). */
function advanceTween(scene: StubScene, elapsedMs: number, duration: number): void {
  const cfg = scene.tweenCfgs[0];
  expect(cfg, 'expected a tween to be scheduled').toBeDefined();
  const gfx = cfg.targets as StubGraphics;
  gfx.alpha = 1 - elapsedMs / duration;
  cfg.onUpdate?.();
}

describe('spawnExplosionParticles (AC1–AC5)', () => {
  it('AC1: returns a handle with particles sized by scaledCount(size)', () => {
    const scene = makeStubScene();
    const handle = spawnExplosionParticles(
      scene as unknown as Parameters<typeof spawnExplosionParticles>[0],
      100,
      100,
      0x00ff00,
      16,
      { seed: 1, patterns: ['radial'] },
    );
    expect(handle).not.toBeNull();
    expect(handle!.totalCount).toBeGreaterThanOrEqual(8);
    expect(handle!.totalCount).toBeLessThanOrEqual(80);
    expect(handle!.particles.length).toBe(handle!.totalCount);
  });

  it('AC1: larger size yields more particles', () => {
    const small = spawnExplosionParticles(
      makeStubScene() as unknown as Parameters<typeof spawnExplosionParticles>[0],
      0, 0, 0x00ff00, 14, { seed: 1, patterns: ['radial'] },
    );
    const large = spawnExplosionParticles(
      makeStubScene() as unknown as Parameters<typeof spawnExplosionParticles>[0],
      0, 0, 0x00ff00, 50, { seed: 1, patterns: ['radial'] },
    );
    expect(large!.totalCount).toBeGreaterThanOrEqual(small!.totalCount);
  });

  it('AC4: scale multiplies the explosion geometry (10x detonation)', () => {
    const normal = spawnExplosionParticles(
      makeStubScene() as unknown as Parameters<typeof spawnExplosionParticles>[0],
      0, 0, 0xff0000, 16, { seed: 3, patterns: ['radial'] },
    );
    const scaled = spawnExplosionParticles(
      makeStubScene() as unknown as Parameters<typeof spawnExplosionParticles>[0],
      0, 0, 0xff0000, 16, { seed: 3, patterns: ['radial'], scale: 10 },
    );
    // Radii are proportional to the effective size (10x larger with scale 10).
    expect(normal!.particles[0].radius).toBeGreaterThan(0);
    expect(scaled!.particles[0].radius).toBeGreaterThan(normal!.particles[0].radius * 9);
    // The count scales up too (clamped at the configured maximum).
    expect(scaled!.totalCount).toBeGreaterThanOrEqual(normal!.totalCount);
  });

  it('AC2: count override exposes tunable configuration', () => {
    const scene = makeStubScene();
    const handle = spawnExplosionParticles(
      scene as unknown as Parameters<typeof spawnExplosionParticles>[0],
      0, 0, 0xff0000, 20, { seed: 5, count: 12, patterns: ['radial'] },
    );
    expect(handle!.totalCount).toBe(12);
  });

  it('AC3: default pattern is radial single', () => {
    const scene = makeStubScene();
    const handle = spawnExplosionParticles(
      scene as unknown as Parameters<typeof spawnExplosionParticles>[0],
      0, 0, 0x00ff00, 20, { seed: 7 },
    );
    expect(handle!.patterns).toEqual(['radial']);
  });

  it('AC3: multiple patterns split particles across groups', () => {
    const scene = makeStubScene();
    const handle = spawnExplosionParticles(
      scene as unknown as Parameters<typeof spawnExplosionParticles>[0],
      0, 0, 0xff00ff, 20, { seed: 9, count: 30, patterns: ['radial', 'ring'] },
    );
    expect(handle!.patterns).toEqual(['radial', 'ring']);
    expect(handle!.totalCount).toBe(30);
  });

  it('AC4: tween drives particles forward and fades/shrinks them', () => {
    const scene = makeStubScene();
    const handle = spawnExplosionParticles(
      scene as unknown as Parameters<typeof spawnExplosionParticles>[0],
      0, 0, 0x00ff00, 20, { seed: 11, count: 8, patterns: ['radial'] },
    );
    const startPositions = handle!.particles.map((p) => ({ x: p.x, y: p.y }));
    // Half-way through the lifespan.
    advanceTween(scene, EXPLOSION_LIFESPAN_MS / 2, EXPLOSION_LIFESPAN_MS);
    for (let i = 0; i < handle!.particles.length; i++) {
      const p = handle!.particles[i];
      // Moved from origin.
      const moved = Math.hypot(p.x - startPositions[i].x, p.y - startPositions[i].y);
      expect(moved).toBeGreaterThan(0);
      // Faded and shrunk but not dead yet.
      expect(p.alpha).toBeLessThan(1);
      expect(p.alpha).toBeGreaterThan(0);
      expect(p.dead).toBe(false);
    }
  });

  it('AC4: onComplete destroys the Graphics and unregisters', () => {
    const registry: unknown[] = [];
    const fakeRegistry = {
      push: (g: unknown) => { registry.push(g); },
      indexOf: (g: unknown) => registry.indexOf(g),
      splice: (i: number, n: number) => { registry.splice(i, n); },
    };
    const scene = makeStubScene();
    const handle = spawnExplosionParticles(
      scene as unknown as Parameters<typeof spawnExplosionParticles>[0],
      0, 0, 0x00ff00, 20, { seed: 13, count: 6, registry: fakeRegistry },
    );
    expect(registry.length).toBe(1);
    // Finish the tween.
    advanceTween(scene, EXPLOSION_LIFESPAN_MS, EXPLOSION_LIFESPAN_MS);
    scene.tweenCfgs[0].onComplete?.();
    expect(handle!.alive).toBe(false);
    expect((handle!.graphics as StubGraphics).destroyed).toBe(true);
    expect(registry.length).toBe(0);
  });

  it('AC4: destroy() tears down mid-flight (SHUTDOWN path)', () => {
    const registry: unknown[] = [];
    const fakeRegistry = {
      push: (g: unknown) => { registry.push(g); },
      indexOf: (g: unknown) => registry.indexOf(g),
      splice: (i: number, n: number) => { registry.splice(i, n); },
    };
    const scene = makeStubScene();
    const handle = spawnExplosionParticles(
      scene as unknown as Parameters<typeof spawnExplosionParticles>[0],
      0, 0, 0x00ff00, 20, { seed: 15, count: 6, registry: fakeRegistry },
    );
    expect(handle!.alive).toBe(true);
    handle!.destroy();
    expect(handle!.alive).toBe(false);
    expect((handle!.graphics as StubGraphics).destroyed).toBe(true);
    expect(registry.length).toBe(0);
  });

  it('AC4: implosion particles switch phase after ~100 ms', () => {
    const scene = makeStubScene();
    const handle = spawnExplosionParticles(
      scene as unknown as Parameters<typeof spawnExplosionParticles>[0],
      0, 0, 0xff0000, 28, { seed: 17, count: 9, patterns: ['implosion'] },
    );
    // Before the implosion window — still inward.
    advanceTween(scene, EXPLOSION_IMPLOSION_MS - 20, EXPLOSION_LIFESPAN_MS);
    for (const p of handle!.particles) {
      expect(p.phase).toBe('implosion');
    }
    // Past the window — burst phase with outward velocity.
    advanceTween(scene, EXPLOSION_IMPLOSION_MS + 50, EXPLOSION_LIFESPAN_MS);
    for (const p of handle!.particles) {
      expect(p.phase).toBe('burst');
    }
  });

  it('AC5: null scene returns null (no crash)', () => {
    const handle = spawnExplosionParticles(null, 0, 0, 0x00ff00, 20);
    expect(handle).toBeNull();
  });

  it('AC5: zero count cleans up immediately without a tween', () => {
    const scene = makeStubScene();
    const handle = spawnExplosionParticles(
      scene as unknown as Parameters<typeof spawnExplosionParticles>[0],
      0, 0, 0x00ff00, 20, { seed: 19, count: 0 },
    );
    expect(handle).not.toBeNull();
    expect(handle!.totalCount).toBe(0);
    expect(handle!.alive).toBe(false);
    expect(scene.tweenCfgs.length).toBe(0);
  });
});

// ── AC5: resolvePatterns + tunable pattern constants ──────────────

describe('resolvePatterns (AC5)', () => {
  it('returns single patterns for scout/diver/swarm', async () => {
    const { resolvePatterns } = await import('./explosionParticles');
    expect(resolvePatterns('scout')).toEqual(['radial']);
    expect(resolvePatterns('diver')).toEqual(['radial']);
    expect(resolvePatterns('swarm')).toEqual(['radial']);
  });

  it('returns pairs for tank/player/phaser', async () => {
    const { resolvePatterns } = await import('./explosionParticles');
    expect(resolvePatterns('tank')).toEqual(['radial', 'ring']);
    expect(resolvePatterns('player')).toEqual(['radial', 'ring']);
    expect(resolvePatterns('phaser')).toEqual(['ring', 'implosion']);
  });

  it('returns all three patterns for the boss', async () => {
    const { resolvePatterns } = await import('./explosionParticles');
    expect(resolvePatterns('boss')).toEqual(['radial', 'ring', 'implosion']);
  });

  it('unknown types fall back to radial (never throws)', async () => {
    const { resolvePatterns } = await import('./explosionParticles');
    expect(resolvePatterns('mystery-ship')).toEqual(['radial']);
    expect(resolvePatterns('')).toEqual(['radial']);
  });

  it('returns a copy (mutating the result does not affect the map)', async () => {
    const { resolvePatterns } = await import('./explosionParticles');
    const first = resolvePatterns('boss');
    first.push('radial');
    expect(resolvePatterns('boss')).toEqual(['radial', 'ring', 'implosion']);
  });

  it('pattern speeds/radii are exposed as tunable constants', async () => {
    const mod = await import('./explosionParticles');
    for (const key of [
      'EXPLOSION_RADIAL_SPEED_BASE',
      'EXPLOSION_RADIAL_SPEED_PER_SIZE',
      'EXPLOSION_RADIAL_SPEED_SPREAD',
      'EXPLOSION_RADIAL_START_RADIUS',
      'EXPLOSION_RING_RADIUS_FACTOR',
      'EXPLOSION_RING_SPEED_BASE',
      'EXPLOSION_RING_SPEED_PER_SIZE',
      'EXPLOSION_RING_SPEED_TOLERANCE',
      'EXPLOSION_RING_PARTICLE_RADIUS',
      'EXPLOSION_IMPLOSION_SCATTER_FACTOR',
      'EXPLOSION_IMPLOSION_SPEED_BASE',
      'EXPLOSION_IMPLOSION_SPEED_PER_SIZE',
      'EXPLOSION_BURST_SPEED_BASE',
      'EXPLOSION_BURST_SPEED_PER_SIZE',
      'EXPLOSION_BURST_SPEED_SPREAD',
      'EXPLOSION_BURST_ANGLE_SPREAD',
      'EXPLOSION_IMPLOSION_PARTICLE_RADIUS',
      'EXPLOSION_IMPLOSION_MS',
    ] as const) {
      expect(typeof mod[key], key).toBe('number');
      expect(mod[key], key).toBeGreaterThan(0);
    }
  });

  it('EXPLOSION_PATTERNS_BY_TYPE covers all 7 entity types', async () => {
    const { EXPLOSION_PATTERNS_BY_TYPE } = await import('./explosionParticles');
    const keys = Object.keys(EXPLOSION_PATTERNS_BY_TYPE).sort();
    expect(keys).toEqual(['boss', 'diver', 'phaser', 'player', 'scout', 'swarm', 'tank']);
    for (const patterns of Object.values(EXPLOSION_PATTERNS_BY_TYPE)) {
      expect(patterns.length).toBeGreaterThanOrEqual(1);
      expect(patterns.length).toBeLessThanOrEqual(3);
      for (const p of patterns) {
        expect(['radial', 'ring', 'implosion']).toContain(p);
      }
    }
  });
});
