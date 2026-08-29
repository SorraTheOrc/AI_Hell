import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import {
  SWARM_BULLET_COLOR,
  SWARM_BULLET_SPEED,
  SWARM_BURST_INTERVAL,
  SWARM_CLUSTER_COUNT,
  SWARM_COLOR,
  Swarm,
  buildSwarmClusterOffsets,
} from './Swarm';
import { FormationOffset } from '../utils/formations';

/** Minimal scene that only constructs Swarm entities (no scene logic needed). */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('HarnessScene');
  }
}

describe('buildSwarmClusterOffsets (GDD §4.1 cluster geometry)', () => {
  it('returns no offsets for a zero/empty formation', () => {
    expect(buildSwarmClusterOffsets(0)).toEqual([]);
    expect(buildSwarmClusterOffsets(-3)).toEqual([]);
  });

  it('produces the requested number of offsets', () => {
    for (const count of [1, 3, 6, 15]) {
      expect(buildSwarmClusterOffsets(count).length).toBe(count);
    }
  });

  it('distributes members into compact clusters of 3–5', () => {
    const offsets = buildSwarmClusterOffsets(15);
    expect(offsets.length).toBe(15);
    // 15 members ⇒ 3 clusters of 5 ⇒ several distinct row bands.
    const bands = new Set(offsets.map((o) => Math.round(o.row)));
    expect(bands.size).toBeGreaterThanOrEqual(2);
    const rows = offsets.map((o) => o.row);
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(4);
  });
});

describe('Swarm entity (E5 Swarm, GDD §4.1)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeSwarm(
    x: number,
    y: number,
    offset: FormationOffset = { row: 0, col: 0 },
    clusterIndex = 0,
  ): Swarm {
    const scene = booted!.scene;
    return new Swarm(scene, { x, y, formationOffset: offset }, clusterIndex);
  }

  it('renders a visible blue body diamond and starts alive', async () => {
    booted = await bootScene([HarnessScene]);
    const swarm = makeSwarm(100, 100);

    expect(swarm.alive).toBe(true);
    expect(swarm.bodyVisible).toBe(true);
    expect(SWARM_COLOR).toBe(0x0066ff); // neon blue per GDD §4.1
  });

  it('strokes the diamond with the GDD blue style applied AFTER the buffer clear (browser render regression)', async () => {
    // Same regression guard as Scout.test.ts: lineStyle() must follow
    // clear() or the body renders with the default white stroke.
    const LINE_STYLE = 6;
    const STROKE_PATH = 9;

    booted = await bootScene([HarnessScene]);
    const swarm = makeSwarm(100, 100);

    const children = (swarm as unknown as { list: Phaser.GameObjects.GameObject[] }).list;
    const body = children.find(
      (c): c is Phaser.GameObjects.Graphics =>
        c instanceof Phaser.GameObjects.Graphics &&
        c.commandBuffer.includes(STROKE_PATH),
    );
    expect(body, 'expected a body Graphics child with a stroked path').toBeDefined();

    const buf: number[] = body!.commandBuffer as number[];
    const strokeIdx = buf.lastIndexOf(STROKE_PATH);
    let lineStyleIdx = -1;
    for (let i = strokeIdx - 1; i >= 0; i--) {
      if (buf[i] === LINE_STYLE) {
        lineStyleIdx = i;
        break;
      }
    }
    expect(lineStyleIdx).toBeGreaterThanOrEqual(0);
    // LINE_STYLE layout: [id, lineWidth, color, alpha].
    expect(buf[lineStyleIdx + 1]).toBe(2);
    expect(buf[lineStyleIdx + 2]).toBe(SWARM_COLOR);
  });

  it('fires a burst bullet only when shoot mode is enabled and the interval has elapsed', async () => {
    booted = await bootScene([HarnessScene]);
    const swarm = makeSwarm(100, 100);
    const t0 = 1_000_000;

    // Disabled — never fires.
    swarm.shootEnabled = false;
    expect(swarm.tryFireBurstBullet(t0)).toBeNull();

    // Enable shooting — with _lastBurstTime=0, the interval has long elapsed
    // so the first call fires immediately. Then test the interval.
    swarm.shootEnabled = true;
    const bullet1 = swarm.tryFireBurstBullet(t0);
    expect(bullet1).not.toBeNull();
    expect(bullet1!.color).toBe(SWARM_BULLET_COLOR);

    // The last burst time is now t0.
    const lastBurstTime = t0;

    // Within the burst interval — refuses to fire again.
    expect(
      swarm.tryFireBurstBullet(lastBurstTime + SWARM_BURST_INTERVAL - 1),
    ).toBeNull();

    // After the burst interval elapses — fires again.
    expect(swarm.tryFireBurstBullet(lastBurstTime + SWARM_BURST_INTERVAL)).not.toBeNull();
  });

  it('fires bullets at the coordinated burst speed', async () => {
    booted = await bootScene([HarnessScene]);
    const swarm = makeSwarm(100, 100);
    swarm.shootEnabled = true;

    // First eligible call fires immediately.
    const bullet = swarm.tryFireBurstBullet(1_000_000 + SWARM_BURST_INTERVAL)!;
    const speed = Math.sqrt(bullet.vx * bullet.vx + bullet.vy * bullet.vy);
    expect(speed).toBeCloseTo(SWARM_BULLET_SPEED, 1);
  });

  it('does not fire once destroyed', async () => {
    booted = await bootScene([HarnessScene]);
    const swarm = makeSwarm(100, 100);
    swarm.shootEnabled = true;
    swarm.destroySelf();

    expect(swarm.alive).toBe(false);
    expect(swarm.bodyVisible).toBe(false);
    expect(swarm.tryFireBurstBullet(1_000_000 + SWARM_BURST_INTERVAL)).toBeNull();
  });

  it('destroySelf hides body and is a no-op when already destroyed', async () => {
    booted = await bootScene([HarnessScene]);
    const swarm = makeSwarm(100, 100);

    swarm.destroySelf();
    expect(swarm.alive).toBe(false);
    expect(swarm.bodyVisible).toBe(false);

    // Destroying twice is harmless.
    expect(() => swarm.destroySelf()).not.toThrow();
  });

  it('swarms pass freely through each other — overlapping members neither repel nor separate (GDD §2.6)', async () => {
    booted = await bootScene([HarnessScene]);
    const left = makeSwarm(480, 270, { row: 0, col: 0 }, 0);
    const right = makeSwarm(480, 270, { row: 0, col: 0 }, 1);

    left.applyFormationPosition(480, 270, 0.016, 28, 24);
    right.applyFormationPosition(480, 270, 0.016, 28, 24);

    // A collision system would push overlapping bodies apart. Here both
    // swarms stay co-located (cluster drift is bounded to ~12px so the
    // pack overlap is preserved).
    expect(left.alive).toBe(true);
    expect(right.alive).toBe(true);
    expect(Math.abs(left.x - right.x)).toBeLessThanOrEqual(25);
    expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(25);
  });

  it('assigns members to distinct clusters (0..SWARM_CLUSTER_COUNT-1)', async () => {
    booted = await bootScene([HarnessScene]);
    for (let i = 0; i < SWARM_CLUSTER_COUNT; i++) {
      const s = makeSwarm(100 + i * 30, 100, { row: i, col: i }, i);
      expect(s.clusterIndex).toBe(i);
    }
  });

  it('cluster drift keeps members near their formation slot', async () => {
    booted = await bootScene([HarnessScene]);
    const swarm = makeSwarm(100, 100, { row: 0, col: 1 });

    swarm.applyFormationPosition(100, 100, 0.016, 28, 24);
    // Slot is (100 + 1*28, 100 + 0*24) = (128, 100); cluster drift is
    // bounded to ~±12px so the member stays tight with its cluster.
    expect(swarm.x).toBeGreaterThan(114);
    expect(swarm.x).toBeLessThan(142);
    expect(swarm.y).toBeGreaterThan(90);
    expect(swarm.y).toBeLessThan(110);
  });

  // ── Audio behaviour (fire sound at shooting moment; louder destruction) ──

  // NOTE: Destruction sound (AC1) is played by the base class
  // `GymFormationScene.explodeRandom()`, not by the entity itself.
  // This avoids double-play with the scene-level call, per design doc §6.
  //
  // The fire sound is NOT an advance cue — it plays at the point of
  // shooting (handled by GymSwarm.update() at scene level).
  // No advance-cue sound is used per operator feedback.
});