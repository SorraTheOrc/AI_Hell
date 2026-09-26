/**
 * Protected gym base seams tests (AH-0MUII3F7Q002O7WX, gap 9).
 *
 * Covers the two protected seams `GymFormationScene` exposes —
 * `respawnFormation()` and `setPlayerEnabled(enabled)` — and the repo-wide
 * source guard that proves `GymEnemies` consumes them instead of
 * re-implementing the respawn and reaching into base privates with
 * `as unknown as` casts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../../test/gameHarness';
import { PLAYER_SPAWN } from '../../../core/constants';
import type { FormationOffset } from '../../../utils/formations';
import { definesMethod } from '../../../test/duplicateBodyGuard';
import {
  GymFormationScene,
  type EnemyFormationConfig,
  type FormationSceneBullet,
  type FormationSceneEntity,
} from './GymFormationScene';

/** Minimal entity the base class drives (mirrors the real enemy contract). */
class SeamEnemy
  extends Phaser.GameObjects.Container
  implements FormationSceneEntity
{
  alive = true;
  shootEnabled = false;
  readonly offset: FormationOffset;

  constructor(scene: Phaser.Scene, x: number, y: number, offset: FormationOffset) {
    super(scene, x, y);
    this.offset = offset;
  }

  destroySelf(): void {
    this.alive = false;
  }

  getHitRadius(): number {
    return 10;
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

/** A bullet the base class advances/clears by lifetime. */
class SeamBullet implements FormationSceneBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  vx = 0;
  vy = 0;
  lifetime = 3.0;
  elapsed = 0;

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.graphics();
  }
}

const SEAM_CONFIG: EnemyFormationConfig<SeamEnemy, SeamBullet> = {
  sceneKey: 'SeamGymScene',
  buildOffsets: (count) =>
    Array.from({ length: count }, (_, col) => ({ row: 0, col })),
  count: 3,
  spacingX: 40,
  spacingY: 30,
  driftSpeed: 0,
  startX: 600,
  startY: 200,
  statusLabel: 'seam',
  hintText: 'seam',
  player: { ...PLAYER_SPAWN },
  createEntity: (scene, x, y, offset) => new SeamEnemy(scene, x, y, offset),
  collectBullets: () => [],
};

/** Test scene exposing the protected seams as public wrappers. */
class SeamGymScene extends GymFormationScene<SeamEnemy, SeamBullet> {
  constructor() {
    super(SEAM_CONFIG);
  }

  callRespawnFormation(): void {
    this.respawnFormation();
  }

  callSetPlayerEnabled(enabled: boolean): boolean {
    return this.setPlayerEnabled(enabled);
  }

  callRegisterDynamicEntity(entity: SeamEnemy): void {
    this.registerDynamicEntity(entity);
  }
}

describe('GymFormationScene — protected respawn/player seams behaviour', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  async function bootSeamScene(): Promise<SeamGymScene> {
    const booted = await bootScene([SeamGymScene]);
    games.push(booted);
    return booted.scene as SeamGymScene;
  }

  it('setPlayerEnabled(false) despawns the ship and clears its bullets; true restores it at spawn', async () => {
    const scene = await bootSeamScene();
    expect(scene.getPlayer()).not.toBeNull();
    scene.spawnPlayerBullet(100, 100, 0, 0);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);

    expect(scene.callSetPlayerEnabled(false)).toBe(false);
    expect(scene.getPlayer()).toBeNull();
    expect(scene.getPlayerBullets()).toHaveLength(0);

    expect(scene.callSetPlayerEnabled(true)).toBe(true);
    const restored = scene.getPlayer();
    expect(restored).not.toBeNull();
    expect(restored!.x).toBeCloseTo(PLAYER_SPAWN.x, 5);
    expect(restored!.y).toBeCloseTo(PLAYER_SPAWN.y, 5);
  });

  it('respawnFormation rebuilds the formation at its initial geometry and preserves the SHOOT toggle', async () => {
    const scene = await bootSeamScene();
    const before = scene.formationEntities.slice();
    expect(before).toHaveLength(SEAM_CONFIG.count);

    scene.toggleShooting();
    expect(scene.shootingEnabled).toBe(true);

    for (const entity of before) entity.destroySelf();
    scene.callRespawnFormation();

    const after = scene.formationEntities;
    expect(after).toHaveLength(SEAM_CONFIG.count);
    for (const stale of before) expect(after).not.toContain(stale);
    expect(after.every((entity) => entity.shootEnabled)).toBe(true);
    expect(scene.formationX).toBeCloseTo(SEAM_CONFIG.startX, 5);
    expect(scene.formationY).toBeCloseTo(SEAM_CONFIG.startY, 5);
  });

  it('registerDynamicEntity appends to the live formation list', async () => {
    const scene = await bootSeamScene();
    const child = new SeamEnemy(scene, 10, 20, { row: 0, col: 0 });
    scene.callRegisterDynamicEntity(child);
    expect(scene.formationEntities).toContain(child);
  });
});

describe('GymFormationScene — protected seams guard (AC2)', () => {
  const BASE_FILE = 'src/scenes/gym/core/GymFormationScene.ts';

  function read(relativePath: string): string {
    return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
  }

  it('the base class defines both protected seams', () => {
    const base = read(BASE_FILE);
    expect(definesMethod(base, 'respawnFormation')).toBe(true);
    expect(definesMethod(base, 'setPlayerEnabled')).toBe(true);
  });

  it('GymEnemies consumes the shared respawn and player-enable seams', () => {
    const gymEnemies = read('src/scenes/gym/GymEnemies.ts');
    expect(gymEnemies).toContain('this.respawnFormation(');
    expect(gymEnemies).toContain('this.setPlayerEnabled(');
  });

  it('the gym subclasses contain no `as unknown as` casts into base privates', () => {
    for (const file of [
      'src/scenes/gym/GymEnemies.ts',
      'src/scenes/gym/GymMinerals.ts',
    ]) {
      const source = read(file);
      expect(source, `${file} must not cast into base entities`).not.toMatch(
        /as unknown as \{ (?:entities|player|playerBullets)\b/,
      );
      expect(source, `${file} must not mutate base spawn coords`).not.toContain(
        'playerSpawnX',
      );
      expect(source, `${file} must not mutate base spawn coords`).not.toContain(
        'playerSpawnY',
      );
    }
  });
});
