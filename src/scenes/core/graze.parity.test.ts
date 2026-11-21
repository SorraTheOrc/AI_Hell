/**
 * Shared graze band / danger multiplier — behavioural and cross-scene parity
 * (AH-0MWL7ORK8007LXJI).
 *
 * AC2: one graze per pass, hysteresis on re-entry, credit cleared when the
 * hostile is gone — through the shared collision pipeline.
 * AC3: kill score is multiplied at the shared score seam.
 * AC4: a player hit resets the chain.
 * AC6: a formation gym exercises detection and tier growth through the very
 * same shared code path as the game.
 * AC7: the same seed and input trace produce the same graze count.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';
import { advanceGame, bootScene, type BootedGame } from '../../test/gameHarness';
import { GRAZE_BAND, GRAZE_HYSTERESIS, GRAZE_TIER_THRESHOLDS } from '../../core/graze';
import { PLAYER_SPAWN, SHIP_SIZE } from '../../core/constants';
import { Player } from '../../entities/Player';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import { PlayScene } from '../../scenes/PlayScene';
import { GameOverScene } from '../../scenes/GameOverScene';
import { MenuScene } from '../../scenes/MenuScene';
import { GymFodderEnemies } from '../gym/GymFodderEnemies';
import type { FormationSceneBullet } from '../gym/core/GymFormationScene';
import {
  CombatScene,
  type CombatDrop,
  type CombatEnemyBullet,
  type CombatEnemyEntity,
} from './CombatScene';

/** Hull collision half-width the shared pass tests (matches `_handleCollisions`). */
const PLAYER_HULL = SHIP_SIZE / 2;

/** Enemy bullet radius the shared pass reads (`getEnemyBulletRadius` default). */
const BULLET_RADIUS = 5;

/** The contact distance for a plain enemy bullet. */
const CONTACT = PLAYER_HULL + BULLET_RADIUS;

/** A distance inside the band for a plain enemy bullet. */
const IN_BAND = CONTACT + GRAZE_BAND - 1;

/** A distance that clears the band by more than the hysteresis margin. */
const CLEARLY_OUT = CONTACT + GRAZE_BAND + GRAZE_HYSTERESIS + 2;

/** Minimal enemy satisfying the shared entity contract. */
class StubEnemy
  extends Phaser.GameObjects.Container
  implements CombatEnemyEntity
{
  alive = true;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    private readonly hitRadius = 10,
  ) {
    super(scene, x, y);
  }

  getHitRadius(): number {
    return this.hitRadius;
  }

  destroySelf(): void {
    this.alive = false;
  }
}

/** Minimal enemy bullet (graphics + velocity). */
class StubBullet implements CombatEnemyBullet {
  readonly graphics: Phaser.GameObjects.Image;
  vx = 0;
  vy = 0;

  constructor(scene: Phaser.Scene, x = 0, y = 0) {
    this.graphics = scene.add.image(x, y, '__DEFAULT');
  }

  /** Moves the bullet to a new centre-to-centre distance from `player`. */
  placeAtDistance(player: Player, distance: number): void {
    this.graphics.setPosition(player.x + distance, player.y);
  }
}

/** Minimal drop satisfying the shared collect contract. */
class StubDrop implements CombatDrop {
  readonly powerUp = new PowerUp('speed_boost');
  readonly dropId = 'speed_boost' as const;
  absorbing?: boolean;

  constructor(
    public x: number,
    public y: number,
    public readonly graphics: Phaser.GameObjects.Graphics,
  ) {}
}

/** Minimal combat scene driving the shared pipeline. */
class GrazeStubScene extends CombatScene<StubEnemy, StubBullet, StubDrop> {
  entities: StubEnemy[] = [];
  bullets: StubBullet[] = [];
  playerRef: Player | null = null;
  effects = new EffectsRegistry();
  phased = false;

  constructor() {
    super({ key: 'GrazeStubScene' });
  }

  protected getPlayer(): Player | null {
    return this.playerRef;
  }
  protected getEffectsRegistry(): EffectsRegistry {
    return this.effects;
  }
  protected getEnemyEntities(): readonly StubEnemy[] {
    return this.entities;
  }
  protected getEnemyBullets(): readonly StubBullet[] {
    return this.bullets;
  }
  protected setEnemyBullets(bullets: StubBullet[]): void {
    this.bullets = bullets;
  }
  protected override isPlayerPhased(): boolean {
    return this.phased;
  }
  /** No invulnerability window: a hit resolves immediately, every time. */
  protected override getInvulnerabilityDuration(): number {
    return 0;
  }

  // ── Public wrappers for the protected template methods ───────────
  addPlayer(x: number, y: number): Player {
    const player = new Player(this, { x, y });
    this.add.existing(player);
    this.playerRef = player;
    return player;
  }
  addBullet(x: number, y: number): StubBullet {
    const bullet = new StubBullet(this, x, y);
    this.bullets.push(bullet);
    return bullet;
  }
  addEnemy(x: number, y: number, hitRadius = 10): StubEnemy {
    const enemy = new StubEnemy(this, x, y, hitRadius);
    this.entities.push(enemy);
    return enemy;
  }
  runCollisions(): void {
    this._handleCollisions();
  }
  runTick(dt: number): void {
    this._tickPlayer(dt);
  }
  runHitPlayer(): void {
    this._hitPlayer();
  }
  hits(): number {
    return this.playerHitCount;
  }
  scoreFor(base: number): number {
    return this.resolveKillScore(base);
  }
}

/** Fresh graze stub booted with a player at a fixed spot. */
async function bootStub(): Promise<{
  scene: GrazeStubScene;
  player: Player;
  booted: BootedGame;
}> {
  const booted = await bootScene([GrazeStubScene]);
  const scene = booted.scene as GrazeStubScene;
  const player = scene.addPlayer(PLAYER_SPAWN.x, PLAYER_SPAWN.y);
  return { scene, player, booted };
}

describe('shared graze pass — band, credit and hysteresis (AC2)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  it('credits a hostile entering the band exactly once, with one spark and cue', async () => {
    const cue = vi.spyOn(effectsModule, 'playGrazeSound');
    const stub = await bootStub();
    booted = stub.booted;
    const bullet = stub.scene.addBullet(stub.player.x + IN_BAND, stub.player.y);

    stub.scene.runCollisions();

    expect(stub.scene.getGrazeCount()).toBe(1);
    expect(stub.scene.getGrazeEffects()).toHaveLength(1);
    expect(cue).toHaveBeenCalledTimes(1);

    // A hostile parked in the band for many frames credits nothing further.
    for (let i = 0; i < 10; i += 1) stub.scene.runCollisions();
    expect(stub.scene.getGrazeCount()).toBe(1);
    expect(bullet.graphics.active).toBe(true);
  });

  it('records none when the hostile leaves and re-enters inside the hysteresis margin', async () => {
    const stub = await bootStub();
    booted = stub.booted;
    const bullet = stub.scene.addBullet(stub.player.x + IN_BAND, stub.player.y);
    stub.scene.runCollisions();
    expect(stub.scene.getGrazeCount()).toBe(1);

    // Just outside the band, still inside the hysteresis margin.
    bullet.placeAtDistance(
      stub.player,
      CONTACT + GRAZE_BAND + GRAZE_HYSTERESIS - 0.5,
    );
    stub.scene.runCollisions();
    // Back into the band.
    bullet.placeAtDistance(stub.player, IN_BAND);
    stub.scene.runCollisions();

    expect(stub.scene.getGrazeCount()).toBe(1);
  });

  it('records a fresh graze once the hostile clears the hysteresis margin', async () => {
    const stub = await bootStub();
    booted = stub.booted;
    const bullet = stub.scene.addBullet(stub.player.x + IN_BAND, stub.player.y);
    stub.scene.runCollisions();

    bullet.placeAtDistance(stub.player, CLEARLY_OUT);
    stub.scene.runCollisions();
    bullet.placeAtDistance(stub.player, IN_BAND);
    stub.scene.runCollisions();

    expect(stub.scene.getGrazeCount()).toBe(2);
  });

  it('clears the credit when the hostile is destroyed and re-credits a new one', async () => {
    const stub = await bootStub();
    booted = stub.booted;
    const bullet = stub.scene.addBullet(stub.player.x + IN_BAND, stub.player.y);
    stub.scene.runCollisions();
    expect(stub.scene.getGrazeCount()).toBe(1);

    // Destroyed: gone from the field, so its credit clears.
    bullet.graphics.destroy();
    stub.scene.bullets = [];
    stub.scene.runCollisions();
    expect(stub.scene.getGrazeTracker().creditedCount).toBe(0);

    stub.scene.addBullet(stub.player.x + IN_BAND, stub.player.y);
    stub.scene.runCollisions();
    expect(stub.scene.getGrazeCount()).toBe(2);
  });

  it('never credits a hostile inside the hit radius', async () => {
    const stub = await bootStub();
    booted = stub.booted;
    stub.scene.addBullet(stub.player.x + CONTACT - 1, stub.player.y);

    stub.scene.runCollisions();

    // It hit the player instead (no graze, chain reset, hit counted).
    expect(stub.scene.getGrazeCount()).toBe(0);
    expect(stub.scene.hits()).toBe(1);
    expect(stub.scene.getDangerMultiplier()).toBe(1);
  });

  it('never credits while the player is phased (no contact, no near miss)', async () => {
    const stub = await bootStub();
    booted = stub.booted;
    stub.scene.addBullet(stub.player.x + IN_BAND, stub.player.y);
    stub.scene.phased = true;

    stub.scene.runCollisions();

    expect(stub.scene.getGrazeCount()).toBe(0);
  });

  it('graze enemy bodies too — they can kill on contact', async () => {
    const stub = await bootStub();
    booted = stub.booted;
    // Contact distance for a 10 px body is hull + 10.
    stub.scene.addEnemy(stub.player.x + PLAYER_HULL + 10 + 4, stub.player.y, 10);

    stub.scene.runCollisions();

    expect(stub.scene.getGrazeCount()).toBe(1);
  });

  it('keeps separate hostiles independent within one pass', async () => {
    const stub = await bootStub();
    booted = stub.booted;
    stub.scene.addBullet(stub.player.x + IN_BAND, stub.player.y);
    stub.scene.addBullet(stub.player.x - IN_BAND, stub.player.y);

    stub.scene.runCollisions();

    expect(stub.scene.getGrazeCount()).toBe(2);
    expect(stub.scene.getGrazeEffects()).toHaveLength(2);
  });
});

describe('shared graze pass — multiplier at the score seam (AC3/AC4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  it('scales kill score by the held tier, rounded half up, and rescales after decay', async () => {
    const stub = await bootStub();
    booted = stub.booted;
    expect(stub.scene.scoreFor(100)).toBe(100);

    // Climb to ×1.5 through grazes on distinct hostiles.
    for (let i = 0; i < GRAZE_TIER_THRESHOLDS[1]; i += 1) {
      stub.scene.addBullet(stub.player.x + IN_BAND, stub.player.y + i * 0.1);
      stub.scene.runCollisions();
    }
    expect(stub.scene.getDangerMultiplier()).toBe(1.5);
    expect(stub.scene.scoreFor(100)).toBe(150);
    expect(stub.scene.scoreFor(3)).toBe(5);

    // One decay window through the shared player step drops a tier.
    stub.scene.runTick(2);
    expect(stub.scene.getDangerMultiplier()).toBe(1);
    expect(stub.scene.scoreFor(100)).toBe(100);
  });

  it('resets the chain to ×1 on a real player hit', async () => {
    const stub = await bootStub();
    booted = stub.booted;
    for (let i = 0; i < GRAZE_TIER_THRESHOLDS[2]; i += 1) {
      stub.scene.addBullet(stub.player.x + IN_BAND, stub.player.y + i * 0.1);
      stub.scene.runCollisions();
    }
    expect(stub.scene.getDangerMultiplier()).toBe(2);

    stub.scene.runHitPlayer();

    expect(stub.scene.getDangerMultiplier()).toBe(1);
    expect(stub.scene.getGrazeCount()).toBe(GRAZE_TIER_THRESHOLDS[2]);
  });
});

describe('game ↔ formation gym graze parity (AC6)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  /** Parks a stationary enemy bullet at `distance` from the ship. */
  /** Parks a stationary enemy bullet at `distance` from the ship. */
  function parkBulletAt(
    scene: Phaser.Scene & { getPlayer(): Player | null },
    distance: number,
    offsetY: number,
  ): FormationSceneBullet {
    const player = scene.getPlayer()!;
    const graphics = scene.add.image(
      player.x + distance,
      player.y + offsetY,
      '__DEFAULT',
    );
    const bullet: FormationSceneBullet = {
      graphics,
      vx: 0,
      vy: 0,
      lifetime: 999,
      elapsed: 0,
    };
    (scene as unknown as { bullets: FormationSceneBullet[] }).bullets.push(
      bullet,
    );
    return bullet;
  }

  it('the game and the formation gym record the same grazes and tier', async () => {
    // ── Game ──────────────────────────────────────────────────────
    booted = await bootScene([PlayScene, MenuScene, GameOverScene]);
    const play = booted.scene as PlayScene;
    const playPlayer = play.getPlayer()!;
    const gameBefore = play.getGrazeCount();
    for (let i = 0; i < GRAZE_TIER_THRESHOLDS[1]; i += 1) {
      play.spawnEnemyBullet(playPlayer.x + IN_BAND, playPlayer.y + i, 0, 0);
    }
    play.tick(1 / 60);
    const gameGrazes = play.getGrazeCount() - gameBefore;
    const gameMultiplier = play.getDangerMultiplier();

    booted.game.destroy(true);
    booted = null;

    // ── Formation gym ─────────────────────────────────────────────
    booted = await bootScene([GymFodderEnemies]);
    const gym = booted.scene as unknown as GymFodderEnemies;
    expect(gym.getPlayer()).not.toBeNull();
    const gymBefore = gym.getGrazeCount();
    for (let i = 0; i < GRAZE_TIER_THRESHOLDS[1]; i += 1) {
      parkBulletAt(gym, IN_BAND + i * 0.1, i);
    }
    gym.tick(1 / 60);
    const gymGrazes = gym.getGrazeCount() - gymBefore;

    // The gym inherits the same shared pass, so the same input produces the
    // same count and the same tier — no gym-local graze rule exists.
    expect(gameGrazes).toBe(GRAZE_TIER_THRESHOLDS[1]);
    expect(gymGrazes).toBe(gameGrazes);
    expect(gym.getDangerMultiplier()).toBe(gameMultiplier);
    expect(gym.getGrazeEffects().length).toBeGreaterThan(0);
  });

  it('a graze-heavy trace is deterministic across two identical runs', async () => {
    const run = async (): Promise<{ grazes: number; multiplier: number }> => {
      const game = await bootScene([PlayScene, MenuScene, GameOverScene]);
      try {
        const scene = game.scene as PlayScene;
        const player = scene.getPlayer()!;
        for (let frame = 0; frame < 20; frame += 1) {
          const distance = IN_BAND + (frame % 3);
          scene.spawnEnemyBullet(
            player.x + distance,
            player.y + frame * 0.5,
            0,
            0,
          );
          scene.tick(1 / 60);
        }
        return {
          grazes: scene.getGrazeCount(),
          multiplier: scene.getDangerMultiplier(),
        };
      } finally {
        game.game.destroy(true);
      }
    };

    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    expect(first.grazes).toBeGreaterThan(0);
  });

  it('the tacho renders the same state the score seam applies', async () => {
    booted = await bootScene([PlayScene, MenuScene, GameOverScene]);
    const play = booted.scene as PlayScene;
    const player = play.getPlayer()!;
    for (let i = 0; i < GRAZE_TIER_THRESHOLDS[2]; i += 1) {
      play.spawnEnemyBullet(player.x + IN_BAND, player.y + i * 0.1, 0, 0);
    }
    play.tick(1 / 60);

    const tacho = play.getDangerTacho();
    expect(tacho).not.toBeNull();
    expect(tacho!.getLabelText()).toContain('DANGER');
    expect(tacho!.getState().multiplier).toBe(play.getDangerMultiplier());
    expect(tacho!.getState().filledPips).toBe(
      play.getGrazeTracker().tierIndex + 1,
    );
  });
});

describe('graze is score-only — nothing else in a run moves (AC8)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  it('a graze never changes lives, minerals or the hit count', async () => {
    booted = await bootScene([PlayScene, MenuScene, GameOverScene]);
    const play = booted.scene as PlayScene;
    const player = play.getPlayer()!;
    const before = {
      lives: play.getGameState().lives,
      minerals: play.getGameState().minerals,
      hits: play.getHitCount(),
      score: play.getGameState().score,
    };

    for (let i = 0; i < 6; i += 1) {
      play.spawnEnemyBullet(player.x + IN_BAND, player.y + i * 0.1, 0, 0);
    }
    await advanceGame(booted.game, 200);

    expect(play.getGrazeCount()).toBeGreaterThan(0);
    expect(play.getGameState().lives).toBe(before.lives);
    expect(play.getGameState().minerals).toBe(before.minerals);
    expect(play.getHitCount()).toBe(before.hits);
    // Grazes award no score of their own.
    expect(play.getGameState().score).toBe(before.score);
  });
});
