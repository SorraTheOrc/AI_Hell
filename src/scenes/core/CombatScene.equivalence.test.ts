import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
import { GymEnemies } from '../gym/GymEnemies';
import { GymPowerUpsUtility } from '../gym/GymPowerUpsUtility';
import { GymWeapons } from '../gym/GymWeapons';
import {
  GymFormationScene,
  type EnemyFormationConfig,
  type FormationSceneBullet,
  type FormationSceneEntity,
} from '../gym/core/GymFormationScene';
import { CombatScene } from './CombatScene';
import { CombatCoreScene } from './CombatCoreScene';
import {
  collectProductionSourceFiles,
  definesFunction,
  definesMethod,
} from '../../test/duplicateBodyGuard';
import type { PlayerBullet } from '../../entities/PlayerBullet';
import type { Boss } from '../../entities/Boss';
import { ENEMY_FIRE_METHODS, fireForEnemy } from '../../entities/enemyFire';
import { createEnemyFromConfig } from '../../entities/enemyFactory';
import { loadEnemyConfig } from '../../core/enemyConfig';
import { GymBoss } from '../gym/GymBoss';

// These equivalence tests boot full Phaser games and walk PlayScene to the
// boss encounter; under full-suite parallel load the Vitest default 5 s
// timeout is too tight (AH-0MUIPP1UU000UT88). Give the file headroom so a
// slow parallel run does not fail on timing alone (AH-0MUII3GOO001XEBB).
vi.setConfig({ testTimeout: 20000 });

/** The nine shared combat/lifecycle template methods (parent AC1/AC2). */
const SHARED_METHODS = [
  '_handleCollisions',
  '_hitPlayer',
  '_autoFire',
  '_collectDrop',
  '_spawnPlayerExplosion',
  '_clearEnemyBullets',
  '_handleTeleport',
  '_readPlayerInput',
  '_tickPlayer',
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

  it('P5 boost yields the same speed/fire-rate outcome in the game and a gym', async () => {
    const { play, gym } = await bootBoth();
    play.getEffectsRegistry().applyCollect('P5');
    gym.getEffectsRegistry().applyCollect('P5');

    play.tick(0.5);
    gym.tick(0.5);

    const playPlayer = play.getPlayer()!;
    const gymPlayer = gym.getPlayer()!;
    // The shared step reads the live multipliers from each scene's own
    // effects registry; the P5 outcome must be identical.
    expect(playPlayer.getFireRateMultiplier()).toBeCloseTo(
      gymPlayer.getFireRateMultiplier(),
      10,
    );
    expect(playPlayer.getMovementConfig().thrust).toBeCloseTo(
      gymPlayer.getMovementConfig().thrust,
      10,
    );
    expect(playPlayer.getMovementConfig().maxSpeed).toBeCloseTo(
      gymPlayer.getMovementConfig().maxSpeed,
      10,
    );
    expect(playPlayer.getFireRateMultiplier()).toBeCloseTo(1.5, 10);
  });

  it('expires timed weapons identically in the game and a gym (timers before auto-fire)', async () => {
    const { play, gym } = await bootBoth();
    play.getPlayer()!.equipWeapon('spread');
    gym.getPlayer()!.equipWeapon('spread');
    expect(play.getPlayer()!.getActiveWeapons()).toContain('spread');
    expect(gym.getPlayer()!.getActiveWeapons()).toContain('spread');

    // One step longer than the 10 s weapon lifetime: the shared step
    // advances the timers before auto-fire, so the weapon expires and
    // does not fire this frame in either scene.
    play.tick(10.1);
    gym.tick(10.1);

    expect(play.getPlayer()!.getActiveWeapons()).toEqual(['cannon']);
    expect(gym.getPlayer()!.getActiveWeapons()).toEqual(['cannon']);
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

// ── Shared enemy-fire dispatcher guard (AH-0MUII3BBW000XZ46, AC1) ─────

describe('CombatScene — shared enemy-fire dispatcher is defined once', () => {
  const FIRE_HELPER = 'fireForEnemy';
  const FIRE_HELPER_FILE = 'src/entities/enemyFire.ts';

  /** Every production TypeScript file under `src/` (excluding tests). */
  function productionSourceFiles(): string[] {
    return collectProductionSourceFiles(path.resolve(process.cwd(), 'src'));
  }

  it('defines the dispatcher exactly once, in the shared helper', () => {
    const definers = productionSourceFiles()
      .filter((file) =>
        definesFunction(fs.readFileSync(file, 'utf8'), FIRE_HELPER),
      )
      .map((file) => path.relative(process.cwd(), file))
      .sort();

    expect(definers).toEqual([FIRE_HELPER_FILE]);
  });

  it('PlayScene and GymEnemies consume the dispatcher and keep no local switch', () => {
    // The game's private archetype switch (`_fireFor`) is deleted entirely.
    expect(
      Object.prototype.hasOwnProperty.call(PlayScene.prototype, '_fireFor'),
    ).toBe(false);

    for (const file of [
      'src/scenes/PlayScene.ts',
      'src/scenes/gym/GymEnemies.ts',
    ]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source, `${file} must consume the shared dispatcher`).toContain(
        FIRE_HELPER,
      );
      // ... and must not re-map archetype keys to fire method names itself.
      expect(source, `${file} must not map tryFire* names`).not.toMatch(
        /['"]tryFire[A-Z]/,
      );
    }
  });

  it('the combat gym uses the dispatcher with the real scene clock, not a fake one', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/scenes/gym/GymPowerUpsCombat.ts'),
      'utf8',
    );
    expect(source).toContain(FIRE_HELPER);
    // The fake fixed-16 ms frame accumulator is gone (AC2).
    expect(source).not.toContain('_nextFireTime');
  });
});

// ── Shared teleport path (gap 7, AH-0MUII3EPU0039R5O) ───────────────

/**
 * The combat gym used to carry a full copy of the shared
 * `CombatScene.triggerTeleport` that bypassed `canTeleport()` and
 * hard-coded the hit radii. It now resolves to the single shared path and
 * supplies its specifics through the overridable hooks.
 */
describe('shared teleport path — GymPowerUpsCombat (gap 7)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  it('GymPowerUpsCombat does not define triggerTeleport; it resolves to the shared core', () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        GymPowerUpsCombat.prototype,
        'triggerTeleport',
      ),
    ).toBe(false);
    expect(
      (GymPowerUpsCombat.prototype as unknown as Record<string, unknown>)
        .triggerTeleport,
    ).toBe(
      (CombatScene.prototype as unknown as Record<string, unknown>)
        .triggerTeleport,
    );
  });

  it('triggerTeleport is defined exactly once repo-wide, in the shared combat core', () => {
    const definers = productionSceneFiles()
      .filter((file) =>
        definesMethod(fs.readFileSync(file, 'utf8'), 'triggerTeleport'),
      )
      .map((file) => path.relative(process.cwd(), file))
      .sort();

    expect(definers).toEqual(['src/scenes/core/CombatScene.ts']);
  });

  it('the gym supplies its teleport hit radii through the overridable hooks', async () => {
    const booted = await bootScene(
      [GymPowerUpsCombat],
      'teleport-hooks-host',
    );
    games.push(booted);
    const hooks = booted.scene as unknown as {
      getTeleportEnemyHitRadius(): number;
      getTeleportBulletHitRadius(): number;
    };

    // The gym owns the hooks rather than relying on the shared defaults.
    expect(
      Object.prototype.hasOwnProperty.call(
        GymPowerUpsCombat.prototype,
        'getTeleportEnemyHitRadius',
      ),
    ).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(
        GymPowerUpsCombat.prototype,
        'getTeleportBulletHitRadius',
      ),
    ).toBe(true);
    // SCOUT_SIZE / 2 + 4 and the shared 5 px bullet radius.
    expect(hooks.getTeleportEnemyHitRadius()).toBe(12);
    expect(hooks.getTeleportBulletHitRadius()).toBe(5);
  });

  it('avoids an enemy body identically to a config-driven gym (per-entity radius)', async () => {
    const combat = await bootScene(
      [GymPowerUpsCombat],
      'teleport-combat-enemy-host',
    );
    const formation = await bootScene(
      [EquivGymScene],
      'teleport-formation-enemy-host',
    );
    games.push(combat, formation);
    const combatScene = combat.scene as GymPowerUpsCombat;
    const formationScene = formation.scene as EquivGymScene;

    // No bullets; one enemy each at the same spot, 71 px beyond the 80 px
    // ray candidate. It is safe for a 10 px entity radius (60 + 10 = 70)
    // but not for the old hard-coded 12 px scalar (60 + 12 = 72).
    (combatScene as unknown as { scoutBullets: unknown[] }).scoutBullets.length = 0;
    (formationScene as unknown as { bullets: unknown[] }).bullets.length = 0;
    const targetX = 300 + 80 + 71;
    const targetY = 400;
    combatScene.getScouts().forEach((scout, index) => {
      if (index === 0) scout.setPosition(targetX, targetY);
      else scout.destroySelf();
    });
    (
      formationScene as unknown as { entities: EquivEnemy[] }
    ).entities.forEach((entity, index) => {
      if (index === 0) entity.setPosition(targetX, targetY);
      else entity.destroySelf();
    });

    for (const player of [
      combatScene.getPlayer()!,
      formationScene.getPlayer()!,
    ]) {
      player.setPosition(300, 400);
      const state = player.getMovementState();
      (
        player as unknown as { _movementState: Record<string, unknown> }
      )._movementState = {
        ...state,
        x: 300,
        y: 400,
        vx: 0,
        vy: 0,
        facing: 0,
      };
    }

    combatScene.getEffectsRegistry().applyCollect('P7');
    formationScene.getEffectsRegistry().applyCollect('P7');

    expect(combatScene.triggerTeleport()).toBe(true);
    expect(formationScene.triggerTeleport()).toBe(true);

    // Both resolve the nearest safe ray candidate through the shared path.
    expect(combatScene.getPlayer()!.x).toBeCloseTo(380, 5);
    expect(formationScene.getPlayer()!.x).toBeCloseTo(380, 5);
    expect(combatScene.getPlayer()!.y).toBeCloseTo(400, 5);
    expect(formationScene.getPlayer()!.y).toBeCloseTo(400, 5);
  });

  it('destination selection, FIFO consumption and P6-on-arrival match the game', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'teleport-play-host',
    );
    const combat = await bootScene(
      [GymPowerUpsCombat],
      'teleport-combat-host',
    );
    games.push(play, combat);
    const playScene = play.scene as PlayScene;
    const combatScene = combat.scene as GymPowerUpsCombat;

    // Remove live obstacles so both scenes resolve the same safe-spot ray.
    (playScene as unknown as { spawned: unknown[] }).spawned.length = 0;
    (playScene as unknown as { enemyBullets: unknown[] }).enemyBullets.length = 0;
    (combatScene as unknown as { scouts: unknown[] }).scouts.length = 0;
    (combatScene as unknown as { scoutBullets: unknown[] }).scoutBullets.length = 0;

    // Park each ship at the same spot with the same heading (facing right).
    for (const player of [playScene.getPlayer()!, combatScene.getPlayer()!]) {
      player.setPosition(300, 400);
      const state = player.getMovementState();
      (
        player as unknown as { _movementState: Record<string, unknown> }
      )._movementState = {
        ...state,
        x: 300,
        y: 400,
        vx: 0,
        vy: 0,
        facing: 0,
      };
    }

    // Two P7 stacks each so FIFO consumption is observable.
    for (const registry of [
      playScene.getEffectsRegistry(),
      combatScene.getEffectsRegistry(),
    ]) {
      registry.applyCollect('P7');
      registry.applyCollect('P7');
    }

    expect(playScene.triggerTeleport()).toBe(true);
    expect(combatScene.triggerTeleport()).toBe(true);

    // Same inputs through the same shared algorithm → same landing spot.
    expect(combatScene.getPlayer()!.x).toBe(playScene.getPlayer()!.x);
    expect(combatScene.getPlayer()!.y).toBe(playScene.getPlayer()!.y);
    expect(playScene.getEffectsRegistry().teleportStacks()).toBe(1);
    expect(combatScene.getEffectsRegistry().teleportStacks()).toBe(1);
    expect(playScene.getEffectsRegistry().isPhased).toBe(true);
    expect(combatScene.getEffectsRegistry().isPhased).toBe(true);

    // The second teleport consumes the remaining stack on both.
    expect(playScene.triggerTeleport()).toBe(true);
    expect(combatScene.triggerTeleport()).toBe(true);
    expect(playScene.getEffectsRegistry().teleportStacks()).toBe(0);
    expect(combatScene.getEffectsRegistry().teleportStacks()).toBe(0);
  });
});

// ── Shared power-up drop layer (gap 4, AH-0MUII3CXX0023H24) ─────────

/** The five pure helpers that own the drop layer. */
const DROP_HELPERS = [
  'buildDefaultDropSpawner',
  'advanceDropLifecycles',
  'collectOverlappingDrops',
  'applyDropMagnet',
  'playDropPickupCue',
] as const;

/** The single file that may define a shared drop-layer helper. */
const DROP_LAYER_FILE = 'src/scenes/core/dropLayer.ts';

/** Shared drop-layer template methods hosted by `CombatCoreScene`. */
const SHARED_DROP_METHODS = [
  '_buildDefaultDropSpawner',
  '_advanceDropLifecycles',
  '_collectOverlappingDrops',
  '_applyDropMagnet',
  '_updateDropLayer',
  '_playPickupCue',
] as const;

/** Every production scene that owns power-up drops. */
const DROP_SCENE_PROTOTYPES: Array<[string, object]> = [
  ['PlayScene', PlayScene.prototype],
  ['GymFormationScene', GymFormationScene.prototype],
  ['GymWeapons', GymWeapons.prototype],
  ['GymPowerUpsCombat', GymPowerUpsCombat.prototype],
  ['GymPowerUpsUtility', GymPowerUpsUtility.prototype],
];

describe('shared power-up drop layer — defined once and consumed everywhere (AC1)', () => {
  /** Every production TypeScript file under `src/` (excluding tests). */
  function productionSourceFiles(): string[] {
    return collectProductionSourceFiles(path.resolve(process.cwd(), 'src'));
  }

  it('defines each drop-layer helper exactly once, in the shared module', () => {
    const files = productionSourceFiles();
    for (const helper of DROP_HELPERS) {
      const definers = files
        .filter((file) => definesFunction(fs.readFileSync(file, 'utf8'), helper))
        .map((file) => path.relative(process.cwd(), file))
        .sort();
      expect(definers, helper).toEqual([DROP_LAYER_FILE]);
    }
  });

  it('hosts the shared drop template methods only on the shared core (no scene overrides)', () => {
    const files = productionSourceFiles();
    for (const method of SHARED_DROP_METHODS) {
      const definers = files
        .filter((file) => definesMethod(fs.readFileSync(file, 'utf8'), method))
        .map((file) => path.relative(process.cwd(), file))
        .sort();
      expect(definers, method).toEqual(['src/scenes/core/CombatCoreScene.ts']);
    }
  });

  it('every drop scene resolves the shared methods to the same core function objects', () => {
    const core = CombatCoreScene.prototype as unknown as Record<string, unknown>;
    for (const [name, prototype] of DROP_SCENE_PROTOTYPES) {
      for (const method of SHARED_DROP_METHODS) {
        expect(
          Object.prototype.hasOwnProperty.call(prototype, method),
          `${name}.prototype must not define ${method}`,
        ).toBe(false);
        expect(
          (prototype as unknown as Record<string, unknown>)[method],
          `${name}.prototype.${method} must be the shared hook`,
        ).toBe(core[method]);
      }
    }
  });

  it('every drop scene consumes at least one shared drop operation', () => {
    const consumers: Array<[string, string]> = [
      ['src/scenes/PlayScene.ts', '_updateDropLayer('],
      ['src/scenes/gym/core/GymFormationScene.ts', '_updateDropLayer('],
      ['src/scenes/gym/GymPowerUpsCombat.ts', '_updateDropLayer('],
      ['src/scenes/gym/GymPowerUpsUtility.ts', '_updateDropLayer('],
      ['src/scenes/gym/GymWeapons.ts', '_advanceDropLifecycles('],
    ];
    for (const [file, call] of consumers) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source, `${file} must consume ${call}`).toContain(call);
    }
  });
});

describe('shared power-up drop layer — cross-scene equivalence (AC5)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  async function bootDrops(): Promise<{
    play: PlayScene;
    formation: EquivGymScene;
    utility: GymPowerUpsUtility;
    combat: GymPowerUpsCombat;
    weapons: GymWeapons;
  }> {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'drop-equivalence-play-host',
    );
    const formation = await bootScene([EquivGymScene], 'drop-equivalence-formation-host');
    const utility = await bootScene([GymPowerUpsUtility], 'drop-equivalence-utility-host');
    const combat = await bootScene([GymPowerUpsCombat], 'drop-equivalence-combat-host');
    const weapons = await bootScene([GymWeapons], 'drop-equivalence-weapons-host');
    games.push(play, formation, utility, combat, weapons);
    return {
      play: play.scene as PlayScene,
      formation: formation.scene as EquivGymScene,
      utility: utility.scene as GymPowerUpsUtility,
      combat: combat.scene as GymPowerUpsCombat,
      weapons: weapons.scene as GymWeapons,
    };
  }

  it('advances lifecycles identically for the same dt', async () => {
    const { play, formation, utility, combat } = await bootDrops();

    // Park every player far from the drop so no scene collects it.
    play.getPlayer()!.setPosition(50, 50);
    formation.getPlayer()!.setPosition(50, 50);
    utility.getPlayer()!.setPosition(50, 50);
    combat.getPlayer()!.setPosition(50, 50);

    const p = play.spawnPowerUpDrop('P5', 700, 100)!;
    const f = formation.spawnPowerUpDrop('P5', 700, 100)!;
    const u = utility.spawnDrop('P5', 700, 100);
    const c = combat.spawnDrop('P5', 700, 100);

    play.tick(0.25);
    formation.tick(0.25);
    utility.advanceDrops(0.25);
    combat.advanceDrops(0.25);

    const scales = [p, f, u, c].map((drop) => drop.powerUp.currentScale);
    expect(scales[0]).toBeCloseTo(0.5, 5);
    for (const scale of scales) expect(scale).toBeCloseTo(scales[0], 5);
  });

  it('collects the same drop type through the shared gate and applies the same effect', async () => {
    const { play, formation, utility, combat } = await bootDrops();

    const playDrop = play.spawnPowerUpDrop('P3', play.getPlayer()!.x, play.getPlayer()!.y)!;
    const fDrop = formation.spawnPowerUpDrop('P3', formation.getPlayer()!.x, formation.getPlayer()!.y)!;
    const uDrop = utility.spawnDrop('P3', utility.getPlayer()!.x, utility.getPlayer()!.y);
    const cDrop = combat.spawnDrop('P3', combat.getPlayer()!.x, combat.getPlayer()!.y);
    for (const drop of [playDrop, fDrop, uDrop, cDrop]) drop.powerUp.advance(0.5);

    play.tick(0.001);
    formation.tick(0.001);
    utility.tick(0.001);
    combat.tick(0.001);

    expect(play.getEffectsRegistry().isShielded).toBe(true);
    expect(formation.getEffectsRegistry().isShielded).toBe(true);
    expect(utility.getEffectsRegistry().isShielded).toBe(true);
    expect(combat.getEffectsRegistry().isShielded).toBe(true);
  });

  it('pulls a grown drop toward the ship wherever drops exist (P9 magnet parity)', async () => {
    const { play, formation, utility, combat, weapons } = await bootDrops();

    const owners = [play, formation, utility, combat, weapons];
    for (const owner of owners) owner.getEffectsRegistry().applyCollect('P9');

    // Spawn each drop 30 px to the right of the scene's own player (no
    // scene position assumptions — PlayScene's physics owns its position).
    const playPlayer = play.getPlayer()!;
    const playDrop = play.spawnPowerUpDrop('P5', playPlayer.x + 30, playPlayer.y)!;
    const fPlayer = formation.getPlayer()!;
    const fDrop = formation.spawnPowerUpDrop('P5', fPlayer.x + 30, fPlayer.y)!;
    const uPlayer = utility.getPlayer()!;
    const uDrop = utility.spawnDrop('P5', uPlayer.x + 30, uPlayer.y);
    const cPlayer = combat.getPlayer()!;
    const cDrop = combat.spawnDrop('P5', cPlayer.x + 30, cPlayer.y);
    const wPlayer = weapons.getPlayer()!;
    const wDrop = weapons.spawnDrop('spread', wPlayer.x + 30, wPlayer.y);
    const drops = [playDrop, fDrop, uDrop, cDrop, wDrop];
    const starts = drops.map((drop) => drop.x);
    for (const drop of drops) drop.powerUp.advance(0.5);

    play.tick(0.5);
    formation.tick(0.5);
    utility.tick(0.5);
    combat.tick(0.5);
    weapons.tick(0.5);

    drops.forEach((drop, index) => {
      expect(drop.x, 'drop pulled toward the ship').toBeLessThan(starts[index]!);
      expect(drop.graphics.x).toBeCloseTo(drop.x, 5);
    });
  });

  it('shows the P4 bomb notice in every scene that can collect a P4', async () => {
    const { play, formation, combat } = await bootDrops();

    const playDrop = play.spawnPowerUpDrop('P4', play.getPlayer()!.x, play.getPlayer()!.y)!;
    const fDrop = formation.spawnPowerUpDrop('P4', formation.getPlayer()!.x, formation.getPlayer()!.y)!;
    const cDrop = combat.spawnDrop('P4', combat.getPlayer()!.x, combat.getPlayer()!.y);
    for (const drop of [playDrop, fDrop, cDrop]) drop.powerUp.advance(0.5);

    play.tick(0.001);
    formation.tick(0.001);
    combat.tick(0.001);

    expect(play.isBombNoticeVisible()).toBe(true);
    expect(formation.isBombNoticeVisible()).toBe(true);
    expect(combat.isBombNoticeVisible()).toBe(true);

    // The shared component auto-hides after its 1.2 s timer everywhere.
    play.tick(2);
    formation.tick(2);
    combat.tick(2);
    expect(play.isBombNoticeVisible()).toBe(false);
    expect(formation.isBombNoticeVisible()).toBe(false);
    expect(combat.isBombNoticeVisible()).toBe(false);
  });

  it('plays the same per-type cue for the same drop in every scene', async () => {
    const { play, formation, utility, weapons } = await bootDrops();
    const speedCue = vi.spyOn(effectsModule, 'playSpeedBoostCollectSound');
    const spreadCue = vi.spyOn(effectsModule, 'playSpreadPickupSound');

    const playDrop = play.spawnPowerUpDrop('P5', play.getPlayer()!.x, play.getPlayer()!.y)!;
    const fDrop = formation.spawnPowerUpDrop('P5', formation.getPlayer()!.x, formation.getPlayer()!.y)!;
    const uDrop = utility.spawnDrop('P5', utility.getPlayer()!.x, utility.getPlayer()!.y);
    for (const drop of [playDrop, fDrop, uDrop]) drop.powerUp.advance(0.5);
    play.tick(0.001);
    formation.tick(0.001);
    utility.tick(0.001);
    expect(speedCue).toHaveBeenCalledTimes(3);

    const playWeapon = play.spawnPowerUpDrop('spread', play.getPlayer()!.x, play.getPlayer()!.y)!;
    const wDrop = weapons.spawnDrop('spread', weapons.getPlayer()!.x, weapons.getPlayer()!.y);
    playWeapon.powerUp.advance(0.5);
    wDrop.powerUp.advance(0.5);
    play.tick(0.001);
    weapons.tick(0.001);
    expect(spreadCue).toHaveBeenCalledTimes(2);
  });
});

// ── Shared player-control step (AH-0MUII39KX007YUQ0, gaps 1 & 11) ───

/**
 * Scenes that must consume the shared `_tickPlayer` step rather than a
 * local copy (AC1). `GymPowerUpsCombat` also consumes it but disables
 * auto-fire via the `autoFireEnabled` hook (its scouts must survive).
 */
const TICK_PLAYER_CONSUMERS: Array<[string, object]> = [
  ['PlayScene', PlayScene.prototype],
  ['GymFormationScene', GymFormationScene.prototype],
  ['GymWeapons', GymWeapons.prototype],
  ['GymPowerUpsUtility', GymPowerUpsUtility.prototype],
];

describe('shared player-control step — defined once and consumed everywhere (AC1)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  it('every consumer inherits `_tickPlayer` from the shared core', () => {
    for (const [name, prototype] of TICK_PLAYER_CONSUMERS) {
      expect(
        Object.prototype.hasOwnProperty.call(prototype, '_tickPlayer'),
        `${name}.prototype must not define _tickPlayer`,
      ).toBe(false);
      expect(
        (prototype as unknown as Record<string, unknown>)['_tickPlayer'],
        `${name}.prototype._tickPlayer must be the shared core method`,
      ).toBe(
        (CombatCoreScene.prototype as unknown as Record<string, unknown>)[
          '_tickPlayer'
        ],
      );
    }
  });

  it('defines `_tickPlayer` exactly once repo-wide, in the shared core', () => {
    const definers = productionSceneFiles()
      .filter((file) =>
        definesMethod(fs.readFileSync(file, 'utf8'), '_tickPlayer'),
      )
      .map((file) => path.relative(process.cwd(), file))
      .sort();
    expect(definers).toEqual(['src/scenes/core/CombatCoreScene.ts']);
  });

  it('weapon-free gyms disable auto-fire so no player bullets are emitted', async () => {
    const utility = await bootScene([GymPowerUpsUtility], 'autofire-utility-host');
    const combat = await bootScene([GymPowerUpsCombat], 'autofire-combat-host');
    const weapons = await bootScene([GymWeapons], 'autofire-weapons-host');
    games.push(utility, combat, weapons);

    (utility.scene as GymPowerUpsUtility).tick(0.5);
    (combat.scene as GymPowerUpsCombat).tick(0.5);
    (weapons.scene as GymWeapons).tick(0.5);

    const playerBullets = (
      scene: GymPowerUpsUtility | GymPowerUpsCombat,
    ): unknown[] =>
      (scene as unknown as { playerBullets: unknown[] }).playerBullets;

    expect(playerBullets(utility.scene as GymPowerUpsUtility)).toHaveLength(0);
    expect(playerBullets(combat.scene as GymPowerUpsCombat)).toHaveLength(0);
    // The weapon-enabled gym still auto-fires normally.
    expect((weapons.scene as GymWeapons).getBullets().length).toBeGreaterThan(0);
  });
});

describe('shared scheme→input mapping — defined once and consumed by GymPlayer (AC2)', () => {
  /** Every production TypeScript file under `src/` (excluding tests). */
  function allProductionSourceFiles(): string[] {
    return collectProductionSourceFiles(path.resolve(process.cwd(), 'src'));
  }

  it('defines mapControlInput exactly once, in the movement-model module', () => {
    const definers = allProductionSourceFiles()
      .filter((file) =>
        definesFunction(fs.readFileSync(file, 'utf8'), 'mapControlInput'),
      )
      .map((file) => path.relative(process.cwd(), file))
      .sort();
    expect(definers).toEqual(['src/utils/movementModel.ts']);
  });

  it('GymPlayer consumes the shared helper and no longer inlines the handlers', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/scenes/gym/GymPlayer.ts'),
      'utf8',
    );
    expect(source).toContain('mapControlInput(');
    expect(source).not.toContain('FourDirectionalInputHandler');
    expect(source).not.toContain('AsteroidsInputHandler');
  });

  it('CombatCoreScene._readPlayerInput delegates to the shared helper', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/scenes/core/CombatCoreScene.ts'),
      'utf8',
    );
    expect(source).toContain('mapControlInput(');
    expect(source).not.toContain('FourDirectionalInputHandler');
    expect(source).not.toContain('AsteroidsInputHandler');
  });
});

// ── Shared boss integration (AH-0MUII3E5E006A93F, gap 6) ───────────

/**
 * Walks the PlayScene run to the boss encounter (Level 5 cleared) by
 * destroying every enemy deterministically.
 */
function reachPlayBoss(play: PlayScene): void {
  play.getGameState().lives = 99;
  for (let guard = 0; guard < 300 && !play.getBoss(); guard++) {
    for (let inner = 0; inner < 500 && play.getAliveCount() > 0; inner++) {
      const enemy = play.getEnemies().find((e) => e.alive);
      if (!enemy) break;
      play.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
      play.tick(0.016);
    }
    if (play.isTransitioning()) play.tick(3.0);
  }
}

/** Stubs a boss to emit one deterministic bullet on its next update. */
function stubBossSingleBullet(boss: Boss): Phaser.GameObjects.Graphics {
  const graphics = boss.scene.add.graphics();
  boss.update = (() =>
    [
      {
        graphics,
        vx: 0,
        vy: 0,
        color: 0xffffff,
        lifetime: 4,
        elapsed: 0,
      },
    ]) as unknown as typeof boss.update;
  return graphics;
}

describe('shared boss integration — advanced by one tick in both scenes (AH-0MUII3E5E006A93F, AC1)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  it('a single tick(dt) advances the boss in PlayScene and GymBoss alike', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'boss-equiv-play-host',
    );
    const gym = await bootScene([GymBoss], 'boss-equiv-gym-host');
    games.push(play, gym);
    const playScene = play.scene as PlayScene;
    const gymScene = gym.scene as GymBoss;

    reachPlayBoss(playScene);
    expect(playScene.getBoss()).not.toBeNull();

    const playGraphics = stubBossSingleBullet(playScene.getBoss()!);
    const gymGraphics = stubBossSingleBullet(gymScene.formationBoss);

    playScene.tick(0.016);
    gymScene.tick(0.016);

    // Both scenes collected their boss bullet through the shared hook.
    expect(
      playScene.getEnemyBullets().some((b) => b.graphics === playGraphics),
    ).toBe(true);
    expect(
      gymScene.activeBullets.some((b) => b.graphics === gymGraphics),
    ).toBe(true);
  });

  it('both scenes inherit the shared boss advance and teleport avoidance', () => {
    const core = CombatScene.prototype as unknown as Record<string, unknown>;
    for (const method of ['_advanceBoss', 'getAdditionalTeleportBodies']) {
      expect(
        Object.prototype.hasOwnProperty.call(PlayScene.prototype, method),
        `PlayScene must not define ${method}`,
      ).toBe(false);
      expect(
        (PlayScene.prototype as unknown as Record<string, unknown>)[method],
      ).toBe(core[method]);
      expect(
        (GymBoss.prototype as unknown as Record<string, unknown>)[method],
      ).toBe(core[method]);
    }
  });
});

// ── Consolidated epic parity guard (AH-0MUII3GOO001XEBB, AC1) ───────

/**
 * Every shared pure helper introduced or touched by the gym-parity epic
 * (parent AH-0MUII2FJ5007MDDA) and the one production file allowed to define
 * it. A scene that re-introduces a copy fails this guard.
 */
const EPIC_SHARED_HELPERS: ReadonlyArray<readonly [string, string]> = [
  ['advanceWrappingBullets', 'src/scenes/core/bulletLifecycle.ts'],
  ['advancePlayerBullets', 'src/scenes/core/bulletLifecycle.ts'],
  ['fireForEnemy', 'src/entities/enemyFire.ts'],
  ['enemyFireMethod', 'src/entities/enemyFire.ts'],
  ['buildDefaultDropSpawner', 'src/scenes/core/dropLayer.ts'],
  ['advanceDropLifecycles', 'src/scenes/core/dropLayer.ts'],
  ['collectOverlappingDrops', 'src/scenes/core/dropLayer.ts'],
  ['applyDropMagnet', 'src/scenes/core/dropLayer.ts'],
  ['playDropPickupCue', 'src/scenes/core/dropLayer.ts'],
  ['collectMinerals', 'src/scenes/core/mineralLayer.ts'],
  ['applyMineralChoiceReward', 'src/scenes/core/mineralLayer.ts'],
  ['isMineralAbsorbingEnemy', 'src/scenes/core/mineralLayer.ts'],
  ['resolveMineralKillDrops', 'src/scenes/core/mineralKillDrops.ts'],
  ['mapControlInput', 'src/utils/movementModel.ts'],
  ['splitAsteroid', 'src/scenes/core/asteroidSplit.ts'],
];

/**
 * Every shared template method the epic introduced or touched, with the one
 * core that must define it. Overridable seams (`onBossAdvanced`,
 * `respawnFormation`, `getBoss`, …) are intentionally excluded: a scene may
 * override a hook, but must not re-implement the shared behaviour.
 */
const EPIC_SHARED_METHODS: ReadonlyArray<readonly [string, string]> = [
  ['_tickPlayer', 'src/scenes/core/CombatCoreScene.ts'],
  ['_readPlayerInput', 'src/scenes/core/CombatCoreScene.ts'],
  ['_autoFire', 'src/scenes/core/CombatCoreScene.ts'],
  ['_collectDrop', 'src/scenes/core/CombatCoreScene.ts'],
  ['_spawnPlayerExplosion', 'src/scenes/core/CombatCoreScene.ts'],
  ['_clearEnemyBullets', 'src/scenes/core/CombatCoreScene.ts'],
  ['_buildDefaultDropSpawner', 'src/scenes/core/CombatCoreScene.ts'],
  ['_advanceDropLifecycles', 'src/scenes/core/CombatCoreScene.ts'],
  ['_collectOverlappingDrops', 'src/scenes/core/CombatCoreScene.ts'],
  ['_applyDropMagnet', 'src/scenes/core/CombatCoreScene.ts'],
  ['_updateDropLayer', 'src/scenes/core/CombatCoreScene.ts'],
  ['_playPickupCue', 'src/scenes/core/CombatCoreScene.ts'],
  ['_handleCollisions', 'src/scenes/core/CombatScene.ts'],
  ['_hitPlayer', 'src/scenes/core/CombatScene.ts'],
  ['_handleTeleport', 'src/scenes/core/CombatScene.ts'],
  ['triggerTeleport', 'src/scenes/core/CombatScene.ts'],
  ['_advanceBoss', 'src/scenes/core/CombatScene.ts'],
  ['getAdditionalTeleportBodies', 'src/scenes/core/CombatScene.ts'],
  ['setPlayerEnabled', 'src/scenes/gym/core/GymFormationScene.ts'],
  ['registerDynamicEntity', 'src/scenes/gym/core/GymFormationScene.ts'],
];

/** Relative paths of production files satisfying `predicate`, sorted. */
function relativeProductionDefiners(
  predicate: (source: string) => boolean,
): string[] {
  return collectProductionSourceFiles(path.resolve(process.cwd(), 'src'))
    .filter((file) => predicate(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(process.cwd(), file))
    .sort();
}

describe('epic parity guard — every shared helper is defined exactly once (AC1)', () => {
  it('defines every shared pure helper exactly once, in its canonical module', () => {
    for (const [helper, expected] of EPIC_SHARED_HELPERS) {
      const definers = relativeProductionDefiners((source) =>
        definesFunction(source, helper),
      );
      expect(definers, helper).toEqual([expected]);
    }
  });

  it('defines every shared template method exactly once, in its canonical core', () => {
    for (const [method, expected] of EPIC_SHARED_METHODS) {
      const definers = relativeProductionDefiners((source) =>
        definesMethod(source, method),
      );
      expect(definers, method).toEqual([expected]);
    }
  });
});

describe('epic parity guard — the guard detects a re-introduced duplicate (AC3)', () => {
  it('fails when a production-like fixture redefines a shared method', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-guard-'));
    try {
      const fixture = path.join(dir, 'DuplicateTickPlayer.ts');
      fs.writeFileSync(
        fixture,
        [
          'export class DuplicateTickPlayer {',
          '  protected _tickPlayer(_dt: number): void {}',
          '}',
          '',
        ].join('\n'),
      );

      // The scanner observes the fixture as production source ...
      const fixtureFiles = collectProductionSourceFiles(dir);
      expect(fixtureFiles).toEqual([fixture]);
      expect(
        definesMethod(fs.readFileSync(fixture, 'utf8'), '_tickPlayer'),
      ).toBe(true);

      // ... so combined with the real core the guard's single-definer
      // invariant is violated and the guard would fail.
      const combined = [
        ...fixtureFiles,
        ...collectProductionSourceFiles(path.resolve(process.cwd(), 'src')),
      ];
      const definers = combined
        .filter((file) =>
          definesMethod(fs.readFileSync(file, 'utf8'), '_tickPlayer'),
        )
        .map((file) => path.relative(process.cwd(), file))
        .sort();
      expect(definers.length).toBeGreaterThan(1);
      expect(definers).not.toEqual(['src/scenes/core/CombatCoreScene.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores *.test.ts files, so the duplicate must live in production-like source', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-guard-test-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'Duplicate.test.ts'),
        'export class Duplicate {}\n',
      );
      expect(collectProductionSourceFiles(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Cross-scene equivalence for every enemy archetype's fire (AC2) ──

describe('shared enemy fire — cross-scene equivalence for every archetype (AC2)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  it('each archetype fires identical bullets in the game and the enemy gym', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'fire-equiv-play-host',
    );
    const gym = await bootScene([GymEnemies], 'fire-equiv-gym-host');
    games.push(play, gym);
    const playScene = play.scene;
    const gymScene = gym.scene;

    const make = (scene: Phaser.Scene, key: string) => {
      const cfg = {
        ...loadEnemyConfig(key),
        fireInterval: 1,
        shotProbability: 1,
      };
      const entity = createEnemyFromConfig(
        scene,
        cfg,
        100,
        100,
        { row: 0, col: 0 },
      );
      entity.shootEnabled = true;
      (
        entity as { setAimTarget?(x: number, y: number): void }
      ).setAimTarget?.(400, 100);
      return entity;
    };

    for (const key of Object.keys(ENEMY_FIRE_METHODS)) {
      const gameEntity = make(playScene, key);
      const gymEntity = make(gymScene, key);

      // Identical clock sequence: first call opens the tell, second fires.
      fireForEnemy(gameEntity, key, 1_000);
      fireForEnemy(gymEntity, key, 1_000);
      const gameBullets = fireForEnemy<{ vx: number; vy: number }>(
        gameEntity,
        key,
        2_000,
      );
      const gymBullets = fireForEnemy<{ vx: number; vy: number }>(
        gymEntity,
        key,
        2_000,
      );

      expect(gymBullets.length, `${key} bullet count`).toBe(
        gameBullets.length,
      );
      for (let i = 0; i < gameBullets.length; i++) {
        // Spread patterns fan out with a (seeded-by-scene) random angle, so
        // compare the deterministic speed magnitude rather than the vector.
        const gameSpeed = Math.hypot(gameBullets[i].vx, gameBullets[i].vy);
        const gymSpeed = Math.hypot(gymBullets[i].vx, gymBullets[i].vy);
        expect(gymSpeed, `${key}[${i}] speed`).toBeCloseTo(gameSpeed, 3);
      }
    }
  });
});
