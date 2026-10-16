/**
 * Player-bullet wrap-around and lifetime tests (AH-0MU960UTE001PTV0).
 *
 * Covers the acceptance criteria for the bullet-range change:
 * - AC1: player bullets wrap across all four edges (and a corner case).
 * - AC3: range is a per-type lifetime; bullets expire only by lifetime,
 *   never by off-screen position.
 * - AC4: two weapon types with different lifetimes expire at different
 *   times.
 * - AC5: a wrapped bullet remains live (and therefore collidable).
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { WEAPON_BULLET_LIFETIME } from '../utils/weapons';
import { advanceAndCull, createPlayerBullet, PlayerBullet } from './PlayerBullet';

let game: Phaser.Game | undefined;

afterEach(async () => {
  if (game) {
    await game.destroy(true);
    game = undefined;
  }
});

/** Minimal scene: the bullet only needs an owning scene. */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('BulletHarnessScene');
  }
}

async function makeScene(): Promise<Phaser.Scene> {
  const result = await bootScene([HarnessScene]);
  game = result.game;
  return result.scene;
}

/** Creates a bullet with a fixed velocity and lifetime for a test. */
function makeBullet(
  scene: Phaser.Scene,
  x: number,
  y: number,
  vx: number,
  vy: number,
  lifetime = 3.0,
): PlayerBullet {
  return createPlayerBullet(scene, x, y, 0x00ffff, 3, vx, vy, lifetime);
}

describe('PlayerBullet — four-edge wrap-around (AC1)', () => {
  it('wraps left → right when crossing the left edge', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 1, GAME_HEIGHT / 2, -350, 0, 3.0);

    advanceAndCull(bullet, 0.01); // 1 - 3.5 = -2.5 → +960

    expect(bullet.x).toBeCloseTo(GAME_WIDTH - 2.5, 5);
    expect(bullet.isExpired()).toBe(false);
  });

  it('wraps right → left when crossing the right edge', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, GAME_WIDTH - 2, GAME_HEIGHT / 2, 350, 0, 3.0);

    advanceAndCull(bullet, 0.01); // 958 + 3.5 = 961.5 → -960

    expect(bullet.x).toBeCloseTo(1.5, 5);
    expect(bullet.isExpired()).toBe(false);
  });

  it('wraps top → bottom when crossing the top edge', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, GAME_WIDTH / 2, 1, 0, -350, 3.0);

    advanceAndCull(bullet, 0.01); // 1 - 3.5 = -2.5 → +540

    expect(bullet.y).toBeCloseTo(GAME_HEIGHT - 2.5, 5);
    expect(bullet.isExpired()).toBe(false);
  });

  it('wraps bottom → top when crossing the bottom edge', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, GAME_WIDTH / 2, GAME_HEIGHT - 2, 0, 350, 3.0);

    advanceAndCull(bullet, 0.01); // 538 + 3.5 = 541.5 → -540

    expect(bullet.y).toBeCloseTo(1.5, 5);
    expect(bullet.isExpired()).toBe(false);
  });

  it('wraps both axes at once (corner case)', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 1, 1, -350, -350, 3.0);

    advanceAndCull(bullet, 0.01); // both x and y cross → wrap on both axes

    expect(bullet.x).toBeCloseTo(GAME_WIDTH - 2.5, 5);
    expect(bullet.y).toBeCloseTo(GAME_HEIGHT - 2.5, 5);
    expect(bullet.isExpired()).toBe(false);
  });

  it('stays on-screen after a wrap (never culled by off-screen position)', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, GAME_WIDTH - 1, GAME_HEIGHT / 2, 350, 0, 3.0);

    // Cross the seam several times; the bullet stays in-bounds and alive.
    for (let i = 0; i < 20; i++) {
      const alive = advanceAndCull(bullet, 0.05);
      expect(alive).toBe(true);
      expect(bullet.x).toBeGreaterThanOrEqual(0);
      expect(bullet.x).toBeLessThan(GAME_WIDTH);
    }
  });
});

describe('PlayerBullet — lifetime-based range (AC3, AC4)', () => {
  it('survives one wrap and expires only once its lifetime elapses', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, GAME_WIDTH - 1, GAME_HEIGHT / 2, 350, 0, 1.0);

    // 0.5 s: wrapped once, still alive.
    expect(advanceAndCull(bullet, 0.5)).toBe(true);
    expect(bullet.isExpired()).toBe(false);

    // 0.6 s more (1.1 s total ≥ 1.0 s lifetime): expired.
    expect(advanceAndCull(bullet, 0.6)).toBe(false);
    expect(bullet.isExpired()).toBe(true);
  });

  it('destroys the bullet Graphics (removes it from the scene) when its lifetime elapses', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 100, 100, 0, 0, 1.0);

    // Alive and rendered before the lifetime elapses.
    expect(advanceAndCull(bullet, 0.5)).toBe(true);
    expect(bullet.active).toBe(true);
    expect(scene.children.list).toContain(bullet);

    // Lifetime exhausted → culled AND destroyed (no lingering stationary
    // projectile left on the display list — AH-0MU960UTE001PTV0 review).
    expect(advanceAndCull(bullet, 0.6)).toBe(false);
    expect(bullet.active).toBe(false);
    expect(scene.children.list).not.toContain(bullet);
  });

  it('destroys a bullet only once its lifetime exceeds its type value', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 100, 100, 0, 0, 2.0);

    expect(bullet.isExpired()).toBe(false);
    advanceAndCull(bullet, 1.999);
    expect(bullet.isExpired()).toBe(false);
    advanceAndCull(bullet, 0.001);
    expect(bullet.isExpired()).toBe(true);
  });

  it('two bullet types with different lifetimes expire at different times', async () => {
    const scene = await makeScene();
    const cannon = makeBullet(
      scene, 100, 100, 0, 0, WEAPON_BULLET_LIFETIME.cannon,
    );
    const rapid = makeBullet(
      scene, 100, 100, 0, 0, WEAPON_BULLET_LIFETIME.rapid,
    );

    // Advance past the rapid lifetime but not the cannon lifetime.
    advanceAndCull(cannon, WEAPON_BULLET_LIFETIME.rapid + 0.1);
    advanceAndCull(rapid, WEAPON_BULLET_LIFETIME.rapid + 0.1);

    expect(rapid.isExpired()).toBe(true);
    expect(cannon.isExpired()).toBe(false);

    // The cannon expires only once its own (longer) lifetime elapses.
    advanceAndCull(cannon, WEAPON_BULLET_LIFETIME.cannon);
    expect(cannon.isExpired()).toBe(true);
  });

  it('invokes the onExpire callback exactly once before destroying an expired bullet (F3)', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 100, 100, 0, 0, 0.5);
    let calls = 0;
    let callBullet: PlayerBullet | null = null;
    bullet.onExpire = (expired) => {
      calls += 1;
      callBullet = expired;
    };

    // Not yet expired — no callback.
    advanceAndCull(bullet, 0.25);
    expect(calls).toBe(0);

    // Expiry fires the callback with the bullet, then destroys it.
    expect(advanceAndCull(bullet, 0.25)).toBe(false);
    expect(calls).toBe(1);
    expect(callBullet).toBe(bullet);
    expect(bullet.active).toBe(false);
  });

  it('leaves onExpire undefined for ordinary bullets (no callback required)', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 100, 100, 0, 0, 0.5);
    expect(bullet.onExpire).toBeUndefined();
    expect(() => advanceAndCull(bullet, 0.6)).not.toThrow();
  });
});

describe('PlayerBullet — reduced fallback lifetime (AH-0MUU131PU006O7ZD AC4)', () => {
  it('createPlayerBullet defaults to the reduced Cannon base lifetime (0.75 s)', async () => {
    const scene = await makeScene();
    // No lifetime argument → the fallback default applies.
    const bullet = createPlayerBullet(scene, 100, 100, 0x00ffff, 3, 0, 0);

    expect(bullet.lifetime).toBe(0.75);
    expect(bullet.lifetime).toBe(WEAPON_BULLET_LIFETIME.cannon);
  });

  it('the PlayerBullet constructor defaults to the reduced Cannon base lifetime (0.75 s)', async () => {
    const scene = await makeScene();
    // No lifetime argument → the constructor fallback applies.
    const bullet = new PlayerBullet(scene, 100, 100, 0, 0, 3, 0x00ffff);

    expect(bullet.lifetime).toBe(0.75);
    expect(bullet.lifetime).toBe(WEAPON_BULLET_LIFETIME.cannon);
  });

  it('a fallback bullet expires at half the old 1.5 s lifetime', async () => {
    const scene = await makeScene();
    const bullet = createPlayerBullet(scene, 100, 100, 0x00ffff, 3, 0, 0);

    // Just under the new lifetime: still alive.
    expect(advanceAndCull(bullet, 0.74)).toBe(true);
    expect(bullet.isExpired()).toBe(false);

    // Past it: expired, exactly as the halved range requires.
    expect(advanceAndCull(bullet, 0.02)).toBe(false);
    expect(bullet.isExpired()).toBe(true);
  });
});

// ── Centipede ricochet wall-bounce (AH-0MV1BIV5L005NJAI) ────────────

describe('PlayerBullet — wall-bounce budget (AH-0MV1BIV5L005NJAI)', () => {
  it('an ordinary bullet leaves the bounce budget unset and wraps', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 1, GAME_HEIGHT / 2, -350, 0, 3.0);

    expect(bullet.bounces).toBeUndefined();
    advanceAndCull(bullet, 0.01); // 1 - 3.5 = -2.5 → wraps to +957.5

    expect(bullet.x).toBeCloseTo(GAME_WIDTH - 2.5, 5);
    expect(bullet.bounces).toBeUndefined();
    expect(bullet.isExpired()).toBe(false);
  });

  it('reflects off the left edge, reversing vx and spending one bounce', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 2, GAME_HEIGHT / 2, -350, 0, 3.0);
    bullet.bounces = 2;

    advanceAndCull(bullet, 0.01); // 2 - 3.5 = -1.5 → mirrors to +1.5

    expect(bullet.x).toBeCloseTo(1.5, 5);
    expect(bullet.vx).toBeCloseTo(350, 5);
    expect(bullet.bounces).toBe(1);
    expect(bullet.isExpired()).toBe(false);
  });

  it('reflects off the right edge, reversing vx', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, GAME_WIDTH - 2, GAME_HEIGHT / 2, 350, 0, 3.0);
    bullet.bounces = 2;

    advanceAndCull(bullet, 0.01); // 958 + 3.5 = 961.5 → mirrors to +958.5

    expect(bullet.x).toBeCloseTo(GAME_WIDTH - 1.5, 5);
    expect(bullet.vx).toBeCloseTo(-350, 5);
    expect(bullet.bounces).toBe(1);
    expect(bullet.isExpired()).toBe(false);
  });

  it('reflects off the top and bottom edges, reversing vy', async () => {
    const scene = await makeScene();
    const top = makeBullet(scene, GAME_WIDTH / 2, 2, 0, -350, 3.0);
    top.bounces = 2;
    advanceAndCull(top, 0.01);
    expect(top.y).toBeCloseTo(1.5, 5);
    expect(top.vy).toBeCloseTo(350, 5);
    expect(top.bounces).toBe(1);

    const bottom = makeBullet(scene, GAME_WIDTH / 2, GAME_HEIGHT - 2, 0, 350, 3.0);
    bottom.bounces = 2;
    advanceAndCull(bottom, 0.01);
    expect(bottom.y).toBeCloseTo(GAME_HEIGHT - 1.5, 5);
    expect(bottom.vy).toBeCloseTo(-350, 5);
    expect(bottom.bounces).toBe(1);
  });

  it('a corner contact reflects both components but spends only one bounce', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 1, 1, -350, -350, 3.0);
    bullet.bounces = 2;

    advanceAndCull(bullet, 0.01); // both x and y cross → mirror on both axes

    expect(bullet.x).toBeCloseTo(2.5, 5);
    expect(bullet.y).toBeCloseTo(2.5, 5);
    expect(bullet.vx).toBeCloseTo(350, 5);
    expect(bullet.vy).toBeCloseTo(350, 5);
    expect(bullet.bounces).toBe(1);
  });

  it('reflects while the budget remains, then expires on the next wall contact', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 2, GAME_HEIGHT / 2, -350, 0, 3.0);
    bullet.bounces = 1;

    // First contact: one reflection, budget now 0, still alive.
    expect(advanceAndCull(bullet, 0.01)).toBe(true);
    expect(bullet.bounces).toBe(0);
    expect(bullet.isExpired()).toBe(false);

    // Second contact with no budget left: the bullet expires instead of wrapping.
    bullet.x = 2;
    bullet.vx = -350;
    expect(advanceAndCull(bullet, 0.01)).toBe(false);
    expect(bullet.isExpired()).toBe(true);
  });

  it('a budget of 0 expires on the very first wall contact', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 2, GAME_HEIGHT / 2, -350, 0, 3.0);
    bullet.bounces = 0;

    expect(advanceAndCull(bullet, 0.01)).toBe(false);
    expect(bullet.isExpired()).toBe(true);
  });

  it('keeps travelling in the reflected direction on the next frame', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 2, GAME_HEIGHT / 2, -350, 0, 3.0);
    bullet.bounces = 2;

    advanceAndCull(bullet, 0.01); // reflect: x ≈ 1.5, vx = +350
    const reflectedX = bullet.x;
    advanceAndCull(bullet, 0.01); // move right by 3.5

    expect(bullet.x).toBeGreaterThan(reflectedX);
    expect(bullet.x).toBeCloseTo(reflectedX + 3.5, 5);
  });

  it('notifies onWallBounce once per wall contact (AH-0MV822AP1006W2F9)', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 2, GAME_HEIGHT / 2, -350, 0, 3.0);
    bullet.bounces = 2;
    let bounces = 0;
    bullet.onWallBounce = () => {
      bounces++;
    };

    advanceAndCull(bullet, 0.01); // wall contact → onWallBounce fires
    advanceAndCull(bullet, 0.01); // flying — no wall contact

    expect(bounces).toBe(1);
    expect(bullet.bounces).toBe(1);
  });

  it('fires onWallBounce on the final wall contact before expiry (AH-0MV822AP1006W2F9)', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 2, GAME_HEIGHT / 2, -350, 0, 3.0);
    bullet.bounces = 0;
    let bounces = 0;
    bullet.onWallBounce = () => {
      bounces++;
    };

    expect(advanceAndCull(bullet, 0.01)).toBe(false); // expires on the wall

    expect(bounces).toBe(1);
    expect(bullet.isExpired()).toBe(true);
  });

  it('an ordinary (wrapping) bullet never fires onWallBounce (AH-0MV822AP1006W2F9)', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 1, GAME_HEIGHT / 2, -350, 0, 3.0);
    let bounces = 0;
    bullet.onWallBounce = () => {
      bounces++;
    };

    advanceAndCull(bullet, 0.01); // wraps, never reflects

    expect(bounces).toBe(0);
  });
});

// ── Shared bullet-shape rendering seam (AH-0MV8228MD009UBF7) ─────

// Phaser Graphics `commandBuffer` opcodes (mirrors src/powerups/icons.test.ts).
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
} as const;

/** Counts occurrences of an opcode in a Graphics command buffer. */
function countCmd(buf: number[], target: number): number {
  const widths: Record<number, number> = {
    [Cmd.ARC]: 7,
    [Cmd.FILL_RECT]: 4,
    [Cmd.LINE_TO]: 2,
    [Cmd.MOVE_TO]: 2,
    [Cmd.LINE_STYLE]: 3,
    [Cmd.FILL_STYLE]: 2,
    [Cmd.FILL_TRIANGLE]: 6,
  };
  let count = 0;
  for (let i = 0; i < buf.length; i += 1 + (widths[buf[i]] ?? 0)) {
    if (buf[i] === target) count += 1;
  }
  return count;
}

describe('PlayerBullet — shared bullet-shape rendering seam (AC1)', () => {
  it('defaults to a filled disc (the classic cannon look)', async () => {
    const scene = await makeScene();
    const bullet = createPlayerBullet(scene, 100, 100, 0x00ffff, 3, 100, 0, 1.0);

    expect(bullet.shape).toBe('circle');
    const buf = bullet.commandBuffer as number[];
    expect(countCmd(buf, Cmd.ARC)).toBeGreaterThanOrEqual(1);
    expect(countCmd(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(1);
  });

  it('renders a line/beam shape as a stroked segment, not a dot', async () => {
    const scene = await makeScene();
    const bullet = createPlayerBullet(
      scene, 100, 100, 0x3366ff, 3, 350, 0, 1.0, 'line', 4,
    );

    const buf = bullet.commandBuffer as number[];
    expect(countCmd(buf, Cmd.LINE_TO)).toBeGreaterThanOrEqual(1);
    expect(countCmd(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
  });

  it('orients the shape to its velocity heading (a beam flying right/up)', async () => {
    const scene = await makeScene();
    const right = createPlayerBullet(scene, 100, 100, 0x3366ff, 3, 350, 0, 1.0, 'line', 4);
    expect(right.rotation).toBeCloseTo(0, 5);

    const up = createPlayerBullet(scene, 100, 100, 0x3366ff, 3, 0, -350, 1.0, 'line', 4);
    expect(up.rotation).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('re-draws through the seam each frame (buffer holds only the current shape)', async () => {
    const scene = await makeScene();
    const bullet = makeBullet(scene, 100, 100, 100, 0, 3.0);
    advanceAndCull(bullet, 0.01);

    const buf = bullet.commandBuffer as number[];
    expect(countCmd(buf, Cmd.ARC)).toBeGreaterThanOrEqual(1);
    expect(countCmd(buf, Cmd.STROKE_PATH)).toBe(0);
  });
});

// ── Cannon — compact neon disc with a short fading trail (AH-0MV8228YW0050IXS) ─

describe('PlayerBullet — cannon visual identity (AC1/AC3)', () => {
  it('the cannon shot renders as a neon disc with a fading trail (rim + tapering tail)', async () => {
    const scene = await makeScene();
    const bullet = createPlayerBullet(
      scene, 100, 100, 0x00ffff, 3, 350, 0, 1.0,
      'circle', undefined, 0xffffff, undefined, 3.5,
    );

    // The cannon signature: filled disc (ARC + FILL_PATH), neon rim
    // (stroked ARC → a second ARC + STROKE_PATH) and a 3-segment fading
    // tail (FILL_TRIANGLE).
    const buf = bullet.commandBuffer as number[];
    expect(countCmd(buf, Cmd.ARC)).toBeGreaterThanOrEqual(2);
    expect(countCmd(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
    expect(countCmd(buf, Cmd.FILL_TRIANGLE)).toBe(3);
  });

  it('an ordinary bullet draws no trail (no tapering tail segments)', async () => {
    const scene = await makeScene();
    const bullet = createPlayerBullet(scene, 100, 100, 0x00ffff, 3, 350, 0, 1.0);

    const buf = bullet.commandBuffer as number[];
    expect(countCmd(buf, Cmd.FILL_TRIANGLE)).toBe(0);
  });
});

// ── Spread — small glowing diamond with a brief fading trail (AH-0MV8229B9009DQGA) ─

describe('PlayerBullet — spread visual identity (AC1/AC3)', () => {
  it('the spread shot renders as a warm-rimmed diamond with a brief fading trail', async () => {
    const scene = await makeScene();
    const bullet = createPlayerBullet(
      scene, 100, 100, 0xffaa00, 2.4, 350, 0, 0.7,
      'diamond', undefined, 0xffdd66, undefined, 2.2,
    );

    // The spread signature: the unique `diamond` shape family (filled
    // rhombus → FILL_PATH with MOVE_TO/LINE_TO joins), a warm neon rim
    // (stroked outline → STROKE_PATH) and a brief 3-segment fading trail
    // (FILL_TRIANGLE). Distinct from the cannon's disc; same trail seam.
    const buf = bullet.commandBuffer as number[];
    expect(countCmd(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(1);
    expect(countCmd(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
    expect(countCmd(buf, Cmd.FILL_TRIANGLE)).toBe(3);
  });
});

// ── Dual — twin short pulse bars with a quick fading wake (AH-0MV8229NM009CZOA) ─

describe('PlayerBullet — dual visual identity (AC1/AC3)', () => {
  it('the dual shot renders as a short stroked beam (not a dot) with a 3-segment fading trail', async () => {
    const scene = await makeScene();
    const bullet = createPlayerBullet(
      scene, 100, 100, 0xff00ff, 3, 350, 0, 0.7,
      'line', 2, undefined, 1.6, 1.6,
    );

    // The dual signature: a stroked line/beam (LINE_TO + STROKE_PATH, never
    // a dot) with a chunkier stroke than the default hairline, plus a short
    // 3-segment fading wake behind each bar (FILL_TRIANGLE via the shared
    // seam).
    const buf = bullet.commandBuffer as number[];
    expect(countCmd(buf, Cmd.LINE_TO)).toBeGreaterThanOrEqual(1);
    expect(countCmd(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
    expect(countCmd(buf, Cmd.FILL_TRIANGLE)).toBe(3);
  });
});

// ── Rapid — small fast staccato spark with a white-hot rim and short trail (AH-0MV822A03006UT2P) ─

describe('PlayerBullet — rapid visual identity (AC1/AC3)', () => {
  it('the rapid shot renders as a small white-rimmed spark with a short fading trail', async () => {
    const scene = await makeScene();
    const bullet = createPlayerBullet(
      scene, 100, 100, 0xffff00, 2.1, 350, 0, 0.375,
      'spark', undefined, 0xffffff, undefined, 1.8,
    );

    // The rapid signature: the unique `spark` star body (filled four-point
    // star → MOVE_TO/LINE_TO joins + FILL_PATH), a white-hot rim highlight
    // (stroked inner ARC → STROKE_PATH) and a short 3-segment fading trail
    // (FILL_TRIANGLE via the shared seam) — the "small fast disc" read at
    // stream pace, visually distinct from the cannon's plain rimmed disc.
    expect(bullet.radius).toBeLessThan(3); // small
    expect(bullet.rimColor).toBe(0xffffff);
    expect(bullet.tail).toBe(1.8); // short, so the stream stays clean
    const buf = bullet.commandBuffer as number[];
    expect(countCmd(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(1);
    expect(countCmd(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
    expect(countCmd(buf, Cmd.FILL_TRIANGLE)).toBe(3);
  });
});
