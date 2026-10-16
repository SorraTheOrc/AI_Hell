/**
 * Unit tests for the shared bullet-shape rendering seam
 * (AH-0MV8228MD009UBF7).
 *
 * The seam is the single, parity-safe place where a bullet's code-drawn
 * appearance is resolved from visual metadata and drawn into a Phaser
 * `Graphics` context. Both the game and every gym render through it, so its
 * behaviour is asserted here once:
 *
 * - `drawBulletShape` draws each supported shape primitive into a Graphics
 *   `commandBuffer` (the same flat-opcode technique as the power-up icon and
 *   Boss tests — the canvas is stubbed under CI by `src/test/setup.ts`).
 * - `resolvePlayerBulletVisual` derives a bullet's visual spec from a weapon
 *   definition (single source of truth = the catalogue).
 * - `resolveEnemyBulletVisual` looks up an enemy archetype's identity.
 *
 * The catalogue-wide *uniqueness* roster lives in
 * `src/utils/bulletVisualRoster.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import { PLAYER_BULLET_RADIUS } from '../core/constants';
import { WEAPON_CATALOGUE, type BulletShape } from './weapons';
import {
  drawBulletShape,
  canonicalShape,
  resolvePlayerBulletVisual,
  resolveEnemyBulletVisual,
  missileFlameLength,
  ENEMY_BULLET_IDENTITIES,
  DEFAULT_SHAPE_LENGTH,
} from './bulletVisuals';

let game: Phaser.Game | undefined;

afterEach(async () => {
  if (game) {
    await game.destroy(true);
    game = undefined;
  }
});

/** Minimal scene used only to allocate Graphics objects. */
class BareScene extends Phaser.Scene {
  constructor() {
    super('BulletVisualsBareScene');
  }
}

// ── Phaser Graphics command-opcode constants ──────────────────────

const Cmd = {
  ARC: 0,
  BEGIN_PATH: 1,
  CLOSE_PATH: 2,
  FILL_RECT: 3,
  LINE_TO: 4,
  MOVE_TO: 5,
  LINE_STYLE: 6,
  FILL_STYLE: 7,
  FILL_PATH: 8,
  STROKE_PATH: 9,
  FILL_TRIANGLE: 10,
  STROKE_TRIANGLE: 11,
} as const;

/** Parameter count following each opcode (0 for path terminators). */
const CmdWidths: Record<number, number> = {
  [Cmd.ARC]: 7,
  [Cmd.BEGIN_PATH]: 0,
  [Cmd.CLOSE_PATH]: 0,
  [Cmd.FILL_RECT]: 4,
  [Cmd.LINE_TO]: 2,
  [Cmd.MOVE_TO]: 2,
  [Cmd.LINE_STYLE]: 3,
  [Cmd.FILL_STYLE]: 2,
  [Cmd.FILL_PATH]: 0,
  [Cmd.STROKE_PATH]: 0,
  [Cmd.FILL_TRIANGLE]: 6,
  [Cmd.STROKE_TRIANGLE]: 6,
};

/** Counts occurrences of a command opcode in a Graphics command buffer. */
function countOps(buf: number[], target: number): number {
  let count = 0;
  for (let i = 0; i < buf.length; i += 1 + (CmdWidths[buf[i]] ?? 0)) {
    if (buf[i] === target) count += 1;
  }
  return count;
}

async function makeGraphics(): Promise<Phaser.GameObjects.Graphics> {
  const result = await bootScene([BareScene]);
  game = result.game;
  return result.scene.add.graphics();
}

describe('canonicalShape', () => {
  it('maps the legacy circle name onto its canonical disc', () => {
    expect(canonicalShape('circle')).toBe('disc');
    expect(canonicalShape('disc')).toBe('disc');
  });

  it('leaves every other shape unchanged', () => {
    expect(canonicalShape('line')).toBe('line');
    expect(canonicalShape('missile')).toBe('missile');
    expect(canonicalShape('bolt')).toBe('bolt');
  });
});

describe('drawBulletShape — every supported primitive emits its expected draw commands', () => {
  const specs = {
    disc: { shape: 'disc' as BulletShape, color: 0x00ffff, radius: 3 },
    circle: { shape: 'circle' as BulletShape, color: 0x00ffff, radius: 3 },
    line: { shape: 'line' as BulletShape, color: 0xff00ff, radius: 3, length: 4 },
    teardrop: { shape: 'teardrop' as BulletShape, color: 0x33ff66, radius: 3, length: 2.2 },
    missile: { shape: 'missile' as BulletShape, color: 0xff3366, radius: 3, length: 3 },
    ring: { shape: 'ring' as BulletShape, color: 0x66ffff, radius: 3 },
    shell: { shape: 'shell' as BulletShape, color: 0xff6600, radius: 3 },
    bolt: { shape: 'bolt' as BulletShape, color: 0xcc66ff, radius: 3, length: 2.4 },
    diamond: { shape: 'diamond' as BulletShape, color: 0xffaa00, radius: 3 },
    spark: { shape: 'spark' as BulletShape, color: 0xffff00, radius: 3 },
    chevron: { shape: 'chevron' as BulletShape, color: 0x00ffcc, radius: 3, length: 2 },
  } as const;

  it('disc and circle render as a filled arc (not a bare rectangle)', async () => {
    for (const shape of ['disc', 'circle'] as const) {
      const g = await makeGraphics();
      drawBulletShape(g, specs[shape]);
      const buf = g.commandBuffer as number[];
      expect(countOps(buf, Cmd.ARC)).toBeGreaterThanOrEqual(1);
      expect(countOps(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(1);
    }
  });

  it('line renders a stroked segment (MOVE_TO + LINE_TO + STROKE_PATH)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.line);
    const buf = g.commandBuffer as number[];
    expect(countOps(buf, Cmd.MOVE_TO)).toBe(1);
    expect(countOps(buf, Cmd.LINE_TO)).toBe(1);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBe(1);
  });

  it('a tail spec draws a tapering 3-segment fading wake behind any shape (AC1/AC3)', async () => {
    const withTail = await makeGraphics();
    drawBulletShape(withTail, { ...specs.disc, tail: 3.5 });
    const tailBuf = withTail.commandBuffer as number[];
    expect(countOps(tailBuf, Cmd.FILL_TRIANGLE)).toBe(3);

    const noTail = await makeGraphics();
    drawBulletShape(noTail, specs.disc);
    expect(countOps(noTail.commandBuffer as number[], Cmd.FILL_TRIANGLE)).toBe(0);
  });

  it('teardrop renders a filled body plus a tail triangle', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.teardrop);
    const buf = g.commandBuffer as number[];
    expect(countOps(buf, Cmd.ARC)).toBeGreaterThanOrEqual(1);
    expect(countOps(buf, Cmd.FILL_TRIANGLE)).toBeGreaterThanOrEqual(1);
  });

  it('missile renders body/fins/nose geometry (rectangle + triangles)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.missile);
    const buf = g.commandBuffer as number[];
    expect(countOps(buf, Cmd.FILL_TRIANGLE)).toBeGreaterThanOrEqual(2);
  });

  it('missile draws a flickering exhaust flame when a flame spec is set (AH-0MV822B1B0048UZT)', async () => {
    const noFlame = await makeGraphics();
    drawBulletShape(noFlame, specs.missile);
    const noFlameTriangles = countOps(
      noFlame.commandBuffer as number[],
      Cmd.FILL_TRIANGLE,
    );

    const withFlame = await makeGraphics();
    drawBulletShape(withFlame, { ...specs.missile, flame: 1.6, time: 0.05 });
    const withFlameTriangles = countOps(
      withFlame.commandBuffer as number[],
      Cmd.FILL_TRIANGLE,
    );

    // The flame adds two filled triangles (outer + white-hot core) behind
    // the body/fins/nose geometry.
    expect(withFlameTriangles).toBe(noFlameTriangles + 2);
  });

  it('missile honours the neon rim by stroking the body outline (AH-0MV822B1B0048UZT)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, { ...specs.missile, rimColor: 0xffffff });
    const buf = g.commandBuffer as number[];
    expect(countOps(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
  });

  it('ring renders a stroked arc (hollow, not a filled disc)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.ring);
    const buf = g.commandBuffer as number[];
    expect(countOps(buf, Cmd.STROKE_PATH)).toBe(1);
    expect(countOps(buf, Cmd.ARC)).toBeGreaterThanOrEqual(1);
  });

  it('shell renders two-tone filled arcs (outer shell + hot core)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.shell);
    const buf = g.commandBuffer as number[];
    expect(countOps(buf, Cmd.ARC)).toBeGreaterThanOrEqual(2);
  });

  it('bolt renders a multi-segment jagged stroke (≥ 3 line segments)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.bolt);
    const buf = g.commandBuffer as number[];
    expect(countOps(buf, Cmd.LINE_TO)).toBeGreaterThanOrEqual(3);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBe(1);
  });

  it('diamond renders a closed filled path (≥ 3 line segments)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.diamond);
    const buf = g.commandBuffer as number[];
    expect(countOps(buf, Cmd.LINE_TO)).toBeGreaterThanOrEqual(3);
    expect(countOps(buf, Cmd.FILL_PATH)).toBe(1);
  });

  it('spark renders a four-point star (≥ 6 line segments + fill path)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.spark);
    const buf = g.commandBuffer as number[];
    expect(countOps(buf, Cmd.LINE_TO)).toBeGreaterThanOrEqual(6);
    expect(countOps(buf, Cmd.FILL_PATH)).toBe(1);
  });

  it('chevron renders a stroked V (MOVE_TO + 2 LINE_TOs)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.chevron);
    const buf = g.commandBuffer as number[];
    expect(countOps(buf, Cmd.LINE_TO)).toBe(2);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBe(1);
  });

  it('draws only the requested shape (the buffer is cleared first)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.line);
    drawBulletShape(g, specs.disc);
    const buf = g.commandBuffer as number[];
    // Line's STROKE_PATH is gone — the second draw replaced the whole buffer.
    expect(countOps(buf, Cmd.STROKE_PATH)).toBe(0);
    expect(countOps(buf, Cmd.ARC)).toBeGreaterThanOrEqual(1);
  });
});

// ── Missile exhaust-flame flicker (AH-0MV822B1B0048UZT) ──────────

describe('missileFlameLength — flickering exhaust flame', () => {
  it('is zero when no flame multiplier is requested', () => {
    expect(missileFlameLength(3, 0.5)).toBe(0);
    expect(missileFlameLength(3, 0.5, 0)).toBe(0);
  });

  it('stays inside [0.55, 1.0] × radius × flame for any time', () => {
    const radius = 3;
    const flame = 2;
    const min = 0.55 * radius * flame;
    const max = radius * flame;
    for (let t = 0; t < 5; t += 0.013) {
      const len = missileFlameLength(radius, t, flame);
      expect(len).toBeGreaterThanOrEqual(min - 1e-9);
      expect(len).toBeLessThanOrEqual(max + 1e-9);
    }
  });

  it('flickers — the length changes as time advances', () => {
    const samples = new Set<number>();
    for (let t = 0; t < 0.2; t += 0.01) {
      samples.add(Number(missileFlameLength(3, t, 2).toFixed(4)));
    }
    expect(samples.size).toBeGreaterThan(1);
  });

  it('treats a non-finite time as zero rather than producing NaN', () => {
    const len = missileFlameLength(3, Number.NaN, 2);
    expect(Number.isFinite(len)).toBe(true);
    expect(len).toBeGreaterThan(0);
  });
});

describe('DEFAULT_SHAPE_LENGTH', () => {
  it('elongated shapes default to a longer-axis multiplier ≥ 1', () => {
    expect(DEFAULT_SHAPE_LENGTH.line).toBeGreaterThan(1);
    expect(DEFAULT_SHAPE_LENGTH.teardrop).toBeGreaterThan(1);
    expect(DEFAULT_SHAPE_LENGTH.missile).toBeGreaterThan(1);
    expect(DEFAULT_SHAPE_LENGTH.bolt).toBeGreaterThan(1);
    expect(DEFAULT_SHAPE_LENGTH.chevron).toBeGreaterThan(1);
  });
});

describe('resolvePlayerBulletVisual', () => {
  it('derives a spec from the catalogue definition (radius × base)', () => {
    const cannon = resolvePlayerBulletVisual(WEAPON_CATALOGUE.cannon);
    expect(cannon.shape).toBe('circle');
    expect(cannon.color).toBe(0x00ffff);
    expect(cannon.radius).toBeCloseTo(PLAYER_BULLET_RADIUS, 5);
    // Cannon's visuals-owned identity: a neon rim + short fading trail.
    expect(cannon.rimColor).toBe(0xffffff);
    expect(cannon.tail).toBeGreaterThan(0);

    const laser = resolvePlayerBulletVisual(WEAPON_CATALOGUE.wave_laser);
    expect(laser.shape).toBe('line');
    expect(laser.length).toBeGreaterThan(1); // a beam, not a dot

    // Spread's visuals-owned identity: a warm rim + brief fading trail so
    // the diamond reads as a small glowing disc-like gem
    // (AH-0MV8229B9009DQGA). The shape family stays `diamond` (its assigned
    // unique family per the catalogue-wide roster guard), never a second
    // `disc`.
    const spread = resolvePlayerBulletVisual(WEAPON_CATALOGUE.spread);
    expect(canonicalShape(spread.shape)).toBe('diamond');
    expect(spread.color).toBe(0xffaa00);
    expect(spread.rimColor).toBeDefined();
    expect(spread.tail).toBeGreaterThan(0);
  });

  it('dual and wave_laser both resolve a beam shape, never a dot', () => {
    for (const id of ['dual', 'wave_laser'] as const) {
      const spec = resolvePlayerBulletVisual(WEAPON_CATALOGUE[id]);
      expect(canonicalShape(spec.shape)).toBe('line');
    }
  });

  it('the dual beam resolves a short stroked bar with a fading trail (AH-0MV8229NM009CZOA)', () => {
    const dual = resolvePlayerBulletVisual(WEAPON_CATALOGUE.dual);
    // The twin pulse bars: a short line/beam (not a dot), a slightly chunkier
    // stroke than the default hairline, and a short fading wake behind each
    // bar — all visual metadata, flight unchanged.
    expect(canonicalShape(dual.shape)).toBe('line');
    expect(dual.length).toBeLessThan(3); // short bar, distinctly not the wave laser
    expect(dual.thickness).toBeGreaterThan(1);
    expect(dual.tail).toBeGreaterThan(0);
    expect(dual.color).toBe(0xff00ff);
  });

  it('the wave laser resolves a long stroked beam with a faint trail (AH-0MV822ACO007CEZF)', () => {
    const laser = resolvePlayerBulletVisual(WEAPON_CATALOGUE.wave_laser);
    // The elongated neon beam identity: a long line/beam (never a dot), a
    // thick stroke, and a faint fading wake behind the trailing edge — all
    // visual metadata; flight (speed, lifetime, piercing) is unchanged.
    expect(canonicalShape(laser.shape)).toBe('line');
    expect(laser.length).toBeGreaterThan(3); // long beam, distinctly not the dual
    expect(laser.thickness).toBeGreaterThan(1);
    expect(laser.tail).toBeGreaterThan(0); // faint trail
    expect(laser.color).toBe(0x3366ff);
  });

  it('the cluster missile resolves a rimmed missile with an exhaust flame and trail (AH-0MV822B1B0048UZT)', () => {
    const cluster = resolvePlayerBulletVisual(WEAPON_CATALOGUE.cluster);
    // The powered-missile identity: the `missile` body family, a white neon
    // rim, a flickering exhaust flame and a short fading smoke trail — all
    // visual metadata; flight and the split budget are unchanged.
    expect(canonicalShape(cluster.shape)).toBe('missile');
    expect(cluster.rimColor).toBeDefined();
    expect(cluster.flame).toBeGreaterThan(0);
    expect(cluster.tail).toBeGreaterThan(0);
    expect(cluster.color).toBe(0xff3366);
  });

  it('the rapid spark resolves a small white-rimmed flare with a short trail (AH-0MV822A03006UT2P)', () => {
    const rapid = resolvePlayerBulletVisual(WEAPON_CATALOGUE.rapid);
    // The "small fast disc" read: the catalogue's `spark` star family at the
    // smallest 0.7× scale, a white-hot rim around the core and a short fading
    // trail — the staccato flare identity, distinct from the cannon's
    // rimmed disc (visual metadata only, flight unchanged).
    expect(canonicalShape(rapid.shape)).toBe('spark');
    expect(rapid.color).toBe(0xffff00);
    expect(rapid.radius).toBeLessThan(PLAYER_BULLET_RADIUS); // smaller than base
    expect(rapid.rimColor).toBe(0xffffff);
    expect(rapid.tail).toBeGreaterThan(0);
  });

  it('the options pod shot resolves a pale-aqua rimmed chevron with a light trail (AH-0MV822BDN008IYL6)', () => {
    const options = resolvePlayerBulletVisual(WEAPON_CATALOGUE.options);
    // The small pod-shot identity: the catalogue `chevron` family (the
    // unique pod-dart family the roster assigns to the Options), a pale
    // aqua neon rim (its own tint) and a short faint fading trail — all
    // visual metadata; the orbit/fire behaviour is unchanged.
    expect(canonicalShape(options.shape)).toBe('chevron');
    expect(options.color).toBe(0x00ffcc);
    // Smaller than the cannon's bullet: the pods multiply firepower rather
    // than matching the main gun.
    expect(options.radius).toBeLessThan(PLAYER_BULLET_RADIUS);
    expect(options.rimColor).toBe(0xd9fff2);
    expect(options.tail).toBeGreaterThan(0);
  });
});

describe('resolveEnemyBulletVisual', () => {
  it('resolves every registered enemy identity', () => {
    for (const entry of ENEMY_BULLET_IDENTITIES) {
      expect(resolveEnemyBulletVisual(entry.id)).toBeDefined();
    }
  });

  it('throws for an unknown archetype (fail loud, so children register first)', async () => {
    expect(() =>
      resolveEnemyBulletVisual('not-a-real-archetype' as never),
    ).toThrow(/unknown enemy bullet archetype/i);
  });
});
