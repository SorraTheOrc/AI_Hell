import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../../test/gameHarness';
import { GAME_HEIGHT, GAME_WIDTH } from '../../../core/constants';
import { BACK_TO_INDEX_LABEL } from '../../../utils/gymNavigation';
import { FormationOffset } from '../../../utils/formations';
import {
  EnemyFormationConfig,
  FormationSceneBullet,
  FormationSceneEntity,
  GymFormationScene,
} from './GymFormationScene';

/** Minimal entity the base class drives (mirrors the real enemy contract). */
class StubEnemy extends Phaser.GameObjects.Container implements FormationSceneEntity {
  alive = true;
  shootEnabled = false;
  readonly offset: FormationOffset;

  constructor(scene: Phaser.Scene, offset: FormationOffset) {
    super(scene, 0, 0);
    this.offset = offset;
  }

  destroySelf(): void {
    this.alive = false;
  }

  applyFormationPosition(
    baseX: number,
    baseY: number,
    _dt: number,
    spacingX: number,
    spacingY: number,
  ): void {
    this.setPosition(
      baseX + this.offset.col * spacingX,
      baseY + this.offset.row * spacingY,
    );
  }
}

/** A bullet the base class advances and removes off-screen. */
class StubBullet implements FormationSceneBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  vx: number;
  vy: number;

  constructor(scene: Phaser.Scene, vx = 0, vy = 0) {
    this.graphics = scene.add.graphics();
    this.vx = vx;
    this.vy = vy;
  }
}

const FORMATION_COUNT = 6;
const SPACING_X = 26;
const SPACING_Y = 22;
const DRIFT_SPEED = 40;
const START_X = GAME_WIDTH * 0.25;
const START_Y = GAME_HEIGHT * 0.5;

/** Deterministic V-shaped offsets so geometry assertions stay predictable. */
function vOffsets(count: number): FormationOffset[] {
  const offsets: FormationOffset[] = [];
  let remaining = count;
  let row = 0;
  while (remaining > 0) {
    const rowWidth = Math.min(remaining, row + 1);
    const startCol = -row;
    for (let col = 0; col < rowWidth; col++) {
      offsets.push({ row, col: startCol + col * 2 });
    }
    remaining -= rowWidth;
    row += 1;
  }
  return offsets;
}

/** Builds a config-less scene class (harness instantiates with `new`). */
function makeStubScene(
  collect: (enemy: StubEnemy, now: number) => StubBullet[] = () => [],
): new () => GymFormationScene<StubEnemy, StubBullet> {
  const config: EnemyFormationConfig<StubEnemy, StubBullet> = {
    sceneKey: 'StubFormation',
    count: FORMATION_COUNT,
    spacingX: SPACING_X,
    spacingY: SPACING_Y,
    driftSpeed: DRIFT_SPEED,
    startX: START_X,
    startY: START_Y,
    statusLabel: 'stubs',
    hintText: 'stub gym — formation demo',
    buildOffsets: vOffsets,
    createEntity: (scene, x, y, offset) => {
      const enemy = new StubEnemy(scene, offset);
      enemy.setPosition(x, y);
      return enemy;
    },
    collectBullets: collect,
  };
  return class StubFormationScene extends GymFormationScene<StubEnemy, StubBullet> {
    constructor() {
      super(config);
    }
  };
}

type BootedScene = GymFormationScene<StubEnemy, StubBullet>;

describe('GymFormationScene — shared gym formation-scene base class', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootGym(
    collect: (enemy: StubEnemy, now: number) => StubBullet[] = () => [],
  ): Promise<BootedScene> {
    booted = await bootScene([makeStubScene(collect)]);
    return booted!.scene as BootedScene;
  }

  it('AC1 — spawns the configured formation count and adds every entity to the display list', async () => {
    const scene = await bootGym();

    expect(scene.sys.isActive()).toBe(true);
    expect(scene.formationEntities.length).toBe(FORMATION_COUNT);
    expect(scene.aliveCount).toBe(FORMATION_COUNT);

    // Without add.existing the entities would never render (project
    // convention regression — see GymScout.ts).
    const allOnDisplayList = scene.formationEntities.every((e) =>
      scene.children.list.includes(e),
    );
    expect(allOnDisplayList).toBe(true);
  });

  it('AC1 — positions each entity from the formation base + its own offset', async () => {
    const scene = await bootGym();
    const offsets = vOffsets(FORMATION_COUNT);

    for (const [index, entity] of scene.formationEntities.entries()) {
      const { row, col } = offsets[index];
      expect(entity.x).toBeCloseTo(scene.formationX + col * SPACING_X, 5);
      expect(entity.y).toBeCloseTo(scene.formationY + row * SPACING_Y, 5);
    }
  });

  it('AC1 — shows the EXPLODE/SHOOT buttons, status line, hint, and shared ← INDEX button', async () => {
    const scene = await bootGym();

    const labels = scene.children.list
      .filter((c) => c instanceof Phaser.GameObjects.Text)
      .map((t) => (t as Phaser.GameObjects.Text).text);
    expect(labels).toContain('EXPLODE');
    expect(labels).toContain('SHOOT: OFF');
    expect(labels).toContain(`SCORE: n/a — stubs: ${FORMATION_COUNT}`);
    expect(labels).toContain('stub gym — formation demo');
    expect(labels).toContain(BACK_TO_INDEX_LABEL);
  });

  it('AC1 — formation advances at the configured drift speed', async () => {
    const scene = await bootGym();
    const baseBefore = scene.formationX;

    await new Promise((r) => setTimeout(r, 350));

    const baseAfter = scene.formationX;
    expect(baseAfter).toBeGreaterThan(baseBefore);
    expect(baseAfter - baseBefore).toBeGreaterThan(DRIFT_SPEED * 0.25);
  });

  it('AC1 — EXPLODE destroys one random alive entity; no-op once none remain', async () => {
    const scene = await bootGym();
    const explode = scene.children.list.find(
      (c): c is Phaser.GameObjects.Text =>
        c instanceof Phaser.GameObjects.Text && c.text === 'EXPLODE',
    );
    expect(explode).toBeDefined();

    explode!.emit('pointerdown');
    expect(scene.aliveCount).toBe(FORMATION_COUNT - 1);

    for (let remaining = FORMATION_COUNT - 1; remaining > 0; remaining--) {
      explode!.emit('pointerdown');
      expect(scene.aliveCount).toBe(remaining - 1);
    }
    expect(() => explode!.emit('pointerdown')).not.toThrow();
    expect(scene.aliveCount).toBe(0);
  });

  it('AC1 — SHOOT toggle propagates to every entity and updates the button label', async () => {
    const scene = await bootGym();
    const shoot = scene.children.list.find(
      (c): c is Phaser.GameObjects.Text =>
        c instanceof Phaser.GameObjects.Text && c.text === 'SHOOT: OFF',
    );
    expect(shoot).toBeDefined();

    shoot!.emit('pointerdown');
    expect(scene.shootingEnabled).toBe(true);
    expect(scene.formationEntities.every((e) => e.shootEnabled)).toBe(true);
    expect(
      scene.children.list.some(
        (c): c is Phaser.GameObjects.Text =>
          c instanceof Phaser.GameObjects.Text && c.text === 'SHOOT: ON',
      ),
    ).toBe(true);

    shoot!.emit('pointerdown');
    expect(scene.shootingEnabled).toBe(false);
    expect(scene.formationEntities.every((e) => !e.shootEnabled)).toBe(true);
  });

  it('AC3 — collects bullets from the fire callback and advances them each frame', async () => {
    const scene = await bootGym((enemy) => [
      new StubBullet(enemy.scene, 0, 60),
    ]);

    await new Promise((r) => setTimeout(r, 250));
    expect(scene.activeBullets.length).toBeGreaterThan(0);

    const first = scene.activeBullets[0];
    const xBefore = first.graphics.x;
    const yBefore = first.graphics.y;
    await new Promise((r) => setTimeout(r, 150));
    const moved = scene.activeBullets.find((b) => b.graphics === first.graphics);
    // The bullet the base class owns moves downward each frame (vy > 0).
    expect(moved).toBeDefined();
    expect(moved!.graphics.x).toBe(xBefore);
    expect(moved!.graphics.y).toBeGreaterThan(yBefore);
  });

  it('AC3 — removes bullets that leave the screen bounds', async () => {
    // Gate firing like the real enemies (interval-based): one fast bullet
    // per 500ms — far fewer than the base class can clean up per frame.
    let lastFire = 0;
    const scene = await bootGym((enemy, now) => {
      if (now - lastFire < 500) return [];
      lastFire = now;
      return [new StubBullet(enemy.scene, 0, 2000)]; // fast downward
    });

    await new Promise((r) => setTimeout(r, 300));
    // The fast bullet exits the screen well inside the wait window; the
    // base class must have removed it (not left it in flight forever).
    expect(scene.activeBullets.length).toBe(0);
  });
});