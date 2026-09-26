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
import { GymPowerUpsCombat } from '../gym/GymPowerUpsCombat';
import { GymWeapons } from '../gym/GymWeapons';
import {
  GymFormationScene,
  type EnemyFormationConfig,
  type FormationSceneBullet,
  type FormationSceneEntity,
} from '../gym/core/GymFormationScene';
import { CombatScene } from './CombatScene';
import {
  collectProductionSourceFiles,
  definesFunction,
  definesMethod,
} from '../../test/duplicateBodyGuard';
import type { PlayerBullet } from '../../entities/PlayerBullet';

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

/**
 * The shared P3/P6 hit-gating hooks (AH-0MUHM66ES0027QQV AC3). They are
 * declared as safe defaults in `CombatCoreScene` and implemented
 * registry-backed in `CombatScene`; no other production scene may
 * re-implement them.
 */
const SHARED_GATING_METHODS = ['isPlayerPhased', 'tryAbsorbPlayerHit'] as const;

/** The three scenes that must route gating through the shared hooks. */
const GATING_SCENE_PROTOTYPES: Array<[string, object]> = [
  ['PlayScene', PlayScene.prototype],
  ['GymFormationScene', GymFormationScene.prototype],
  ['GymPowerUpsCombat', GymPowerUpsCombat.prototype],
];

/** The two shared-core files that may host a shared-method definition. */
const SHARED_CORE_FILES = [
  'src/scenes/core/CombatCoreScene.ts',
  'src/scenes/core/CombatScene.ts',
];

/** Production scene root scanned by the repo-wide duplicate-body guard. */
const SCENES_ROOT = 'src/scenes';

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
  lifetime = 3.0;
  elapsed = 0;

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
// `definesMethod` is shared via `../../test/duplicateBodyGuard` so the
// eight-method guard and the `_readInput` guard use one matcher (AC3).

/** Production scene files under `src/scenes`, excluding tests. */
function productionSceneFiles(): string[] {
  return collectProductionSourceFiles(
    path.resolve(process.cwd(), SCENES_ROOT),
  );
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

  it('each shared method is defined exactly once repo-wide, in the shared core', () => {
    // Repo-wide scope: every production scene file under src/scenes
    // (AH-0MUH5FD180063BU5). The shared core (CombatCoreScene
    // and/or CombatScene) must hold the single definition of each of the
    // eight methods; no other production scene may re-introduce a copy.
    const files = productionSceneFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const method of SHARED_METHODS) {
      const definers = files.filter((file) =>
        definesMethod(fs.readFileSync(file, 'utf8'), method),
      );
      const relative = definers
        .map((file) => path.relative(process.cwd(), file))
        .sort();
      // Exactly one definer, and it must be one of the shared-core files.
      expect(relative).toHaveLength(1);
      expect(SHARED_CORE_FILES).toContain(relative[0]);
    }
  });

  it('no production scene defines a legacy private `_readInput` copy', () => {
    // AC2: the duplicated private `_readInput` was unified onto the
    // shared `_readPlayerInput`; every production scene (including
    // GymPlayer) must route input through the shared path.
    const files = productionSceneFiles();
    const definers = files
      .filter((file) =>
        definesMethod(fs.readFileSync(file, 'utf8'), '_readInput'),
      )
      .map((file) => path.relative(process.cwd(), file))
      .sort();
    expect(definers).toEqual([]);
  });

  it('P3/P6 gating resolves to the same shared hooks on all three scenes (no own overrides)', () => {
    for (const [name, prototype] of GATING_SCENE_PROTOTYPES) {
      for (const method of SHARED_GATING_METHODS) {
        // No scene defines its own body ...
        expect(
          Object.prototype.hasOwnProperty.call(prototype, method),
          `${name}.prototype must not define ${method}`,
        ).toBe(false);
        // ... and all three resolve to the same CombatScene function object.
        expect(
          (prototype as unknown as Record<string, unknown>)[method],
          `${name}.prototype.${method} must be the shared CombatScene hook`,
        ).toBe(
          (CombatScene.prototype as unknown as Record<string, unknown>)[method],
        );
      }
    }
  });

  it('phase/shield gating is defined only in the shared core repo-wide', () => {
    const files = productionSceneFiles();
    for (const method of SHARED_GATING_METHODS) {
      const definers = files
        .filter((file) => definesMethod(fs.readFileSync(file, 'utf8'), method))
        .map((file) => path.relative(process.cwd(), file))
        .sort();
      // At least the shared core defines it (CombatCoreScene safe default
      // + CombatScene registry-backed override), and no other scene does.
      expect(definers.length).toBeGreaterThanOrEqual(1);
      for (const definer of definers) {
        expect(SHARED_CORE_FILES).toContain(definer);
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

// ── Shared mineral kill-drop guard (AH-0MUHMT5JC004WRSB, AC3) ───────

describe('CombatScene — shared mineral kill-drop rule is defined once', () => {
  const KILL_DROP_HELPER = 'resolveMineralKillDrops';
  const SCATTER_HELPER = 'scatterMineralDrops';
  const KILL_DROP_HELPER_FILE = 'src/scenes/core/mineralKillDrops.ts';
  const SCATTER_HELPER_FILE = 'src/entities/Mineral.ts';

  /** Every production TypeScript file under `src/` (excluding tests). */
  function productionSourceFiles(): string[] {
    return collectProductionSourceFiles(path.resolve(process.cwd(), 'src'));
  }

  it('defines the kill-drop rule exactly once, in the shared helper', () => {
    const definers = productionSourceFiles()
      .filter((file) =>
        definesFunction(fs.readFileSync(file, 'utf8'), KILL_DROP_HELPER),
      )
      .map((file) => path.relative(process.cwd(), file))
      .sort();

    expect(definers).toEqual([KILL_DROP_HELPER_FILE]);
  });

  it('defines the scatter maths exactly once, in the Mineral entity module', () => {
    const definers = productionSourceFiles()
      .filter((file) =>
        definesFunction(fs.readFileSync(file, 'utf8'), SCATTER_HELPER),
      )
      .map((file) => path.relative(process.cwd(), file))
      .sort();

    expect(definers).toEqual([SCATTER_HELPER_FILE]);
  });

  it('both the game and the gym consume the shared kill-drop rule', () => {
    for (const file of [
      'src/scenes/PlayScene.ts',
      'src/scenes/gym/core/GymFormationScene.ts',
    ]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source, `${file} must call the shared rule`).toContain(
        `${KILL_DROP_HELPER}(`,
      );
    }
  });
});

// ── Shared projectile lifecycle (gap 3, AH-0MUII3CF00024EDM) ────────

/** The two shared projectile-lifecycle helpers. */
const PROJECTILE_HELPERS = [
  'advanceWrappingBullets',
  'advancePlayerBullets',
] as const;

/** The single file that may define the shared projectile helpers. */
const PROJECTILE_HELPER_FILE = 'src/scenes/core/bulletLifecycle.ts';

/** Scenes that own enemy-bullet advancement. */
const ENEMY_BULLET_SCENE_FILES = [
  'src/scenes/PlayScene.ts',
  'src/scenes/gym/core/GymFormationScene.ts',
  'src/scenes/gym/GymPowerUpsCombat.ts',
];

/** Scenes that own player-bullet advancement. */
const PLAYER_BULLET_SCENE_FILES = [
  'src/scenes/PlayScene.ts',
  'src/scenes/gym/core/GymFormationScene.ts',
  'src/scenes/gym/GymWeapons.ts',
];

describe('shared projectile-lifecycle helper — defined once and consumed everywhere (AC1)', () => {
  it('defines each helper exactly once, in the shared module', () => {
    const files = productionSceneFiles();
    for (const helper of PROJECTILE_HELPERS) {
      const definers = files
        .filter((file) =>
          definesFunction(fs.readFileSync(file, 'utf8'), helper),
        )
        .map((file) => path.relative(process.cwd(), file))
        .sort();
      expect(definers).toEqual([PROJECTILE_HELPER_FILE]);
    }
  });

  it('every enemy-bullet scene routes through the shared enemy helper', () => {
    for (const file of ENEMY_BULLET_SCENE_FILES) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source, `${file} must call advanceWrappingBullets`).toContain(
        'advanceWrappingBullets(',
      );
    }
  });

  it('every player-bullet scene routes through the shared player helper', () => {
    for (const file of PLAYER_BULLET_SCENE_FILES) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source, `${file} must call advancePlayerBullets`).toContain(
        'advancePlayerBullets(',
      );
    }
  });
});

/** A scene that owns enemy bullets and can be driven for equivalence. */
type EnemyBulletOwner = PlayScene | EquivGymScene | GymPowerUpsCombat;

/** A scene that owns player bullets and can be driven for equivalence. */
type PlayerBulletOwner = PlayScene | EquivGymScene | GymWeapons;

/** The lifecycle values injected into an enemy bullet for a test case. */
interface EnemyBulletValues {
  x: number;
  y: number;
  vx: number;
  vy: number;
  lifetime: number;
}

/** Injects an enemy bullet with the given lifecycle values into a scene. */
function pushEnemyBullet(
  owner: EnemyBulletOwner,
  bullet: EnemyBulletValues,
): Phaser.GameObjects.Graphics {
  if (owner instanceof EquivGymScene) {
    const created = new EquivBullet(owner);
    created.graphics.setPosition(bullet.x, bullet.y);
    created.vx = bullet.vx;
    created.vy = bullet.vy;
    created.lifetime = bullet.lifetime;
    (owner as unknown as { bullets: EquivBullet[] }).bullets.push(created);
    return created.graphics;
  }
  if (owner instanceof GymPowerUpsCombat) {
    const created = owner.spawnEnemyBullet(
      bullet.x,
      bullet.y,
      bullet.vx,
      bullet.vy,
    );
    created.lifetime = bullet.lifetime;
    return created.graphics;
  }
  return owner.spawnEnemyBullet(
    bullet.x,
    bullet.y,
    bullet.vx,
    bullet.vy,
    0xff4444,
    bullet.lifetime,
  ).graphics;
}

/** Advances a scene's enemy bullets through its shared helper. */
function advanceEnemyBullets(owner: EnemyBulletOwner, dt: number): void {
  if (owner instanceof EquivGymScene || owner instanceof GymPowerUpsCombat) {
    (
      owner as unknown as { _advanceEnemyBullets(dt: number): void }
    )._advanceEnemyBullets(dt);
    return;
  }
  (owner as unknown as { _advanceBullets(dt: number): void })._advanceBullets(dt);
}

/** The Graphics of a scene's live enemy bullets. */
function enemyBulletGraphics(
  owner: EnemyBulletOwner,
): Phaser.GameObjects.Graphics[] {
  if (owner instanceof EquivGymScene) {
    return owner.activeBullets.map((bullet) => bullet.graphics);
  }
  const bullets = owner.getEnemyBullets() as Array<{
    graphics: Phaser.GameObjects.Graphics;
  }>;
  return bullets.map((bullet) => bullet.graphics);
}

/** Injects a player bullet with the given lifecycle values into a scene. */
function pushPlayerBullet(
  owner: PlayerBulletOwner,
  bullet: EnemyBulletValues,
): PlayerBullet {
  return owner.spawnPlayerBullet(
    bullet.x,
    bullet.y,
    bullet.vx,
    bullet.vy,
    0x00ffff,
    bullet.lifetime,
  );
}

/** Advances a scene's player bullets through its shared helper. */
function advancePlayerBulletList(owner: PlayerBulletOwner, dt: number): void {
  if (owner instanceof GymWeapons) {
    owner.advanceBullets(dt);
    return;
  }
  if (owner instanceof EquivGymScene) {
    (
      owner as unknown as { _advancePlayerBullets(dt: number): void }
    )._advancePlayerBullets(dt);
    return;
  }
  (owner as unknown as { _advanceBullets(dt: number): void })._advanceBullets(dt);
}

describe('shared projectile lifecycle — cross-scene equivalence (AC2)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  async function bootOwners(): Promise<{
    play: PlayScene;
    formation: EquivGymScene;
    combat: GymPowerUpsCombat;
    weapons: GymWeapons;
  }> {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'projectile-play-host',
    );
    const formation = await bootScene(
      [EquivGymScene],
      'projectile-formation-host',
    );
    const combat = await bootScene(
      [GymPowerUpsCombat],
      'projectile-combat-host',
    );
    const weapons = await bootScene([GymWeapons], 'projectile-weapons-host');
    games.push(play, formation, combat, weapons);
    return {
      play: play.scene as PlayScene,
      formation: formation.scene as EquivGymScene,
      combat: combat.scene as GymPowerUpsCombat,
      weapons: weapons.scene as GymWeapons,
    };
  }

  it('wraps enemy bullets identically in the game and every bullet-owning gym', async () => {
    const booted = await bootOwners();
    const scenes: EnemyBulletOwner[] = [
      booted.play,
      booted.formation,
      booted.combat,
    ];

    const cases = [
      { label: 'no wrap', x: 100, y: 100, vx: 20, vy: 10, dt: 0.5, expectedX: 110, expectedY: 105 },
      { label: 'left→right', x: 1, y: 270, vx: -350, vy: 0, dt: 0.01, expectedX: 957.5, expectedY: 270 },
      { label: 'right→left', x: 958, y: 270, vx: 350, vy: 0, dt: 0.01, expectedX: 1.5, expectedY: 270 },
      { label: 'top→bottom', x: 480, y: 1, vx: 0, vy: -350, dt: 0.01, expectedX: 480, expectedY: 537.5 },
      { label: 'bottom→top', x: 480, y: 538, vx: 0, vy: 350, dt: 0.01, expectedX: 480, expectedY: 1.5 },
      { label: 'corner', x: 1, y: 1, vx: -350, vy: -350, dt: 0.01, expectedX: 957.5, expectedY: 537.5 },
    ];

    for (const scene of scenes) {
      for (const testCase of cases) {
        const graphics = pushEnemyBullet(scene, {
          x: testCase.x,
          y: testCase.y,
          vx: testCase.vx,
          vy: testCase.vy,
          lifetime: 5,
        });
        advanceEnemyBullets(scene, testCase.dt);
        const where = `${scene.constructor.name} ${testCase.label}`;
        expect(graphics.x, `${where} x`).toBeCloseTo(testCase.expectedX, 5);
        expect(graphics.y, `${where} y`).toBeCloseTo(testCase.expectedY, 5);
        expect(enemyBulletGraphics(scene), `${where} live`).toContain(graphics);
      }
    }
  });

  it('expires enemy bullets identically in the game and every bullet-owning gym', async () => {
    const booted = await bootOwners();
    const scenes: EnemyBulletOwner[] = [
      booted.play,
      booted.formation,
      booted.combat,
    ];

    for (const scene of scenes) {
      const graphics = pushEnemyBullet(scene, {
        x: 100,
        y: 100,
        vx: 0,
        vy: 0,
        lifetime: 0.5,
      });
      advanceEnemyBullets(scene, 0.25);
      expect(
        enemyBulletGraphics(scene),
        `${scene.constructor.name} alive`,
      ).toContain(graphics);
      advanceEnemyBullets(scene, 0.25); // exactly the 0.5 s lifetime
      expect(
        enemyBulletGraphics(scene),
        `${scene.constructor.name} expired`,
      ).not.toContain(graphics);
      expect(graphics.active, `${scene.constructor.name} destroyed`).toBe(false);
    }
  });

  it('advances and expires player bullets identically across the game and every gym', async () => {
    const booted = await bootOwners();
    const scenes: PlayerBulletOwner[] = [
      booted.play,
      booted.formation,
      booted.weapons,
    ];

    for (const scene of scenes) {
      const bullet = pushPlayerBullet(scene, {
        x: 1,
        y: 270,
        vx: -350,
        vy: 0,
        lifetime: 5,
      });
      advancePlayerBulletList(scene, 0.01);
      expect(bullet.x, `${scene.constructor.name} wrap x`).toBeCloseTo(957.5, 5);
      expect(bullet.y, `${scene.constructor.name} wrap y`).toBeCloseTo(270, 5);
    }

    for (const scene of scenes) {
      const bullet = pushPlayerBullet(scene, {
        x: 100,
        y: 100,
        vx: 0,
        vy: 0,
        lifetime: 0.5,
      });
      advancePlayerBulletList(scene, 0.5);
      expect(
        bullet.active,
        `${scene.constructor.name} player bullet expired`,
      ).toBe(false);
    }
  });
});
