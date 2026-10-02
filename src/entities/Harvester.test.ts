/**
 * Harvester entity behaviour tests (parent AH-0MUI820PM0038HS2, feature F3).
 *
 * A large, slow roaming enemy that always steers toward the nearest live
 * mineral, absorbs it on overlap (through the shared enemy-absorption rule),
 * never fires, and survives five player-bullet hits.
 *
 * Every test asserts observable behaviour through the public API — no
 * source-grepping or re-implemented production logic.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import {
  HARVESTER_COLOR,
  HARVESTER_HEALTH,
  HARVESTER_SIZE,
  HARVESTER_SPEED,
  Harvester,
} from './Harvester';
import { Mineral } from './Mineral';
import { collectMinerals } from '../scenes/core/mineralLayer';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('HarvesterHarness');
  }
}

const OFFSET = { row: 0, col: 0 };

function makeHarvester(
  scene: Phaser.Scene,
  x: number,
  y: number,
): Harvester {
  return new Harvester(scene, { x, y, formationOffset: OFFSET });
}

/** Deterministic mineral at a fixed position (uses the real entity). */
function makeMineral(scene: Phaser.Scene, x: number, y: number): Mineral {
  return new Mineral(scene, { x, y });
}

describe('Harvester entity', () => {
  let booted: BootedGame | null = null;
  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([HarnessScene]);
    return booted.scene;
  }

  // ── Configuration ────────────────────────────────────────────────

  it('is a large, slow, five-hit non-firing roamer', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);

    expect(h.health).toBe(HARVESTER_HEALTH);
    expect(HARVESTER_HEALTH).toBe(5);
    expect(HARVESTER_SIZE).toBeGreaterThan(30);
    expect(HARVESTER_SPEED).toBeLessThan(40);
    expect(h.effectiveColor).toBe(HARVESTER_COLOR);
    expect(h.effectiveSize).toBe(HARVESTER_SIZE);

    // Roamer, not a formation enemy.
    expect(h.isFormationEnemy()).toBe(false);
    expect(h.formationKind).toBe('single');
  });

  it('body graphic is the colour shell + core only — no inner white accent (producer review)', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);

    // Phaser Graphics command ids (src/gameobjects/graphics/Commands.js).
    const LINE_STYLE = 6;
    const FILL_STYLE = 7;

    // The body is the container child whose buffer strokes the hexagon shell.
    const children = (h as unknown as { list: Phaser.GameObjects.GameObject[] }).list;
    const body = children.find(
      (c): c is Phaser.GameObjects.Graphics =>
        c instanceof Phaser.GameObjects.Graphics &&
        c.commandBuffer.includes(LINE_STYLE),
    );
    expect(body, 'expected a body Graphics child with a stroked shell').toBeDefined();

    const buf = body!.commandBuffer as number[];
    // The purple hexagonal shell is still stroked...
    expect(buf).toContain(HARVESTER_COLOR);

    // ...and no stroke or fill uses pure white (the removed inner chevron).
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] === LINE_STYLE) {
        // Layout: [id, lineWidth, color, alpha].
        expect(buf[i + 2]).not.toBe(0xffffff);
      } else if (buf[i] === FILL_STYLE) {
        // Layout: [id, color, alpha].
        expect(buf[i + 1]).not.toBe(0xffffff);
      }
    }
  });

  it('never fires — shootEnabled is a no-op and the effective pattern is none', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);

    expect(h.shootEnabled).toBe(false);
    h.shootEnabled = true;
    expect(h.shootEnabled).toBe(false);
    expect(h.effectiveShotPattern).toBe('none');
  });

  // ── Seek target selection ────────────────────────────────────────

  it('seeks the nearest live mineral when several are supplied', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);
    const far = makeMineral(scene, 400, 100);
    const near = makeMineral(scene, 150, 100);
    h.setSeekTargets([far, near]);

    expect(h.seekTargetX).toBe(near.x);
    expect(h.seekTargetY).toBe(near.y);
  });

  it('ignores dead minerals when choosing a target', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);
    const collected = makeMineral(scene, 120, 100);
    collected.handleOverlap('player'); // mark dead + hidden
    const live = makeMineral(scene, 300, 100);
    h.setSeekTargets([collected, live]);

    expect(h.seekTargetX).toBe(live.x);
    expect(h.seekTargetY).toBe(live.y);
  });

  it('has no seek target when the field is empty', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);
    h.setSeekTargets([]);

    expect(h.seekTargetX).toBeNull();
    expect(h.seekTargetY).toBeNull();
  });

  it('holds station when no mineral is present', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);
    h.setSeekTargets([]);

    h.updatePosition(0.5);

    expect(h.x).toBe(100);
    expect(h.y).toBe(100);
  });

  // ── Seek movement ────────────────────────────────────────────────

  it('closes distance to the target at the configured slow speed', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);
    const target = makeMineral(scene, 300, 100);
    h.setSeekTargets([target]);

    const before = Math.hypot(target.x - h.x, target.y - h.y);
    h.updatePosition(1); // 1 second
    const after = Math.hypot(target.x - h.x, target.y - h.y);

    expect(after).toBeLessThan(before);
    expect(before - after).toBeCloseTo(HARVESTER_SPEED, 0);
  });

  it('moves diagonally toward an off-axis target', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);
    const target = makeMineral(scene, 200, 200);
    h.setSeekTargets([target]);

    h.updatePosition(0.5);

    expect(h.x).toBeGreaterThan(100);
    expect(h.y).toBeGreaterThan(100);
  });

  // ── Absorption ───────────────────────────────────────────────────

  it('absorbs an overlapping mineral through the shared rule and counts it', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);
    const mineral = makeMineral(scene, 100, 100);
    h.setSeekTargets([mineral]);

    expect(h.mineralCount).toBe(0);
    // The shared enemy-absorption pass is the single mineral rule.
    const kept = collectMinerals([mineral], null, [h], () => {});

    expect(h.mineralCount).toBe(1);
    expect(mineral.alive).toBe(false);
    expect(kept).toHaveLength(0);

    // The absorbed mineral is no longer a seek target.
    h.setSeekTargets(kept);
    expect(h.seekTargetX).toBeNull();
  });

  it('does not absorb a mineral it is not overlapping', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);
    const mineral = makeMineral(scene, 400, 100);
    h.setSeekTargets([mineral]);

    const kept = collectMinerals([mineral], null, [h], () => {});

    expect(h.mineralCount).toBe(0);
    expect(mineral.alive).toBe(true);
    expect(kept).toHaveLength(1);
  });

  it('can never take a mineral from the player hold (only live field minerals are absorbed)', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);
    // A mineral already collected by the player is dead — it must be ignored.
    const held = makeMineral(scene, 100, 100);
    held.handleOverlap('player');
    h.setSeekTargets([held]);

    collectMinerals([held], null, [h], () => {});

    expect(h.mineralCount).toBe(0);
  });

  // ── Destruction ──────────────────────────────────────────────────

  it('is destroyed after exactly five player-bullet hits', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);

    for (let hit = 1; hit <= 4; hit++) {
      expect(h.takeDamage()).toBe(HARVESTER_HEALTH - hit);
      expect(h.alive).toBe(true);
    }
    expect(h.takeDamage()).toBe(0);
    expect(h.alive).toBe(false);
  });

  it('re-drops the collected minerals plus an additive bonus on destruction', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);
    for (let i = 0; i < 4; i++) h.collectMineral();

    // Deterministic bounds (mirrors BaseEnemy.mineralRedropCount):
    // round(4 + 0.25) = 4 at rng 0 and round(4 + 1.25) = 5 at rng 1.
    const low = h.mineralRedropCount(() => 0);
    const high = h.mineralRedropCount(() => 1);
    expect(low).toBe(4);
    expect(high).toBe(5);
    expect(high).toBeGreaterThanOrEqual(low);
  });

  // ── Formation no-op ──────────────────────────────────────────────

  it('applyFormationPosition is a no-op (the Harvester manages its own motion)', async () => {
    const scene = await boot();
    const h = makeHarvester(scene, 100, 100);
    const target = makeMineral(scene, 200, 100);
    h.setSeekTargets([target]);

    h.applyFormationPosition(500, 500, 0.5, 20, 20);

    expect(h.x).toBe(100);
    expect(h.y).toBe(100);
  });
});
