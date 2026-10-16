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
  shapeAnimates,
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
    'heavy-shell': { shape: 'heavy-shell' as BulletShape, color: 0xffaa00, radius: 3 },
    shard: { shape: 'shard' as BulletShape, color: 0xffee88, radius: 3, length: 2.6, rimColor: 0xffff00 },
    bolt: { shape: 'bolt' as BulletShape, color: 0xcc66ff, radius: 3, length: 2.4 },
    'phaser-bolt': { shape: 'phaser-bolt' as BulletShape, color: 0xff4444, radius: 3, length: 1.8, rimColor: 0xff00ff },
    fleck: { shape: 'fleck' as BulletShape, color: 0x00ccff, radius: 3, length: 1.4, rimColor: 0x00ccff },
    dart: { shape: 'dart' as BulletShape, color: 0xffddaa, radius: 3, length: 2.8, rimColor: 0xff6688 },
    'boss-pellet': { shape: 'boss-pellet' as BulletShape, color: 0xffffff, radius: 3, rimColor: 0xff3366 },
    'spiral-pellet': { shape: 'spiral-pellet' as BulletShape, color: 0xffffff, radius: 3, rimColor: 0xffcc00 },
    'pulse-ring': { shape: 'pulse-ring' as BulletShape, color: 0xffffff, radius: 3, rimColor: 0x88ddff, thickness: 2.2 },
    diamond: { shape: 'diamond' as BulletShape, color: 0xffaa00, radius: 3 },
    spark: { shape: 'spark' as BulletShape, color: 0xffff00, radius: 3 },
    chevron: { shape: 'chevron' as BulletShape, color: 0x00ffcc, radius: 3, length: 2 },
    pellet: { shape: 'pellet' as BulletShape, color: 0xff4444, radius: 3, rimColor: 0x00ff66 },
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

  it('heavy-shell renders a large two-tone shell (body + hot core) plus a slow glow ring (AH-0MV822DF60001EPA)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs['heavy-shell']);
    const buf = g.commandBuffer as number[];
    // The heavy shell's read: a filled body + white-hot core (filled arcs)
    // AND the breathing glow halo ring (a stroked arc) — the "slow glow" of
    // the Tank's radial shot, distinct from the plain `shell`'s two fills.
    expect(countOps(buf, Cmd.ARC)).toBeGreaterThanOrEqual(3);
    expect(countOps(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(2);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
  });

  it('the heavy-shell glow ring breathes slowly with the bullet age (time-driven alpha)', async () => {
    // The slow glow is the LAST stroked path in the buffer; the LINE_STYLE
    // immediately before it carries `alpha × (0.15 + 0.25·breathe)` where
    // `breathe = 0.5 + 0.5·sin(time·1.8)` — slow (1.8 rad/s), unlike the
    // pellet's fast pulse (7 rad/s), so the heavy shell reads as a lazy,
    // glowing ember rather than a blinking pellet.
    const glowAlpha = (graphics: Phaser.GameObjects.Graphics): number => {
      const buf = graphics.commandBuffer as number[];
      const strokeIdx = buf.lastIndexOf(Cmd.STROKE_PATH);
      let lineStyleIdx = -1;
      for (let i = strokeIdx - 1; i >= 0; i--) {
        if (buf[i] === Cmd.LINE_STYLE) {
          lineStyleIdx = i;
          break;
        }
      }
      expect(lineStyleIdx).toBeGreaterThanOrEqual(0);
      expect(buf[lineStyleIdx + 1]).toBe(1); // 1 px glow stroke
      return buf[lineStyleIdx + 3];
    };

    const start = await makeGraphics();
    drawBulletShape(start, { ...specs['heavy-shell'], time: 0 });
    const bright = await makeGraphics();
    // sin(π/2) = 1 → the glow reaches its brightest phase.
    drawBulletShape(bright, { ...specs['heavy-shell'], time: Math.PI / 2 / 1.8 });

    expect(glowAlpha(bright)).toBeGreaterThan(glowAlpha(start));
  });

  it('shard renders a razor arrowhead + white-hot spine + sweeping spine glint (AH-0MV822D2U000LRFV)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.shard);
    const buf = g.commandBuffer as number[];
    // The shard's read: a filled razor outline + a white-hot spine (two
    // closed filled paths) AND the arc-energy glint (a filled arc) plus a
    // neon-rim stroke — the sharp-splinter identity, distinct from the
    // generic teardrop/disc fallbacks.
    expect(countOps(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(3);
    expect(countOps(buf, Cmd.ARC)).toBeGreaterThanOrEqual(1);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
  });

  it('the shard glint sweeps up and down the spine with the bullet age (time-driven motion)', async () => {
    // The glint is the ONLY arc in the shard's buffer; its x offset travels
    // tail→tip with `sweep = 0.5 + 0.5·sin(time·9)`. At t=0 the glint sits
    // mid-spine; a quarter-cycle later (sin = 1) it has swept to the tip, so
    // the drawn x differs clearly — the shard shimmers as it flies its arc.
    // (Walk the opcode stream with the width table rather than
    // `lastIndexOf(Cmd.ARC)` — ARC's opcode is 0, which also appears as a
    // parameter value, so a bare lastIndexOf is ambiguous.)
    const glintXs = (graphics: Phaser.GameObjects.Graphics): number[] => {
      const buf = graphics.commandBuffer as number[];
      const xs: number[] = [];
      for (let i = 0; i < buf.length; i += 1 + (CmdWidths[buf[i]] ?? 0)) {
        if (buf[i] === Cmd.ARC) xs.push(buf[i + 1]);
      }
      return xs;
    };

    const start = await makeGraphics();
    drawBulletShape(start, { ...specs.shard, time: 0 });
    const tip = await makeGraphics();
    // sin(π/2) = 1 → the glint has swept tail→tip (a quarter cycle).
    drawBulletShape(tip, { ...specs.shard, time: Math.PI / 2 / 9 });

    expect(glintXs(start)).toHaveLength(1);
    expect(glintXs(tip)).toHaveLength(1);
    expect(Math.abs(glintXs(tip)[0] - glintXs(start)[0])).toBeGreaterThan(2);
  });

  it('bolt renders a multi-segment jagged stroke (≥ 3 line segments)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.bolt);
    const buf = g.commandBuffer as number[];
    expect(countOps(buf, Cmd.LINE_TO)).toBeGreaterThanOrEqual(3);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBe(1);
  });

  it('phaser-bolt renders a crisp hexagonal prism with a white-hot core streak plus a neon rim (AH-0MV822DRX009RYUB)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs['phaser-bolt']);
    const buf = g.commandBuffer as number[];
    // The phaser-bolt's read: a filled hexagonal prism body + a bright
    // velocity-aligned white core streak (two closed filled paths) plus a
    // magenta neon-rim stroke — distinct from the jagged `bolt` (a bare
    // stroke with no body) and from the smooth `line`/`teardrop` bodies.
    expect(countOps(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(2);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
  });

  it('fleck renders a tiny cometary tear: filled head + tail + white-hot glint + neon rim (AH-0MV822E4T006F37Y)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.fleck);
    const buf = g.commandBuffer as number[];
    // The fleck's read: a filled tear body + a pointed tail triangle + a
    // white-hot leading glint (arc fills) plus a cyan neon-rim stroke — the
    // tiny-fast-fleck massed-fire micro-shard, distinct from the 4-point
    // `spark` star and the Raider's wide `diamond`.
    expect(countOps(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(1);
    expect(countOps(buf, Cmd.ARC)).toBeGreaterThanOrEqual(2);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
  });

  it('dart renders a slim sharp-nosed spearhead with a white-hot nose tip + neon rim (AH-0MV822EH800780GI)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.dart);
    const buf = g.commandBuffer as number[];
    // The dart's read: a filled long spearhead body + a white-hot nose-tip
    // fill (two closed filled paths) plus a hot-pink neon-rim stroke — the
    // needle-like fast-attacker identity, distinct from the Raider's own
    // `diamond` body and every other shot.
    expect(countOps(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(2);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
  });

  it('boss-pellet renders a dense hexagonal pellet with a white-hot core + menacing ring accent (AH-0MV822ETD008LLZX)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs['boss-pellet']);
    const buf = g.commandBuffer as number[];
    // The boss pellet's read: a filled hexagonal body + a white-hot core
    // (two filled paths) plus the concentric ring-accent stroke — denser
    // than a plain disc and distinct from the Boss's other pattern shapes.
    expect(countOps(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(2);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
    expect(countOps(buf, Cmd.LINE_TO)).toBeGreaterThanOrEqual(5);
  });

  it('spiral-pellet renders a phase-coloured pellet with a spiral-wake arc (AH-0MV822F5J006WFR0)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs['spiral-pellet']);
    const buf = g.commandBuffer as number[];
    // The spiral pellet's read: a filled body + a phase-coloured core (two
    // filled paths) plus the trailing spiral-wake stroke — distinct from the
    // spread pattern's dense hex pellet and the plain `ring`.
    expect(countOps(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(2);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
  });

  it('pulse-ring renders a slow wide pulse (faint fill + outer ring + dim inner halo) (AH-0MV822FHN005PK37)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs['pulse-ring']);
    const buf = g.commandBuffer as number[];
    // The pulse-ring's read: a faint filled body + a bright outer ring stroke
    // + a dim inner halo stroke — the slow wide pulse-wave echo, distinct from
    // the dense hex `boss-pellet` and the `shell` it replaced.
    expect(countOps(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(1);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(2);
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

  it('pellet renders a scalloped alien-pod body, an enemy-tinted core and a stroked pulse ring (AH-0MV822CQL005R4MM)', async () => {
    const g = await makeGraphics();
    drawBulletShape(g, specs.pellet);
    const buf = g.commandBuffer as number[];
    // The body's bulged silhouette + the rim-tinted core are filled arcs; the
    // outer pulse ring is a stroked arc. Plenty of arcs/fills, exactly one
    // stroke: the faint pulsing rim.
    expect(countOps(buf, Cmd.ARC)).toBeGreaterThanOrEqual(3);
    expect(countOps(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(2);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBe(1);
  });

  it('the pellet pulse ring breathes with the bullet age (time-driven alpha)', async () => {
    // The pulse ring is the LAST stroked path in the buffer; the LINE_STYLE
    // immediately before it carries `alpha × (0.35 + 0.30·sin(time·7))`.
    const pulseAlpha = (graphics: Phaser.GameObjects.Graphics): number => {
      const buf = graphics.commandBuffer as number[];
      const strokeIdx = buf.lastIndexOf(Cmd.STROKE_PATH);
      let lineStyleIdx = -1;
      for (let i = strokeIdx - 1; i >= 0; i--) {
        if (buf[i] === Cmd.LINE_STYLE) {
          lineStyleIdx = i;
          break;
        }
      }
      expect(lineStyleIdx).toBeGreaterThanOrEqual(0);
      // LINE_STYLE layout: [id, lineWidth, color, alpha] (Phaser Commands.js).
      expect(buf[lineStyleIdx + 1]).toBe(1); // 1 px stroke
      return buf[lineStyleIdx + 3];
    };

    const start = await makeGraphics();
    drawBulletShape(start, { ...specs.pellet, time: 0 });
    const bright = await makeGraphics();
    // sin(π/2) = 1 → the ring reaches its brightest pulse phase.
    drawBulletShape(bright, { ...specs.pellet, time: Math.PI / 2 / 7 });

    expect(pulseAlpha(bright)).toBeGreaterThan(pulseAlpha(start));
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
    expect(DEFAULT_SHAPE_LENGTH['phaser-bolt']).toBeGreaterThan(1);
    expect(DEFAULT_SHAPE_LENGTH.fleck).toBeGreaterThan(1);
    expect(DEFAULT_SHAPE_LENGTH.dart).toBeGreaterThan(1);
    expect(DEFAULT_SHAPE_LENGTH['boss-pellet']).toBe(1);
    expect(DEFAULT_SHAPE_LENGTH['spiral-pellet']).toBe(1);
    expect(DEFAULT_SHAPE_LENGTH['pulse-ring']).toBeGreaterThan(1);
    expect(DEFAULT_SHAPE_LENGTH.shard).toBeGreaterThan(1);
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

  it('scout/invader aimed shots resolve a pellet identity with an enemy-tinted core + faint pulse (AH-0MV822CQL005R4MM)', () => {
    for (const id of ['scout', 'march'] as const) {
      const visual = resolveEnemyBulletVisual(id);
      // The shared family: a small alien pellet, not the legacy plain disc.
      expect(canonicalShape(visual.shape)).toBe('pellet');
      // The shot body keeps the established lethal-red Scout bullet colour.
      expect(visual.color).toBe(0xff4444);
      // The enemy-tinted core/pulse + the launch-cue VFX are part of the
      // identity, so the game and every gym resolve the same feel.
      expect(visual.rimColor).toBeDefined();
      expect(visual.muzzle).toBeDefined();
      expect(shapeAnimates(visual.shape)).toBe(true);
    }
    // Aliases share one signature (the roster guard asserts this too).
    expect(resolveEnemyBulletVisual('scout')).toEqual(
      resolveEnemyBulletVisual('march'),
    );
  });

  it('tank radial shots resolve a heavy-shell identity with a slow glow + launch pop (AH-0MV822DF60001EPA)', () => {
    const visual = resolveEnemyBulletVisual('tank');
    // The Tank's signature look: a heavy shell — a dedicated `heavy-shell`
    // primitive (larger body + white-hot core + slow breathing glow), NOT the
    // plain `shell` reserved for the Boss pulse / Orbital-Strike placeholders.
    expect(canonicalShape(visual.shape)).toBe('heavy-shell');
    // The shot body keeps the established amber Tank bullet colour.
    expect(visual.color).toBe(0xffaa00);
    // Feel knobs: an amber neon rim, a short ember trail (slow shell reads
    // heavy), and an amber launch pop at the tank body when the burst leaves.
    expect(visual.rimColor).toBeDefined();
    expect(visual.tail).toBeGreaterThan(0);
    expect(visual.muzzle).toBeDefined();
    expect(visual.muzzle?.color).toBe(0xffaa00);
    // The slow glow is time-driven → the shared bullet lifecycle redraws the
    // shell each frame (identically in game and every gym).
    expect(shapeAnimates(visual.shape)).toBe(true);
  });

  it('diver spread bursts resolve a sharp shard identity with a sweeping glint + launch pop (AH-0MV822D2U000LRFV)', () => {
    const visual = resolveEnemyBulletVisual('diver');
    // The Diver's signature look: a sharp splinter/arrowhead echoing its
    // dart body and dive arc — a dedicated `shard` primitive (razor
    // outline, white-hot spine, sweeping time-driven glint), NOT the
    // generic `teardrop` fallback the placeholder used before this landed.
    expect(canonicalShape(visual.shape)).toBe('shard');
    // The shot body keeps the established pale-yellow Diver bullet colour.
    expect(visual.color).toBe(0xffee88);
    // Feel knobs: a neon rim in the Diver's own body yellow, a short fading
    // trail, and a pale-yellow launch pop at the diver body per burst. The
    // glint is time-driven → the shared lifecycle redraws it each frame
    // (identically in game and every gym).
    expect(visual.rimColor).toBe(0xffff00);
    expect(visual.tail).toBeGreaterThan(0);
    expect(visual.muzzle).toBeDefined();
    expect(visual.muzzle?.color).toBe(0xffee88);
    expect(shapeAnimates(visual.shape)).toBe(true);
  });

  it('phaser radial shots resolve a crisp phaser-bolt identity with a white core streak + launch pop (AH-0MV822DRX009RYUB)', () => {
    const visual = resolveEnemyBulletVisual('phaser');
    // The Phaser's signature look: a crisply-edged hexagonal phaser bolt with
    // a bright velocity-aligned white core streak — a dedicated `phaser-bolt`
    // primitive, NOT the jagged `bolt` the placeholder used before this
    // landed (and distinct from `boss-desperation`'s jagged bolt).
    expect(canonicalShape(visual.shape)).toBe('phaser-bolt');
    // The shot body keeps the established lethal-red Phaser bullet colour.
    expect(visual.color).toBe(0xff4444);
    // Feel knobs: a neon rim in the Phaser's own body magenta, a short fading
    // trail, and a magenta launch pop at the phaser body per radial volley.
    // The bolt is static, so no per-frame redraw is required.
    expect(visual.rimColor).toBe(0xff00ff);
    expect(visual.tail).toBeGreaterThan(0);
    expect(visual.muzzle).toBeDefined();
    expect(visual.muzzle?.color).toBe(0xff00ff);
    expect(shapeAnimates(visual.shape)).toBe(false);
  });

  it('swarm coordinated bursts resolve a tiny fast fleck identity with a cyan pop (AH-0MV822E4T006F37Y)', () => {
    const visual = resolveEnemyBulletVisual('swarm');
    // The Swarm's signature look: a tiny fast cometary micro-shard — a
    // dedicated `fleck` primitive (small elongated tear + white-hot leading
    // glint + pointed tail), NOT the 4-point `spark` star the placeholder
    // used before this landed.
    expect(canonicalShape(visual.shape)).toBe('fleck');
    // The shot body keeps the established cyan Swarm bullet colour.
    expect(visual.color).toBe(0x00ccff);
    // Feel knobs: a cyan neon rim, a short fading trail (the fast-fleck
    // read), and a cyan launch pop at each member's body. No animation —
    // massed fire must stay cheap, so no per-frame redraw is required.
    expect(visual.rimColor).toBe(0x00ccff);
    expect(visual.tail).toBeGreaterThan(0);
    expect(visual.muzzle).toBeDefined();
    expect(visual.muzzle?.color).toBe(0x00ccff);
    expect(shapeAnimates(visual.shape)).toBe(false);
  });

  it('raider shots resolve a slim sharp-nosed dart identity with a hot-pink rim + launch pop (AH-0MV822EH800780GI)', () => {
    const visual = resolveEnemyBulletVisual('raider');
    // The Raider's signature look: a slim sharp-nosed dart — a dedicated
    // `dart` primitive (long spearhead body + white-hot nose tip), NOT the
    // wide `diamond` the placeholder used before this landed.
    expect(canonicalShape(visual.shape)).toBe('dart');
    // The shot body keeps the established pale-amber Raider bullet colour.
    expect(visual.color).toBe(0xffddaa);
    // Feel knobs: a hot-pink neon rim (the attack-run threat read), a short
    // fading trail, and a pale-amber launch pop at the raider's body. No
    // animation — the dart is static, so no per-frame redraw is required.
    expect(visual.rimColor).toBe(0xff6688);
    expect(visual.tail).toBeGreaterThan(0);
    expect(visual.muzzle).toBeDefined();
    expect(visual.muzzle?.color).toBe(0xffddaa);
    expect(shapeAnimates(visual.shape)).toBe(false);
  });

  it('boss spread volleys resolve a dense pellet identity with a menacing ring accent + launch pop (AH-0MV822ETD008LLZX)', () => {
    const visual = resolveEnemyBulletVisual('boss-spread');
    // The Boss spread pattern's signature look: a dense hexagonal pellet
    // with a white-hot core and a menacing concentric ring accent — a
    // dedicated `boss-pellet` primitive, NOT the plain `disc` the
    // placeholder used before this landed.
    expect(canonicalShape(visual.shape)).toBe('boss-pellet');
    // The shot body keeps the established white Boss bullet colour.
    expect(visual.color).toBe(0xffffff);
    // Feel knobs: the blood-red targeting-halo ring accent, a short fading
    // trail, and a blood-red launch pop at the Boss's body per volley. No
    // animation — static pellet, so no per-frame redraw is required.
    expect(visual.rimColor).toBe(0xff3366);
    expect(visual.tail).toBeGreaterThan(0);
    expect(visual.muzzle).toBeDefined();
    expect(visual.muzzle?.color).toBe(0xff3366);
    expect(shapeAnimates(visual.shape)).toBe(false);
  });

  it('boss spiral volleys resolve a phase-coloured pellet identity with a spiral-wake + launch pop (AH-0MV822F5J006WFR0)', () => {
    const visual = resolveEnemyBulletVisual('boss-spiral');
    // The Boss spiral pattern's signature look: a compact pellet carrying the
    // Boss's current phase colour with a spiral-wake arc — a dedicated
    // `spiral-pellet` primitive, NOT the plain `ring` the placeholder used
    // before this landed.
    expect(canonicalShape(visual.shape)).toBe('spiral-pellet');
    // The shot body keeps the established white Boss bullet colour.
    expect(visual.color).toBe(0xffffff);
    // Feel knobs: the phase-colour core tint (yellow at phase 2 defaults),
    // a short fading trail, and a phase-tinted launch pop at the Boss's body
    // per volley. No animation — static pellet, so no per-frame redraw is
    // required.
    expect(visual.rimColor).toBe(0xffcc00);
    expect(visual.tail).toBeGreaterThan(0);
    expect(visual.muzzle).toBeDefined();
    expect(visual.muzzle?.color).toBe(0xffcc00);
    expect(shapeAnimates(visual.shape)).toBe(false);
  });

  it('boss pulse aimed shots resolve a slow wide pulse-ring identity with a pale launch pop (AH-0MV822FHN005PK37)', () => {
    const visual = resolveEnemyBulletVisual('boss-pulse');
    // The Boss pulse pattern's signature look: a slow wide pulse ring — a
    // dedicated `pulse-ring` primitive (faint fill + bright outer ring +
    // dim inner halo), NOT the filled `shell` the placeholder used before
    // this landed.
    expect(canonicalShape(visual.shape)).toBe('pulse-ring');
    // The shot body keeps the established white Boss bullet colour.
    expect(visual.color).toBe(0xffffff);
    // Feel knobs: a pale-blue ring tint, a thicker ring stroke, a short
    // fading trail, and a pale launch pop at the Boss's body. No animation
    // — static ring, so no per-frame redraw is required.
    expect(visual.rimColor).toBe(0x88ddff);
    expect(visual.thickness).toBeGreaterThan(1);
    expect(visual.tail).toBeGreaterThan(0);
    expect(visual.muzzle).toBeDefined();
    expect(visual.muzzle?.color).toBe(0x88ddff);
    expect(shapeAnimates(visual.shape)).toBe(false);
  });

  it('throws for an unknown archetype (fail loud, so children register first)', async () => {
    expect(() =>
      resolveEnemyBulletVisual('not-a-real-archetype' as never),
    ).toThrow(/unknown enemy bullet archetype/i);
  });
});
