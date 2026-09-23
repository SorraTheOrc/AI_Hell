import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';
import { PLAYER_BULLET_SPEED } from '../../core/constants';
import { bootScene, type BootedGame } from '../../test/gameHarness';
import type { FormationOffset } from '../../utils/formations';
import { PlayScene } from '../PlayScene';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import {
  GymFormationScene,
  type EnemyFormationConfig,
  type FormationSceneBullet,
  type FormationSceneEntity,
} from '../gym/core/GymFormationScene';
import { CombatScene } from './CombatScene';

/** The eight shared combat/lifecycle template methods (parent AC1/AC2). */
const SHARED_METHODS = [
  '_handleCollisions',
  '_hitPlayer',
  '_autoFire',
  '_collectDrop',
  '_spawnPlayerExplosion',
  '_clearEnemyBullets',
  '_handleTeleport',
  '_readPlayerInput',
] as const;

/** Production files the epic re-based onto the shared core. */
const TARGET_FILES = [
  'src/scenes/core/CombatScene.ts',
  'src/scenes/PlayScene.ts',
  'src/scenes/gym/core/GymFormationScene.ts',
];

// ── Minimal gym scene for cross-scene equivalence ───────────────────

class EquivEnemy
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

  applyFormationPosition(): void {
    // Static formation — equivalence tests drive the shared combat paths.
  }
}

class EquivBullet implements FormationSceneBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  vx = 0;
  vy = 0;

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.graphics();
  }
}

const EQUIV_GYM_CONFIG: EnemyFormationConfig<EquivEnemy, EquivBullet> = {
  sceneKey: 'EquivGymScene',
  count: 2,
  spacingX: 30,
  spacingY: 30,
  driftSpeed: 0,
  startX: 700,
  startY: 400,
  statusLabel: 'equiv',
  hintText: 'equiv',
  player: { x: 100, y: 100 },
  // Enable the gym's opt-in power-up layer so P7 teleport is allowed
  // (`canTeleport()` gates on `powerUpsEnabled`).
  powerUps: {},
  buildOffsets: (count) =>
    Array.from({ length: count }, (_, col) => ({ row: 0, col })),
  createEntity: (scene, x, y, offset) => {
    const enemy = new EquivEnemy(scene, x, y, offset);
    enemy.setPosition(x, y);
    return enemy;
  },
  collectBullets: () => [],
};

class EquivGymScene extends GymFormationScene<EquivEnemy, EquivBullet> {
  constructor() {
    super(EQUIV_GYM_CONFIG);
  }
}

// ── Source scan helper (duplicate-body guard) ───────────────────────

function definesMethod(source: string, method: string): boolean {
  // Definition lines only — `this._method(` call sites do not match.
  const re = new RegExp(
    `^[ \\t]*(?:(?:private|protected|public)\\s+)?(?:override\\s+)?${method}\\s*\\(`,
    'm',
  );
  return re.test(source);
}

describe('CombatScene — shared-implementation identity and duplicate-body guard (AC2)', () => {
  it('both scenes subclass CombatScene and inherit the eight template methods', () => {
    expect(Object.getPrototypeOf(PlayScene.prototype)).toBe(
      CombatScene.prototype,
    );
    expect(Object.getPrototypeOf(GymFormationScene.prototype)).toBe(
      CombatScene.prototype,
    );

    for (const method of SHARED_METHODS) {
      expect(
        Object.prototype.hasOwnProperty.call(PlayScene.prototype, method),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(GymFormationScene.prototype, method),
      ).toBe(false);
      // Same function object — the scenes cannot diverge.
      expect((PlayScene.prototype as unknown as Record<string, unknown>)[method]).toBe(
        (CombatScene.prototype as unknown as Record<string, unknown>)[method],
      );
      expect(
        (GymFormationScene.prototype as unknown as Record<string, unknown>)[method],
      ).toBe(
        (CombatScene.prototype as unknown as Record<string, unknown>)[method],
      );
    }
  });

  it('each shared method is defined in exactly one of the target production files', () => {
    // Scope: the three files this epic re-based. Older standalone gym scenes
    // (GymWeapons/GymPowerUpsCombat/GymPowerUpsUtility) predate the shared
    // core and are out of scope for this epic (full engine extraction is
    // explicitly excluded); a repo-wide scan would flag them. The two
    // re-based scenes must define each method zero times and the shared
    // core exactly once.
    const files = TARGET_FILES.map((file) => path.resolve(process.cwd(), file));
    for (const method of SHARED_METHODS) {
      const definers = files.filter((file) =>
        definesMethod(fs.readFileSync(file, 'utf8'), method),
      );
      const relative = definers
        .map((file) => path.relative(process.cwd(), file))
        .sort();
      // Exactly one definer, and it must be the shared core.
      expect(relative).toEqual(['src/scenes/core/CombatScene.ts']);
      // The re-based scenes must not re-introduce a copy.
      for (const target of TARGET_FILES.slice(1)) {
        expect(relative).not.toContain(target);
      }
    }
  });
});

describe('CombatScene — cross-scene behavioural equivalence (AC1)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  async function bootBoth(): Promise<{
    play: PlayScene;
    gym: EquivGymScene;
  }> {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'equiv-play-host',
    );
    const gym = await bootScene([EquivGymScene], 'equiv-gym-host');
    games.push(play, gym);
    return { play: play.scene as PlayScene, gym: gym.scene as EquivGymScene };
  }

  it('auto-fire produces bullets at the shared PLAYER_BULLET_SPEED in both scenes', async () => {
    const { play, gym } = await bootBoth();

    // Drive each scene's player in the same direction (right) for the same dt.
    play.getPlayer()!.setPosition(100, 100);
    play.tick(0.5);

    gym.getCursors()!.right.isDown = true;
    gym.tick(0.5);
    gym.getCursors()!.right.isDown = false;

    const playBullets = play.getPlayerBullets();
    const gymBullets = gym.getPlayerBullets();
    expect(playBullets.length).toBeGreaterThan(0);
    expect(gymBullets.length).toBeGreaterThan(0);

    for (const bullet of [...playBullets, ...gymBullets]) {
      expect(Math.hypot(bullet.vx, bullet.vy)).toBeCloseTo(
        PLAYER_BULLET_SPEED,
        5,
      );
    }
  });

  it('teleport consumes a P7 stack and warps the player in both scenes', async () => {
    const { play, gym } = await bootBoth();

    play.getEffectsRegistry().applyCollect('P7');
    gym.getEffectsRegistry().applyCollect('P7');

    const playMoved = play.triggerTeleport();
    const gymMoved = gym.triggerTeleport();

    expect(playMoved).toBe(true);
    expect(gymMoved).toBe(true);
    expect(play.getEffectsRegistry().hasTeleport()).toBe(false);
    expect(gym.getEffectsRegistry().hasTeleport()).toBe(false);
  });

  it('an enemy bullet on the player registers a hit and invulnerability in both scenes', async () => {
    const { play, gym } = await bootBoth();

    // Clear any auto-fired bullets so they cannot intercept the enemy
    // bullet in the shared case-2 pass before it can hit the player.
    (play as unknown as { playerBullets: unknown[] }).playerBullets.length = 0;
    (gym as unknown as { playerBullets: unknown[] }).playerBullets.length = 0;

    const playPlayer = play.getPlayer()!;
    play.spawnEnemyBullet(playPlayer.x, playPlayer.y, 0, 0);
    play.tick(0.001);

    const gymPlayer = gym.getPlayer()!;
    const gymBullet = new EquivBullet(gym);
    gymBullet.graphics.setPosition(gymPlayer.x, gymPlayer.y);
    (gym as unknown as { bullets: EquivBullet[] }).bullets.push(gymBullet);
    gym.tick(0.001);

    expect(play.getHitCount()).toBe(1);
    expect(gym.getPlayerHitCount()).toBe(1);
    expect(play.isPlayerInvulnerable()).toBe(true);
    expect(gym.isPlayerInvulnerable()).toBe(true);
  });

  it('bullet-vs-bullet interception consumes both bullets and plays the shared cue in both scenes', async () => {
    const { play, gym } = await bootBoth();
    const cue = vi.spyOn(effectsModule, 'playBulletDestructionSound');

    // Game: park the ship away, then intercept at a fixed point.
    (play as unknown as { playerBullets: unknown[] }).playerBullets.length = 0;
    (gym as unknown as { playerBullets: unknown[] }).playerBullets.length = 0;
    play.getPlayer()!.setPosition(50, 50);
    const playEnemyBullet = play.spawnEnemyBullet(500, 300, 0, 0);
    play.spawnPlayerBullet(500, 300, 0, 0);
    play.tick(0.001);
    expect(play.getEnemyBullets()).not.toContain(playEnemyBullet);
    expect(cue).toHaveBeenCalledTimes(1);

    // Gym: same interception at the same point.
    const gymPlayer = gym.getPlayer()!;
    gymPlayer.setPosition(50, 50);
    const gymEnemyBullet = new EquivBullet(gym);
    gymEnemyBullet.graphics.setPosition(500, 300);
    (gym as unknown as { bullets: EquivBullet[] }).bullets.push(gymEnemyBullet);
    gym.spawnPlayerBullet(500, 300, 0, 0);
    gym.tick(0.001);
    expect(gym.activeBullets).not.toContain(gymEnemyBullet);
    expect(cue).toHaveBeenCalledTimes(2);
  });

  it('both scenes resolve interception through the shared CombatScene hook', () => {
    // Drop collection and bullet-clear are hosted by the same shared
    // methods; identity here plus the base-class hook tests proves the
    // scenes cannot diverge on those paths.
    for (const method of [
      '_collectDrop',
      '_clearEnemyBullets',
      '_spawnPlayerExplosion',
      '_readPlayerInput',
      '_handleTeleport',
    ] as const) {
      expect(
        (PlayScene.prototype as unknown as Record<string, unknown>)[method],
      ).toBe(
        (GymFormationScene.prototype as unknown as Record<string, unknown>)[method],
      );
    }
  });
});
