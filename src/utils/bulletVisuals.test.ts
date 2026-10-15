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
  });

  it('dual and wave_laser both resolve a beam shape, never a dot', () => {
    for (const id of ['dual', 'wave_laser'] as const) {
      const spec = resolvePlayerBulletVisual(WEAPON_CATALOGUE[id]);
      expect(canonicalShape(spec.shape)).toBe('line');
    }
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
