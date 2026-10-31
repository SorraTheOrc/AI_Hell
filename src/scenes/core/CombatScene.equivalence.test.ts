import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  PLAYER_BULLET_SPEED,
} from '../../core/constants';
import { WEAPON_CATALOGUE } from '../../utils/weapons';
import { RULES_STORAGE_KEY } from '../../core/rules';
import { advanceGame, bootScene, stepGameUntil, type BootedGame } from '../../test/gameHarness';
import type { FormationOffset } from '../../utils/formations';
import { PlayScene } from '../PlayScene';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { GymPowerUpsCombat } from '../gym/GymPowerUpsCombat';
import { GymFodderEnemies } from '../gym/GymFodderEnemies';
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
import { resolvePowerUpAtLevel } from '../../powerups/powerUpLevels';
import {
  collectProductionSourceFiles,
  definesFunction,
  definesMethod,
} from '../../test/duplicateBodyGuard';
import type { PlayerBullet } from '../../entities/PlayerBullet';
import { advanceAndCull } from '../../entities/PlayerBullet';
import {
  Boss,
  BOSS_HIT_POINTS_PER_PHASE,
  BOSS_MOVE_AMPLITUDE_X,
  BOSS_MOVE_AMPLITUDE_Y,
  BOSS_MOVE_PERIOD_MS,
} from '../../entities/Boss';
import { minionCountForPhase } from '../../waves/BossMinions';
import { ENEMY_FIRE_METHODS, fireForEnemy } from '../../entities/enemyFire';
import { createEnemyFromConfig } from '../../entities/enemyFactory';
import { loadEnemyConfig } from '../../core/enemyConfig';
import { enemyForceFieldHits } from '../../core/enemyForceField';
import { GymBoss } from '../gym/GymBoss';
import { GymLevel } from '../gym/GymLevel';
import { Harvester } from '../../entities/Harvester';
import { Tank } from '../../entities/Tank';
import { Mineral } from '../../entities/Mineral';
import {
  DIVER_HOLD_FORMATION_SECONDS,
  Diver,
  type DiverBullet,
} from '../../entities/Diver';
import type { Player } from '../../entities/Player';
import type { LevelDefinition, WaveDefinition } from '../../waves/Formations';
import { LEVELS } from '../../waves/Formations';

// These equivalence tests boot full Phaser games and walk PlayScene to the
// boss encounter; under full-suite parallel load the Vitest default 5 s
// timeout is too tight (AH-0MUIPP1UU000UT88). Give the file headroom so a
// slow parallel run does not fail on timing alone (AH-0MUII3GOO001XEBB).
// The expanded campaign (AH-0MVCYANT6003SG5C) walks ten waves per level to
// the boss; the parity walk seeds a single-level campaign so it stays short.
vi.setConfig({ testTimeout: 60000 });

/** The nine shared combat/lifecycle template methods (parent AC1/AC2). */
const SHARED_METHODS = [
  '_handleCollisions',
  '_hitPlayer',
  '_autoFire',
  '_collectDrop',
  '_spawnPlayerExplosion',
  '_clearEnemyBullets',
  '_updateAutoDefence',
  '_readPlayerInput',
  '_tickPlayer',
] as const;

/**
 * The shared Shield/Phase Shift hit-gating hooks (AH-0MUHM66ES0027QQV AC3). They are
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
  // Enable the gym's opt-in power-up layer so Teleport teleport is allowed
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

  it('P3 absorb / P4 pulse methods are defined only in the shared core repo-wide', () => {
    const sharedMethods = [
      '_clearEnemyBulletsInRange',
      '_updateP4Bomb',
      '_spawnBombPulse',
      // Smart Bomb screen pulse (AH-0MV1BIWP9003EHRQ / re-balanced in
      // AH-0MV8GPGBL009M0D8): detection lives in the shared core so gyms
      // cannot fork the interval/radius schedules.
      '_updateSmartBomb',
      'onSmartBombPulse',
    ] as const;
    const files = productionSceneFiles();
    for (const method of sharedMethods) {
      const definers = files
        .filter((file) => definesMethod(fs.readFileSync(file, 'utf8'), method))
        .map((file) => path.relative(process.cwd(), file))
        .sort();
      // The shared core owns it; no production scene re-implements it.
      expect(definers, method).toContain(
        'src/scenes/core/CombatCoreScene.ts',
      );
      for (const definer of definers) {
        expect(SHARED_CORE_FILES, method).toContain(definer);
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

  it('AC5 — the game and every gym register the same shared explosion-accent seam', async () => {
    const register = vi.spyOn(effectsModule, 'setExplosionBeatClock');
    try {
      const { play, gym } = await bootBoth();

      // Both scenes register their own shared beat clock with the single
      // audio seam (defined once in `CombatCoreScene.resetRunState`), so the
      // accent grid is never a per-scene copy.
      expect(register).toHaveBeenCalledWith(play.getBeatClock());
      expect(register).toHaveBeenCalledWith(gym.getBeatClock());
    } finally {
      register.mockRestore();
    }
  });

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

  it('P5 boost yields the same speed/fire-rate outcome in the game and a gym', async () => {    const { play, gym } = await bootBoth();
    play.getEffectsRegistry().applyCollect('speed_boost');
    gym.getEffectsRegistry().applyCollect('speed_boost');

    play.tick(0.5);
    gym.tick(0.5);

    const playPlayer = play.getPlayer()!;
    const gymPlayer = gym.getPlayer()!;
    // The shared step reads the live multipliers from each scene's own
    // effects registry; the Speed Boost outcome must be identical.
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

  it('a field pickup advances the single player store identically in the game and a gym (AC5)', async () => {
    const { play, gym } = await bootBoth();
    const playPlayer = play.getPlayer()!;
    const gymPlayer = gym.getPlayer()!;

    // The registry consumes the player's run-scoped store in both scenes, so
    // the shared `applyCollect` path levels the power-up up exactly once and
    // resolves the same effect strength everywhere.
    play.getEffectsRegistry().applyCollect('speed_boost');
    gym.getEffectsRegistry().applyCollect('speed_boost');

    expect(playPlayer.getPowerUpLevel('speed_boost')).toBe(1);
    expect(gymPlayer.getPowerUpLevel('speed_boost')).toBe(1);
    expect(play.getEffectsRegistry().speedMultiplier()).toBeCloseTo(
      gym.getEffectsRegistry().speedMultiplier(),
      10,
    );
  });

  it('a hold-full power-up reward raises the level by exactly one in both scenes (AC1/AC5)', async () => {
    const { play, gym } = await bootBoth();
    const playPlayer = play.getPlayer()!;
    const gymPlayer = gym.getPlayer()!;

    play.getEffectsRegistry().applyCollect('speed_boost', true);
    gym.getEffectsRegistry().applyCollect('speed_boost', true);

    expect(playPlayer.getPowerUpLevel('speed_boost')).toBe(1);
    expect(gymPlayer.getPowerUpLevel('speed_boost')).toBe(1);
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

    play.getEffectsRegistry().applyCollect('teleport');
    gym.getEffectsRegistry().applyCollect('teleport');

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
      '_updateAutoDefence',
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
  const PAYOUT_HELPER = 'resolveMineralKillPayout';
  const SCATTER_HELPER = 'scatterMineralDrops';
  const SALVAGE_HELPER = 'scatterSalvageMineralDrops';
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

  // The red-deposit payout seam (AH-0MVJ79739008396I): the threshold decision
  // and the Salvage folding live in the same shared module, so a wreck pays
  // out identically in the game and every formation gym.
  it('defines the kill-payout seam exactly once, in the shared helper', () => {
    const definers = productionSourceFiles()
      .filter((file) =>
        definesFunction(fs.readFileSync(file, 'utf8'), PAYOUT_HELPER),
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

  it('both the game and the gym consume the shared kill-payout seam', () => {
    for (const file of [
      'src/scenes/PlayScene.ts',
      'src/scenes/gym/core/GymFormationScene.ts',
    ]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source, `${file} must call the shared payout seam`).toContain(
        `${PAYOUT_HELPER}(`,
      );
    }
  });

  // Salvage bonus drops (AH-0MVJ72I8O0009T09): the orange bounty minerals are
  // scattered by one shared helper so the colour and scatter maths cannot
  // drift between the game and the gyms (gym↔game parity).
  it('defines the salvage-drop seam exactly once, in the shared helper', () => {
    const definers = productionSourceFiles()
      .filter((file) =>
        definesFunction(fs.readFileSync(file, 'utf8'), SALVAGE_HELPER),
      )
      .map((file) => path.relative(process.cwd(), file))
      .sort();

    expect(definers).toEqual([KILL_DROP_HELPER_FILE]);
  });

  it('the shared payout seam is the only consumer of the salvage-drop seam', () => {
    // Folding Salvage into the deposit threshold (AH-0MVJ79739008396I) means
    // no scene scatters the bounty itself: the shared seam decides whether the
    // wreck pays orange dots or one red deposit.
    const consumers = productionSourceFiles()
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8');
        return (
          path.relative(process.cwd(), file) !== KILL_DROP_HELPER_FILE &&
          source.includes(`${SALVAGE_HELPER}(`)
        );
      })
      .map((file) => path.relative(process.cwd(), file))
      .sort();

    expect(consumers).toEqual([]);
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

  it('PlayScene and GymFodderEnemies consume the dispatcher and keep no local switch', () => {
    // The game's private archetype switch (`_fireFor`) is deleted entirely.
    expect(
      Object.prototype.hasOwnProperty.call(PlayScene.prototype, '_fireFor'),
    ).toBe(false);

    for (const file of [
      'src/scenes/PlayScene.ts',
      'src/scenes/gym/GymFodderEnemies.ts',
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

    combatScene.getEffectsRegistry().applyCollect('teleport');
    formationScene.getEffectsRegistry().applyCollect('teleport');

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

    // Two Teleport collects each → 3 stored uses (level-derived: +1 then +2), so
    // FIFO consumption is observable.
    for (const registry of [
      playScene.getEffectsRegistry(),
      combatScene.getEffectsRegistry(),
    ]) {
      registry.applyCollect('teleport');
      registry.applyCollect('teleport');
    }

    expect(playScene.triggerTeleport()).toBe(true);
    expect(combatScene.triggerTeleport()).toBe(true);

    // Same inputs through the same shared algorithm → same landing spot.
    expect(combatScene.getPlayer()!.x).toBe(playScene.getPlayer()!.x);
    expect(combatScene.getPlayer()!.y).toBe(playScene.getPlayer()!.y);
    expect(playScene.getEffectsRegistry().teleportStacks()).toBe(2);
    expect(combatScene.getEffectsRegistry().teleportStacks()).toBe(2);
    expect(playScene.getEffectsRegistry().isPhased).toBe(true);
    expect(combatScene.getEffectsRegistry().isPhased).toBe(true);

    // The second teleport consumes the remaining stack on both.
    expect(playScene.triggerTeleport()).toBe(true);
    expect(combatScene.triggerTeleport()).toBe(true);
    expect(playScene.getEffectsRegistry().teleportStacks()).toBe(1);
    expect(combatScene.getEffectsRegistry().teleportStacks()).toBe(1);
  });

  it('danger auto-triggers Phase Shift identically in the game and both gyms (Q1/Q2/Q3)', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'phase-play-host',
    );
    const combat = await bootScene(
      [GymPowerUpsCombat],
      'phase-combat-host',
    );
    const formation = await bootScene([EquivGymScene], 'phase-formation-host');
    games.push(play, combat, formation);
    const playScene = play.scene as PlayScene;
    const combatScene = combat.scene as GymPowerUpsCombat;
    const formationScene = formation.scene as EquivGymScene;
    const scenes: Array<PlayScene | GymPowerUpsCombat | EquivGymScene> = [
      playScene,
      combatScene,
      formationScene,
    ];

    // Same starting state in every scene: ship parked at a clear corner with
    // one stored Phase Shift auto-activation charge.
    for (const scene of scenes) {
      const player = scene.getPlayer()!;
      player.setPosition(120, 120);
      (
        player as unknown as { _movementState: Record<string, unknown> }
      )._movementState = {
        ...player.getMovementState(),
        x: 120,
        y: 120,
        vx: 0,
        vy: 0,
        facing: 0,
      };
      scene.getEffectsRegistry().applyCollect('phase_shift');
    }

    // Three enemy bullets centred within DANGER_RADIUS (40 px) of the ship.
    const threats: Array<[number, number]> = [
      [130, 120],
      [120, 130],
      [120, 110],
    ];
    for (const [x, y] of threats) {
      playScene.spawnEnemyBullet(x, y, 0, 0);
      combatScene.spawnEnemyBullet(x, y, 0, 0);
    }
    const formationBullets = (
      formationScene as unknown as { bullets: EquivBullet[] }
    ).bullets;
    for (const [x, y] of threats) {
      const bullet = new EquivBullet(formationScene);
      bullet.graphics.setPosition(x, y);
      formationBullets.push(bullet);
    }

    for (const scene of scenes) scene.tick(0.016);

    // Every scene auto-activated the phase and consumed the same charge.
    for (const scene of scenes) {
      expect(scene.getEffectsRegistry().isPhased).toBe(true);
      expect(scene.getEffectsRegistry().phaseCharges()).toBe(0);
    }
  });

  it('applies the shared Phase Shift juice overlays in every scene while phased', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'phase-juice-play-host',
    );
    const combat = await bootScene(
      [GymPowerUpsCombat],
      'phase-juice-combat-host',
    );
    const formation = await bootScene(
      [EquivGymScene],
      'phase-juice-formation-host',
    );
    games.push(play, combat, formation);
    const playScene = play.scene as PlayScene;
    const combatScene = combat.scene as GymPowerUpsCombat;
    const formationScene = formation.scene as EquivGymScene;
    const scenes: Array<PlayScene | GymPowerUpsCombat | EquivGymScene> = [
      playScene,
      combatScene,
      formationScene,
    ];

    for (const scene of scenes) {
      const player = scene.getPlayer()!;
      player.setPosition(120, 120);
      (
        player as unknown as { _movementState: Record<string, unknown> }
      )._movementState = {
        ...player.getMovementState(),
        x: 120,
        y: 120,
        vx: 0,
        vy: 0,
        facing: 0,
      };
      scene.getEffectsRegistry().applyCollect('phase_shift');
    }

    const threats: Array<[number, number]> = [
      [130, 120],
      [120, 130],
      [120, 110],
    ];
    for (const [x, y] of threats) {
      playScene.spawnEnemyBullet(x, y, 0, 0);
      combatScene.spawnEnemyBullet(x, y, 0, 0);
    }
    const formationBullets = (
      formationScene as unknown as { bullets: EquivBullet[] }
    ).bullets;
    for (const [x, y] of threats) {
      const bullet = new EquivBullet(formationScene);
      bullet.graphics.setPosition(x, y);
      formationBullets.push(bullet);
    }

    for (const scene of scenes) scene.tick(0.016);

    for (const scene of scenes) {
      expect(scene.getEffectsRegistry().isPhased).toBe(true);
      const overlays = scene.children.list.filter(
        (obj) =>
          (
            obj as Phaser.GameObjects.GameObject & {
              getData?: (key: string) => unknown;
            }
          ).getData?.('juiceLayer') === 'phaseShift',
      );
      expect(overlays.length).toBeGreaterThan(0);
    }
  });

  it('applies the shared Phase Shift juice in the level gym too (AH-0MVNTY0700053T9E)', async () => {
    const level = await bootScene([GymLevel], 'phase-juice-level-host');
    games.push(level);
    const levelScene = level.scene as GymLevel;
    expect(levelScene.getPlayer()).not.toBeNull();

    levelScene.getEffectsRegistry().applyCollect('phase_shift');
    levelScene.getEffectsRegistry().applyPhaseShift();
    levelScene.tick(0.016);

    expect(levelScene.getEffectsRegistry().isPhased).toBe(true);
    const overlays = levelScene.children.list.filter(
      (obj) =>
        (
          obj as Phaser.GameObjects.GameObject & {
            getData?: (key: string) => unknown;
          }
        ).getData?.('juiceLayer') === 'phaseShift',
    );
    // The level gym advances the treatment through the same shared step, so it
    // cannot silently omit the effect the game and every other gym show.
    expect(overlays.length).toBeGreaterThan(0);
  });

  it('plays the Phase Shift cue exactly once when danger auto-triggers (parent AH-0MUIYX1EE008FVS8)', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'phase-sfx-play-host',
    );
    games.push(play);
    const playScene = play.scene as PlayScene;
    const soundSpy = vi.spyOn(effectsModule, 'playPhaseShiftSound');

    const player = playScene.getPlayer()!;
    player.setPosition(120, 120);
    (
      player as unknown as { _movementState: Record<string, unknown> }
    )._movementState = {
      ...player.getMovementState(),
      x: 120,
      y: 120,
      vx: 0,
      vy: 0,
      facing: 0,
    };
    playScene.getEffectsRegistry().applyCollect('phase_shift');
    playScene.spawnEnemyBullet(130, 120, 0, 0);
    playScene.spawnEnemyBullet(120, 130, 0, 0);
    playScene.spawnEnemyBullet(120, 110, 0, 0);

    playScene.tick(0.016);

    expect(playScene.getEffectsRegistry().isPhased).toBe(true);
    expect(soundSpy).toHaveBeenCalledTimes(1);
    soundSpy.mockRestore();
  });

  it('plays the Phase Shift cue on a P7 teleport activation (parent AH-0MUIYX1EE008FVS8)', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'phase-teleport-sfx-host',
    );
    games.push(play);
    const playScene = play.scene as PlayScene;
    const soundSpy = vi.spyOn(effectsModule, 'playPhaseShiftSound');

    playScene.getEffectsRegistry().applyCollect('teleport');
    expect(playScene.triggerTeleport()).toBe(true);

    expect(playScene.getEffectsRegistry().isPhased).toBe(true);
    expect(soundSpy).toHaveBeenCalledTimes(1);
    soundSpy.mockRestore();
  });
});

// ── Shared power-up drop layer (gap 4, AH-0MUII3CXX0023H24) ─────────

/** The six pure helpers that own the drop layer. */
const DROP_HELPERS = [
  'buildDefaultDropSpawner',
  'advanceDropLifecycles',
  'collectOverlappingDrops',
  'applyDropMagnet',
  'playDropPickupCue',
  // Six-slot gate (AH-0MVNT2YGD003N8NR): the one eligible-filtered draw seal.
  'drawNextDrop',
] as const;

/** The single file that may define a shared drop-layer helper. */
const DROP_LAYER_FILE = 'src/scenes/core/dropLayer.ts';

/** Shared drop-layer template methods hosted by `CombatCoreScene`. */
const SHARED_DROP_METHODS = [
  '_buildDefaultDropSpawner',
  '_drawNextDrop',
  '_resolveDropSlotState',
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

    const p = play.spawnPowerUpDrop('speed_boost', 700, 100)!;
    const f = formation.spawnPowerUpDrop('speed_boost', 700, 100)!;
    const u = utility.spawnDrop('speed_boost', 700, 100);
    const c = combat.spawnDrop('speed_boost', 700, 100);

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

    const playDrop = play.spawnPowerUpDrop('shield', play.getPlayer()!.x, play.getPlayer()!.y)!;
    const fDrop = formation.spawnPowerUpDrop('shield', formation.getPlayer()!.x, formation.getPlayer()!.y)!;
    const uDrop = utility.spawnDrop('shield', utility.getPlayer()!.x, utility.getPlayer()!.y);
    const cDrop = combat.spawnDrop('shield', combat.getPlayer()!.x, combat.getPlayer()!.y);
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

  it('absorbs identical P3 hit counts in the game and every gym', async () => {
    const { play, formation, utility, combat } = await bootDrops();
    const owners = [play, formation, utility, combat];

    // Two collections reach upgrade level 1 (base = one collection). The
    // shared store is the single source, so every scene must resolve the
    // same remaining-absorptions count.
    for (const owner of owners) {
      owner.getEffectsRegistry().applyCollect('shield');
      owner.getEffectsRegistry().applyCollect('shield');
    }

    const expected = resolvePowerUpAtLevel('shield', 1).shieldAbsorptions!;
    for (const owner of owners) {
      const registry = owner.getEffectsRegistry();
      expect(registry.shieldAbsorptionsRemaining()).toBe(expected);
      // Absorb exactly `expected` hits; the shield then pops everywhere.
      for (let hit = 0; hit < expected; hit++) {
        expect(registry.tryAbsorbShield()).toBe(true);
      }
      expect(registry.isShielded).toBe(false);
      expect(registry.tryAbsorbShield()).toBe(false);
    }
  });

  it('pulls a grown drop toward the ship wherever drops exist (P9 magnet parity)', async () => {
    const { play, formation, utility, combat, weapons } = await bootDrops();

    const owners = [play, formation, utility, combat, weapons];
    for (const owner of owners) owner.getEffectsRegistry().applyCollect('magnet');

    // Spawn each drop 30 px to the right of the scene's own player (no
    // scene position assumptions — PlayScene's physics owns its position).
    const playPlayer = play.getPlayer()!;
    const playDrop = play.spawnPowerUpDrop('speed_boost', playPlayer.x + 30, playPlayer.y)!;
    const fPlayer = formation.getPlayer()!;
    const fDrop = formation.spawnPowerUpDrop('speed_boost', fPlayer.x + 30, fPlayer.y)!;
    const uPlayer = utility.getPlayer()!;
    const uDrop = utility.spawnDrop('speed_boost', uPlayer.x + 30, uPlayer.y);
    const cPlayer = combat.getPlayer()!;
    const cDrop = combat.spawnDrop('speed_boost', cPlayer.x + 30, cPlayer.y);
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

  it('drives the P4 ranged bomb pulse identically in the game and every gym', async () => {
    const { play, formation, combat } = await bootDrops();
    const owners: EnemyBulletOwner[] = [play, formation, combat];

    const inside = new Map<EnemyBulletOwner, Phaser.GameObjects.Graphics>();
    const outside = new Map<EnemyBulletOwner, Phaser.GameObjects.Graphics>();

    for (const owner of owners) {
      const player = owner.getPlayer()!;
      // The level-0 bomb range is 120 px: 50 px is inside, 400 px outside.
      inside.set(
        owner,
        pushEnemyBullet(owner, {
          x: player.x + 50,
          y: player.y,
          vx: 0,
          vy: 0,
          lifetime: 5,
        }),
      );
      outside.set(
        owner,
        pushEnemyBullet(owner, {
          x: player.x + 400,
          y: player.y,
          vx: 0,
          vy: 0,
          lifetime: 5,
        }),
      );
      // Grant the permanent (hold-full) bomb — the shared pulse path fires it.
      owner.getEffectsRegistry().applyCollect('bomb', true);
    }

    play.tick(0.016);
    formation.tick(0.016);
    combat.tick(0.016);

    for (const owner of owners) {
      const live = enemyBulletGraphics(owner);
      expect(live, 'in-range bullet cleared').not.toContain(inside.get(owner));
      expect(live, 'out-of-range bullet survives').toContain(outside.get(owner));
      expect(owner.getEffectsRegistry().isBombPermanent()).toBe(true);
    }
  });

  it('drives the shared Smart Bomb screen pulse identically in the game and every gym (AH-0MV8GPGBL009M0D8)', async () => {
    const { play, formation, combat } = await bootDrops();
    const owners: EnemyBulletOwner[] = [play, formation, combat];

    const inside = new Map<EnemyBulletOwner, Phaser.GameObjects.Graphics>();
    const outside = new Map<EnemyBulletOwner, Phaser.GameObjects.Graphics>();

    for (const owner of owners) {
      const player = owner.getPlayer()!;
      // Re-balanced base pulse radius is 200 px (10 × SHIP_SIZE): 50 px is
      // inside, 400 px outside — no longer the old screen-wide 1200 px.
      inside.set(
        owner,
        pushEnemyBullet(owner, {
          x: player.x + 50,
          y: player.y,
          vx: 0,
          vy: 0,
          lifetime: 5,
        }),
      );
      outside.set(
        owner,
        pushEnemyBullet(owner, {
          x: player.x + 400,
          y: player.y,
          vx: 0,
          vy: 0,
          lifetime: 5,
        }),
      );
      // Grant the permanent (hold-full) smart bomb — the shared pulse path
      // fires it immediately and then on the resolved interval.
      owner.getEffectsRegistry().applyCollect('smart_bomb', true);
    }

    play.tick(0.016);
    formation.tick(0.016);
    combat.tick(0.016);

    for (const owner of owners) {
      const live = enemyBulletGraphics(owner);
      expect(live, 'in-range bullet cleared').not.toContain(inside.get(owner));
      expect(live, 'out-of-range bullet survives').toContain(outside.get(owner));
      expect(owner.getEffectsRegistry().isSmartBombPermanent()).toBe(true);
      // The permanent pulse interval resolves to the re-balanced schedule
      // (30 s at level 0 — `max(10, 30 − 2×level)`), shared by every scene.
      expect(owner.getEffectsRegistry().smartBombInterval()).toBe(30);
    }
  });

  it('plays the same per-type cue for the same drop in every scene', async () => {
    const { play, formation, utility, weapons } = await bootDrops();
    const speedCue = vi.spyOn(effectsModule, 'playSpeedBoostCollectSound');
    const spreadCue = vi.spyOn(effectsModule, 'playSpreadPickupSound');

    const playDrop = play.spawnPowerUpDrop('speed_boost', play.getPlayer()!.x, play.getPlayer()!.y)!;
    const fDrop = formation.spawnPowerUpDrop('speed_boost', formation.getPlayer()!.x, formation.getPlayer()!.y)!;
    const uDrop = utility.spawnDrop('speed_boost', utility.getPlayer()!.x, utility.getPlayer()!.y);
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

  it('GymPlayer inherits the shared scheme→input path (no inlined handlers)', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/scenes/gym/GymPlayer.ts'),
      'utf8',
    );
    // Re-based onto the shared combat core: input is read by the inherited
    // `CombatCoreScene._readPlayerInput` (which delegates to
    // `mapControlInput`), so GymPlayer must not define its own copy nor
    // inline the legacy handlers.
    expect(definesMethod(source, '_readPlayerInput')).toBe(false);
    expect(definesMethod(source, '_readInput')).toBe(false);
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
 * Seeds a booted PlayScene with a **single-level** campaign so the boss walk
 * clears one level (final by construction) instead of all ten
 * (AH-0MVCYANT6003SG5C). Same encounter, ~1/10 the simulated waves.
 */
function seedSingleLevelCampaign(play: PlayScene): void {
  const level = LEVELS[0];
  play.getWaveManager().setLevels([
    {
      ...level,
      level: 1,
      waves: level.waves.map((w) => ({
        ...w,
        groups: w.groups.map((g) => ({ ...g })),
      })),
    },
  ]);
  play.getWaveManager().beginGame();
  play.spawnWave();
}

/**
 * Walks the PlayScene run to the boss encounter (the final level cleared) by
 * destroying every enemy deterministically. Robust to the ten-level campaign:
 * it advances spawned enemies past their spawn animation, and ticks the scene
 * to release any dynamically scheduled enemies (horde/ghosts) when nothing is
 * currently alive but the wave still has accounted enemies.
 */
function reachPlayBoss(play: PlayScene): void {
  play.getGameState().lives = 99;
  // The expanded campaign (AH-0MVCYANT6003SG5C) has 100 waves (10 per level)
  // plus occasional spawner-delivered crowds; scale the walker budget up from
  // the original 29-wave campaign so it can clear the whole run.
  for (let guard = 0; guard < 4000; guard++) {
    const wm = play.getWaveManager();
    if (wm.bossTriggered || wm.bossActive) break;
    play.finishSpawnAnimations();
    for (let inner = 0; inner < 2000; inner++) {
      // A hold-full choice pauses the scene (tick() no-ops) — resolve it.
      if (play.isMineralChoiceOpen()) {
        play.selectMineralChoice(0);
        continue;
      }
      const enemy = play.getEnemies().find((e) => e.alive);
      if (!enemy) break;
      play.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
      play.tick(0.016);
    }
    // The wave-10 mini-boss is a separate gating entity (not part of the
    // spawned set): defeat it too, otherwise the level never completes
    // (AH-0MVCRBISU006NUN5 AC2).
    const miniBoss = play.getMiniBoss();
    if (miniBoss?.alive) {
      for (let hits = 0; hits < 800 && miniBoss.alive; hits++) {
        if (play.isMineralChoiceOpen()) {
          play.selectMineralChoice(0);
          continue;
        }
        play.spawnPlayerBullet(miniBoss.x, miniBoss.y, 0, 0);
        // A zero-length step resolves collisions without moving the target.
        play.tick(0);
      }
    }
    // The mini-boss defeat plays a tween-driven death sweep before it is
    // finalised (deferred reward overlay + single level advance); step the
    // game loop so every sweep completes and the walk can continue
    // (AH-0MVROELN600410GP).
    if (play.isMiniBossSweepActive()) {
      stepGameUntil(
        play.game,
        'mini-boss death sweep',
        () => !play.isMiniBossSweepActive(),
        240,
      );
    }
    // The mini-boss defeat offers the one upgrade-or-unlock reward choice
    // (AH-0MVCRBNO6003E1CH); resolve it so play can continue.
    if (play.isMiniBossRewardOpen()) play.selectMiniBossReward(0);
    // Nothing alive but the wave still has accounted enemies: advance the
    // scene so pending dynamic spawns are released and the wave timer runs.
    if (wm.enemiesAlive > 0 && play.getAliveCount() === 0) play.tick(0.25);
    if (play.isTransitioning()) play.tick(3.0);
  }
  // The boss entity only exists once the transition completes.
  if (play.isTransitioning()) play.tick(3.0);
  play.finishSpawnAnimations();
  if (!play.getBoss()) {
    const wm = play.getWaveManager();
    throw new Error(
      `reachPlayBoss failed: bossTriggered=${wm.bossTriggered} ` +
        `bossActive=${wm.bossActive} level=${wm.level} wave=${wm.waveNumber} ` +
        `enemiesAlive=${wm.enemiesAlive} aliveCount=${play.getAliveCount()}`,
    );
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
    // Deterministic static campaign: the default sequenced campaign is
    // generated from a `Math.random()` seed and can stall the walk-to-boss
    // loop on an un-accounted asteroid group (AH-0MUNVVWWC0015JTM; game bug
    // tracked by AH-0MUR1HZLQ001ELX9).
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'boss-equiv-play-host',
    );
    const gym = await bootScene([GymBoss], 'boss-equiv-gym-host');
    games.push(play, gym);
    const playScene = play.scene as PlayScene;
    const gymScene = gym.scene as GymBoss;

    seedSingleLevelCampaign(playScene);
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

// ── Boss encounter game↔gym parity (AH-0MUZMTU3Y001Y8XZ) ────────────

/**
 * End-to-end parity checks for the parent boss-encounter epic
 * (AH-0MUY3X4NS007JR8X, AC6/AC8). The health bar must be screen-fixed, the
 * figure-of-eight motion must be the single shared `Boss` lemniscate, every
 * hit must run through the one `Boss.takeDamage` feedback path, and the
 * per-phase minion counts must come from the shared `planMinionSpawns`
 * planner — all verified against **both** `PlayScene` and `GymBoss`.
 */
describe('boss encounter — game↔gym parity (AH-0MUZMTU3Y001Y8XZ)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
    localStorage.clear();
  });

  /** Boots PlayScene past the static campaign and walks it to the boss. */
  async function bootPlayAtBoss(): Promise<PlayScene> {
    // Deterministic static campaign: the default sequenced campaign can
    // include un-accounted asteroid groups that stall the walk (see the
    // shared boss integration suite above).
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'boss-parity-play-host',
    );
    games.push(play);
    const scene = play.scene as PlayScene;
    seedSingleLevelCampaign(scene);
    reachPlayBoss(scene);
    return scene;
  }

  async function bootBossGym(): Promise<GymBoss> {
    const gym = await bootScene([GymBoss], 'boss-parity-gym-host');
    games.push(gym);
    return gym.scene as GymBoss;
  }

  /** Zeroes the boss's figure-of-eight clock (test seam). */
  function resetMotionClock(boss: Boss): void {
    (boss as unknown as { _moveElapsedMs: number })._moveElapsedMs = 0;
  }

  /** The boss's offset from its figure-of-eight anchor. */
  function motionOffset(boss: Boss): { x: number; y: number } {
    return {
      x: boss.x - boss.getMoveAnchorX(),
      y: boss.y - boss.getMoveAnchorY(),
    };
  }

  it('AC2 — the boss health bar is screen-fixed and position-independent in both scenes', async () => {
    const play = await bootPlayAtBoss();
    const gym = await bootBossGym();
    const playBoss = play.getBoss()!;
    const gymBoss = gym.formationBoss;

    const playBar = playBoss.getHealthBarGraphics();
    const gymBar = gymBoss.getHealthBarGraphics();

    // Both are camera-fixed scene children (never boss-container children),
    // so the bar never rides the figure-of-eight motion.
    for (const [scene, bar] of [
      [play, playBar],
      [gym, gymBar],
    ] as const) {
      expect(bar.parentContainer).toBeNull();
      expect(bar.scrollFactorX).toBe(0);
      expect(bar.scrollFactorY).toBe(0);
      expect(bar.depth).toBe(100);
      expect(scene.children.list).toContain(bar);
    }

    const playBefore = [...(playBar.commandBuffer as number[])];
    const gymBefore = [...(gymBar.commandBuffer as number[])];

    // Move each boss far from its own anchor; the drawn screen coordinates
    // must be byte-for-byte unchanged (the bar is not transformed by the
    // boss container).
    playBoss.setPosition(40, 500);
    gymBoss.setPosition(920, 40);

    expect([...(playBar.commandBuffer as number[])]).toEqual(playBefore);
    expect([...(gymBar.commandBuffer as number[])]).toEqual(gymBefore);

    // The game and the gym draw the identical screen-space bar.
    expect(playBefore).toEqual(gymBefore);
  });

  it('AC3 — the figure-of-eight trace matches in the game and the gym for the same delta', async () => {
    const play = await bootPlayAtBoss();
    const gym = await bootBossGym();
    const playBoss = play.getBoss()!;
    const gymBoss = gym.formationBoss;

    // Both scenes host the one shared `Boss` implementation, and the gym does
    // not re-implement the motion.
    expect(Object.getPrototypeOf(playBoss)).toBe(Boss.prototype);
    expect(Object.getPrototypeOf(gymBoss)).toBe(Boss.prototype);
    expect(
      Object.prototype.hasOwnProperty.call(
        GymBoss.prototype,
        '_advanceFigureEight',
      ),
    ).toBe(false);

    // Compare the same delta from a common clock origin.
    resetMotionClock(playBoss);
    resetMotionClock(gymBoss);
    const delta = 0.25;
    play.tick(delta);
    gym.tick(delta);

    expect(playBoss.getMoveElapsedMs()).toBeCloseTo(250, 6);
    expect(gymBoss.getMoveElapsedMs()).toBeCloseTo(250, 6);

    const playOffset = motionOffset(playBoss);
    const gymOffset = motionOffset(gymBoss);
    expect(playOffset.x).toBeCloseTo(gymOffset.x, 6);
    expect(playOffset.y).toBeCloseTo(gymOffset.y, 6);

    // ... and both equal the shared Gerono-lemniscate position for that delta.
    const theta = (2 * Math.PI * 250) / BOSS_MOVE_PERIOD_MS;
    expect(playOffset.x).toBeCloseTo(
      BOSS_MOVE_AMPLITUDE_X * Math.sin(theta),
      6,
    );
    expect(playOffset.y).toBeCloseTo(
      BOSS_MOVE_AMPLITUDE_Y * Math.sin(2 * theta),
      6,
    );
  });

  it('AC3 — no production scene re-implements the shared boss motion', () => {
    const definers = productionSceneFiles()
      .filter((file) =>
        definesMethod(fs.readFileSync(file, 'utf8'), '_advanceFigureEight'),
      )
      .map((file) => path.relative(process.cwd(), file));
    expect(definers).toEqual([]);
  });

  it('AC5 — every boss hit uses the shared per-hit feedback path in both scenes', async () => {
    const play = await bootPlayAtBoss();
    const gym = await bootBossGym();
    const playBoss = play.getBoss()!;
    const gymBoss = gym.formationBoss;

    const cue = vi.spyOn(effectsModule, 'playBossHitSound');
    try {
      expect(playBoss.getHitEffects()).toHaveLength(0);
      expect(gymBoss.getHitEffects()).toHaveLength(0);

      // The same shared `Boss.takeDamage()` entry point with the same hit
      // point yields the same per-hit feedback in both scenes.
      playBoss.takeDamage(123, 45);
      gymBoss.takeDamage(123, 45);

      for (const boss of [playBoss, gymBoss]) {
        const effects = boss.getHitEffects();
        expect(effects).toHaveLength(1);
        expect(effects[0].x).toBeCloseTo(123, 1);
        expect(effects[0].y).toBeCloseTo(45, 1);
      }
      expect(cue).toHaveBeenCalledTimes(2);
    } finally {
      cue.mockRestore();
    }
  });

  it('parent AC6 — per-phase minion counts are driven by the shared planner in both scenes', async () => {
    // Both scene sources consume the single shared planner, so the per-phase
    // counts cannot diverge between the game and the gym.
    for (const file of [
      'src/scenes/PlayScene.ts',
      'src/scenes/gym/GymBoss.ts',
    ]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source, `${file} must use the shared minion planner`).toContain(
        'planMinionSpawns(',
      );
    }

    // Runtime: the gym opens on the shared phase-1 count, and depleting the
    // phase adds exactly the shared phase-2 count.
    const gym = await bootBossGym();
    expect(gym.getMinions()).toHaveLength(minionCountForPhase(1));
    for (let hit = 0; hit < BOSS_HIT_POINTS_PER_PHASE; hit++) {
      gym.damageBoss();
    }
    expect(gym.formationBoss.getPhaseNumber()).toBe(2);
    expect(gym.getMinions()).toHaveLength(
      minionCountForPhase(1) + minionCountForPhase(2),
    );
  });
});

// ── Wrap-aware aim + post-motion wrap — game↔gym parity ────────────

/**
 * Wrap-aware aim and post-motion movement parity (parent
 * AH-0MV9G3DZ9003P7P8, test item AH-0MVKXBXQX003S7K5 AC2/AC3).
 *
 * The seam maths (`aimVectorToTarget`, `wrappedAxisDelta`) and the shared
 * post-motion seam (`applyPostMotionWrapAll`) live once in the shared core and
 * are consumed by `PlayScene` and every gym. These tests drive the *scene*
 * paths — the game and a real gym fire the same aimed shot, and both scene
 * loops run the same post-motion wrap — so the equivalence claims are proven
 * end-to-end rather than inferred from the shared source.
 */
describe('wrap-aware aim and post-motion wrap — game↔gym parity (AH-0MVKXBXQX003S7K5)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  /** The aim geometry used in both scenes: the wrap route is the short one. */
  const ENEMY_POS = { x: 100, y: 100 };
  const PLAYER_POS = { x: 800, y: 500 };
  /** The wrapped deltas for that geometry (right/top seams are nearer). */
  const WRAPPED_DX = PLAYER_POS.x - ENEMY_POS.x - GAME_WIDTH; // −260
  const WRAPPED_DY = PLAYER_POS.y - ENEMY_POS.y - GAME_HEIGHT; // −140

  /**
   * Fires one aimed shot from a freshly created Scout in `scene`.
   *
   * The Scout is created at the shared geometry, aimed through the same
   * `setAimTarget` seam the scenes push, and fired through the shared
   * `fireForEnemy` dispatcher (tell → shot) — exactly what the scene's own
   * `_collectEnemyFire` loop does.
   */
  function aimedShot(
    scene: Phaser.Scene,
    wrapAware: boolean,
  ): { vx: number; vy: number } {
    const config = {
      ...loadEnemyConfig('scout'),
      wrapAware,
      fireInterval: 1,
      shotProbability: 1,
    };
    const enemy = createEnemyFromConfig(
      scene,
      config,
      ENEMY_POS.x,
      ENEMY_POS.y,
      { row: 0, col: 0 },
    );
    enemy.shootEnabled = true;
    (enemy as { setAimTarget?(x: number, y: number): void }).setAimTarget?.(
      PLAYER_POS.x,
      PLAYER_POS.y,
    );
    // Identical clock sequence in both scenes: tell first, then the shot.
    fireForEnemy(enemy, 'scout', 1_000);
    const [bullet] = fireForEnemy<{ vx: number; vy: number }>(
      enemy,
      'scout',
      2_000,
    );
    expect(bullet, 'the aimed shot fired').toBeDefined();
    return bullet;
  }

  async function bootAimOwners(): Promise<{
    play: PlayScene;
    gym: GymFodderEnemies;
  }> {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'wrap-aim-play-host',
    );
    const gym = await bootScene([GymFodderEnemies], 'wrap-aim-gym-host');
    games.push(play, gym);
    return { play: play.scene as PlayScene, gym: gym.scene as GymFodderEnemies };
  }

  it('fires a wrap-aware aimed shot on the same wrapped heading in the game and the enemy gym', async () => {
    const { play, gym } = await bootAimOwners();

    const gameBullet = aimedShot(play, true);
    const gymBullet = aimedShot(gym, true);

    // Same geometry ⇒ same launch vector in both scenes.
    expect(gymBullet.vx, 'gym vx matches the game').toBeCloseTo(
      gameBullet.vx,
      6,
    );
    expect(gymBullet.vy, 'gym vy matches the game').toBeCloseTo(
      gameBullet.vy,
      6,
    );

    // The launch angle follows the shortest wrapped path ...
    const wrappedHeading = Math.atan2(WRAPPED_DY, WRAPPED_DX);
    expect(Math.atan2(gameBullet.vy, gameBullet.vx)).toBeCloseTo(
      wrappedHeading,
      6,
    );
    // ... which is not the direct line to the player (the seam shot wins).
    const directHeading = Math.atan2(
      PLAYER_POS.y - ENEMY_POS.y,
      PLAYER_POS.x - ENEMY_POS.x,
    );
    expect(Math.atan2(gameBullet.vy, gameBullet.vx)).not.toBeCloseTo(
      directHeading,
      3,
    );
  });

  it('keeps the direct heading for a non-aware archetype in the game and the enemy gym', async () => {
    const { play, gym } = await bootAimOwners();

    const gameBullet = aimedShot(play, false);
    const gymBullet = aimedShot(gym, false);

    expect(gymBullet.vx, 'gym vx matches the game').toBeCloseTo(
      gameBullet.vx,
      6,
    );
    expect(gymBullet.vy, 'gym vy matches the game').toBeCloseTo(
      gameBullet.vy,
      6,
    );

    const directHeading = Math.atan2(
      PLAYER_POS.y - ENEMY_POS.y,
      PLAYER_POS.x - ENEMY_POS.x,
    );
    expect(Math.atan2(gymBullet.vy, gymBullet.vx)).toBeCloseTo(
      directHeading,
      6,
    );
  });

  /**
   * A deterministic body for the post-motion seam parity test: it holds the
   * position it is placed at (no formation or steering motion), so the only
   * thing that can move it is the shared seam both scene loops run.
   */
  class WrapParityEnemy
    extends Phaser.GameObjects.Container
    implements FormationSceneEntity
  {
    alive = true;
    shootEnabled = false;
    readonly offset: FormationOffset;
    readonly wrapAware: boolean;

    constructor(
      scene: Phaser.Scene,
      x: number,
      y: number,
      offset: FormationOffset,
      wrapAware: boolean,
    ) {
      super(scene, x, y);
      this.offset = offset;
      this.wrapAware = wrapAware;
      this.setPosition(x, y);
    }

    destroySelf(): void {
      this.alive = false;
    }

    getHitRadius(): number {
      return 10;
    }

    applyFormationPosition(): void {
      // Static body — the seam is the only thing allowed to move it.
    }
  }

  const WRAP_PARITY_GYM_CONFIG: EnemyFormationConfig<
    WrapParityEnemy,
    EquivBullet
  > = {
    sceneKey: 'WrapParityGymScene',
    count: 1,
    spacingX: 0,
    spacingY: 0,
    driftSpeed: 0,
    startX: 300,
    startY: 300,
    statusLabel: 'wrap',
    hintText: 'wrap parity',
    buildOffsets: () => [{ row: 0, col: 0 }],
    createEntity: (scene, x, y, offset) =>
      new WrapParityEnemy(scene, x, y, offset, true),
    collectBullets: () => [],
  };

  class WrapParityGymScene extends GymFormationScene<
    WrapParityEnemy,
    EquivBullet
  > {
    constructor() {
      super(WRAP_PARITY_GYM_CONFIG);
    }
  }

  it('relocates a crossing enemy to the identical position in the game and the formation gym', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'wrap-motion-play-host',
    );
    const gym = await bootScene([WrapParityGymScene], 'wrap-motion-gym-host');
    games.push(play, gym);
    const playScene = play.scene as PlayScene;
    const gymScene = gym.scene as WrapParityGymScene;

    // One body per edge, plus one non-aware body that must never move.
    const cases = [
      {
        label: 'right→left',
        from: { x: GAME_WIDTH + 40, y: 100 },
        to: { x: 40, y: 100 },
      },
      {
        label: 'left→right',
        from: { x: -40, y: 100 },
        to: { x: GAME_WIDTH - 40, y: 100 },
      },
      {
        label: 'bottom→top',
        from: { x: 300, y: GAME_HEIGHT + 40 },
        to: { x: 300, y: 40 },
      },
      {
        label: 'top→bottom',
        from: { x: 300, y: -40 },
        to: { x: 300, y: GAME_HEIGHT - 40 },
      },
    ];

    const gameBodies = cases.map((testCase) => {
      const body = new WrapParityEnemy(
        playScene,
        testCase.from.x,
        testCase.from.y,
        { row: 0, col: 0 },
        true,
      );
      playScene.registerEnemy(body as unknown as never, 'scout');
      return body;
    });
    const gymBodies = cases.map((testCase) => {
      const body = new WrapParityEnemy(
        gymScene,
        testCase.from.x,
        testCase.from.y,
        { row: 0, col: 0 },
        true,
      );
      gymScene.registerDynamicEntity(body);
      return body;
    });

    // The non-aware control body, placed over the seam in both scenes.
    const gameUnaware = new WrapParityEnemy(
      playScene,
      GAME_WIDTH + 40,
      200,
      { row: 0, col: 0 },
      false,
    );
    playScene.registerEnemy(gameUnaware as unknown as never, 'scout');
    const gymUnaware = new WrapParityEnemy(
      gymScene,
      GAME_WIDTH + 40,
      200,
      { row: 0, col: 0 },
      false,
    );
    gymScene.registerDynamicEntity(gymUnaware);

    // One deterministic step in each scene (the shared tick).
    playScene.tick(0);
    gymScene.tick(0);

    cases.forEach((testCase, index) => {
      const gameBody = gameBodies[index];
      const gymBody = gymBodies[index];
      expect(gymBody.x, `${testCase.label} gym x matches the game`).toBeCloseTo(
        gameBody.x,
        6,
      );
      expect(gymBody.y, `${testCase.label} gym y matches the game`).toBeCloseTo(
        gameBody.y,
        6,
      );
      expect(gameBody.x, `${testCase.label} wrapped x`).toBeCloseTo(
        testCase.to.x,
        6,
      );
      expect(gameBody.y, `${testCase.label} wrapped y`).toBeCloseTo(
        testCase.to.y,
        6,
      );
    });

    // The flag gates the seam identically in both scenes.
    expect(gameUnaware.x, 'game non-aware body stays put').toBe(
      GAME_WIDTH + 40,
    );
    expect(gymUnaware.x, 'gym non-aware body stays put').toBe(GAME_WIDTH + 40);
  });

  it('every formation-positioning scene runs the shared post-motion wrap seam (AH-0MVKXBZ5N007LKH4)', () => {
    // Game↔gym parity by construction: the wrap step is *called* by the game
    // and by every player-bearing scene that positions enemies in its own
    // loop, and never re-implemented. `GymFodderEnemies` and `GymCentipede`
    // inherit the call from the shared `GymFormationScene` they extend.
    for (const file of [
      'src/scenes/PlayScene.ts',
      'src/scenes/gym/core/GymFormationScene.ts',
      'src/scenes/gym/GymLevel.ts',
    ]) {
      expect(
        fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'),
        `${file} invokes applyPostMotionWrapAll`,
      ).toContain('applyPostMotionWrapAll(');
    }
    // The shared helper owns the wrap body; a scene must never copy it.
    expect(fs.readFileSync(
      path.resolve(process.cwd(), 'src/scenes/core/enemyWrap.ts'),
      'utf8',
    )).toContain('applyPostMotionWrapAll');
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
  ['applyMineralScoop', 'src/powerups/mineralScoop.ts'],
  ['collectMinerals', 'src/scenes/core/mineralLayer.ts'],
  // The hold-full reward moved to the Phaser-free `powerups/choiceReward`
  // so the headless eval arena shares one reward path without importing
  // Phaser (AH-0MVD1RIH2008YCNV); `mineralLayer` re-exports it for scenes.
  ['applyMineralChoiceReward', 'src/powerups/choiceReward.ts'],
  ['isMineralAbsorbingEnemy', 'src/scenes/core/mineralLayer.ts'],
  ['resolveMineralKillDrops', 'src/scenes/core/mineralKillDrops.ts'],
  // Per-kill Extra Life drop rule (AH-0MV6M2M9P0078N4S): the shared tier +
  // chance rule consumed by PlayScene, GymFormationScene (all asteroid-bearing
  // gyms) and GymLevel. Registered so any scene that re-introduces a copy
  // fails the repo-wide duplicate-body guard.
  ['rollAsteroidExtraLife', 'src/scenes/core/asteroidKillDrops.ts'],
  ['mapControlInput', 'src/utils/movementModel.ts'],
  ['splitAsteroid', 'src/scenes/core/asteroidSplit.ts'],
  // Live-aim / live-mineral-seek seam (AH-0MV5SDM6G003A0US). The shared
  // helper lives in `src/scenes/core/enemyTargeting.ts` (created by
  // AH-0MV5SDN24006SD2B) and is consumed by PlayScene, GymFormationScene and
  // GymLevel in AH-0MV5SDNI2008RWQ2; registering it here means the moment a
  // scene re-introduces a copy the repo-wide duplicate-body guard fails.
  // The module now exists, so the single-definer guard below is a hard gate
  // and the temporary PENDING red-first wrapper has been removed.
  ['pushAimTargets', 'src/scenes/core/enemyTargeting.ts'],
  ['pushSeekTargets', 'src/scenes/core/enemyTargeting.ts'],
  // Seam-aware aim + shared post-motion wrap (parent AH-0MV9G3DZ9003P7P8;
  // equivalence guard coverage requested by AH-0MVKXBXQX003S7K5 AC1). The
  // wrapped-aim maths and the post-motion seam are each defined once and
  // consumed by `PlayScene` and every gym, so a scene that re-introduces a
  // copy fails the repo-wide duplicate-body guard.
  ['wrappedAxisDelta', 'src/scenes/core/enemyTargeting.ts'],
  ['aimVectorToTarget', 'src/scenes/core/enemyTargeting.ts'],
  ['wrapPosition', 'src/scenes/core/enemyWrap.ts'],
  ['applyPostMotionWrap', 'src/scenes/core/enemyWrap.ts'],
  ['applyPostMotionWrapAll', 'src/scenes/core/enemyWrap.ts'],
  // Enemy force-field resolver (epic AH-0MVJ8W4GE007OMNT AC4,
  // AH-0MVM8GXEF009883O): the curve is evaluated once in this pure module and
  // consumed by PlayScene's spawn seam and GymLevel's launch seam, so a scene
  // that re-introduces a divergent copy fails the guard.
  ['enemyForceFieldHits', 'src/core/enemyForceField.ts'],
  // Wormhole-transit destination rule (AH-0MVRMHQC9003VDNN): the
  // "autonomous-mover exemption → orbital live slot → grid-slot/offset
  // fallback" chain is defined once in `src/scenes/core/spawnTransit.ts` and
  // consumed by PlayScene, GymFormationScene, GymLevel and GymBoss. A scene
  // that re-introduces a copy fails the repo-wide duplicate-body guard.
  ['resolveSpawnTransitTarget', 'src/scenes/core/spawnTransit.ts'],
  // Diver re-anchor request consumption (D2, docs/GYM_PARITY.md): the rule
  // that turns an entity's re-anchor request into a formation-origin delta is
  // defined once here and consumed by PlayScene, GymFormationScene and
  // GymLevel through `FormationReanchorController`.
  ['consumeFormationReanchor', 'src/scenes/core/formationReanchor.ts'],
  // Spawner-delivered dynamic wave plan/release rule (D3, docs/GYM_PARITY.md):
  // the game and the level gym build the same ghost/centipede/horde/lane
  // traffic/orbital-strike plans and release them through the same
  // time-ordered rule. Scene-specific entity construction and wave accounting
  // stay scene-side, so no gameplay object is forked.
  ['planGhostWaveSpawns', 'src/scenes/core/dynamicSpawnPlan.ts'],
  ['planCentipedeWaveSpawn', 'src/scenes/core/dynamicSpawnPlan.ts'],
  ['planHordeWaveSpawns', 'src/scenes/core/dynamicSpawnPlan.ts'],
  ['planLaneTrafficWaveSpawns', 'src/scenes/core/dynamicSpawnPlan.ts'],
  ['planStrikeWaveSpawns', 'src/scenes/core/dynamicSpawnPlan.ts'],
  ['releaseDueSpawns', 'src/scenes/core/dynamicSpawnPlan.ts'],
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
  ['_applyMineralScoop', 'src/scenes/core/CombatCoreScene.ts'],
  ['_updateDropLayer', 'src/scenes/core/CombatCoreScene.ts'],
  ['_playPickupCue', 'src/scenes/core/CombatCoreScene.ts'],
  ['_handleCollisions', 'src/scenes/core/CombatScene.ts'],
  ['_hitPlayer', 'src/scenes/core/CombatScene.ts'],
  ['_updateAutoDefence', 'src/scenes/core/CombatScene.ts'],
  ['triggerTeleport', 'src/scenes/core/CombatScene.ts'],
  ['_advanceBoss', 'src/scenes/core/CombatScene.ts'],
  ['getAdditionalTeleportBodies', 'src/scenes/core/CombatScene.ts'],
  // F8 (Harvester, AH-0MUI820PM0038HS2): the shared multi-hit kill
  // finalisation (destruction audio + `onEnemyDestroyed`) is defined once in
  // the shared core; a scene must not re-implement it.
  ['finaliseEnemyKill', 'src/scenes/core/CombatScene.ts'],
  // Reverse-thruster engine selection (AH-0MV13LYCL006LB6J /
  // AH-0MV13LZO2007ANRP): the engine the Asteroids scheme fires — including
  // the nose retro-thruster while reversing — is selected by the shared
  // movement model, so a scene can never re-implement the reverse VFX wiring.
  ['getEngineActivity', 'src/utils/movementModel.ts'],
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

  it('fails when a production-like fixture redefines the shared transit resolver', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-guard-transit-'));
    try {
      const fixture = path.join(dir, 'DuplicateSpawnTransit.ts');
      fs.writeFileSync(
        fixture,
        [
          'export function resolveSpawnTransitTarget(input: { transit: boolean }): { x: number; y: number } | undefined {',
          '  if (!input.transit) return undefined;',
          '  return { x: 0, y: 0 };',
          '}',
          '',
        ].join('\n'),
      );

      // The scanner observes the fixture as production source ...
      const fixtureFiles = collectProductionSourceFiles(dir);
      expect(fixtureFiles).toEqual([fixture]);
      expect(
        definesFunction(
          fs.readFileSync(fixture, 'utf8'),
          'resolveSpawnTransitTarget',
        ),
      ).toBe(true);

      // ... so combined with the canonical definer the single-definer
      // invariant is violated and the guard would fail.
      const combined = [
        ...fixtureFiles,
        ...collectProductionSourceFiles(path.resolve(process.cwd(), 'src')),
      ];
      const definers = combined
        .filter((file) =>
          definesFunction(
            fs.readFileSync(file, 'utf8'),
            'resolveSpawnTransitTarget',
          ),
        )
        .map((file) => path.relative(process.cwd(), file))
        .sort();
      expect(definers.length).toBeGreaterThan(1);
      expect(definers).not.toEqual(['src/scenes/core/spawnTransit.ts']);
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
    const gym = await bootScene([GymFodderEnemies], 'fire-equiv-gym-host');
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

// ── Shared mineral-seek seam parity (F4, AH-0MUJRVZP2002G8GC) ────────

describe('shared mineral-seek seam — game/gym parity for the Harvester (F4)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  it('the Harvester seeks and absorbs identically in PlayScene and GymFodderEnemies', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'seek-equiv-play-host',
    );
    const gym = await bootScene([GymFodderEnemies], 'seek-equiv-gym-host');
    games.push(play, gym);
    const playScene = play.scene as PlayScene;
    const gymScene = gym.scene as GymFodderEnemies;

    // Place a deterministic mineral field and a Harvester in each scene.
    // Start the Harvester within absorption reach of the nearest mineral so
    // the same step exercises both seeking and absorption.
    const playHarvester = new Harvester(playScene, {
      x: 280,
      y: 100,
      formationOffset: { row: 0, col: 0 },
    });
    playScene.registerEnemy(playHarvester as unknown as never, 'harvester');
    playScene.spawnMineralAt(300, 100);
    playScene.spawnMineralAt(500, 400);

    // Clear the gym's pre-seeded random field, then mirror the game's two
    // minerals exactly so the two scenes see an identical field.
    for (const m of gymScene.getMinerals()) m.destroy();
    const gymField = gymScene as unknown as { minerals: Mineral[] };
    gymField.minerals = [
      new Mineral(gymScene, { x: 300, y: 100 }),
      new Mineral(gymScene, { x: 500, y: 400 }),
    ];

    const gymHarvester = new Harvester(gymScene, {
      x: 280,
      y: 100,
      formationOffset: { row: 0, col: 0 },
    });
    gymScene.registerDynamicEntity(gymHarvester as never);

    // Advance one deterministic step in each scene (the shared tick).
    playScene.tick(1);
    gymScene.tick(1);

    // Identical seek: both steered to the nearest mineral and closed the
    // same distance (parity of the shared seam from each scene's tick).
    expect(playHarvester.seekTargetX).toBe(300);
    expect(gymHarvester.seekTargetX).toBe(300);
    expect(gymHarvester.seekTargetY).toBe(100);
    expect(gymHarvester.x).toBeCloseTo(playHarvester.x, 5);
    expect(gymHarvester.y).toBeCloseTo(playHarvester.y, 5);

    // Identical absorption: both absorbed exactly one mineral through the
    // shared `collectMinerals` rule, leaving one on each field.
    expect(playHarvester.mineralCount).toBe(1);
    expect(gymHarvester.mineralCount).toBe(1);
    expect(playScene.getMinerals()).toHaveLength(1);
    expect(gymScene.getMinerals()).toHaveLength(1);
  });
});

// ── F8: Harvester health-finalise & mineral-seek seam guards ────────

describe('F8 — health-finalise and mineral-seek seams are single-sourced (AH-0MUJRW1720037VEX)', () => {
  const PRODUCTION = (rel: string) =>
    fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

  it('defines the shared multi-hit kill finalisation exactly once (CombatScene)', () => {
    const definers = relativeProductionDefiners((source) =>
      definesMethod(source, 'finaliseEnemyKill'),
    );
    expect(definers).toEqual(['src/scenes/core/CombatScene.ts']);
  });

  it('defines the shared entity health/takeDamage in BaseEnemy only', () => {
    const definers = relativeProductionDefiners((source) =>
      definesMethod(source, 'takeDamage'),
    );
    // Boss intentionally owns its own phased takeDamage; BaseEnemy provides
    // the shared regular-enemy implementation (Harvester inherits it).
    expect(definers).toContain('src/entities/BaseEnemy.ts');
    expect(definers).toContain('src/entities/Boss.ts');
    expect(definers).not.toContain('src/entities/Harvester.ts');
  });

  it('defines the mineral-seek seam on seeker entities only (no per-scene copy)', () => {
    const entityDefiners = relativeProductionDefiners((source) =>
      definesMethod(source, 'setSeekTargets'),
    );
    // The seam is implemented by the seeker *entities* only — the Harvester
    // and the Mystery UFO collector drone (AH-0MV9G113S009B37I) — and never
    // by a scene, so the game and the gyms cannot diverge on seeking.
    expect(entityDefiners.sort()).toEqual(
      ['src/entities/Harvester.ts', 'src/entities/MysteryUfoDrone.ts'].sort(),
    );
  });

  it('both PlayScene and the gym tick invoke the shared seek seam', () => {
    // The seam is *called* by the game and both gym families and never
    // re-implemented, so they cannot diverge on seeking. Since the live-aim
    // parity epic (AH-0MV5SDNI2008RWQ2) every player-bearing base scene
    // consumes the single shared `pushSeekTargets` helper in
    // `src/scenes/core/enemyTargeting.ts`; the helper invokes the
    // Harvester's `setSeekTargets` seam with the scene's live mineral field.
    for (const file of [
      'src/scenes/PlayScene.ts',
      'src/scenes/gym/core/GymFormationScene.ts',
      'src/scenes/gym/GymLevel.ts',
    ]) {
      expect(PRODUCTION(file)).toContain('pushSeekTargets(');
    }
    // The shared helper owns the push body; the Harvester remains the only
    // definer of the seam implementation (asserted above).
    expect(PRODUCTION('src/scenes/core/enemyTargeting.ts')).toContain(
      'setSeekTargets?.(',
    );
  });

  it('the Harvester is the only production definer of the health/finalise consumer path', () => {
    // Sanity: the Harvester extends BaseEnemy (inheriting health/takeDamage)
    // rather than re-implementing health accounting.
    expect(PRODUCTION('src/entities/Harvester.ts')).toContain(
      'extends BaseEnemy',
    );
    expect(
      definesMethod(PRODUCTION('src/entities/Harvester.ts'), 'takeDamage'),
    ).toBe(false);
  });

  it('defines the collector-drone lifecycle helpers exactly once, in the shared core', () => {
    // Every scene that can spawn the Mystery UFO drone consumes the single
    // shared pass; a per-scene copy (or a second implementation) would break
    // gym↔game parity (AH-0MV9G113S009B37I, AH-0MVBMRS4K000TTTP).
    const production = collectProductionSourceFiles(
      path.resolve(process.cwd(), 'src'),
    );
    const helperFile = 'src/scenes/core/combatDrone.ts';
    for (const fn of [
      'spawnDrone',
      'tickDrones',
      'hitDrone',
      'destroyedDroneDropCount',
    ]) {
      const definers = production
        .filter((file) => definesFunction(fs.readFileSync(file, 'utf8'), fn))
        .map((file) => path.relative(process.cwd(), file))
        .sort();
      expect(definers, `${fn} must be defined once`).toEqual([helperFile]);
    }
  });

  it('no retired Mystery UFO instant-bounty symbols remain in production source', () => {
    // The invisible instant burst is retired (AH-0MV9G113S009B37I): the
    // registry queues collector-drone spawns instead, so the old accumulator
    // and its score axis must not linger as dead paths.
    const production = collectProductionSourceFiles(
      path.resolve(process.cwd(), 'src'),
    );
    for (const file of production) {
      const source = fs.readFileSync(file, 'utf8');
      for (const symbol of [
        'consumeMysteryBonus',
        '_mysteryBonus',
        'mysteryUfoScore',
      ]) {
        expect(
          source.includes(symbol),
          `${path.relative(process.cwd(), file)} must not reference ${symbol}`,
        ).toBe(false);
      }
    }
  });
});

// ── Live-aim seam — bot/level gym ↔ PlayScene equivalence ───────────

/**
 * Cross-scene equivalence for the live-aim seam (child
 * AH-0MV5SDLQK005ZBOH of the live-aim parity epic AH-0MV4XFQ0J0082BN6).
 *
 * `PlayScene._collectEnemyFire` pushes the live player position into every
 * alive enemy through the `setAimTarget(x, y)` seam **before** it dispatches
 * that frame's fire, so an aimed archetype (Diver, Scout, …) tracks the ship.
 * `GymLevel.tick` calls `fireLiveEnemies(...)` with no push, so in every
 * `GymLevel`-based gym (`GymBotTuning`, the dedicated Level Gym) an aimed
 * enemy keeps its constructor default target — the bottom-centre stand-in —
 * instead of the live player.
 *
 * ## Test-first reconciliation (AH-0MV5SDLQK005ZBOH)
 *
 * The work item's AC4 required this test to be red before the fix; it was
 * written under Vitest's `it.fails(...)` (expected failure) so the build →
 * test → commit gate stayed green while the gym still diverged. The adoption
 * item AH-0MV5SDNI2008RWQ2 removed the expected-failure wrapper once the
 * shared helper (AH-0MV5SDN24006SD2B) and the `GymLevel` adoption landed —
 * the assertion is now a hard gate (the same pattern used by
 * `powerUpIdNaming.test.ts` and `difficultySequencer.variety.test.ts`).
 */
describe('live-aim seam — bot/level gym tracks the live player like PlayScene (AH-0MV5SDLQK005ZBOH)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
    localStorage.clear();
  });

  /** The live player position used in both scenes (not the constructor default). */
  const PLAYER_X = 120;
  const PLAYER_Y = 90;

  /** The aim target captured at the instant the enemy's fire is dispatched. */
  interface AimAtFireProbe {
    atFire: Phaser.Math.Vector2 | null;
  }

  /**
   * Wraps the Diver's shared fire method so the aim target is captured at the
   * exact moment that frame's fire is dispatched. When the scene pushes the
   * live player *before* collecting fire, `atFire` is the player position; when
   * the push is missing or ordered after, it is the stale constructor default.
   */
  function probeAimAtFire(diver: Diver): AimAtFireProbe {
    const probe: AimAtFireProbe = { atFire: null };
    const fire = diver.tryFireSpreadBurst.bind(diver);
    diver.tryFireSpreadBurst = (now: number): DiverBullet[] => {
      probe.atFire = diver.aimTarget;
      return fire(now);
    };
    return probe;
  }

  /** A one-Diver wave launched through the real `GymLevel` contract. */
  function diverWave(): WaveDefinition {
    return {
      groups: [
        {
          enemyKey: 'diver',
          formation: 'v',
          count: 1,
          spacingX: 0,
          spacingY: 0,
          startX: 300,
          startY: 150,
        },
      ],
      shootEnabled: false,
    };
  }

  /** Pins a player at (x, y) without the next `physicsTick` snapping it back. */
  function placePlayer(player: Player, x: number, y: number): void {
    player.setPosition(x, y);
    // Keep the internal movement state in sync so `physicsTick` does not reset
    // the ship to its spawn position (same pattern as the teleport tests).
    const state = player.getMovementState();
    (
      player as unknown as {
        _movementState: ReturnType<Player['getMovementState']>;
      }
    )._movementState = { ...state, x, y, vx: 0, vy: 0 };
  }

  /** Boots `PlayScene` and registers one deterministic aimed Diver. */
  async function bootPlayWithDiver(): Promise<{
    scene: PlayScene;
    diver: Diver;
  }> {
    const booted = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'aim-equiv-play-host',
    );
    games.push(booted);
    const scene = booted.scene as PlayScene;
    placePlayer(scene.getPlayer()!, PLAYER_X, PLAYER_Y);
    const diver = new Diver(scene, {
      x: 300,
      y: 150,
      formationOffset: { row: 0, col: 0 },
    });
    scene.registerEnemy(diver, 'diver');
    return { scene, diver };
  }

  /** Boots the real Level Gym with a one-Diver wave and returns its Diver. */
  async function bootLevelGymWithDiver(): Promise<{
    scene: GymLevel;
    diver: Diver;
  }> {
    const booted = await bootScene([GymLevel], 'aim-equiv-gym-host');
    games.push(booted);
    const manager = booted.game.scene;
    const level: LevelDefinition = {
      level: 1,
      name: 'Aim Equivalence',
      waves: [diverWave()],
    };
    manager.start('GymLevel', { level });
    await advanceGame(booted.game, 200);
    const scene = manager.getScene('GymLevel') as GymLevel;
    // The launched wave enters through the wormhole spawn animation
    // (AH-0MV8BSMXC0097KLW), during which enemies cannot fire; settle it so
    // the gym Diver is fully spawned, like the hand-registered game Diver.
    scene.finishSpawnAnimations();
    placePlayer(scene.getShip()!, PLAYER_X, PLAYER_Y);
    const diver = scene.getEnemies()[0] as Diver;
    return { scene, diver };
  }

  /** Forces the Diver's formation hold to elapse on its next tick. */
  function forceDive(diver: Diver): void {
    (diver as unknown as { _holdTimer: number })._holdTimer =
      DIVER_HOLD_FORMATION_SECONDS;
  }

  /** The position the Diver's in-flight dive was snapshotted toward. */
  function diveTarget(diver: Diver): { x: number; y: number } {
    const fields = diver as unknown as {
      _diveTargetX: number;
      _diveTargetY: number;
    };
    return { x: fields._diveTargetX, y: fields._diveTargetY };
  }

  it('boots the level gym with the aimed archetype reachable (setup gate)', async () => {
    const { scene, diver } = await bootLevelGymWithDiver();
    expect(diver).toBeInstanceOf(Diver);
    expect(diver.alive).toBe(true);
    expect(scene.getEnemies()).toContain(diver);
    expect(diver.aimTarget).toBeDefined();
  });

  it('PlayScene pushes the live player into an aimed enemy before that frame fire is collected', async () => {
    const { scene, diver } = await bootPlayWithDiver();
    const probe = probeAimAtFire(diver);
    scene.tick(1 / 60);

    // The target is the live player, not the constructor's bottom-centre default.
    expect(diver.aimTarget.x).toBeCloseTo(PLAYER_X, 5);
    expect(diver.aimTarget.y).toBeCloseTo(PLAYER_Y, 5);
    // The push ran before fire collection: the target seen at fire time is live.
    expect(probe.atFire).not.toBeNull();
    expect(probe.atFire!.x).toBeCloseTo(PLAYER_X, 5);
    expect(probe.atFire!.y).toBeCloseTo(PLAYER_Y, 5);
  });

  it('GymFormationScene pushes the live player before fire, matching PlayScene', async () => {
    // The other player-bearing base scene (AC2) — `GymFodderEnemies` extends
    // `GymFormationScene` — must order the push the same way. Restart it on the
    // Diver roster so its `collectBullets` dispatch calls the same fire method
    // probed below.
    const booted = await bootScene([GymFodderEnemies], 'aim-ref-formation-host');
    games.push(booted);
    const manager = booted.game.scene;
    manager.start('GymFodderEnemies', { enemyKey: 'diver' });
    await advanceGame(booted.game, 200);
    const scene = manager.getScene('GymFodderEnemies') as GymFodderEnemies;
    placePlayer(scene.getPlayer()!, PLAYER_X, PLAYER_Y);
    const diver = new Diver(scene, {
      x: 300,
      y: 150,
      formationOffset: { row: 0, col: 0 },
    });
    scene.registerDynamicEntity(diver as never);
    const probe = probeAimAtFire(diver);
    scene.tick(1 / 60);

    expect(diver.aimTarget.x).toBeCloseTo(PLAYER_X, 5);
    expect(diver.aimTarget.y).toBeCloseTo(PLAYER_Y, 5);
    expect(probe.atFire).not.toBeNull();
    expect(probe.atFire!.x).toBeCloseTo(PLAYER_X, 5);
    expect(probe.atFire!.y).toBeCloseTo(PLAYER_Y, 5);
  });

  it('the bot/level gym tracks and dives toward the live player identically to PlayScene', async () => {
    const play = await bootPlayWithDiver();
    const gym = await bootLevelGymWithDiver();
    const playProbe = probeAimAtFire(play.diver);
    const gymProbe = probeAimAtFire(gym.diver);

    // Same input and dt in both scenes (AC3).
    for (let i = 0; i < 30; i++) {
      play.scene.tick(1 / 60);
      gym.scene.tick(1 / 60);
    }

    // AC1 — the gym's aimed enemy tracks the live player. Red today: it keeps
    // the constructor's bottom-centre default instead of the ship.
    expect(gym.diver.aimTarget.x).toBeCloseTo(PLAYER_X, 5);
    expect(gym.diver.aimTarget.y).toBeCloseTo(PLAYER_Y, 5);

    // AC3 — identical target outcome to PlayScene for the same tick sequence.
    expect(gym.diver.aimTarget.x).toBeCloseTo(play.diver.aimTarget.x, 5);
    expect(gym.diver.aimTarget.y).toBeCloseTo(play.diver.aimTarget.y, 5);

    // AC2 — the aim push precedes that frame's fire in both scenes.
    expect(playProbe.atFire).not.toBeNull();
    expect(gymProbe.atFire).not.toBeNull();
    expect(gymProbe.atFire!.x).toBeCloseTo(playProbe.atFire!.x, 5);
    expect(gymProbe.atFire!.y).toBeCloseTo(playProbe.atFire!.y, 5);
    expect(gymProbe.atFire!.x).toBeCloseTo(PLAYER_X, 5);

    // AC1 — “dives toward it”: forcing the hold to elapse snapshots the live
    // player as the dive target, identically in both scenes.
    forceDive(play.diver);
    forceDive(gym.diver);
    play.scene.tick(1 / 60);
    gym.scene.tick(1 / 60);

    const playTarget = diveTarget(play.diver);
    const gymTarget = diveTarget(gym.diver);
    expect(gymTarget.x).toBeCloseTo(PLAYER_X, 5);
    expect(gymTarget.y).toBeCloseTo(PLAYER_Y, 5);
    expect(gymTarget.x).toBeCloseTo(playTarget.x, 5);
    expect(gymTarget.y).toBeCloseTo(playTarget.y, 5);
  });
});

// ── Live-aim source parity guard (AH-0MV5SDM6G003A0US) ──────────────

/**
 * Source parity guard for the live-aim seam (child AH-0MV5SDM6G003A0US of the
 * live-aim parity epic AH-0MV4XFQ0J0082BN6).
 *
 * The runtime equivalence suite above proves the *current* behaviour; this
 * guard protects the *seam itself* against future omission: every
 * player-bearing enemy base scene must push the live player (and the live
 * mineral field) into its enemies through the single shared helper in
 * `src/scenes/core/enemyTargeting.ts`. A scene that stops calling the helper
 * fails the suite instead of silently reverting to the constructor's
 * bottom-centre stand-in target.
 *
 * A scene may opt out only by carrying an explicit documented-divergence
 * marker with a reason, mirroring the gym-parity convention
 * (AGENTS.md § Game Architecture Conventions).
 */

/** Player-bearing enemy base scenes that must consume the shared helper. */
const LIVE_AIM_SCENES = [
  'src/scenes/PlayScene.ts',
  'src/scenes/gym/core/GymFormationScene.ts',
  'src/scenes/gym/GymLevel.ts',
] as const;

/** The shared live-aim helper call every player-bearing scene must make. */
const LIVE_AIM_HELPER_CALL = 'pushAimTargets(';

/** The shared live-mineral-seek helper call every player-bearing scene must make. */
const LIVE_MINERAL_HELPER_CALL = 'pushSeekTargets(';

/**
 * Explicit marker a scene may carry to record a legitimate divergence from
 * the shared live-aim seam. It must be followed by a non-empty reason on the
 * same line, e.g.
 * `// @gym-parity-divergence: this gym has no player ship`.
 */
const DIVERGENCE_MARKER = '@gym-parity-divergence:';

/** True when `source` pushes the live-aim seam through the shared helper. */
function pushesAimSeam(source: string): boolean {
  return source.includes(LIVE_AIM_HELPER_CALL);
}

/** True when `source` pushes live minerals through the shared helper. */
function pushesMineralSeekSeam(source: string): boolean {
  return source.includes(LIVE_MINERAL_HELPER_CALL);
}

/** True when `source` documents a divergence with a non-empty reason. */
function documentsDivergence(source: string): boolean {
  const at = source.indexOf(DIVERGENCE_MARKER);
  if (at === -1) return false;
  const reason = source
    .slice(at + DIVERGENCE_MARKER.length)
    .split('\n')[0]
    .trim();
  return reason.length > 0;
}

/** True when `source` satisfies the aim-seam requirement (divergence allowed). */
function satisfiesAimSeam(source: string): boolean {
  return pushesAimSeam(source) || documentsDivergence(source);
}

describe('live-aim source parity guard — every player-bearing base scene pushes the seam (AH-0MV5SDM6G003A0US)', () => {
  it('permits an explicit documented-divergence marker with a reason (AC3)', () => {
    // An unmarked scene that never calls the helper would be flagged ...
    expect(satisfiesAimSeam('export class Bare {}')).toBe(false);
    // ... while a shared-helper call satisfies the guard ...
    expect(satisfiesAimSeam('pushAimTargets(this.spawned, this.player);')).toBe(
      true,
    );
    // ... and an explicit marker with a reason documents a legitimate divergence.
    expect(
      satisfiesAimSeam('// @gym-parity-divergence: this gym has no player ship'),
    ).toBe(true);
    // A bare marker with no reason is not a documented divergence.
    expect(satisfiesAimSeam('// @gym-parity-divergence:')).toBe(false);
  });

  it(
    'every player-bearing enemy base scene pushes the shared live-aim seam (AC1/AC2)',
    () => {      // Red before adoption (AH-0MV5SDNI2008RWQ2): now a hard gate — the
      // helper module and its consumers have landed.
      const missing = LIVE_AIM_SCENES.filter((file) => {
        const source = fs.readFileSync(
          path.resolve(process.cwd(), file),
          'utf8',
        );
        return !satisfiesAimSeam(source);
      });
      expect(missing).toEqual([]);
    },
  );

  it(
    'every player-bearing enemy base scene pushes the shared live-mineral-seek seam (AC2)',
    () => {
      // GymLevel now passes its live mineral field (not an empty array).
      const missing = LIVE_AIM_SCENES.filter((file) => {
        const source = fs.readFileSync(
          path.resolve(process.cwd(), file),
          'utf8',
        );
        return !pushesMineralSeekSeam(source) && !documentsDivergence(source);
      });
      expect(missing).toEqual([]);
    },
  );
});

// ── Shared wave-timeout + wipe→respawn lifecycle (AH-0MUNR5LM1004B223) ─

/**
 * The wave-timeout state machine and the wipe→3 s countdown→respawn
 * lifecycle live once in the shared `CombatScene` core. The formation gyms
 * (GymFormationScene subclasses) and the combat gym (GymPowerUpsCombat) all
 * opt in through hooks, so they run the *same code* — a single kind of
 * scene — and cannot diverge.
 */
describe('shared wave-timeout + wipe→respawn lifecycle (AH-0MUNR5LM1004B223)', () => {
  const SHARED_WAVE_METHODS = [
    'startWaveTimeout',
    'hideWaveTimeout',
    '_advanceWaveTimeout',
    '_onWaveTimeout',
    '_drawWaveTimeoutBar',
    '_startRespawnCountdown',
    '_cancelRespawnCountdown',
    '_tickRespawnCountdown',
    'isWaveTimeoutActive',
    'getWaveTimeoutRemaining',
    'setWaveTimeoutRemaining',
    'getWaveTimeoutBar',
    'isRespawnCountdownActive',
    'getRespawnCountdownRemaining',
    'getRespawnCountdownText',
  ] as const;
  const WAVE_CORE = 'src/scenes/core/CombatScene.ts';
  const GYM_PROTOTYPES: Array<[string, object]> = [
    ['GymFormationScene', GymFormationScene.prototype],
    ['GymPowerUpsCombat', GymPowerUpsCombat.prototype],
  ];

  it('defines each shared method exactly once, in the shared combat core', () => {
    for (const method of SHARED_WAVE_METHODS) {
      const definers = relativeProductionDefiners((source) =>
        definesMethod(source, method),
      );
      expect(definers, method).toEqual([WAVE_CORE]);
    }
  });

  it('both gyms resolve the shared methods to the same core function objects', () => {
    const core = CombatScene.prototype as unknown as Record<string, unknown>;
    for (const [name, prototype] of GYM_PROTOTYPES) {
      for (const method of SHARED_WAVE_METHODS) {
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
});

// ── Shared AOE dispatch/effect (parent AH-0MUOOB3OR001V8CD, F6 AC1/AC2) ──
//
// The AOE dispatch, effect resolution and VFX live once in the shared core
// (`CombatScene`); the game and the gyms inherit the same function objects,
// so an AOE behaviour fix reaches every scene at once.

/** The shared AOE dispatch/effect/VFX hooks. */
const SHARED_AOE_METHODS = [
  'onAoeFired',
  'onAoeRandomFired',
  'applyAoeEffect',
  'detonateAoeProjectile',
  'spawnAoeEffectVfx',
  'spawnArcChainVfx',
  'onAoeProjectileSpawned',
] as const;

/** The scenes that must inherit the shared AOE hooks unchanged. */
const AOE_SCENE_PROTOTYPES: Array<[string, object]> = [
  ['PlayScene', PlayScene.prototype],
  ['GymFormationScene', GymFormationScene.prototype],
  ['GymWeapons', GymWeapons.prototype],
];

describe('CombatScene — shared AOE dispatch/effect is defined once (F6 AC1)', () => {
  it('each AOE hook is defined only in the shared core (default + override)', () => {
    const files = productionSceneFiles();
    for (const method of SHARED_AOE_METHODS) {
      const definers = files
        .filter((file) => definesMethod(fs.readFileSync(file, 'utf8'), method))
        .map((file) => path.relative(process.cwd(), file))
        .sort();
      // At least one definition (base default + shared override where the
      // hook is a no-op default), and no production scene redefines it.
      expect(definers.length, method).toBeGreaterThanOrEqual(1);
      for (const definer of definers) {
        expect(SHARED_CORE_FILES, method).toContain(definer);
      }
    }
  });

  it('the game and every AOE-exercising gym resolve the same AOE hook functions', () => {
    for (const [name, prototype] of AOE_SCENE_PROTOTYPES) {
      for (const method of SHARED_AOE_METHODS) {
        expect(
          Object.prototype.hasOwnProperty.call(prototype, method),
          `${name}.prototype must not define ${method}`,
        ).toBe(false);
        expect(
          (prototype as unknown as Record<string, unknown>)[method],
          `${name}.prototype.${method} must be the shared CombatScene hook`,
        ).toBe(
          (CombatScene.prototype as unknown as Record<string, unknown>)[method],
        );
      }
    }
  });
});

// ── R-Type wave-laser damage-budget parity (AH-0MV97RISJ002WR2S) ───────

describe('CombatScene — wave-laser damage-budget parity (AH-0MV1BIUSJ0090W92, AH-0MV97RISJ002WR2S)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  /** Creates a real game enemy on the shared structural contract. */
  function makeGameEnemy(
    scene: Phaser.Scene,
    key: string,
    x: number,
    y: number,
  ): ReturnType<typeof createEnemyFromConfig> {
    return createEnemyFromConfig(scene, loadEnemyConfig(key), x, y, {
      row: 0,
      col: 0,
    });
  }

  it('a damage-budget beam passes through a line of enemies identically in the game and a gym', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'damage-budget-play-host',
    );
    const gym = await bootScene([EquivGymScene], 'damage-budget-gym-host');
    games.push(play, gym);
    const playScene = play.scene as PlayScene;
    const gymScene = gym.scene as EquivGymScene;

    // Clear any auto-fired bullets so only the injected beam collides.
    (playScene as unknown as { playerBullets: unknown[] }).playerBullets.length = 0;
    (gymScene as unknown as { playerBullets: unknown[] }).playerBullets.length = 0;

    // Game: two stationary 1-HP enemies overlapping the injection point.
    const gameEnemies = [
      makeGameEnemy(playScene, 'scout', 700, 400),
      makeGameEnemy(playScene, 'scout', 706, 400),
    ];
    for (const enemy of gameEnemies) playScene.registerEnemy(enemy, 'scout');

    // Gym: reposition its two formation enemies onto the same points.
    const gymEnemies = (
      gymScene as unknown as { getEnemyEntities(): EquivEnemy[] }
    ).getEnemyEntities();
    expect(gymEnemies).toHaveLength(2);
    gymEnemies[0].setPosition(700, 400);
    gymEnemies[1].setPosition(706, 400);

    // Park both ships far away so ram/player-hit passes stay inert.
    playScene.getPlayer()!.setPosition(50, 50);
    gymScene.getPlayer()!.setPosition(50, 50);

    // Budget 2 (the level-0 wave laser): destroys the first enemy, passes
    // through with 1 budget, destroys the second and is consumed — exactly one
    // damage point per 1-HP ship, in both scenes.
    const spawnBeam = (owner: PlayScene | EquivGymScene) =>
      owner.spawnPlayerBullet(
        703,
        400,
        PLAYER_BULLET_SPEED,
        0,
        0x3366ff,
        2,
        3,
        WEAPON_CATALOGUE.wave_laser.maxHitPoints!,
      );
    const gameBeam = spawnBeam(playScene);
    const gymBeam = spawnBeam(gymScene);

    // Run the shared collision pass directly in both scenes.
    (playScene as unknown as { _handleCollisions(): void })._handleCollisions();
    (gymScene as unknown as { _handleCollisions(): void })._handleCollisions();

    // The same shared code leaves the same outcome in both scenes: both
    // ships destroyed and the beam consumed once its budget is spent.
    expect(gameEnemies.every((enemy) => !enemy.alive)).toBe(true);
    expect(gymEnemies.every((enemy) => !enemy.alive)).toBe(true);
    expect(gameBeam.maxHitPoints).toBe(0);
    expect(gymBeam.maxHitPoints).toBe(0);
    expect(playScene.getPlayerBullets()).not.toContain(gameBeam);
    expect(gymScene.getPlayerBullets()).not.toContain(gymBeam);
  });

  it('the game and GymWeapons both resolve the damage budget through the shared CombatScene hook', () => {
    for (const [name, prototype] of [
      ['PlayScene', PlayScene.prototype],
      ['GymWeapons', GymWeapons.prototype],
    ] as const) {
      expect(
        Object.prototype.hasOwnProperty.call(prototype, 'onPlayerBulletHitsEnemy'),
        `${name}.prototype must not define onPlayerBulletHitsEnemy`,
      ).toBe(false);
      expect(
        (prototype as unknown as Record<string, unknown>)
          .onPlayerBulletHitsEnemy,
        `${name}.prototype.onPlayerBulletHitsEnemy must be the shared hook`,
      ).toBe(
        (CombatScene.prototype as unknown as Record<string, unknown>)
          .onPlayerBulletHitsEnemy,
      );
    }
  });
});

// ── Centipede ricochet bounce parity (AH-0MV1BIV5L005NJAI) ────────────

describe('CombatScene — ricochet bounce parity (AH-0MV1BIV5L005NJAI)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  it('the game and GymWeapons share the single spawnPlayerBullet path', () => {
    for (const [name, prototype] of [
      ['PlayScene', PlayScene.prototype],
      ['GymWeapons', GymWeapons.prototype],
    ] as const) {
      expect(
        Object.prototype.hasOwnProperty.call(prototype, 'spawnPlayerBullet'),
        `${name}.prototype must not define spawnPlayerBullet`,
      ).toBe(false);
      expect(
        (prototype as unknown as Record<string, unknown>).spawnPlayerBullet,
        `${name}.prototype.spawnPlayerBullet must be the shared core method`,
      ).toBe(
        (CombatCoreScene.prototype as unknown as Record<string, unknown>)
          .spawnPlayerBullet,
      );
    }
  });

  it('a ricochet bullet bounces identically in the game and a gym', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'ricochet-play-host',
    );
    const gym = await bootScene([EquivGymScene], 'ricochet-gym-host');
    games.push(play, gym);
    const playScene = play.scene as PlayScene;
    const gymScene = gym.scene as EquivGymScene;

    // Park both ships far away so ram/player-hit passes stay inert, and clear
    // any auto-fired bullets so only the injected pellet is advanced.
    playScene.getPlayer()!.setPosition(50, 50);
    gymScene.getPlayer()!.setPosition(50, 50);
    (playScene as unknown as { playerBullets: unknown[] }).playerBullets.length = 0;
    (gymScene as unknown as { playerBullets: unknown[] }).playerBullets.length = 0;

    const spawn = (owner: PlayScene | EquivGymScene) =>
      owner.spawnPlayerBullet(
        100,
        400,
        -PLAYER_BULLET_SPEED,
        0,
        WEAPON_CATALOGUE.ricochet.bulletColor,
        5,
        3,
        0,
        WEAPON_CATALOGUE.ricochet.bounce,
      );
    const gameBullet = spawn(playScene);
    const gymBullet = spawn(gymScene);

    // Both scenes' bullets advance through the same shared entity step.
    expect(advanceAndCull(gameBullet, 0.3)).toBe(true);
    expect(advanceAndCull(gymBullet, 0.3)).toBe(true);

    // The same reflected velocity, position and remaining budget in each.
    expect(gameBullet.vx).toBeCloseTo(PLAYER_BULLET_SPEED, 5);
    expect(gymBullet.vx).toBeCloseTo(PLAYER_BULLET_SPEED, 5);
    expect(gameBullet.bounces).toBe(1);
    expect(gymBullet.bounces).toBe(1);
    expect(gameBullet.x).toBeCloseTo(gymBullet.x, 5);
  });
});

// ── Force Field reflect parity (AH-0MV1BIX1W006XF95) ──────────────────

describe('CombatScene — Force Field reflect parity (AH-0MV1BIX1W006XF95)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  it('the game and a gym share the single _reflectEnemyBullet seam', () => {
    for (const [name, prototype] of [
      ['PlayScene', PlayScene.prototype],
      ['EquivGymScene', EquivGymScene.prototype],
    ] as const) {
      expect(
        Object.prototype.hasOwnProperty.call(prototype, '_reflectEnemyBullet'),
        `${name}.prototype must not define _reflectEnemyBullet`,
      ).toBe(false);
      expect(
        (prototype as unknown as Record<string, unknown>)._reflectEnemyBullet,
        `${name}.prototype._reflectEnemyBullet must be the shared core method`,
      ).toBe(
        (CombatScene.prototype as unknown as Record<string, unknown>)
          ._reflectEnemyBullet,
      );
    }
  });

  it('reflects an enemy bullet identically in the game and a gym', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'forcefield-play-host',
    );
    const gym = await bootScene([EquivGymScene], 'forcefield-gym-host');
    games.push(play, gym);
    const playScene = play.scene as PlayScene;
    const gymScene = gym.scene as EquivGymScene;
    const owners: EnemyBulletOwner[] = [playScene, gymScene];

    for (const owner of owners) {
      owner.getPlayer()!.setPosition(200, 270);
      // Clear any auto-fired bullets so only the reflected shot remains.
      (
        owner as unknown as { playerBullets: unknown[] }
      ).playerBullets.length = 0;
      owner.getEffectsRegistry().applyCollect('force_field');
      pushEnemyBullet(owner, {
        x: 230,
        y: 270,
        vx: -120,
        vy: 40,
        lifetime: 5,
      });
      (
        owner as unknown as { _handleCollisions(): void }
      )._handleCollisions();
    }

    // The enemy bullet is consumed in both scenes.
    expect(enemyBulletGraphics(playScene)).toHaveLength(0);
    expect(enemyBulletGraphics(gymScene)).toHaveLength(0);

    // Each scene owns exactly one reflected player bullet with the same
    // reversed velocity at the same position — the shared seam does the work.
    const playBullets = (
      playScene as unknown as { playerBullets: PlayerBullet[] }
    ).playerBullets;
    const gymBullets = (
      gymScene as unknown as { playerBullets: PlayerBullet[] }
    ).playerBullets;
    expect(playBullets).toHaveLength(1);
    expect(gymBullets).toHaveLength(1);
    const gameBullet = playBullets[0];
    const gymBullet = gymBullets[0];
    expect(gameBullet.vx).toBeCloseTo(120, 5);
    expect(gymBullet.vx).toBeCloseTo(120, 5);
    expect(gameBullet.vy).toBeCloseTo(-40, 5);
    expect(gymBullet.vy).toBeCloseTo(-40, 5);
    expect(gameBullet.x).toBeCloseTo(gymBullet.x, 5);
    expect(gameBullet.y).toBeCloseTo(gymBullet.y, 5);
    expect(playScene.getEffectsRegistry().forceFieldRemaining()).toBe(
      gymScene.getEffectsRegistry().forceFieldRemaining(),
    );
  });
});

// ── Missile Command cluster split parity (AH-0MV1BIVIJ007KYXU) ────────

describe('CombatScene — cluster-missile split parity (AH-0MV1BIVIJ007KYXU)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  it('the game and GymWeapons share the single splitProjectile seam', () => {
    for (const [name, prototype] of [
      ['PlayScene', PlayScene.prototype],
      ['GymWeapons', GymWeapons.prototype],
    ] as const) {
      expect(
        Object.prototype.hasOwnProperty.call(prototype, 'splitProjectile'),
        `${name}.prototype must not define splitProjectile`,
      ).toBe(false);
      expect(
        (prototype as unknown as Record<string, unknown>).splitProjectile,
        `${name}.prototype.splitProjectile must be the shared core method`,
      ).toBe(
        (CombatCoreScene.prototype as unknown as Record<string, unknown>)
          .splitProjectile,
      );
    }
  });

  it('a cluster missile splits into identical warheads in the game and a gym', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'cluster-play-host',
    );
    const gym = await bootScene([EquivGymScene], 'cluster-gym-host');
    games.push(play, gym);
    const playScene = play.scene as PlayScene;
    const gymScene = gym.scene as EquivGymScene;

    // Park both ships and clear any auto-fired bullets so only the injected
    // cluster missiles are split and counted.
    playScene.getPlayer()!.setPosition(50, 50);
    gymScene.getPlayer()!.setPosition(50, 50);
    const clear = (owner: PlayScene | EquivGymScene) => {
      (owner as unknown as { playerBullets: PlayerBullet[] }).playerBullets.length = 0;
    };
    clear(playScene);
    clear(gymScene);

    const spawn = (owner: PlayScene | EquivGymScene): PlayerBullet => {
      const bullet = owner.spawnPlayerBullet(
        200,
        200,
        PLAYER_BULLET_SPEED,
        0,
        WEAPON_CATALOGUE.cluster.bulletColor,
        2,
        3,
      );
      bullet.splitWeapon = WEAPON_CATALOGUE.cluster;
      return bullet;
    };
    const gameBullet = spawn(playScene);
    const gymBullet = spawn(gymScene);

    // Both scenes split through the same shared core method.
    const split = (owner: PlayScene | EquivGymScene, bullet: PlayerBullet) => {
      (
        owner as unknown as { splitProjectile(b: PlayerBullet): void }
      ).splitProjectile(bullet);
      (
        owner as unknown as { flushPendingSplitWarheads(): void }
      ).flushPendingSplitWarheads();
      return (owner as unknown as { playerBullets: PlayerBullet[] })
        .playerBullets;
    };
    const gameWarheads = split(playScene, gameBullet).filter(
      (b) => b.splitWeapon === undefined,
    );
    const gymWarheads = split(gymScene, gymBullet).filter(
      (b) => b.splitWeapon === undefined,
    );

    expect(gameWarheads).toHaveLength(WEAPON_CATALOGUE.cluster.splits!);
    expect(gymWarheads).toHaveLength(gameWarheads.length);
    // Identical radial spray: same velocity magnitude and colour.
    for (let i = 0; i < gameWarheads.length; i++) {
      expect(gymWarheads[i].vx).toBeCloseTo(gameWarheads[i].vx, 5);
      expect(gymWarheads[i].vy).toBeCloseTo(gameWarheads[i].vy, 5);
      expect(gymWarheads[i].color).toBe(gameWarheads[i].color);
    }
    // The shared fan is phase-locked +90° from the parent heading: a shell
    // fired to the right (heading 0) bursts to 90°/270° — perpendicular,
    // never 0° or 180° backwards — in both the game and the gym.
    const headings = (warheads: PlayerBullet[]): number[] =>
      warheads.map((b) => Math.atan2(b.vy, b.vx)).sort((a, b) => a - b);
    const gameHeadings = headings(gameWarheads);
    const expected = [Math.PI / 2, -Math.PI / 2].sort((a, b) => a - b);
    for (let i = 0; i < expected.length; i++) {
      expect(gameHeadings[i]).toBeCloseTo(expected[i], 5);
      expect(headings(gymWarheads)[i]).toBeCloseTo(expected[i], 5);
    }
  });
});

// ── Gradius Options orbit-emitter parity (AH-0MV1BIVVK0043TEM) ────────

describe('CombatScene — Options orbit-emitter parity (AH-0MV1BIVVK0043TEM)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  it('the game and GymWeapons share the single fireOptionsPods seam', () => {
    for (const [name, prototype] of [
      ['PlayScene', PlayScene.prototype],
      ['GymWeapons', GymWeapons.prototype],
    ] as const) {
      for (const method of ['fireOptionsPods', '_updateOptionsEscort'] as const) {
        expect(
          Object.prototype.hasOwnProperty.call(prototype, method),
          `${name}.prototype must not define ${method}`,
        ).toBe(false);
        expect(
          (prototype as unknown as Record<string, unknown>)[method],
          `${name}.prototype.${method} must be the shared core method`,
        ).toBe(
          (CombatCoreScene.prototype as unknown as Record<string, unknown>)[
            method
          ],
        );
      }
    }
  });

  it('the game and a gym spawn identical pod bullets from the shared seam', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'options-play-host',
    );
    const gym = await bootScene([EquivGymScene], 'options-gym-host');
    games.push(play, gym);
    const playScene = play.scene as PlayScene;
    const gymScene = gym.scene as EquivGymScene;

    // Park both ships at the same point and clear any auto-fired bullets.
    playScene.getPlayer()!.setPosition(50, 50);
    gymScene.getPlayer()!.setPosition(50, 50);
    (
      playScene as unknown as { playerBullets: PlayerBullet[] }
    ).playerBullets.length = 0;
    (
      gymScene as unknown as { playerBullets: PlayerBullet[] }
    ).playerBullets.length = 0;

    const fire = (owner: PlayScene | EquivGymScene): PlayerBullet[] => {
      (
        owner as unknown as {
          fireOptionsPods(
            def: typeof WEAPON_CATALOGUE.options,
            player: NonNullable<ReturnType<PlayScene['getPlayer']>>,
          ): void;
        }
      ).fireOptionsPods(WEAPON_CATALOGUE.options, owner.getPlayer()!);
      return (
        owner as unknown as { playerBullets: PlayerBullet[] }
      ).playerBullets.filter(
        (b) => b.color === WEAPON_CATALOGUE.options.bulletColor,
      );
    };
    const gamePods = fire(playScene);
    const gymPods = fire(gymScene);

    expect(gamePods).toHaveLength(WEAPON_CATALOGUE.options.orbit!.pods);
    expect(gymPods).toHaveLength(gamePods.length);
    // Identical escort geometry and pod-shot speed (phase starts at 0 in both).
    for (let i = 0; i < gamePods.length; i++) {
      expect(gymPods[i].x).toBeCloseTo(gamePods[i].x, 5);
      expect(gymPods[i].y).toBeCloseTo(gamePods[i].y, 5);
      expect(Math.hypot(gymPods[i].vx, gymPods[i].vy)).toBeCloseTo(
        Math.hypot(gamePods[i].vx, gamePods[i].vy),
        5,
      );
      // Each pod fires radially outward along its own ship→pod line, and the
      // game and gym aim identically (same orbit phase, same geometry —
      // AH-0MV1BIVVK0043TEM, AH-0MV5DFBVW002J2XO).
      const radial = (owner: PlayScene | EquivGymScene, pod: PlayerBullet) => {
        const ship = owner.getPlayer()!;
        return Math.atan2(pod.y - ship.y, pod.x - ship.x);
      };
      expect(Math.atan2(gamePods[i].vy, gamePods[i].vx)).toBeCloseTo(
        radial(playScene, gamePods[i]),
        5,
      );
      expect(Math.atan2(gymPods[i].vy, gymPods[i].vx)).toBeCloseTo(
        radial(gymScene, gymPods[i]),
        5,
      );
    }
  });
});

// ── Mystery UFO collector-drone spawn parity (AH-0MV9G113S009B37I) ─────

describe('CombatScene — Mystery UFO collector-drone spawn parity (AH-0MV9G113S009B37I)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  it('shares the single _spawnMysteryUfoDrone path across the game and the gym', () => {
    for (const [name, prototype] of [
      ['PlayScene', PlayScene.prototype],
      ['GymPowerUpsUtility', GymPowerUpsUtility.prototype],
    ] as const) {
      expect(
        Object.prototype.hasOwnProperty.call(
          prototype,
          '_spawnMysteryUfoDrone',
        ),
        `${name} must not define its own collector-drone spawn`,
      ).toBe(false);
      expect(
        (prototype as unknown as Record<string, unknown>)
          ._spawnMysteryUfoDrone,
      ).toBe(
        (CombatCoreScene.prototype as unknown as Record<string, unknown>)
          ._spawnMysteryUfoDrone,
      );
    }
  });

  it('spawns exactly one collector drone (and no instant minerals) in the game and the utility gym', async () => {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'mystery-play-host',
    );
    const gym = await bootScene([GymPowerUpsUtility], 'mystery-gym-host');
    games.push(play, gym);
    const playScene = play.scene as PlayScene;
    const gymScene = gym.scene as GymPowerUpsUtility;

    // Clear the gym's random mineral field so only the drone's own sortie can
    // move minerals into the gym hold.
    const gymMinerals = (gymScene as unknown as { minerals: Mineral[] })
      .minerals;
    for (const mineral of gymMinerals) mineral.destroy();
    gymMinerals.length = 0;

    const playBefore = playScene.getGameState().minerals;
    const gymBefore = gymScene.getMineralHold().store;

    const playDrop = playScene.spawnPowerUpDrop('mystery_ufo', 480, 270)!;
    for (let i = 0; i < 40; i++) playDrop.powerUp.advance(0.05);
    // Park the ship on the (possibly nudged) drop so the overlap is exact. The
    // shared player step reads `_movementState` (not the display position), so
    // both must agree, as the teleport parity tests above do.
    const playPlayer = playScene.getPlayer()!;
    playPlayer.setPosition(playDrop.x, playDrop.y);
    const playState = playPlayer.getMovementState();
    (
      playPlayer as unknown as { _movementState: Record<string, unknown> }
    )._movementState = {
      ...playState,
      x: playDrop.x,
      y: playDrop.y,
      vx: 0,
      vy: 0,
      facing: 0,
    };
    // Frame 1 collects the drop (queues the spawn); frame 2 runs the shared
    // spawn pass that turns the request into a visible drone.
    playScene.tick(0.016);
    playScene.tick(0.016);

    gymScene.spawnDrop('mystery_ufo', 480, 270);
    gymScene.advanceDrops(0.5);
    gymScene.getPlayer()!.setPosition(480, 270);
    gymScene.tick(1 / 60);
    gymScene.tick(1 / 60);

    // Both scenes spawn exactly one visible drone and grant no instant
    // mineral/score burst (the retired invisible bounty).
    expect(playScene.getDrones()).toHaveLength(1);
    expect(gymScene.getDrones()).toHaveLength(1);
    expect(playScene.getGameState().minerals).toBe(playBefore);
    expect(gymScene.getMineralHold().store).toBe(gymBefore);
    expect(playScene.getPlayer()!.getPowerUpLevel('mystery_ufo')).toBe(1);
    expect(gymScene.getPlayer()!.getPowerUpLevel('mystery_ufo')).toBe(1);
    expect(playScene.getEffectsRegistry().mysteryUfoSpawnInterval()).toBe(
      gymScene.getEffectsRegistry().mysteryUfoSpawnInterval(),
    );
  });
});

// ── Hold-full overlay metronome + countdown parity (AH-0MV55OB5Q000C9L1) ──
//
// The reduced-volume metronomic fire and the beat-locked 3-2-1 countdown
// live in the shared overlay (`MineralChoiceScene`), the pure schedulers
// (`src/scenes/core/holdFullFire.ts`, `holdFullCountdown.ts`) and the shared
// resume re-base in `CombatCoreScene`. The game and every gym launcher
// supply the SAME payload and consume the SAME shared functions — an
// enabled gameplay object runs the same code in a gym and the game
// (AGENTS.md gym↔game parity).

/** Every production scene that launches the shared `MineralChoiceScene`. */
const HOLDFULL_LAUNCHERS = [
  'src/scenes/PlayScene.ts',
  'src/scenes/gym/core/GymFormationScene.ts',
  'src/scenes/gym/GymWeaponLeveling.ts',
  'src/scenes/gym/GymPowerUpLeveling.ts',
] as const;

/** The shared hold-full pure helpers, each defined once in its module. */
const HOLDFULL_SHARED_HELPERS: Array<[string, string]> = [
  ['buildHoldFullFireSchedule', 'src/scenes/core/holdFullFire.ts'],
  ['createHoldFullFireMetronome', 'src/scenes/core/holdFullFire.ts'],
  ['createHoldFullCountdown', 'src/scenes/core/holdFullCountdown.ts'],
] as const;

describe('hold-full overlay metronome + countdown — gym↔game parity (AC5)', () => {
  it('every launcher passes the common overlay payload: options + fireSchedule + onSelect', () => {
    for (const file of HOLDFULL_LAUNCHERS) {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), file),
        'utf8',
      );
      // The overlay launch must carry the exact options the launcher will
      // apply (options), the frozen player-fire schedule (fireSchedule) and
      // the single selection contract (onSelect).
      expect(
        source.includes("scene.launch('MineralChoiceScene'"),
        `${file} must launch the overlay`,
      ).toBe(true);
      expect(
        source.includes('options: [...this.mineralChoiceOptions]'),
        `${file} passes the exact options`,
      ).toBe(true);
      expect(
        source.includes('fireSchedule: buildHoldFullFireSchedule(this.player)'),
        `${file} passes the shared frozen fire schedule`,
      ).toBe(true);
      expect(
        source.includes('onSelect: (index: number) => this.selectMineralChoice(index)'),
        `${file} passes the single selection contract`,
      ).toBe(true);
    }
  });

  it('every launcher supplies the top-left owned-permanents panel from the shared builder', () => {
    // The panel's rows are built once, by the pure `buildOwnedLoadout`
    // helper, and handed to the single shared overlay — never re-derived in a
    // launcher or the scene (AH-0MVCRKAPL000L68Y · AC3/AC6).
    for (const file of HOLDFULL_LAUNCHERS) {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), file),
        'utf8',
      );
      expect(
        source.includes("import { buildOwnedLoadout } from"),
        `${file} imports the shared owned-loadout builder`,
      ).toBe(true);
      expect(
        source.includes(
          'ownedUpgrades: buildOwnedLoadout(powerUpLevels, weaponLevels)',
        ),
        `${file} passes the owned-permanents rows to the overlay`,
      ).toBe(true);
    }
  });

  it('every launcher resumes through the shared beat-clock re-base', () => {
    for (const file of HOLDFULL_LAUNCHERS) {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), file),
        'utf8',
      );
      expect(
        source.includes('this.rebaseBeatClockForHoldFullResume('),
        `${file} re-bases the frozen beat clock on resume`,
      ).toBe(true);
    }
  });

  it('the shared hold-full functions are defined exactly once, in the shared core', () => {
    const files = productionSceneFiles();
    for (const [fn, expectedFile] of HOLDFULL_SHARED_HELPERS) {
      const definers = files
        .filter((file) => definesFunction(fs.readFileSync(file, 'utf8'), fn))
        .map((file) => path.relative(process.cwd(), file))
        .sort();
      expect(definers, `${fn} should be defined once`).toEqual([expectedFile]);
    }
  });

  it('rebaseBeatClockForHoldFullResume is defined once in the shared CombatCoreScene', () => {
    const files = productionSceneFiles();
    const definers = files
      .filter((file) =>
        definesMethod(fs.readFileSync(file, 'utf8'), 'rebaseBeatClockForHoldFullResume'),
      )
      .map((file) => path.relative(process.cwd(), file))
      .sort();
    expect(definers).toEqual(['src/scenes/core/CombatCoreScene.ts']);
  });

  it('fadeThrusterHumForHoldFull is defined once in the shared core and consumed by every launcher', () => {
    // The engine-hum fade on overlay open (AH-0MV70Y2XY005J2HI) is one
    // shared seam, so the game and every gym fade identically.
    const files = productionSceneFiles();
    const definers = files
      .filter((file) =>
        definesMethod(fs.readFileSync(file, 'utf8'), 'fadeThrusterHumForHoldFull'),
      )
      .map((file) => path.relative(process.cwd(), file))
      .sort();
    expect(definers).toEqual(['src/scenes/core/CombatCoreScene.ts']);

    for (const file of HOLDFULL_LAUNCHERS) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(
        source.includes('this.fadeThrusterHumForHoldFull()'),
        `${file} must fade the thruster hum on overlay open`,
      ).toBe(true);
    }
  });

  it('PlayScene and every hold-full gym inherit the same overlay selection flow', () => {
    // The overlay itself resolves every selection through the countdown;
    // the launchers must not re-introduce a divergent immediate-select copy.
    for (const file of HOLDFULL_LAUNCHERS) {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), file),
        'utf8',
      );
      // The single `onSelect` contract answers through selectMineralChoice —
      // the resume entry point that re-bases the clock. No other selection
      // callback is wired.
      expect(
        source.includes(
          "onSelect: (index: number) => this.selectMineralChoice(index)",
        ),
        `${file} selection contract via selectMineralChoice`,
      ).toBe(true);
      // The launcher never applies the choice inline at the launch site (no
      // divergent immediate-resume copy).
      const launchBlock = source.match(
        /scene\.launch\('MineralChoiceScene',\s*\{[\s\S]*?\}\);/,
      )?.[0];
      expect(launchBlock, `${file} launch block`).toBeDefined();
      expect(
        launchBlock?.includes('selectMineralChoice'),
        `${file} defers to selectMineralChoice`,
      ).toBe(true);
    }
  });
});

// ── Enemy force-field spawn parity (AH-0MVM8GXEF009883O) ─────────────

/**
 * Game↔gym parity for the enemy force-field curve (epic AH-0MVJ8W4GE007OMNT
 * AC4). The resolver (`enemyForceFieldHits`) is pure shared code: the game
 * resolves it in `PlayScene._spawnEnemy` from `WaveManager.level`, the level
 * gym resolves it in `GymLevel.spawnWave` from the launched `level.level`, and
 * both hand the count to the same `createEnemyFromConfig` factory parameter.
 * The ram-absorb branch is shared core (`CombatScene._handleCollisions` step
 * 4), so the same (level, config) pair must yield both the same shields and
 * the same ram outcome in the two scenes.
 */
describe('enemy force-field spawn parity — game and level gym (AH-0MVM8GXEF009883O)', () => {
  const games: BootedGame[] = [];
  const FF_LEVEL = 5;

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
    localStorage.clear();
  });

  /** One non-firing Tank wave at `level` — a heavy archetype, shielded at L2+. */
  function tankLevel(level: number, count = 1): LevelDefinition {
    return {
      level,
      name: `Force Field Parity ${level}`,
      waves: [
        {
          groups: [
            {
              enemyKey: 'tank',
              formation: 'rect',
              count,
              spacingX: 44,
              spacingY: 36,
              startX: 300,
              startY: 180,
            },
          ],
          shootEnabled: false,
        },
      ],
    };
  }

  /** A `target`-level Tank campaign (one wave per level). */
  function tankCampaign(target: number): LevelDefinition[] {
    return Array.from({ length: target }, (_, i) => tankLevel(i + 1));
  }

  /**
   * Clears the active wave. Bullets drain any force field first, so this also
   * works for shielded Tank waves at deeper levels.
   */
  function clearLiveEnemies(play: PlayScene): void {
    play.finishSpawnAnimations();
    for (let guard = 0; guard < 500; guard++) {
      if (play.isMineralChoiceOpen()) {
        play.selectMineralChoice(0);
        continue;
      }
      const enemy = play.getEnemies().find((entity) => entity.alive);
      if (!enemy) break;
      play.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
      play.tick(0.016);
    }
  }

  /**
   * Boots `PlayScene` on an injected `targetLevel`-level Tank campaign and
   * walks it to that level (`WaveManager.level` is the 1-based level index,
   * so spawning at level N requires the run to reach it).
   */
  async function bootGameCampaign(targetLevel: number): Promise<PlayScene> {
    // Opt out of the sequenced campaign so the injected fixture is honoured.
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    const booted = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'ff-play-host',
    );
    games.push(booted);
    const scene = booted.scene as PlayScene;
    // Batch walking must not end the run on a stray ram.
    scene.getGameState().lives = 99;
    scene.getWaveManager().setLevels(tankCampaign(targetLevel));
    scene.scene.restart();
    await advanceGame(booted.game, 200);
    for (
      let guard = 0;
      guard < 12 && scene.getWaveManager().level < targetLevel;
      guard++
    ) {
      clearLiveEnemies(scene);
      if (scene.isTransitioning()) scene.tick(3.0);
    }
    scene.finishSpawnAnimations();
    return scene;
  }

  /** Boots the real Level Gym with the same launched level (gym spawn path). */
  async function bootLevelGym(level: LevelDefinition): Promise<GymLevel> {
    const booted = await bootScene([GymLevel], 'ff-gym-host');
    games.push(booted);
    const manager = booted.game.scene;
    manager.start('GymLevel', { level });
    await advanceGame(booted.game, 200);
    const scene = manager.getScene('GymLevel') as GymLevel;
    scene.finishSpawnAnimations();
    return scene;
  }

  function tanksOf(entities: readonly unknown[]): Tank[] {
    return entities.filter(
      (entity): entity is Tank => entity instanceof Tank && entity.alive,
    );
  }

  /** Suspends auto-fire so only the ram touches the enemy in the collision pass. */
  function suspendAutoFire(scene: PlayScene | GymLevel): void {
    (scene as unknown as { autoFireEnabled(): boolean }).autoFireEnabled =
      () => false;
  }

  /** Pins a player at (x, y) without the next physics tick snapping it back. */
  function placePlayer(player: Player, x: number, y: number): void {
    player.setPosition(x, y);
    const state = player.getMovementState();
    (
      player as unknown as {
        _movementState: ReturnType<Player['getMovementState']>;
      }
    )._movementState = { ...state, x, y, vx: 0, vy: 0 };
  }

  it('resolves identical field hits for the same (level, config) pair in both spawn paths', async () => {
    const game = await bootGameCampaign(FF_LEVEL);
    const gym = await bootLevelGym(tankLevel(FF_LEVEL));

    const expected = enemyForceFieldHits(
      FF_LEVEL,
      loadEnemyConfig('tank'),
    );
    // A level-5 Tank is genuinely shielded — the parity assertion is not vacuous.
    expect(expected).toBeGreaterThan(0);

    const gameFields = tanksOf(game.getEnemies()).map((t) => t.forceFieldHits);
    const gymFields = tanksOf(gym.getEnemies()).map((t) => t.forceFieldHits);
    expect(gameFields.length).toBeGreaterThan(0);
    expect(gameFields.every((hits) => hits === expected)).toBe(true);
    expect(gymFields).toEqual(gameFields);

    // Both still resolve level 1 to the unshielded baseline (L1 untouched).
    const gameL1 = await bootGameCampaign(1);
    const gymL1 = await bootLevelGym(tankLevel(1));
    expect(tanksOf(gameL1.getEnemies()).every((t) => t.forceFieldHits === 0)).toBe(true);
    expect(tanksOf(gymL1.getEnemies()).every((t) => t.forceFieldHits === 0)).toBe(true);
  });

  it('absorbs a player ram identically in the game and the gym (one field hit, both survive)', async () => {
    const game = await bootGameCampaign(FF_LEVEL);
    const gym = await bootLevelGym(tankLevel(FF_LEVEL));
    const expected = enemyForceFieldHits(FF_LEVEL, loadEnemyConfig('tank'));

    const gameTank = tanksOf(game.getEnemies())[0];
    const gymTank = tanksOf(gym.getEnemies())[0];
    expect(gameTank).toBeDefined();
    expect(gymTank).toBeDefined();
    expect(gameTank.forceFieldHits).toBe(expected);
    expect(gymTank.forceFieldHits).toBe(expected);

    // Park the ship on the shielded enemy: the shared core must consume
    // exactly one field hit and destroy neither side.
    suspendAutoFire(game);
    suspendAutoFire(gym);
    placePlayer(game.getPlayer()!, gameTank.x, gameTank.y);
    placePlayer(gym.getShip()!, gymTank.x, gymTank.y);

    game.tick(1 / 60);
    gym.tick(1 / 60);

    expect(gameTank.alive).toBe(true);
    expect(gymTank.alive).toBe(true);
    expect(gameTank.forceFieldHits).toBe(expected - 1);
    expect(gymTank.forceFieldHits).toBe(expected - 1);
    expect(game.getPlayer()!.active).toBe(true);
    expect(gym.getShip()!.active).toBe(true);
    // The shared outcome is identical, not merely individually plausible.
    expect(gymTank.forceFieldHits).toBe(gameTank.forceFieldHits);
  });
});
